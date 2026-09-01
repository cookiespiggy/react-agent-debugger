import type { ReplayMessage, ReplayToolSpec, ToolCall } from "./types";

/**
 * Minimal OpenAI-compatible chat client.
 *
 * Deliberately not tied to any SDK: a base URL plus a key covers OpenAI,
 * Azure, DeepSeek, Groq, OpenRouter, vLLM and Ollama's compatibility layer,
 * so replays work against whatever the original agent used.
 */

export interface ChatUsage {
  inputTokens: number | null;
  outputTokens: number | null;
  reasoningTokens: number | null;
}

export interface ChatResult {
  content: string | null;
  toolCalls: ToolCall[];
  finishReason: string;
  usage: ChatUsage;
  latencyMs: number;
  model: string;
}

export interface LlmRequestConfig {
  baseUrl: string;
  apiKey: string;
  model: string;
  /** Milliseconds. */
  timeoutMs?: number;
}

interface WireMessage {
  role: string;
  content: string | null;
  name?: string;
  tool_calls?: ToolCall[];
  tool_call_id?: string;
}

export class LlmError extends Error {
  constructor(
    message: string,
    readonly status?: number,
    readonly body?: string,
  ) {
    super(message);
    this.name = "LlmError";
  }
}

/** Providers disagree on usage field names; accept both generations. */
function readUsage(raw: Record<string, unknown> | undefined): ChatUsage {
  if (!raw) return { inputTokens: null, outputTokens: null, reasoningTokens: null };

  const num = (v: unknown): number | null =>
    typeof v === "number" && Number.isFinite(v) ? v : null;

  const inputTokens =
    num(raw.input_tokens) ?? num(raw.prompt_tokens) ?? null;
  const outputTokens =
    num(raw.output_tokens) ?? num(raw.completion_tokens) ?? null;

  // Reasoning tokens live in completion_tokens_details for o-series / GPT-5,
  // and are absent entirely when a gateway strips them.
  const details = raw.completion_tokens_details as Record<string, unknown> | undefined;
  const reasoningTokens =
    num(raw.reasoning_tokens) ??
    num(raw.output_reasoning_tokens) ??
    num(details?.reasoning_tokens) ??
    null;

  return { inputTokens, outputTokens, reasoningTokens };
}

export async function callChat(
  config: LlmRequestConfig,
  messages: ReplayMessage[],
  tools: ReplayToolSpec[],
): Promise<ChatResult> {
  const url = `${config.baseUrl.replace(/\/$/, "")}/chat/completions`;

  const wireMessages: WireMessage[] = messages.map((m) => {
    const out: WireMessage = { role: m.role, content: m.content };
    if (m.name) out.name = m.name;
    if (m.tool_calls?.length) out.tool_calls = m.tool_calls;
    if (m.tool_call_id) out.tool_call_id = m.tool_call_id;
    return out;
  });

  const body: Record<string, unknown> = {
    model: config.model,
    messages: wireMessages,
  };

  if (tools.length > 0) {
    body.tools = tools.map((t) => ({
      type: "function",
      function: {
        name: t.name,
        description: t.description,
        parameters: t.parameters,
      },
    }));
    body.tool_choice = "auto";
  }

  const startedAt = Date.now();

  let response: Response;
  try {
    response = await fetch(url, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${config.apiKey}`,
      },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(config.timeoutMs ?? 120_000),
    });
  } catch (err) {
    if (err instanceof Error && err.name === "TimeoutError") {
      throw new LlmError(`Model request timed out after ${config.timeoutMs ?? 120_000}ms`);
    }
    throw new LlmError(
      `Could not reach ${url}: ${err instanceof Error ? err.message : String(err)}`,
    );
  }

  const text = await response.text().catch(() => "");

  if (!response.ok) {
    throw new LlmError(
      `Model request failed with HTTP ${response.status}`,
      response.status,
      text.slice(0, 800),
    );
  }

  let parsed: Record<string, unknown>;
  try {
    parsed = JSON.parse(text) as Record<string, unknown>;
  } catch {
    throw new LlmError("Model response was not valid JSON", response.status, text.slice(0, 800));
  }

  const choices = parsed.choices as Record<string, unknown>[] | undefined;
  const message = choices?.[0]?.message as Record<string, unknown> | undefined;

  if (!message) {
    throw new LlmError("Model response contained no choices", response.status, text.slice(0, 800));
  }

  const content =
    typeof message.content === "string" && message.content.length > 0
      ? message.content
      : null;

  const rawToolCalls = Array.isArray(message.tool_calls) ? message.tool_calls : [];
  const toolCalls: ToolCall[] = rawToolCalls
    .map((tc): ToolCall | null => {
      const record = tc as Record<string, unknown>;
      const fn = record.function as Record<string, unknown> | undefined;
      if (!fn || typeof fn.name !== "string") return null;
      return {
        id: String(record.id ?? `call_${Math.random().toString(16).slice(2, 10)}`),
        type: "function",
        function: {
          name: fn.name,
          arguments: typeof fn.arguments === "string" ? fn.arguments : "{}",
        },
      };
    })
    .filter((tc): tc is ToolCall => tc !== null);

  return {
    content,
    toolCalls,
    finishReason: String(choices?.[0]?.finish_reason ?? "stop"),
    usage: readUsage(parsed.usage as Record<string, unknown> | undefined),
    latencyMs: Date.now() - startedAt,
    model: String(parsed.model ?? config.model),
  };
}
