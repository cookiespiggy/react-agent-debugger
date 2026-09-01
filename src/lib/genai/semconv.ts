/**
 * OpenTelemetry GenAI Semantic Conventions — attribute & operation registry.
 *
 * Pinned against: open-telemetry/semantic-conventions-genai @ semconv v1.42.0 (2026-06-12).
 *
 * IMPORTANT: as of 2026-07 every `gen_ai.*` surface is **Development** status — nothing
 * here is Stable. Three generations of attribute names are simultaneously in the wild,
 * which is why `normalize.ts` exists. Keep this file in sync with the pinned version and
 * re-run the mock agent after any bump.
 */

export const PINNED_SEMCONV_VERSION = "1.42.0";

/** The nine well-known `gen_ai.operation.name` values. */
export const GENAI_OPERATIONS = [
  "create_agent",
  "invoke_agent",
  "invoke_workflow",
  "execute_tool",
  "chat",
  "text_completion",
  "embeddings",
  "generate_content",
  "retrieval",
] as const;

export type GenAIOperation = (typeof GENAI_OPERATIONS)[number];

/** Agent-orchestration operations (as opposed to model-facing ones). */
export const AGENT_OPERATIONS: ReadonlySet<GenAIOperation> = new Set([
  "create_agent",
  "invoke_agent",
  "invoke_workflow",
  "execute_tool",
]);

/** Model-facing operations. Token usage is only meaningful on these. */
export const MODEL_OPERATIONS: ReadonlySet<GenAIOperation> = new Set([
  "chat",
  "text_completion",
  "embeddings",
  "generate_content",
  "retrieval",
]);

export const isAgentOperation = (op: GenAIOperation | null): boolean =>
  op !== null && AGENT_OPERATIONS.has(op);

export const isModelOperation = (op: GenAIOperation | null): boolean =>
  op !== null && MODEL_OPERATIONS.has(op);

/**
 * Current (non-deprecated) `gen_ai.*` attribute names.
 */
export const ATTR = {
  OPERATION_NAME: "gen_ai.operation.name",
  PROVIDER_NAME: "gen_ai.provider.name",
  REQUEST_MODEL: "gen_ai.request.model",
  RESPONSE_MODEL: "gen_ai.response.model",
  CONVERSATION_ID: "gen_ai.conversation.id",
  AGENT_NAME: "gen_ai.agent.name",
  AGENT_ID: "gen_ai.agent.id",
  TOOL_NAME: "gen_ai.tool.name",
  TOOL_CALL_ID: "gen_ai.tool.call.id",
  USAGE_INPUT_TOKENS: "gen_ai.usage.input_tokens",
  USAGE_OUTPUT_TOKENS: "gen_ai.usage.output_tokens",
  /** Added v1.41.0. Omit it and cost reports skew 5–20x low on reasoning models. */
  USAGE_REASONING_TOKENS: "gen_ai.usage.reasoning.output_tokens",
  INPUT_MESSAGES: "gen_ai.input.messages",
  OUTPUT_MESSAGES: "gen_ai.output.messages",
  /** Standard OTel attribute — there is deliberately no `gen_ai.error.type`. */
  ERROR_TYPE: "error.type",
} as const;

type AttrKey = (typeof ATTR)[keyof typeof ATTR];

export const isGenAiAttr = (key: string): key is AttrKey =>
  (Object.values(ATTR) as string[]).includes(key);

/**
 * Deprecated names, mapped to their replacements and the version that deprecated them.
 * Consumed by `normalize.ts` to coalesce — never to sum.
 */
export const DEPRECATED_ATTRS: Record<
  string,
  { replacedBy: string; since: string }
> = {
  "gen_ai.system": { replacedBy: ATTR.PROVIDER_NAME, since: "v1.37" },
  "gen_ai.usage.prompt_tokens": {
    replacedBy: ATTR.USAGE_INPUT_TOKENS,
    since: "v1.37",
  },
  "gen_ai.usage.completion_tokens": {
    replacedBy: ATTR.USAGE_OUTPUT_TOKENS,
    since: "v1.37",
  },
  "gen_ai.prompt": { replacedBy: ATTR.INPUT_MESSAGES, since: "v1.42" },
  "gen_ai.completion": { replacedBy: ATTR.OUTPUT_MESSAGES, since: "v1.42" },
};

/**
 * Span event names used to carry prompt/completion content.
 * Content lives on events (not attributes) so spans stay lean.
 */
export const GENAI_EVENTS = {
  SYSTEM_MESSAGE: "gen_ai.system.message",
  USER_MESSAGE: "gen_ai.user.message",
  ASSISTANT_MESSAGE: "gen_ai.assistant.message",
  TOOL_MESSAGE: "gen_ai.tool.message",
  CHOICE: "gen_ai.choice",
} as const;

/**
 * The four content-capture modes from opentelemetry-util-genai 1.0b0 (2026-07-09).
 * Default is NO_CONTENT for privacy.
 */
export const CAPTURE_MODES = [
  "NO_CONTENT",
  "SPAN_ONLY",
  "EVENT_ONLY",
  "SPAN_AND_EVENT",
] as const;
export type CaptureMode = (typeof CAPTURE_MODES)[number];

/** OTel SpanKind. GenAI spans are CLIENT (model calls) or INTERNAL (agent loop). */
export const SpanKind = {
  UNSPECIFIED: 0,
  INTERNAL: 1,
  SERVER: 2,
  CLIENT: 3,
  PRODUCER: 4,
  CONSUMER: 5,
} as const;
export type SpanKindCode = (typeof SpanKind)[keyof typeof SpanKind];

export const SPAN_KIND_LABEL: Record<number, string> = {
  [SpanKind.UNSPECIFIED]: "unspecified",
  [SpanKind.INTERNAL]: "internal",
  [SpanKind.SERVER]: "server",
  [SpanKind.CLIENT]: "client",
  [SpanKind.PRODUCER]: "producer",
  [SpanKind.CONSUMER]: "consumer",
};

export const StatusCode = {
  UNSET: 0,
  OK: 1,
  ERROR: 2,
} as const;
export type StatusCodeValue = (typeof StatusCode)[keyof typeof StatusCode];

/** Human-readable labels + accent colors for the waterfall UI. */
export const OPERATION_META: Record<
  GenAIOperation,
  { label: string; short: string; group: "agent" | "model" }
> = {
  create_agent: { label: "Create Agent", short: "create", group: "agent" },
  invoke_agent: { label: "Invoke Agent", short: "agent", group: "agent" },
  invoke_workflow: { label: "Workflow Step", short: "workflow", group: "agent" },
  execute_tool: { label: "Tool Execution", short: "tool", group: "agent" },
  chat: { label: "Model Call", short: "chat", group: "model" },
  text_completion: { label: "Completion", short: "completion", group: "model" },
  embeddings: { label: "Embeddings", short: "embed", group: "model" },
  generate_content: { label: "Generate Content", short: "generate", group: "model" },
  retrieval: { label: "Retrieval", short: "retrieve", group: "model" },
};
