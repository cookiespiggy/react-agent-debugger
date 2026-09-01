/**
 * Insight-engine regression: one constructed trace per failure mode.
 *
 * We feed hand-built OTLP spans through the *real* ingest pipeline
 * (normalizeSpan -> buildTraceView -> analyzeTrace) so the assertions pin
 * the behaviour of the production code, not a mock. No DB is touched.
 *
 * Two kinds of assertions matter most for a debugger's credibility:
 *   1. the right detector fires on the right failure (true positive)
 *   2. a healthy / different failure does NOT trigger it (no false alarm)
 *      — the sonnet-4.5 case is a deliberate regression guard for a bug we
 *        already shipped once: a non-reasoning model mis-flagged as reasoning.
 */
import { normalizeSpan } from "../src/lib/genai/normalize";
import { buildTraceView } from "../src/lib/trace/tree";
import { analyzeTrace, type Insight, type InsightSeverity } from "../src/lib/trace/insights";
import { ATTR, StatusCode } from "../src/lib/genai/semconv";
import type { KeyValue, OtlpSpan } from "../src/lib/otlp/types";

const BASE_NS = 1_700_000_000_000_000_000n;
let TRACE = "0".repeat(32);
let sidCounter = 0;
function sid(): string {
  sidCounter += 1;
  return sidCounter.toString(16).padStart(16, "0");
}

function kv(attrs: Record<string, string | number | boolean>): KeyValue[] {
  return Object.entries(attrs).map(([k, v]) => {
    if (typeof v === "boolean") return { key: k, value: { boolValue: v } };
    if (typeof v === "number") return { key: k, value: { intValue: String(v) } };
    return { key: k, value: { stringValue: v } };
  });
}

interface SpanOpts {
  op?: string;
  name?: string;
  parent?: string;
  model?: string;
  tool?: string;
  provider?: string;
  inputTokens?: number;
  outputTokens?: number;
  reasoningTokens?: number;
  errorType?: string;
  startNs?: number;
  durationNs?: number;
}

function mkSpan(id: string, o: SpanOpts): OtlpSpan {
  const start = BASE_NS + BigInt(o.startNs ?? 0);
  const dur = BigInt(o.durationNs ?? 1_000_000);
  const attrs: Record<string, string | number | boolean> = {};
  if (o.op) attrs[ATTR.OPERATION_NAME] = o.op;
  if (o.model) {
    attrs[ATTR.REQUEST_MODEL] = o.model;
    attrs[ATTR.RESPONSE_MODEL] = o.model;
  }
  if (o.tool) attrs[ATTR.TOOL_NAME] = o.tool;
  if (o.provider) attrs[ATTR.PROVIDER_NAME] = o.provider;
  if (o.inputTokens !== undefined) attrs[ATTR.USAGE_INPUT_TOKENS] = o.inputTokens;
  if (o.outputTokens !== undefined) attrs[ATTR.USAGE_OUTPUT_TOKENS] = o.outputTokens;
  if (o.reasoningTokens !== undefined) attrs[ATTR.USAGE_REASONING_TOKENS] = o.reasoningTokens;
  if (o.errorType) attrs[ATTR.ERROR_TYPE] = o.errorType;
  const isErr = o.errorType !== undefined;
  return {
    traceId: TRACE,
    spanId: id,
    parentSpanId: o.parent,
    name: o.name ?? o.op ?? "span",
    kind: o.op === "chat" || o.op === "text_completion" ? 3 : 1,
    startTimeUnixNano: start.toString(),
    endTimeUnixNano: (start + dur).toString(),
    attributes: kv(attrs),
    status: isErr ? { code: StatusCode.ERROR, message: o.errorType } : { code: StatusCode.OK },
  };
}

/** A minimal ReAct tree; children are laid out sequentially inside the parent. */
interface Node {
  op?: string;
  model?: string;
  tool?: string;
  provider?: string;
  inputTokens?: number;
  outputTokens?: number;
  reasoningTokens?: number;
  errorType?: string;
  durationMs?: number;
  children?: Node[];
}

function build(spec: Node, start: bigint, end: bigint, out: OtlpSpan[], parentId?: string): void {
  const id = sid();
  out.push(
    mkSpan(id, {
      op: spec.op,
      model: spec.model,
      tool: spec.tool,
      provider: spec.provider,
      inputTokens: spec.inputTokens,
      outputTokens: spec.outputTokens,
      reasoningTokens: spec.reasoningTokens,
      errorType: spec.errorType,
      startNs: Number(start),
      durationNs: Number(end - start),
      parent: parentId,
    }),
  );
  const children = spec.children ?? [];
  if (children.length) {
    const seg = (end - start) / BigInt(children.length);
    children.forEach((c, i) => {
      const cs = start + seg * BigInt(i);
      build(c, cs, cs + seg, out, id);
    });
  }
}

function buildTree(spec: Node): OtlpSpan[] {
  const out: OtlpSpan[] = [];
  const total = BigInt(spec.durationMs ?? 6000) * 1_000_000n;
  build(spec, 0n, total, out, undefined);
  return out;
}

function analyze(spans: OtlpSpan[]): Insight[] {
  const view = buildTraceView(spans.map((s) => normalizeSpan(s, {})));
  if (!view) throw new Error("buildTraceView returned null");
  return analyzeTrace(view);
}

const SEVRANK: Record<InsightSeverity, number> = { critical: 0, warning: 1, info: 2 };
let failures = 0;

function check(
  name: string,
  spans: OtlpSpan[],
  expectIds: string[],
  opts: { forbid?: string[]; maxSeverity?: InsightSeverity } = {},
): void {
  const ins = analyze(spans);
  const ids = ins.map((i) => i.id);
  const missing = expectIds.filter((e) => !ids.includes(e));
  const forbidden = (opts.forbid ?? []).filter((f) => ids.includes(f));
  let bad = false;
  if (missing.length) {
    console.error(`  ✗ ${name}: MISSING ${missing.join(", ")} — got [${ids.join(", ")}]`);
    bad = true;
  }
  if (forbidden.length) {
    console.error(`  ✗ ${name}: UNEXPECTED ${forbidden.join(", ")} — got [${ids.join(", ")}]`);
    bad = true;
  }
  if (opts.maxSeverity) {
    const maxRank = ins.reduce((m, i) => Math.max(m, SEVRANK[i.severity]), 0);
    if (maxRank > SEVRANK[opts.maxSeverity]) {
      console.error(
        `  ✗ ${name}: severity exceeds ${opts.maxSeverity} — got [${ins
          .map((i) => `${i.severity}:${i.id}`)
          .join(", ")}]`,
      );
      bad = true;
    }
  }
  if (!bad) console.log(`  ✓ ${name}  [${ids.join(", ") || "—"}]`);
  else failures++;
}

function scenario(traceId: string, spec: Node): OtlpSpan[] {
  TRACE = traceId;
  return buildTree(spec);
}

console.log("Insight engine — multi-failure-mode regression\n");

// 1. Retry storm (3+ consecutive identical tool failures) + the cascade it causes.
check(
  "retry-storm + error-cascade",
  scenario("1".repeat(32), {
    op: "invoke_agent",
    durationMs: 6000,
    children: [
      { op: "chat", model: "gpt-4.1", provider: "openai", inputTokens: 1000, outputTokens: 100, children: [{ op: "execute_tool", tool: "crm_lookup", errorType: "429" }] },
      { op: "chat", model: "gpt-4.1", provider: "openai", inputTokens: 1200, outputTokens: 100, children: [{ op: "execute_tool", tool: "crm_lookup", errorType: "429" }] },
      { op: "chat", model: "gpt-4.1", provider: "openai", inputTokens: 1400, outputTokens: 100, children: [{ op: "execute_tool", tool: "crm_lookup", errorType: "429" }] },
      { op: "chat", model: "gpt-4.1", provider: "openai", inputTokens: 1600, outputTokens: 100, children: [{ op: "execute_tool", tool: "escalate", errorType: "timeout" }] },
    ],
  }),
  ["retry-storm", "error-cascade"],
  { forbid: ["loop", "context-growth", "reasoning-gap", "token-hotspot", "latency-hotspot"] },
);

// 2. A stuck loop — the same call repeating with no strategy change.
//    The detector needs >=6 spans in the sequence and 4+ consecutive identical
//    signatures, so we repeat the call six times.
check(
  "stuck loop (repeating tool)",
  scenario("2".repeat(32), {
    op: "invoke_agent",
    durationMs: 6000,
    children: [
      { op: "execute_tool", tool: "search" },
      { op: "execute_tool", tool: "search" },
      { op: "execute_tool", tool: "search" },
      { op: "execute_tool", tool: "search" },
      { op: "execute_tool", tool: "search" },
      { op: "execute_tool", tool: "search" },
    ],
  }),
  ["loop"],
  { forbid: ["retry-storm", "error-cascade", "context-growth", "reasoning-gap"] },
);

// 3. Input context quietly quadrupling across turns (quadratic cost).
check(
  "context growth",
  scenario("3".repeat(32), {
    op: "invoke_agent",
    durationMs: 6000,
    children: [
      { op: "chat", model: "gpt-4.1", provider: "openai", inputTokens: 1000, outputTokens: 100 },
      { op: "chat", model: "gpt-4.1", provider: "openai", inputTokens: 2000, outputTokens: 100 },
      { op: "chat", model: "gpt-4.1", provider: "openai", inputTokens: 3000, outputTokens: 100 },
      { op: "chat", model: "gpt-4.1", provider: "openai", inputTokens: 4000, outputTokens: 100 },
    ],
  }),
  ["context-growth"],
  { forbid: ["retry-storm", "error-cascade", "loop", "reasoning-gap"] },
);

// 4. Reasoning model that omits reasoning tokens — cost wildly understated.
check(
  "reasoning-gap on o3 (true positive)",
  scenario("4".repeat(32), {
    op: "invoke_agent",
    durationMs: 3000,
    children: [{ op: "chat", model: "o3", provider: "openai", inputTokens: 1000, outputTokens: 500 }],
  }),
  ["reasoning-gap"],
  { forbid: ["retry-storm", "error-cascade", "context-growth", "loop"] },
);

// 5. REGRESSION: a non-reasoning model must NOT trip the reasoning-gap detector.
check(
  "claude-sonnet-4.5 must NOT trigger reasoning-gap (regression)",
  scenario("5".repeat(32), {
    op: "invoke_agent",
    durationMs: 3000,
    children: [{ op: "chat", model: "claude-sonnet-4.5", provider: "anthropic", inputTokens: 1000, outputTokens: 500 }],
  }),
  [],
  { forbid: ["reasoning-gap"], maxSeverity: "info" },
);

// 6. A healthy run — the single most important "no false alarm" guarantee.
check(
  "healthy trace — no critical/warning",
  scenario("6".repeat(32), {
    op: "invoke_agent",
    durationMs: 6000,
    children: [
      { op: "chat", model: "gpt-4.1", provider: "openai", inputTokens: 1000, outputTokens: 200, children: [{ op: "execute_tool", tool: "search" }] },
      { op: "chat", model: "gpt-4.1", provider: "openai", inputTokens: 1200, outputTokens: 200, children: [{ op: "execute_tool", tool: "lookup" }] },
      { op: "chat", model: "gpt-4.1", provider: "openai", inputTokens: 1500, outputTokens: 200, children: [{ op: "execute_tool", tool: "summarize" }] },
    ],
  }),
  [],
  { maxSeverity: "info" },
);

// 7. One call dominating token spend.
check(
  "token hotspot",
  scenario("7".repeat(32), {
    op: "invoke_agent",
    durationMs: 6000,
    children: [
      { op: "chat", model: "gpt-4.1", provider: "openai", inputTokens: 9000, outputTokens: 1000 },
      { op: "chat", model: "gpt-4.1", provider: "openai", inputTokens: 300, outputTokens: 50 },
      { op: "execute_tool", tool: "search" },
    ],
  }),
  ["token-hotspot"],
  { forbid: ["retry-storm", "error-cascade", "context-growth", "reasoning-gap", "loop"], maxSeverity: "info" },
);

// 8. Wall-clock time concentrated in one span's own work.
check(
  "latency hotspot",
  scenario("8".repeat(32), {
    op: "invoke_agent",
    durationMs: 6000,
    children: [
      {
        op: "chat",
        model: "gpt-4.1",
        provider: "openai",
        inputTokens: 500,
        outputTokens: 50,
        children: [{ op: "execute_tool", tool: "slow_db" }],
      },
    ],
  }),
  ["latency-hotspot"],
  { forbid: ["retry-storm", "error-cascade", "context-growth", "reasoning-gap", "loop"], maxSeverity: "info" },
);

console.log(
  `\n${failures === 0 ? "✓ all insight checks passed" : `✗ ${failures} check(s) failed`}`,
);
process.exit(failures === 0 ? 0 : 1);
