import { getTrace, listTraces } from "../src/lib/db";
import type { ReplayResult } from "../src/lib/replay/types";

const BASE = "http://localhost:3000/api/fork";

const target = listTraces({ limit: 50 }).find((t) => t.agentName === "support-agent");
if (!target) throw new Error("no support-agent trace");

const trace = getTrace(target.traceId)!;
const spans = trace.orderedIds
  .map((id) => trace.byId[id]!)
  .sort((a, b) => a.startOffsetNs - b.startOffsetNs);

// Fork after the first model decision (before any failure has accumulated),
// so the replay can either reproduce the storm or, with an override, avoid it.
const forkSpan = spans[2]!;
console.log(`source trace : ${trace.traceId}`);
console.log(`fork after   : ${forkSpan.name} (${forkSpan.spanId})\n`);

async function replay(
  label: string,
  overrides: Record<string, unknown>,
): Promise<ReplayResult> {
  const res = await fetch(BASE, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      traceId: trace.traceId,
      forkSpanId: forkSpan.spanId,
      maxSteps: 6,
      overrides,
    }),
  });
  const body = await res.json();
  if (!res.ok) throw new Error(`${label}: ${JSON.stringify(body)}`);

  const result = body as ReplayResult;
  console.log(`--- ${label}`);
  console.log(`    traceId   : ${result.traceId}`);
  console.log(`    stopped   : ${result.stoppedReason}`);
  console.log(`    steps     : ${result.steps.length}`);
  console.log(`    tool calls: ${result.totals.toolCalls}`);
  console.log(
    `    tokens    : in=${result.totals.inputTokens} out=${result.totals.outputTokens} reasoning=${result.totals.reasoningTokens}`,
  );
  console.log(`    final     : ${(result.finalAnswer ?? "").slice(0, 90)}`);
  if (result.error) console.log(`    error     : ${result.error}`);
  console.log();
  return result;
}

async function main() {
// 1. Deterministic: tools return exactly what was recorded (429 failures).
//    The replay should reproduce the retry loop.
const baseline = await replay("A · deterministic (no overrides)", {});

// 2. Counterfactual: make crm_lookup succeed.
const fixed = await replay("B · counterfactual (crm_lookup succeeds)", {
  toolOutputs: { crm_lookup: "Account #8821 — active, plan=enterprise" },
});

console.log("=== outcome");
console.log(`  steps      ${baseline.steps.length} -> ${fixed.steps.length}`);
console.log(
  `  tool calls ${baseline.totals.toolCalls} -> ${fixed.totals.toolCalls}`,
);
console.log(
  `  tokens     ${baseline.totals.inputTokens} -> ${fixed.totals.inputTokens}`,
);
console.log(
  `  retry loop reproduced: ${baseline.totals.toolCalls > 1 ? "yes" : "NO"}`,
);
console.log(
  `  counterfactual helped: ${fixed.steps.length < baseline.steps.length ? "yes" : "NO"}`,
);
console.log(
  `\n  compare: http://localhost:3000/compare?a=${trace.traceId}&b=${fixed.traceId}`,
);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
