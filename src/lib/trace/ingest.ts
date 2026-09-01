import type { RawSpanRecord } from "../db";
import { getRawSpans, insertTrace, upsertRawSpans } from "../db";
import { normalizeSpan, type NormalizedSpan } from "../genai/normalize";
import { decodeAttributes } from "../otlp/decode";
import type { ExportTraceServiceRequest, OtlpSpan } from "../otlp/types";
import { buildTraceView } from "./tree";

/**
 * Ingest pipeline: OTLP export request -> normalized spans -> stored trace view.
 *
 * Exporters routinely split a single trace across multiple batches, so traces
 * are rebuilt from the union of everything received so far rather than from
 * just this batch. Re-ingesting the same span is therefore idempotent.
 */

export interface IngestResult {
  traceIds: string[];
  spanCount: number;
  spansRejected: number;
}

interface CollectedSpan {
  span: OtlpSpan;
  resourceAttributes: Record<string, unknown>;
  scopeName: string | null;
}

const TRACE_ID_RE = /^[0-9a-f]{32}$/i;
const SPAN_ID_RE = /^[0-9a-f]{16}$/i;
const ALL_ZERO_32 = /^0{32}$/;
const ALL_ZERO_16 = /^0{16}$/;

/**
 * Validate OTel identifier shape before anything touches storage.
 * All-zero IDs mean "no parent" / "unset" and must not become a real span.
 */
function hasValidIds(span: OtlpSpan): boolean {
  const { traceId, spanId } = span;
  if (!traceId || !spanId) return false;
  if (!TRACE_ID_RE.test(traceId) || !SPAN_ID_RE.test(spanId)) return false;
  return !ALL_ZERO_32.test(traceId) && !ALL_ZERO_16.test(spanId);
}

function collectSpans(req: ExportTraceServiceRequest): {
  collected: CollectedSpan[];
  rejected: number;
} {
  const collected: CollectedSpan[] = [];
  let rejected = 0;

  for (const rs of req.resourceSpans ?? []) {
    const resourceAttributes = decodeAttributes(rs.resource?.attributes);

    for (const ss of rs.scopeSpans ?? []) {
      const scopeName = ss.scope?.name ?? null;

      for (const span of ss.spans ?? []) {
        if (!hasValidIds(span)) {
          rejected += 1;
          continue;
        }
        collected.push({ span, resourceAttributes, scopeName });
      }
    }
  }

  return { collected, rejected };
}

export function ingestExportRequest(req: ExportTraceServiceRequest): IngestResult {
  const { collected, rejected } = collectSpans(req);
  if (collected.length === 0) {
    return { traceIds: [], spanCount: 0, spansRejected: rejected };
  }

  // Within a single batch, later spans win for the same spanId.
  const byTrace = new Map<string, Map<string, CollectedSpan>>();
  for (const c of collected) {
    const traceId = c.span.traceId;
    let perTrace = byTrace.get(traceId);
    if (!perTrace) {
      perTrace = new Map();
      byTrace.set(traceId, perTrace);
    }
    perTrace.set(c.span.spanId, c);
  }

  const traceIds: string[] = [];

  for (const [traceId, spanMap] of byTrace) {
    upsertRawSpans(traceId, [...spanMap.values()] as RawSpanRecord[]);

    // Rebuild from all known spans, not just this batch.
    const all = getRawSpans(traceId);
    const normalized: NormalizedSpan[] = all.map((r) =>
      normalizeSpan(r.span, {
        resourceAttributes: r.resourceAttributes,
        scopeName: r.scopeName,
      }),
    );

    const view = buildTraceView(normalized);
    if (view) {
      insertTrace(view);
      traceIds.push(traceId);
    }
  }

  return { traceIds, spanCount: collected.length, spansRejected: rejected };
}
