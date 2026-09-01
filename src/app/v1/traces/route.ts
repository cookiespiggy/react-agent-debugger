import { POST as receiverPost } from "@/app/api/v1/traces/route";

/**
 * Standard OTLP/HTTP endpoint alias.
 *
 * Every OTel SDK appends `/v1/traces` to the exporter's base URL, so pointing
 * one at `http://host:3000` would otherwise 404 against `/api/v1/traces`.
 * This makes zero-path-configuration export work:
 *
 *   OTEL_EXPORTER_OTLP_ENDPOINT=http://localhost:3000
 *
 * Identical handler — just reachable at the spec's conventional path.
 */

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export const POST = receiverPost;

/** Health probe — confirms the collector is listening at the standard path. */
export async function GET(): Promise<Response> {
  return Response.json({
    ok: true,
    endpoint: "/v1/traces",
    aliasOf: "/api/v1/traces",
    protocols: ["application/x-protobuf", "application/json"],
    encodings: ["gzip", "deflate", "identity"],
  });
}
