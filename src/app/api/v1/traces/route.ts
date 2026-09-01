import { gunzipSync, inflateSync } from "node:zlib";
import { pruneRawSpans } from "@/lib/db";
import { decodeProtobufExportRequest, looksLikeProtobuf } from "@/lib/otlp/protobuf";
import type { ExportTraceServiceRequest } from "@/lib/otlp/types";
import { ingestExportRequest } from "@/lib/trace/ingest";

/**
 * OTLP/HTTP trace receiver.
 *
 * Accepts both wire encodings:
 *   - `application/x-protobuf` — the OTel SDK default
 *   - `application/json`       — handy for curl and debugging
 *
 * Responds per the OTLP spec: 200 with an (optionally partial-success)
 * ExportTraceServiceResponse body.
 */

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const MAX_BODY_BYTES = 64 * 1024 * 1024;

/** Prune is cheap but not free; run it occasionally rather than per-request. */
let ingestCount = 0;
const PRUNE_EVERY = 50;

function decompress(buf: Buffer, encoding: string | null): Buffer {
  if (!encoding) return buf;
  const enc = encoding.toLowerCase();
  try {
    if (enc.includes("gzip")) return gunzipSync(buf);
    if (enc.includes("deflate")) return inflateSync(buf);
  } catch {
    throw new Error(`Failed to decompress payload with content-encoding "${encoding}"`);
  }
  return buf;
}

function badRequest(message: string): Response {
  return Response.json(
    { error: message },
    { status: 400, headers: { "content-type": "application/json" } },
  );
}

export async function POST(request: Request): Promise<Response> {
  const contentType = request.headers.get("content-type") ?? "";
  const contentEncoding = request.headers.get("content-encoding");

  const raw = Buffer.from(await request.arrayBuffer());
  if (raw.byteLength === 0) {
    return badRequest("Empty OTLP payload.");
  }
  if (raw.byteLength > MAX_BODY_BYTES) {
    return badRequest(
      `Payload too large (${raw.byteLength} bytes, limit ${MAX_BODY_BYTES}).`,
    );
  }

  let body: Buffer;
  try {
    body = decompress(raw, contentEncoding);
  } catch (err) {
    return badRequest(err instanceof Error ? err.message : "Decompression failed.");
  }

  let req: ExportTraceServiceRequest;
  try {
    if (contentType.includes("application/x-protobuf")) {
      req = decodeProtobufExportRequest(body);
    } else if (contentType.includes("application/json") || !looksLikeProtobuf(body)) {
      const text = body.toString("utf8");
      const parsed: unknown = JSON.parse(text);
      if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
        return badRequest("Expected a JSON object at the top level.");
      }
      req = parsed as ExportTraceServiceRequest;
    } else {
      req = decodeProtobufExportRequest(body);
    }
  } catch (err) {
    return badRequest(
      `Could not decode OTLP payload: ${err instanceof Error ? err.message : String(err)}`,
    );
  }

  try {
    const result = ingestExportRequest(req);

    ingestCount += 1;
    if (ingestCount % PRUNE_EVERY === 0) {
      try {
        pruneRawSpans();
      } catch {
        // Retention cleanup must never fail an ingest.
      }
    }

    // OTLP: an empty object means full success; partialSuccess reports rejects.
    const response =
      result.spansRejected > 0
        ? {
            partialSuccess: {
              rejectedSpans: result.spansRejected,
              errorMessage: "Spans with invalid trace_id/span_id were rejected.",
            },
          }
        : {};

    return Response.json(response, { status: 200 });
  } catch (err) {
    return Response.json(
      {
        error: `Ingest failed: ${err instanceof Error ? err.message : String(err)}`,
      },
      { status: 500 },
    );
  }
}

/** Health probe — confirms the collector is listening. */
export async function GET(): Promise<Response> {
  return Response.json({
    ok: true,
    endpoint: "/api/v1/traces",
    protocols: ["application/x-protobuf", "application/json"],
    encodings: ["gzip", "deflate", "identity"],
  });
}
