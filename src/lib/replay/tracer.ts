import { randomBytes } from "node:crypto";
import { ATTR, SpanKind, StatusCode, type GenAIOperation } from "@/lib/genai/semconv";
import { toOtlpAttributes } from "@/lib/otlp/encode";
import type { ExportTraceServiceRequest, OtlpSpan, SpanEvent } from "@/lib/otlp/types";

/**
 * The replay engine reports on itself through the same OTLP endpoint it expects
 * from other agents.
 *
 * Two consequences worth noting:
 *  - A replayed run becomes an ordinary trace, so the existing waterfall,
 *    insights and comparisons all work on it with no special-casing.
 *  - Because ingest upserts by span_id, an early "in progress" span can be
 *    emitted first and re-emitted with final timings later. That is how the UI
 *    shows a replay before it finishes.
 */

export interface SpanSpec {
  spanId?: string;
  parentSpanId?: string | null;
  name: string;
  operation: GenAIOperation;
  kind?: number;
  startNs: bigint;
  endNs: bigint;
  attributes?: Record<string, unknown>;
  status?: { code: number; message?: string };
  events?: SpanEvent[];
}

export class ReplayTracer {
  readonly traceId: string;
  private queue: OtlpSpan[] = [];
  private flushFailures: string[] = [];

  constructor(
    traceId: string,
    private readonly endpoint: string,
    private readonly resourceAttributes: Record<string, unknown>,
  ) {
    this.traceId = traceId;
  }

  newSpanId(): string {
    return randomBytes(8).toString("hex");
  }

  push(spec: SpanSpec): string {
    const spanId = spec.spanId ?? this.newSpanId();
    const span: OtlpSpan = {
      traceId: this.traceId,
      spanId,
      name: spec.name,
      kind: spec.kind ?? SpanKind.INTERNAL,
      startTimeUnixNano: spec.startNs.toString(),
      endTimeUnixNano: spec.endNs.toString(),
      attributes: toOtlpAttributes({
        [ATTR.OPERATION_NAME]: spec.operation,
        ...spec.attributes,
      }),
      status: spec.status ?? { code: StatusCode.OK },
    };

    if (spec.parentSpanId) span.parentSpanId = spec.parentSpanId;
    if (spec.events?.length) span.events = spec.events;

    this.queue.push(span);
    return spanId;
  }

  /** POST queued spans. Ingest is idempotent, so re-sending is safe. */
  async flush(): Promise<void> {
    if (this.queue.length === 0) return;
    const spans = this.queue;
    this.queue = [];

    const payload: ExportTraceServiceRequest = {
      resourceSpans: [
        {
          resource: { attributes: toOtlpAttributes(this.resourceAttributes) },
          scopeSpans: [
            {
              scope: { name: "react-agent-debugger.replay", version: "0.1.0" },
              spans,
            },
          ],
        },
      ],
    };

    try {
      const res = await fetch(this.endpoint, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(payload),
        signal: AbortSignal.timeout(15_000),
      });
      if (!res.ok) {
        this.flushFailures.push(`HTTP ${res.status}: ${(await res.text()).slice(0, 200)}`);
      }
    } catch (err) {
      // Telemetry must never take down the replay it is measuring.
      this.flushFailures.push(err instanceof Error ? err.message : String(err));
    }
  }

  get failures(): readonly string[] {
    return this.flushFailures;
  }
}

export function newTraceId(): string {
  return randomBytes(16).toString("hex");
}
