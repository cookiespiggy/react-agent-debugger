/**
 * Mock ReAct agent — emits real OTLP payloads at the local collector.
 *
 * Purpose: exercising the debugger end-to-end without a live agent, using
 * traces that reproduce the failure modes a debugger is actually for:
 *
 *   happy-path       clean 3-step ReAct loop (the baseline to compare against)
 *   retry-loop       tool 429s four times; the agent burns budget in a loop
 *   legacy-sdk       pre-v1.37 attribute names, incl. a token double-count trap
 *   reasoning-model  o4-mini omitting reasoning tokens (cost understated 5-20x)
 *   context-bloat    input tokens double every turn — the silent cost killer
 *   error-cascade    one tool failure poisons every downstream step
 *
 * Usage:
 *   npm run mock -- --url=http://localhost:3000
 *   npm run mock -- --scenario=retry-loop --count=3
 */

import { randomBytes } from "node:crypto";
import { ATTR, SpanKind, StatusCode, type GenAIOperation } from "../src/lib/genai/semconv";
import type {
  ExportTraceServiceRequest,
  KeyValue,
  OtlpSpan,
  SpanEvent,
} from "../src/lib/otlp/types";

const NS_PER_MS = 1_000_000n;

const hex = (bytes: number): string => randomBytes(bytes).toString("hex");

const ns = (ms: number): bigint => BigInt(Math.max(0, Math.round(ms * 1e6)));

/** Thrown-together deterministic jitter so repeated runs are not identical. */
const jitter = (base: number, pct = 0.15): number =>
  base * (1 + (Math.random() * 2 - 1) * pct);

// ---------------------------------------------------------------------------
// Span tree construction
// ---------------------------------------------------------------------------

interface SpanSpec {
  name: string;
  operation: GenAIOperation;
  kind?: number;
  /** Milliseconds. */
  duration: number;
  /** Milliseconds between the previous sibling's end and this span's start. */
  gap?: number;
  attributes?: Record<string, unknown>;
  events?: SpanEvent[];
  status?: { code: number; message?: string };
  children?: SpanSpec[];
}

interface BuiltSpan {
  span: OtlpSpan;
}

class TraceBuilder {
  private readonly spans: BuiltSpan[] = [];

  constructor(
    private readonly traceId: string,
    private readonly baseNs: bigint,
    private readonly resourceAttributes: Record<string, unknown>,
    private readonly scopeName: string,
  ) {}

  /**
   * Lay out a span tree onto a timeline.
   *
   * Siblings run sequentially (a ReAct loop is sequential), each child nested
   * inside its parent's window. `gap` models queueing/network waits between
   * steps, which is exactly what the waterfall should make visible.
   */
  private emit(
    spec: SpanSpec,
    parentSpanId: string | null,
    startOffsetNs: bigint,
  ): bigint {
    const spanId = hex(8);
    const startNs = this.baseNs + startOffsetNs;
    const durationNs = ns(jitter(spec.duration));
    const endNs = startNs + durationNs;

    const span: OtlpSpan = {
      traceId: this.traceId,
      spanId,
      name: spec.name,
      kind: spec.kind ?? SpanKind.INTERNAL,
      startTimeUnixNano: startNs.toString(),
      endTimeUnixNano: endNs.toString(),
      attributes: toOtlpAttributes({
        [ATTR.OPERATION_NAME]: spec.operation,
        ...spec.attributes,
      }),
      status: spec.status ?? { code: StatusCode.OK },
    };

    if (parentSpanId) span.parentSpanId = parentSpanId;
    if (spec.events?.length) span.events = spec.events;

    this.spans.push({ span });

    let childOffset = startOffsetNs;
    for (const child of spec.children ?? []) {
      childOffset += ns(child.gap ?? 0);
      const consumed = this.emit(child, spanId, childOffset);
      childOffset = consumed;
    }

    // Next sibling starts after this span's own duration, not after its children.
    return startOffsetNs + durationNs;
  }

  build(roots: SpanSpec[]): ExportTraceServiceRequest {
    let cursor = 0n;
    for (const root of roots) {
      cursor += ns(root.gap ?? 0);
      cursor = this.emit(root, null, cursor);
    }

    return {
      resourceSpans: [
        {
          resource: { attributes: toOtlpAttributes(this.resourceAttributes) },
          scopeSpans: [
            {
              scope: { name: this.scopeName, version: "0.1.0" },
              spans: this.spans.map((s) => s.span),
            },
          ],
        },
      ],
    };
  }
}

function toOtlpAttributes(attrs: Record<string, unknown>): KeyValue[] {
  const out: KeyValue[] = [];
  for (const [key, value] of Object.entries(attrs)) {
    if (value === undefined || value === null) continue;
    if (typeof value === "string") out.push({ key, value: { stringValue: value } });
    else if (typeof value === "boolean") out.push({ key, value: { boolValue: value } });
    else if (typeof value === "number" && Number.isInteger(value))
      out.push({ key, value: { intValue: String(value) } });
    else if (typeof value === "number") out.push({ key, value: { doubleValue: value } });
    else out.push({ key, value: { stringValue: JSON.stringify(value) } });
  }
  return out;
}

/** Message content carried as span events (EVENT_ONLY capture mode). */
function messageEvents(
  startNs: bigint,
  messages: { role: "system" | "user" | "assistant" | "tool"; content: string }[],
): SpanEvent[] {
  const nameFor = {
    system: "gen_ai.system.message",
    user: "gen_ai.user.message",
    assistant: "gen_ai.assistant.message",
    tool: "gen_ai.tool.message",
  } as const;

  return messages.map((m, i) => ({
    timeUnixNano: (startNs + ns(i)).toString(),
    name: nameFor[m.role],
    attributes: toOtlpAttributes({ role: m.role, content: m.content }),
  }));
}

// ---------------------------------------------------------------------------
// Scenarios
// ---------------------------------------------------------------------------

type ScenarioName =
  | "happy-path"
  | "retry-loop"
  | "legacy-sdk"
  | "reasoning-model"
  | "context-bloat"
  | "error-cascade";

const ALL_SCENARIOS: ScenarioName[] = [
  "happy-path",
  "retry-loop",
  "legacy-sdk",
  "reasoning-model",
  "context-bloat",
  "error-cascade",
];

interface ScenarioContext {
  traceId: string;
  baseNs: bigint;
  conversationId: string;
}

type ScenarioBuilder = (ctx: ScenarioContext) => {
  roots: SpanSpec[];
  resourceAttributes: Record<string, unknown>;
  scopeName: string;
};

const BASE_RESOURCE = {
  "service.name": "react-agent-debugger-mock",
  "service.version": "0.1.0",
  "telemetry.sdk.language": "nodejs",
  "telemetry.sdk.name": "opentelemetry",
};

const SYSTEM_PROMPT =
  "You are a research assistant. Answer the user's question using the available tools. " +
  "Think step by step. Call at most one tool per turn.";

/** Model span for one ReAct turn. */
function chatSpec(opts: {
  model: string;
  provider: string;
  inputTokens: number;
  outputTokens: number;
  reasoningTokens?: number;
  duration: number;
  thought: string;
  baseNs: bigint;
  extraAttributes?: Record<string, unknown>;
  status?: { code: number; message?: string };
}): SpanSpec {
  return {
    name: `chat ${opts.model}`,
    operation: "chat",
    kind: SpanKind.CLIENT,
    duration: opts.duration,
    attributes: {
      [ATTR.PROVIDER_NAME]: opts.provider,
      [ATTR.REQUEST_MODEL]: opts.model,
      [ATTR.RESPONSE_MODEL]: opts.model,
      [ATTR.USAGE_INPUT_TOKENS]: opts.inputTokens,
      [ATTR.USAGE_OUTPUT_TOKENS]: opts.outputTokens,
      ...(opts.reasoningTokens !== undefined
        ? { [ATTR.USAGE_REASONING_TOKENS]: opts.reasoningTokens }
        : {}),
      ...opts.extraAttributes,
    },
    events: messageEvents(opts.baseNs, [
      { role: "system", content: SYSTEM_PROMPT },
      { role: "user", content: "Compare the latency of vector DBs for RAG workloads." },
      { role: "assistant", content: opts.thought },
    ]),
    ...(opts.status ? { status: opts.status } : {}),
  };
}

function toolSpec(opts: {
  toolName: string;
  duration: number;
  callId: string;
  provider?: string;
  status?: { code: number; message?: string };
  errorType?: string;
  output?: string;
}): SpanSpec {
  return {
    name: `execute_tool ${opts.toolName}`,
    operation: "execute_tool",
    kind: SpanKind.INTERNAL,
    duration: opts.duration,
    attributes: {
      [ATTR.TOOL_NAME]: opts.toolName,
      [ATTR.TOOL_CALL_ID]: opts.callId,
      ...(opts.provider ? { [ATTR.PROVIDER_NAME]: opts.provider } : {}),
      ...(opts.errorType ? { [ATTR.ERROR_TYPE]: opts.errorType } : {}),
      ...(opts.output ? { "tool.output": opts.output } : {}),
    },
    ...(opts.status ? { status: opts.status } : {}),
  };
}

const scenarios: Record<ScenarioName, ScenarioBuilder> = {
  // ---------------------------------------------------------------- baseline
  "happy-path": ({ traceId, baseNs, conversationId }) => ({
    scopeName: "mock.react-agent",
    resourceAttributes: { ...BASE_RESOURCE, "service.name": "research-assistant" },
    roots: [
      {
        name: "invoke_agent research-assistant",
        operation: "invoke_agent",
        kind: SpanKind.CLIENT,
        duration: 5100,
        attributes: {
          [ATTR.AGENT_NAME]: "research-assistant",
          [ATTR.AGENT_ID]: "agent_research_v2",
          [ATTR.CONVERSATION_ID]: conversationId,
          [ATTR.PROVIDER_NAME]: "openai",
        },
        children: [
          {
            name: "invoke_agent research-assistant",
            operation: "invoke_agent",
            kind: SpanKind.INTERNAL,
            duration: 5000,
            gap: 40,
            attributes: {
              [ATTR.AGENT_NAME]: "research-assistant",
              [ATTR.AGENT_ID]: "agent_research_v2",
              [ATTR.CONVERSATION_ID]: conversationId,
              "agent.max_iterations": 8,
            },
            children: [
              {
                ...chatSpec({
                  model: "gpt-4.1",
                  provider: "openai",
                  inputTokens: 1240,
                  outputTokens: 86,
                  duration: 820,
                  baseNs,
                  thought:
                    "Thought: I should search for recent latency benchmarks first.",
                }),
                gap: 30,
              },
              {
                ...toolSpec({
                  toolName: "web_search",
                  callId: "call_h1a",
                  duration: 1180,
                  output: "5 results for 'vector db latency benchmark 2026'",
                }),
                gap: 15,
              },
              {
                ...chatSpec({
                  model: "gpt-4.1",
                  provider: "openai",
                  inputTokens: 2180,
                  outputTokens: 94,
                  duration: 910,
                  baseNs,
                  thought: "Thought: Result #2 and #4 look authoritative. Fetch both.",
                }),
                gap: 20,
              },
              {
                ...toolSpec({
                  toolName: "fetch_url",
                  callId: "call_h2b",
                  duration: 640,
                  output: "Retrieved benchmark article (4.2k chars)",
                }),
                gap: 10,
              },
              {
                ...chatSpec({
                  model: "gpt-4.1",
                  provider: "openai",
                  inputTokens: 4860,
                  outputTokens: 312,
                  duration: 1240,
                  baseNs,
                  thought:
                    "Thought: I have p50/p95 for all three candidates. Writing the answer.",
                }),
                gap: 25,
              },
            ],
          },
        ],
      },
    ],
  }),

  // -------------------------------------------------------------- retry loop
  "retry-loop": ({ baseNs, conversationId }) => ({
    scopeName: "mock.react-agent",
    resourceAttributes: { ...BASE_RESOURCE, "service.name": "support-agent" },
    roots: [
      {
        name: "invoke_agent support-agent",
        operation: "invoke_agent",
        kind: SpanKind.CLIENT,
        duration: 14200,
        attributes: {
          [ATTR.AGENT_NAME]: "support-agent",
          [ATTR.AGENT_ID]: "agent_support_v1",
          [ATTR.CONVERSATION_ID]: conversationId,
          [ATTR.PROVIDER_NAME]: "openai",
        },
        children: [
          {
            name: "invoke_agent support-agent",
            operation: "invoke_agent",
            kind: SpanKind.INTERNAL,
            duration: 14100,
            gap: 45,
            attributes: {
              [ATTR.AGENT_NAME]: "support-agent",
              [ATTR.AGENT_ID]: "agent_support_v1",
              "agent.max_iterations": 12,
            },
            children: [
              // Four identical thought -> failing tool cycles. The agent never
              // changes strategy: this is the pattern a debugger must surface.
              ...Array.from({ length: 4 }, (_, i) => [
                {
                  ...chatSpec({
                    model: "gpt-4.1",
                    provider: "openai",
                    inputTokens: 980 + i * 640,
                    outputTokens: 72,
                    duration: 780 + i * 90,
                    baseNs,
                    thought: `Thought: The lookup failed. Retrying (attempt ${i + 1}).`,
                  }),
                  gap: 20,
                },
                {
                  ...toolSpec({
                    toolName: "crm_lookup",
                    callId: `call_r${i}`,
                    duration: 1900 + i * 120,
                    errorType: "429",
                    status: {
                      code: StatusCode.ERROR,
                      message: "Rate limit exceeded for CRM API",
                    },
                  }),
                  gap: 12,
                },
              ]).flat(),
              {
                ...chatSpec({
                  model: "gpt-4.1",
                  provider: "openai",
                  inputTokens: 3980,
                  outputTokens: 148,
                  duration: 1100,
                  baseNs,
                  thought:
                    "Thought: I could not retrieve the account. Escalating to a human.",
                }),
                gap: 25,
              },
            ],
          },
        ],
      },
    ],
  }),

  // -------------------------------------------------------------- legacy sdk
  "legacy-sdk": ({ baseNs, conversationId }) => ({
    scopeName: "legacy-agent-sdk",
    resourceAttributes: { ...BASE_RESOURCE, "service.name": "legacy-bot" },
    roots: [
      {
        name: "invoke_agent legacy-bot",
        operation: "invoke_agent",
        kind: SpanKind.INTERNAL,
        duration: 3200,
        attributes: {
          // Deprecated in v1.37 — replaced by gen_ai.provider.name.
          "gen_ai.system": "openai",
          [ATTR.AGENT_NAME]: "legacy-bot",
          [ATTR.CONVERSATION_ID]: conversationId,
        },
        children: [
          {
            name: "chat gpt-4o",
            operation: "chat",
            kind: SpanKind.CLIENT,
            duration: 890,
            gap: 20,
            attributes: {
              "gen_ai.system": "openai",
              [ATTR.REQUEST_MODEL]: "gpt-4o",
              // Deprecated token attribute names.
              "gen_ai.usage.prompt_tokens": 1450,
              "gen_ai.usage.completion_tokens": 120,
            },
          },
          {
            name: "chat gpt-4o",
            operation: "chat",
            kind: SpanKind.CLIENT,
            duration: 1020,
            gap: 15,
            attributes: {
              "gen_ai.system": "openai",
              [ATTR.REQUEST_MODEL]: "gpt-4o",
              // The trap: BOTH generations present. Summing would double-count;
              // the normalizer must coalesce and flag it.
              [ATTR.USAGE_INPUT_TOKENS]: 2600,
              "gen_ai.usage.prompt_tokens": 2600,
              [ATTR.USAGE_OUTPUT_TOKENS]: 180,
              "gen_ai.usage.completion_tokens": 180,
            },
          },
          {
            name: "chat gpt-4o",
            operation: "chat",
            kind: SpanKind.CLIENT,
            duration: 760,
            gap: 15,
            attributes: {
              "gen_ai.system": "openai",
              [ATTR.REQUEST_MODEL]: "gpt-4o",
              [ATTR.USAGE_INPUT_TOKENS]: 3100,
              [ATTR.USAGE_OUTPUT_TOKENS]: 240,
              // Content captured as a span attribute (SPAN_ONLY) instead of an
              // event — bloats the span.
              "gen_ai.prompt": JSON.stringify([
                { role: "system", content: SYSTEM_PROMPT },
                { role: "user", content: "Summarise the incident report." },
              ]),
            },
            events: messageEvents(baseNs, [
              { role: "assistant", content: "Summary: the outage lasted 42 minutes." },
            ]),
          },
        ],
      },
    ],
  }),

  // ---------------------------------------------------------- reasoning model
  "reasoning-model": ({ baseNs, conversationId }) => ({
    scopeName: "mock.react-agent",
    resourceAttributes: { ...BASE_RESOURCE, "service.name": "planner-agent" },
    roots: [
      {
        name: "invoke_agent planner-agent",
        operation: "invoke_agent",
        kind: SpanKind.INTERNAL,
        duration: 9800,
        attributes: {
          [ATTR.AGENT_NAME]: "planner-agent",
          [ATTR.CONVERSATION_ID]: conversationId,
          [ATTR.PROVIDER_NAME]: "openai",
        },
        children: [
          {
            name: "chat o4-mini",
            operation: "chat",
            kind: SpanKind.CLIENT,
            duration: 6200,
            gap: 30,
            attributes: {
              [ATTR.PROVIDER_NAME]: "openai",
              [ATTR.REQUEST_MODEL]: "o4-mini",
              [ATTR.RESPONSE_MODEL]: "o4-mini",
              // Reasoning tokens deliberately absent — the reported total is
              // missing the dominant cost component.
              [ATTR.USAGE_INPUT_TOKENS]: 1840,
              [ATTR.USAGE_OUTPUT_TOKENS]: 96,
              "gen_ai.request.reasoning_effort": "high",
            },
            events: messageEvents(baseNs, [
              { role: "user", content: "Plan a migration with zero downtime." },
              { role: "assistant", content: "Plan: dual-write, backfill, then cut over." },
            ]),
          },
          {
            name: "execute_tool migration_planner",
            operation: "execute_tool",
            kind: SpanKind.INTERNAL,
            duration: 2100,
            gap: 20,
            attributes: {
              [ATTR.TOOL_NAME]: "migration_planner",
              [ATTR.TOOL_CALL_ID]: "call_p1",
              [ATTR.PROVIDER_NAME]: "openai",
            },
          },
          {
            // Same model, but the SDK does report reasoning tokens here —
            // makes the under-count visible side by side.
            name: "chat o4-mini",
            operation: "chat",
            kind: SpanKind.CLIENT,
            duration: 1400,
            gap: 15,
            attributes: {
              [ATTR.PROVIDER_NAME]: "openai",
              [ATTR.REQUEST_MODEL]: "o4-mini",
              [ATTR.USAGE_INPUT_TOKENS]: 2900,
              [ATTR.USAGE_OUTPUT_TOKENS]: 210,
              [ATTR.USAGE_REASONING_TOKENS]: 12480,
            },
          },
        ],
      },
    ],
  }),

  // ----------------------------------------------------------- context bloat
  "context-bloat": ({ baseNs, conversationId }) => ({
    scopeName: "mock.react-agent",
    resourceAttributes: { ...BASE_RESOURCE, "service.name": "summariser-agent" },
    roots: [
      {
        name: "invoke_agent summariser-agent",
        operation: "invoke_agent",
        kind: SpanKind.INTERNAL,
        duration: 21000,
        attributes: {
          [ATTR.AGENT_NAME]: "summariser-agent",
          [ATTR.CONVERSATION_ID]: conversationId,
          [ATTR.PROVIDER_NAME]: "anthropic",
        },
        children: [
          {
            name: "invoke_agent summariser-agent",
            operation: "invoke_agent",
            kind: SpanKind.INTERNAL,
            duration: 20900,
            gap: 40,
            attributes: { [ATTR.AGENT_NAME]: "summariser-agent" },
            children: [
              // Input context doubles every turn: the model keeps re-reading
              // everything it already saw. Total spend is dominated by the last
              // two calls.
              ...[760, 1520, 3060, 6140, 12280, 24560].flatMap((inputTokens, i) => [
                {
                  ...chatSpec({
                    model: "claude-sonnet-4.5",
                    provider: "anthropic",
                    inputTokens,
                    outputTokens: 180 + i * 40,
                    duration: 1400 + i * 620,
                    baseNs,
                    thought: `Thought: Summarising chunk ${i + 1} of 6.`,
                  }),
                  gap: 18,
                },
                {
                  ...toolSpec({
                    toolName: "read_chunk",
                    callId: `call_c${i}`,
                    duration: 320 + i * 40,
                    output: `chunk ${i + 1}: 2.1k chars`,
                  }),
                  gap: 10,
                },
              ]),
            ],
          },
        ],
      },
    ],
  }),

  // ---------------------------------------------------------- error cascade
  "error-cascade": ({ baseNs, conversationId }) => ({
    scopeName: "mock.react-agent",
    resourceAttributes: { ...BASE_RESOURCE, "service.name": "booking-agent" },
    roots: [
      {
        name: "invoke_agent booking-agent",
        operation: "invoke_agent",
        kind: SpanKind.CLIENT,
        duration: 8600,
        attributes: {
          [ATTR.AGENT_NAME]: "booking-agent",
          [ATTR.CONVERSATION_ID]: conversationId,
          [ATTR.PROVIDER_NAME]: "openai",
        },
        status: { code: StatusCode.ERROR, message: "Agent run failed" },
        children: [
          {
            name: "invoke_agent booking-agent",
            operation: "invoke_agent",
            kind: SpanKind.INTERNAL,
            duration: 8500,
            gap: 40,
            attributes: { [ATTR.AGENT_NAME]: "booking-agent" },
            children: [
              {
                ...chatSpec({
                  model: "gpt-4.1",
                  provider: "openai",
                  inputTokens: 1120,
                  outputTokens: 78,
                  duration: 800,
                  baseNs,
                  thought: "Thought: Check availability for the requested dates.",
                }),
                gap: 20,
              },
              {
                // Root cause: the availability service is down.
                ...toolSpec({
                  toolName: "check_availability",
                  callId: "call_e1",
                  duration: 4200,
                  errorType: "TimeoutError",
                  status: {
                    code: StatusCode.ERROR,
                    message: "Upstream timeout after 4000ms",
                  },
                }),
                gap: 12,
              },
              {
                // The agent keeps going with a missing observation, and every
                // downstream step inherits the failure.
                ...chatSpec({
                  model: "gpt-4.1",
                  provider: "openai",
                  inputTokens: 1620,
                  outputTokens: 64,
                  duration: 900,
                  baseNs,
                  thought:
                    "Thought: No availability data returned. Trying the fallback API.",
                  status: {
                    code: StatusCode.ERROR,
                    message: "Model call aborted: tool result missing",
                  },
                  extraAttributes: { [ATTR.ERROR_TYPE]: "DependencyFailure" },
                }),
                gap: 20,
              },
              {
                ...toolSpec({
                  toolName: "check_availability_fallback",
                  callId: "call_e2",
                  duration: 2100,
                  errorType: "ConnectionError",
                  status: {
                    code: StatusCode.ERROR,
                    message: "connection refused: fallback.internal:443",
                  },
                }),
                gap: 12,
              },
              {
                // Fails without an error.type — the normalizer should call this
                // out as ungroupable.
                ...chatSpec({
                  model: "gpt-4.1",
                  provider: "openai",
                  inputTokens: 2010,
                  outputTokens: 0,
                  duration: 640,
                  baseNs,
                  thought: "",
                  status: { code: StatusCode.ERROR, message: "Run aborted" },
                }),
                gap: 15,
              },
            ],
          },
        ],
      },
    ],
  }),
};

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

interface ParsedArgs {
  url: string;
  scenario: ScenarioName | "all";
  count: number;
}

function parseArgs(argv: string[]): ParsedArgs {
  const args: ParsedArgs = {
    url: "http://localhost:3000",
    scenario: "all",
    count: 1,
  };

  for (const arg of argv) {
    if (arg.startsWith("--url=")) args.url = arg.slice("--url=".length);
    else if (arg.startsWith("--scenario="))
      args.scenario = arg.slice("--scenario=".length) as ParsedArgs["scenario"];
    else if (arg.startsWith("--count="))
      args.count = Math.max(1, Number.parseInt(arg.slice("--count=".length), 10) || 1);
  }

  return args;
}

async function postTrace(
  url: string,
  payload: ExportTraceServiceRequest,
  traceId: string,
): Promise<boolean> {
  const endpoint = `${url.replace(/\/$/, "")}/api/v1/traces`;
  const res = await fetch(endpoint, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(payload),
  });

  if (!res.ok) {
    const text = await res.text().catch(() => "");
    console.error(
      `  ✗ ${traceId.slice(0, 12)}  HTTP ${res.status} ${text.slice(0, 200)}`,
    );
    return false;
  }

  const bodyText = await res.text().catch(() => "");
  if (bodyText.includes("partialSuccess")) {
    console.warn(`  ! ${traceId.slice(0, 12)}  partial success: ${bodyText}`);
  }
  return true;
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const names: ScenarioName[] =
    args.scenario === "all"
      ? ALL_SCENARIOS
      : ALL_SCENARIOS.includes(args.scenario as ScenarioName)
        ? [args.scenario as ScenarioName]
        : (() => {
            console.error(
              `Unknown scenario "${args.scenario}". Options: ${ALL_SCENARIOS.join(", ")}, all`,
            );
            process.exit(1);
          })();

  console.log(`Emitting traces to ${args.url}`);
  console.log(`Scenarios: ${names.join(", ")} (x${args.count})\n`);

  let ok = 0;
  let failed = 0;

  for (let i = 0; i < args.count; i++) {
    for (const name of names) {
      const traceId = hex(16);
      const conversationId = `conv_${name}_${hex(4)}`;
      // Spread traces across the past hour so the list view has a real timeline.
      // Must stay integral — BigInt() rejects fractional milliseconds.
      const ageMs = Math.round(Math.random() * 3600_000);
      const baseNs = BigInt(Date.now() - ageMs) * NS_PER_MS;

      const built = scenarios[name]({ traceId, baseNs, conversationId });
      const builder = new TraceBuilder(
        traceId,
        baseNs,
        built.resourceAttributes,
        built.scopeName,
      );
      const payload = builder.build(built.roots);

      const spanCount = payload.resourceSpans?.[0]?.scopeSpans?.[0]?.spans.length ?? 0;
      const success = await postTrace(args.url, payload, traceId);
      if (success) {
        ok += 1;
        console.log(`  ✓ ${name.padEnd(16)} ${traceId.slice(0, 12)}  ${spanCount} spans`);
      } else {
        failed += 1;
      }
    }
  }

  console.log(`\nDone. ${ok} trace(s) ingested, ${failed} failed.`);
  if (failed > 0) process.exitCode = 1;
}

void main().catch((err: unknown) => {
  console.error("mock-agent failed:", err);
  process.exit(1);
});
