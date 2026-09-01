import type { SpanWarning, TokenUsage } from "../genai/normalize";
import type { NormalizedSpan } from "../genai/normalize";
import type { GenAIOperation } from "../genai/semconv";

/**
 * Serializable, client-safe span view.
 *
 * `NormalizedSpan` carries nanosecond timestamps as BigInt (they exceed
 * Number.MAX_SAFE_INTEGER as absolute epoch values). React cannot serialize
 * BigInt across the server/client boundary, so this view converts everything to
 * offsets **relative to the trace start** — small numbers where plain `number`
 * keeps full nanosecond precision.
 */
export interface SpanView {
  traceId: string;
  spanId: string;
  parentSpanId: string | null;
  name: string;
  operation: GenAIOperation | null;
  operationInferred: boolean;
  kind: number;

  /** Nanoseconds from trace start. */
  startOffsetNs: number;
  durationNs: number;
  /** Duration minus time covered by child spans — the "where did it actually go" metric. */
  selfDurationNs: number;

  statusCode: number;
  statusMessage: string | null;
  errorType: string | null;

  provider: string | null;
  model: string | null;
  agentName: string | null;
  toolName: string | null;
  toolCallId: string | null;
  conversationId: string | null;

  usage: TokenUsage;
  /** Prompt / completion content, when the SDK captured it. */
  inputMessages: unknown;
  outputMessages: unknown;
  attributes: Record<string, unknown>;
  events: { name: string; offsetNs: number; attributes: Record<string, unknown> }[];
  warnings: SpanWarning[];

  depth: number;
  childIds: string[];

  /** Aggregated over the whole subtree — lets collapsed rows still show their weight. */
  subtree: {
    spanCount: number;
    totalTokens: number;
    errorCount: number;
    warningCount: number;
    selfDurationNs: number;
  };
}

export interface TraceTotals {
  spanCount: number;
  inputTokens: number;
  outputTokens: number;
  reasoningTokens: number;
  totalTokens: number;
  modelCalls: number;
  toolCalls: number;
  errorCount: number;
  warningCount: number;
}

export interface TraceView {
  traceId: string;
  /** Depth-first order — matches the visual row order of the waterfall. */
  orderedIds: string[];
  byId: Record<string, SpanView>;
  rootIds: string[];
  durationNs: number;
  /** Epoch milliseconds of trace start, for display. */
  startedAtMs: number;
  totals: TraceTotals;
  models: string[];
  agentName: string | null;
  conversationId: string | null;
  /** Set on replay traces — the trace this run was forked from. */
  sourceTraceId?: string;
}

/** Subtract the union of child intervals from the parent duration. */
function computeSelfDuration(
  span: NormalizedSpan,
  children: NormalizedSpan[],
): bigint {
  if (children.length === 0) return span.durationNs;

  const intervals = children
    .map((c) => [c.startTimeNs, c.endTimeNs] as const)
    .filter(([s, e]) => e > s)
    .sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));

  let covered = 0n;
  let curStart: bigint | null = null;
  let curEnd = 0n;

  for (const [s, e] of intervals) {
    if (curStart === null) {
      curStart = s;
      curEnd = e;
      continue;
    }
    if (s <= curEnd) {
      if (e > curEnd) curEnd = e;
    } else {
      covered += curEnd - curStart;
      curStart = s;
      curEnd = e;
    }
  }
  if (curStart !== null) covered += curEnd - curStart;

  const self = span.durationNs - covered;
  return self < 0n ? 0n : self;
}

const toNumberClamped = (v: bigint): number => {
  const n = Number(v);
  return Number.isFinite(n) && n >= 0 ? n : 0;
};

/**
 * Build a serializable trace view from normalized spans.
 *
 * Orphans (spans whose parent is missing from the batch — common when spans
 * arrive in multiple OTLP batches) are promoted to roots rather than dropped,
 * so a partially-collected trace still renders.
 */
export function buildTraceView(spans: NormalizedSpan[]): TraceView | null {
  if (spans.length === 0) return null;

  const bySpanId = new Map<string, NormalizedSpan>();
  for (const s of spans) {
    if (s.spanId) bySpanId.set(s.spanId, s);
  }

  const childrenOf = new Map<string, NormalizedSpan[]>();
  const rootIds: string[] = [];

  for (const s of spans) {
    const parent = s.parentSpanId;
    if (parent && bySpanId.has(parent) && parent !== s.spanId) {
      const list = childrenOf.get(parent);
      if (list) list.push(s);
      else childrenOf.set(parent, [s]);
    } else {
      rootIds.push(s.spanId);
    }
  }

  // Trace start = earliest start across all spans.
  let traceStart = spans[0]!.startTimeNs;
  let traceEnd = spans[0]!.endTimeNs;
  for (const s of spans) {
    if (s.startTimeNs < traceStart) traceStart = s.startTimeNs;
    if (s.endTimeNs > traceEnd) traceEnd = s.endTimeNs;
  }

  const byId: Record<string, SpanView> = {};
  const orderedIds: string[] = [];

  const totals: TraceTotals = {
    spanCount: spans.length,
    inputTokens: 0,
    outputTokens: 0,
    reasoningTokens: 0,
    totalTokens: 0,
    modelCalls: 0,
    toolCalls: 0,
    errorCount: 0,
    warningCount: 0,
  };
  const models = new Set<string>();
  let agentName: string | null = null;
  let conversationId: string | null = null;

  let sourceTraceId: string | null = null;
  for (const s of spans) {
    const attrs = s.attributes ?? {};
    const v = attrs["replay.source_trace_id"] ?? attrs["source_trace_id"];
    if (typeof v === "string" && v) {
      sourceTraceId = v;
      break;
    }
  }

  const visit = (span: NormalizedSpan, depth: number): SpanView => {
    const children = childrenOf.get(span.spanId) ?? [];
    children.sort((a, b) => (a.startTimeNs < b.startTimeNs ? -1 : a.startTimeNs > b.startTimeNs ? 1 : 0));

    const selfDurationNs = computeSelfDuration(span, children);
    const childViews = children.map((c) => visit(c, depth + 1));

    const usage = span.usage;
    const usageTokens = usage.totalTokens ?? 0;

    const subtree = {
      spanCount: 1,
      totalTokens: usageTokens,
      errorCount:
        span.statusCode === 2 || span.errorType !== null ? 1 : 0,
      warningCount: span.warnings.length,
      selfDurationNs: toNumberClamped(selfDurationNs),
    };

    for (const c of childViews) {
      subtree.spanCount += c.subtree.spanCount;
      subtree.totalTokens += c.subtree.totalTokens;
      subtree.errorCount += c.subtree.errorCount;
      subtree.warningCount += c.subtree.warningCount;
      subtree.selfDurationNs += c.subtree.selfDurationNs;
    }

    const view: SpanView = {
      traceId: span.traceId,
      spanId: span.spanId,
      parentSpanId: span.parentSpanId,
      name: span.name,
      operation: span.operation,
      operationInferred: span.operationInferred,
      kind: span.kind,
      startOffsetNs: toNumberClamped(span.startTimeNs - traceStart),
      durationNs: toNumberClamped(span.durationNs),
      selfDurationNs: toNumberClamped(selfDurationNs),
      statusCode: span.statusCode,
      statusMessage: span.statusMessage,
      errorType: span.errorType,
      provider: span.provider,
      model: span.model,
      agentName: span.agentName,
      toolName: span.toolName,
      toolCallId: span.toolCallId,
      conversationId: span.conversationId,
      usage,
      inputMessages: span.inputMessages,
      outputMessages: span.outputMessages,
      attributes: span.attributes,
      events: span.events.map((e) => ({
        name: e.name,
        offsetNs: toNumberClamped(e.timeNs - traceStart),
        attributes: e.attributes,
      })),
      warnings: span.warnings,
      depth,
      childIds: childViews.map((c) => c.spanId),
      subtree,
    };

    byId[view.spanId] = view;
    orderedIds.push(view.spanId);

    // Trace-level rollup
    totals.inputTokens += usage.inputTokens ?? 0;
    totals.outputTokens += usage.outputTokens ?? 0;
    totals.reasoningTokens += usage.reasoningTokens ?? 0;
    totals.totalTokens += usageTokens;
    totals.warningCount += span.warnings.length;
    if (span.statusCode === 2 || span.errorType !== null) totals.errorCount += 1;
    if (span.operation === "chat" || span.operation === "text_completion") totals.modelCalls += 1;
    if (span.operation === "execute_tool") totals.toolCalls += 1;
    if (span.model) models.add(span.model);
    if (!agentName && span.agentName) agentName = span.agentName;
    if (!conversationId && span.conversationId) conversationId = span.conversationId;

    return view;
  };

  const roots = rootIds
    .map((id) => bySpanId.get(id))
    .filter((s): s is NormalizedSpan => s !== undefined)
    .sort((a, b) => (a.startTimeNs < b.startTimeNs ? -1 : a.startTimeNs > b.startTimeNs ? 1 : 0))
    .map((s) => visit(s, 0));

  return {
    traceId: spans[0]!.traceId,
    orderedIds,
    byId,
    rootIds: roots.map((r) => r.spanId),
    durationNs: toNumberClamped(traceEnd - traceStart),
    startedAtMs: Number(traceStart / 1_000_000n),
    totals,
    models: [...models].sort(),
    agentName,
    conversationId,
    sourceTraceId: sourceTraceId ?? undefined,
  };
}
