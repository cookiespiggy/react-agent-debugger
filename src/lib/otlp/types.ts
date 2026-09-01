/**
 * OTLP/HTTP wire types (JSON encoding) — `application/json`.
 *
 * Reference: https://opentelemetry.io/docs/specs/otlp/#json-protobuf-encoding
 *
 * Note the deliberate stringly-typed 64-bit fields (`intValue`, `timeUnixNano`).
 * Nanosecond epoch timestamps are ~1.7e18, far beyond Number.MAX_SAFE_INTEGER
 * (9.007e15). They MUST be carried as strings on the wire and parsed with BigInt
 * here — decoding them as JSON numbers silently corrupts timing, which would
 * wreck the waterfall view.
 */

export type AnyValue =
  | { stringValue: string }
  | { boolValue: boolean }
  | { intValue: string }
  | { doubleValue: number }
  | { arrayValue: { values: AnyValue[] } }
  | { kvlistValue: { values: KeyValue[] } }
  | { bytesValue: string };

export interface KeyValue {
  key: string;
  value: AnyValue;
}

export interface InstrumentationScope {
  name?: string;
  version?: string;
  attributes?: KeyValue[];
  droppedAttributesCount?: number;
}

export interface SpanEvent {
  /** Nanoseconds since epoch, as a string. */
  timeUnixNano: string;
  name: string;
  attributes?: KeyValue[];
  droppedAttributesCount?: number;
}

export interface SpanLink {
  traceId: string;
  spanId: string;
  traceState?: string;
  attributes?: KeyValue[];
  droppedAttributesCount?: number;
}

export interface SpanStatus {
  message?: string;
  code?: number;
}

export interface OtlpSpan {
  traceId: string;
  spanId: string;
  traceState?: string;
  parentSpanId?: string;
  flags?: number;
  name: string;
  kind?: number;
  /** Nanoseconds since epoch, as a string. */
  startTimeUnixNano: string;
  endTimeUnixNano: string;
  attributes?: KeyValue[];
  droppedAttributesCount?: number;
  events?: SpanEvent[];
  droppedEventsCount?: number;
  links?: SpanLink[];
  droppedLinksCount?: number;
  status?: SpanStatus;
}

export interface ScopeSpans {
  scope?: InstrumentationScope;
  spans: OtlpSpan[];
  schemaUrl?: string;
}

export interface ResourceSpans {
  resource?: {
    attributes?: KeyValue[];
    droppedAttributesCount?: number;
  };
  scopeSpans: ScopeSpans[];
  schemaUrl?: string;
}

export interface ExportTraceServiceRequest {
  resourceSpans?: ResourceSpans[];
}
