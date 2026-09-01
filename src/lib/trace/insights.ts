import { isReasoningModel } from "../genai/normalize";
import { formatDuration, formatNumber, formatTokens } from "../format";
import type { SpanView, TraceView } from "./tree";

/**
 * Automatic trace diagnosis.
 *
 * Dashboards show you a waterfall and leave the interpretation to you. These
 * detectors encode the failure modes that account for most agent incidents, so
 * the debugger can name the problem and jump straight to the spans involved.
 */

export type InsightSeverity = "critical" | "warning" | "info";

export interface Insight {
  id: string;
  severity: InsightSeverity;
  title: string;
  detail: string;
  /** Spans to highlight — clicking an insight selects the first one. */
  spanIds: string[];
}

const isFailed = (s: SpanView): boolean =>
  s.statusCode === 2 || s.errorType !== null;

function ordered(trace: TraceView): SpanView[] {
  return trace.orderedIds
    .map((id) => trace.byId[id])
    .filter((s): s is SpanView => s !== undefined);
}

/** Longest run of consecutive failing calls to the same tool. */
function detectRetryStorm(spans: SpanView[]): Insight | null {
  const tools = spans.filter((s) => s.operation === "execute_tool");
  if (tools.length < 3) return null;

  const byTool = new Map<string, SpanView[]>();
  for (const s of tools) {
    const key = s.toolName ?? "unknown";
    const list = byTool.get(key);
    if (list) list.push(s);
    else byTool.set(key, [s]);
  }

  let best: { tool: string; run: SpanView[] } | null = null;

  for (const [tool, list] of byTool) {
    list.sort((a, b) => a.startOffsetNs - b.startOffsetNs);
    let current: SpanView[] = [];
    for (const s of list) {
      if (isFailed(s)) {
        current.push(s);
        if (!best || current.length > best.run.length) {
          best = { tool, run: [...current] };
        }
      } else {
        current = [];
      }
    }
  }

  if (!best || best.run.length < 3) return null;

  const wasted = best.run.reduce((sum, s) => sum + s.durationNs, 0);
  const errors = new Set(best.run.map((s) => s.errorType).filter(Boolean));

  return {
    id: "retry-storm",
    severity: "critical",
    title: `Retried "${best.tool}" ${best.run.length}× in a row`,
    detail:
      `Every attempt failed${errors.size ? ` (${[...errors].join(", ")})` : ""}, ` +
      `burning ${formatDuration(wasted)} with no change in strategy. ` +
      `The agent needs a different fallback, not another retry.`,
    spanIds: best.run.map((s) => s.spanId),
  };
}

/** Detect a repeating signature in the ordered span sequence — a stuck loop. */
function detectLoop(trace: TraceView): Insight | null {
  const seq = ordered(trace).filter((s) => s.depth > 0);
  if (seq.length < 6) return null;

  const signature = (s: SpanView): string =>
    `${s.operation ?? "?"}:${s.toolName ?? s.model ?? ""}`;

  // Find the longest run of consecutive identical signatures.
  let best = { sig: "", count: 0, start: 0 };
  let current = { sig: signature(seq[0]!), count: 1, start: 0 };

  for (let i = 1; i < seq.length; i++) {
    const sig = signature(seq[i]!);
    if (sig === current.sig) {
      current.count += 1;
    } else {
      if (current.count > best.count) best = current;
      current = { sig, count: 1, start: i };
    }
  }
  if (current.count > best.count) best = current;

  if (best.count < 4) return null;

  const involved = seq.slice(best.start, best.start + best.count);
  return {
    id: "loop",
    severity: "warning",
    title: `Repeating pattern detected (${best.count}×)`,
    detail:
      `"${best.sig}" repeats consecutively ${best.count} times. ` +
      `Usually a sign the agent is not incorporating the observation into its next decision.`,
    spanIds: involved.map((s) => s.spanId),
  };
}

/** Input context growing across turns — the classic silent cost multiplier. */
function detectContextGrowth(spans: SpanView[]): Insight | null {
  const calls = spans
    .filter(
      (s) =>
        (s.operation === "chat" || s.operation === "text_completion") &&
        s.usage.inputTokens !== null,
    )
    .sort((a, b) => a.startOffsetNs - b.startOffsetNs);

  if (calls.length < 3) return null;

  const first = calls[0]!.usage.inputTokens!;
  const last = calls[calls.length - 1]!.usage.inputTokens!;
  if (first <= 0) return null;

  const growth = last / first;
  if (growth < 4) return null;

  return {
    id: "context-growth",
    severity: "warning",
    title: `Input context grew ${growth.toFixed(1)}× across the run`,
    detail:
      `From ${formatNumber(first)} to ${formatNumber(last)} input tokens over ` +
      `${calls.length} model calls. Each turn re-sends the full history, so cost ` +
      `grows quadratically. Consider summarising or trimming earlier turns.`,
    spanIds: calls.map((s) => s.spanId),
  };
}

/** A single call dominating token spend. */
function detectTokenHotspot(trace: TraceView, spans: SpanView[]): Insight | null {
  if (trace.totals.totalTokens <= 0) return null;

  let top: SpanView | null = null;
  for (const s of spans) {
    const t = s.usage.totalTokens ?? 0;
    if (t > 0 && (!top || t > (top.usage.totalTokens ?? 0))) top = s;
  }
  if (!top) return null;

  const share = (top.usage.totalTokens ?? 0) / trace.totals.totalTokens;
  if (share < 0.5) return null;

  return {
    id: "token-hotspot",
    severity: "info",
    title: `One call is ${Math.round(share * 100)}% of all tokens`,
    detail:
      `"${top.name}" consumed ${formatTokens(top.usage.totalTokens)} of ` +
      `${formatTokens(trace.totals.totalTokens)} total. Optimising this single call ` +
      `matters more than the rest combined.`,
    spanIds: [top.spanId],
  };
}

/** Reasoning models that report no reasoning tokens: cost is understated. */
function detectReasoningGap(spans: SpanView[]): Insight | null {
  const gaps = spans.filter(
    (s) =>
      (s.operation === "chat" || s.operation === "text_completion") &&
      isReasoningModel(s.model, s.attributes) &&
      s.usage.reasoningTokens === null &&
      s.usage.totalTokens !== null &&
      s.usage.totalTokens > 0,
  );

  if (gaps.length === 0) return null;

  const reported = gaps.reduce((sum, s) => sum + (s.usage.totalTokens ?? 0), 0);

  return {
    id: "reasoning-gap",
    severity: "warning",
    title: "Reasoning tokens missing on a reasoning model",
    detail:
      `${gaps.length} call(s) to ${gaps[0]!.model} report ` +
      `${formatTokens(reported)} tokens without ` +
      `\`gen_ai.usage.reasoning.output_tokens\`. On extended-thinking models the ` +
      `hidden reasoning trace typically dwarfs visible output — real spend is very ` +
      `likely several times higher than shown.`,
    spanIds: gaps.map((s) => s.spanId),
  };
}

/** Where wall-clock time actually goes, excluding child spans. */
function detectLatencyHotspot(trace: TraceView, spans: SpanView[]): Insight | null {
  if (trace.durationNs <= 0 || spans.length === 0) return null;

  let top: SpanView | null = null;
  for (const s of spans) {
    if (!top || s.selfDurationNs > top.selfDurationNs) top = s;
  }
  if (!top || top.selfDurationNs <= 0) return null;

  const share = top.selfDurationNs / trace.durationNs;
  if (share < 0.4) return null;

  return {
    id: "latency-hotspot",
    severity: "info",
    title: `${Math.round(share * 100)}% of the run is one span's own work`,
    detail:
      `"${top.name}" spends ${formatDuration(top.selfDurationNs)} in itself, ` +
      `not waiting on children. This is the place to optimise first.`,
    spanIds: [top.spanId],
  };
}

/** One failure followed by more failures — the blast radius. */
function detectErrorCascade(trace: TraceView): Insight | null {
  const byTime = ordered(trace).sort((a, b) => a.startOffsetNs - b.startOffsetNs);
  const failed = byTime.filter(isFailed);
  if (failed.length < 2) return null;

  // A failed span whose subtree also contains a failure is a symptom, not a
  // cause: the root span failed *because* a child did. Root-cause candidates
  // are therefore the failed spans with no failed descendant — the most
  // specific points of failure. Take the earliest of those.
  // subtree.errorCount covers the span plus every descendant. A value of 1
  // means nothing *beneath* this span also failed, i.e. this is the most
  // specific point of failure. Checking direct children only is not enough:
  // the root span often has a healthy child with a failing grandchild.
  const isCause = (s: SpanView): boolean => s.subtree.errorCount <= 1;

  const firstFailed = (failed.find(isCause) ?? failed[0])!;
  const after = failed.filter((s) => s.spanId !== firstFailed.spanId);
  if (after.length < 1) return null;

  const downstreamTools = after.filter((s) => s.operation === "execute_tool").length;

  return {
    id: "error-cascade",
    severity: "critical",
    title: `Failure at "${firstFailed.name}" cascaded to ${after.length} more span(s)`,
    detail:
      `The first failure is "${firstFailed.errorType ?? `status ${firstFailed.statusCode}`}"` +
      `${firstFailed.statusMessage ? ` — ${firstFailed.statusMessage}` : ""}. ` +
      `${downstreamTools} subsequent tool call(s) also failed. Fix the first failure; ` +
      `the rest are symptoms.`,
    spanIds: [firstFailed.spanId, ...after.map((s) => s.spanId)],
  };
}

/** Data-quality warnings indicate the instrumentation itself is untrustworthy. */
function detectInstrumentationIssues(spans: SpanView[]): Insight | null {
  const withWarnings = spans.filter(
    (s) => s.warnings.some((w) => w.code === "DEPRECATED_ATTR" || w.code === "TOKEN_ATTR_CONFLICT"),
  );
  if (withWarnings.length === 0) return null;

  const conflicts = spans.filter((s) =>
    s.warnings.some((w) => w.code === "TOKEN_ATTR_CONFLICT"),
  );

  return {
    id: "instrumentation",
    severity: conflicts.length > 0 ? "critical" : "warning",
    title: `${withWarnings.length} span(s) use outdated or conflicting attributes`,
    detail:
      conflicts.length > 0
        ? `Both generations of token attributes are set on ${conflicts.length} span(s). ` +
          `Any backend that sums instead of coalescing will double-count usage.`
        : `Deprecated \`gen_ai.*\` attribute names detected. Values shown here were ` +
          `coalesced to the current names, but upgrade the SDK to keep downstream ` +
          `tooling accurate.`,
    spanIds: withWarnings.map((s) => s.spanId),
  };
}

const SEVERITY_RANK: Record<InsightSeverity, number> = {
  critical: 0,
  warning: 1,
  info: 2,
};

export function analyzeTrace(trace: TraceView): Insight[] {
  const spans = ordered(trace);

  const candidates: (Insight | null)[] = [
    detectErrorCascade(trace),
    detectRetryStorm(spans),
    detectReasoningGap(spans),
    detectLoop(trace),
    detectContextGrowth(spans),
    detectInstrumentationIssues(spans),
    detectTokenHotspot(trace, spans),
    detectLatencyHotspot(trace, spans),
  ];

  return candidates
    .filter((i): i is Insight => i !== null)
    .sort((a, b) => SEVERITY_RANK[a.severity] - SEVERITY_RANK[b.severity]);
}
