/** Types shared by the fork / replay pipeline. Message shapes follow OpenAI's
 *  chat-completions format, which is what most providers and gateways accept. */

export interface ToolCall {
  id: string;
  type: "function";
  function: {
    name: string;
    /** JSON string, per the OpenAI wire format. */
    arguments: string;
  };
}

export interface ReplayMessage {
  role: "system" | "user" | "assistant" | "tool";
  content: string | null;
  /** Tool name, on role === "tool". */
  name?: string;
  tool_calls?: ToolCall[];
  tool_call_id?: string;
}

export interface ReplayToolSpec {
  name: string;
  description: string;
  /**
   * OTel GenAI spans record the tool *name* but not its JSON schema, so
   * replays must fall back to a permissive object. A model asked to call a
   * schema-less tool will still emit reasonable arguments; it just isn't
   * validated.
   */
  parameters: Record<string, unknown>;
  schemaRecovered: boolean;
}

export interface RecordedToolOutput {
  output: string;
  errorType: string | null;
  /**
   * Original duration. Replayed tools are not actually executed, so the
   * recorded latency is reused — otherwise the replay's timeline would show
   * every tool as instant and time comparisons would be meaningless.
   */
  durationNs: number;
}

export interface ReplayContext {
  traceId: string;
  /** Replay resumes *after* this span. */
  forkSpanId: string;
  forkSpanName: string;
  messages: ReplayMessage[];
  model: string | null;
  provider: string | null;
  tools: ReplayToolSpec[];
  /** Keyed by tool name — tool_call ids are regenerated on replay. */
  recordedOutputs: Record<string, RecordedToolOutput>;
  systemPrompt: string | null;
  /**
   * Things the reconstruction could not determine from the spans alone.
   * Shown in the UI so the operator knows which parts are inferred.
   */
  warnings: string[];
}

export interface ReplayOverrides {
  /** Replace the system prompt for the replayed continuation. */
  systemPrompt?: string;
  /** Force a tool to return this instead of what was recorded. */
  toolOutputs?: Record<string, string>;
  /** Replay with a different model — the classic "is the model at fault?" test. */
  model?: string;
}

export interface ReplayConfig {
  context: ReplayContext;
  overrides: ReplayOverrides;
  maxSteps: number;
  llm: LlmConfig;
  /** Absolute OTLP endpoint the replay reports its own spans to. */
  otlpEndpoint: string;
}

export interface LlmConfig {
  baseUrl: string;
  apiKey: string;
  model: string;
}

export interface ReplayStepResult {
  step: number;
  finishReason: string;
  inputTokens: number | null;
  outputTokens: number | null;
  reasoningTokens: number | null;
  durationMs: number;
  toolCalls: { name: string; output: string; overridden: boolean }[];
  assistantText: string | null;
}

export interface ReplayResult {
  traceId: string;
  /** Trace the replay was forked from. */
  sourceTraceId: string;
  forkSpanId: string;
  steps: ReplayStepResult[];
  finalAnswer: string | null;
  stoppedReason: "completed" | "max_steps" | "error";
  error?: string;
  totals: {
    inputTokens: number;
    outputTokens: number;
    reasoningTokens: number;
    durationMs: number;
    toolCalls: number;
  };
}
