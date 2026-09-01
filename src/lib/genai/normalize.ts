import { decodeAttributes, parseNanos } from "../otlp/decode";
import type { OtlpSpan, SpanEvent } from "../otlp/types";
import {
  ATTR,
  DEPRECATED_ATTRS,
  GENAI_EVENTS,
  GENAI_OPERATIONS,
  MODEL_OPERATIONS,
  StatusCode,
  type GenAIOperation,
} from "./semconv";

export type WarningSeverity = "error" | "warn" | "info";

export type WarningCode =
  | "DEPRECATED_ATTR"
  | "TOKEN_ATTR_CONFLICT"
  | "MISSING_OPERATION_NAME"
  | "OPERATION_INFERRED_FROM_NAME"
  | "UNKNOWN_OPERATION"
  | "MISSING_PROVIDER"
  | "MISSING_MODEL"
  | "MISSING_REASONING_TOKENS"
  | "NEGATIVE_DURATION"
  | "MISSING_TOOL_NAME"
  | "SPAN_ERROR";

export interface SpanWarning {
  code: WarningCode;
  severity: WarningSeverity;
  message: string;
  attr?: string;
}

export interface TokenUsage {
  inputTokens: number | null;
  outputTokens: number | null;
  /** v1.41.0+. Null on non-reasoning models, or when the SDK omits it. */
  reasoningTokens: number | null;
  totalTokens: number | null;
}

export interface NormalizedEvent {
  name: string;
  timeNs: bigint;
  attributes: Record<string, unknown>;
}

export interface NormalizedSpan {
  traceId: string;
  spanId: string;
  parentSpanId: string | null;
  name: string;
  kind: number;
  /** Resolved `gen_ai.operation.name`, or inferred from the span name. */
  operation: GenAIOperation | null;
  /** True when `operation` came from parsing `name` rather than the attribute. */
  operationInferred: boolean;

  startTimeNs: bigint;
  endTimeNs: bigint;
  durationNs: bigint;

  statusCode: number;
  statusMessage: string | null;

  provider: string | null;
  model: string | null;
  agentName: string | null;
  agentId: string | null;
  toolName: string | null;
  toolCallId: string | null;
  conversationId: string | null;

  usage: TokenUsage;
  inputMessages: unknown;
  outputMessages: unknown;
  errorType: string | null;

  /** All decoded attributes, for the raw inspector panel. */
  attributes: Record<string, unknown>;
  resourceAttributes: Record<string, unknown>;
  events: NormalizedEvent[];
  scopeName: string | null;

  /** Data-quality diagnostics surfaced in the UI. */
  warnings: SpanWarning[];
}

const EMPTY_USAGE: TokenUsage = {
  inputTokens: null,
  outputTokens: null,
  reasoningTokens: null,
  totalTokens: null,
};

/**
 * Models that emit reasoning tokens unconditionally (o-series, GPT-5, R1, QwQ).
 * Missing `gen_ai.usage.reasoning.output_tokens` on these understates cost 5-20x.
 */
const ALWAYS_REASONING_PATTERN =
  /(?:^|[^a-z0-9])(?:o[1345]|gpt-5|deepseek-r1|qwq)(?:[^a-z0-9]|$)/i;

/**
 * Attributes proving extended thinking was explicitly requested.
 *
 * Models like Claude 4.x / Gemini 2.5 support *optional* reasoning. Flagging
 * every such span as "missing reasoning tokens" would be a false alarm — and a
 * debugger that cries wolf gets ignored. Only treat them as reasoning models
 * when the request actually turned it on.
 */
const REASONING_REQUEST_ATTRS = [
  "gen_ai.request.reasoning_effort",
  "gen_ai.request.thinking_budget",
  "gen_ai.request.extended_thinking",
] as const;

export function isReasoningModel(
  model: string | null,
  attributes?: Record<string, unknown>,
): boolean {
  if (!model) return false;
  if (ALWAYS_REASONING_PATTERN.test(model)) return true;
  if (!attributes) return false;
  return REASONING_REQUEST_ATTRS.some(
    (key) => attributes[key] !== undefined && attributes[key] !== null,
  );
}

/** Coerce a decoded attribute to a finite number, or null. */
function toNumber(value: unknown): number | null {
  if (typeof value === "number") return Number.isFinite(value) ? value : null;
  if (typeof value === "string") {
    const trimmed = value.trim();
    if (!trimmed) return null;
    const n = Number(trimmed);
    return Number.isFinite(n) ? n : null;
  }
  return null;
}

function toStr(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  if (typeof value === "string") return value.length ? value : null;
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  return null;
}

/**
 * Pick the first non-null value across generations of an attribute name.
 *
 * The spec is explicit: backends must **coalesce, never sum**. If both
 * `gen_ai.usage.prompt_tokens` (v1.36) and `gen_ai.usage.input_tokens` (v1.37+)
 * are present, adding them double-counts usage.
 */
function coalesce(
  attrs: Record<string, unknown>,
  candidates: readonly string[],
): { value: unknown; usedKey: string | null; present: string[] } {
  const present: string[] = [];
  for (const key of candidates) {
    const raw = attrs[key];
    if (raw === null || raw === undefined || raw === "") continue;
    present.push(key);
  }
  if (present.length === 0) return { value: null, usedKey: null, present: [] };
  const usedKey = present[0]!;
  return { value: attrs[usedKey], usedKey, present };
}

/**
 * Messaging content can arrive as a JSON string (SPAN_ONLY) or a decoded
 * structure (EVENT_ONLY / native array). Normalize both to a JS value.
 */
function parseMessages(raw: unknown): unknown {
  if (raw === null || raw === undefined) return null;
  if (typeof raw === "string") {
    const t = raw.trim();
    if (!t) return null;
    if (t.startsWith("[") || t.startsWith("{")) {
      try {
        return JSON.parse(t);
      } catch {
        return raw;
      }
    }
    return raw;
  }
  return raw;
}

/** Fallback: derive the operation from a conventional span name, e.g. `chat gpt-4.1`. */
function inferOperationFromName(name: string): GenAIOperation | null {
  const head = name.trim().split(/\s+/)[0]?.toLowerCase();
  if (!head) return null;
  const match = (GENAI_OPERATIONS as readonly string[]).find((op) => op === head);
  return (match as GenAIOperation | undefined) ?? null;
}

function normalizeEvents(events: SpanEvent[] | undefined): NormalizedEvent[] {
  if (!events?.length) return [];
  return events.map((e) => ({
    name: e.name ?? "",
    timeNs: parseNanos(e.timeUnixNano),
    attributes: decodeAttributes(e.attributes),
  }));
}

const MESSAGE_EVENT_NAMES = new Set<string>(Object.values(GENAI_EVENTS));

/** Reconstruct input/output messages from span events when attributes lack them. */
function messagesFromEvents(events: NormalizedEvent[], kind: "input" | "output"): unknown {
  const wanted =
    kind === "input"
      ? [GENAI_EVENTS.SYSTEM_MESSAGE, GENAI_EVENTS.USER_MESSAGE]
      : [GENAI_EVENTS.ASSISTANT_MESSAGE];
  const found = events
    .filter((e) => wanted.includes(e.name as never))
    .map((e) => e.attributes);
  return found.length ? found : null;
}

export interface NormalizeOptions {
  resourceAttributes?: Record<string, unknown>;
  scopeName?: string | null;
}

export function normalizeSpan(span: OtlpSpan, opts: NormalizeOptions = {}): NormalizedSpan {
  const warnings: SpanWarning[] = [];
  const attributes = decodeAttributes(span.attributes);
  const resourceAttributes = opts.resourceAttributes ?? {};

  // --- operation ---------------------------------------------------------
  let operation = toStr(attributes[ATTR.OPERATION_NAME]) as GenAIOperation | null;
  let operationInferred = false;

  if (operation === null) {
    const inferred = inferOperationFromName(span.name ?? "");
    if (inferred) {
      operation = inferred;
      operationInferred = true;
      warnings.push({
        code: "OPERATION_INFERRED_FROM_NAME",
        severity: "warn",
        attr: ATTR.OPERATION_NAME,
        message: `Missing \`${ATTR.OPERATION_NAME}\`. Inferred "${inferred}" from span name "${span.name}". Set the attribute — inference is best-effort.`,
      });
    } else {
      warnings.push({
        code: "MISSING_OPERATION_NAME",
        severity: "warn",
        attr: ATTR.OPERATION_NAME,
        message: `Missing \`${ATTR.OPERATION_NAME}\`, and the span name does not match a known operation. This span cannot be classified.`,
      });
    }
  } else if (!(GENAI_OPERATIONS as readonly string[]).includes(operation)) {
    warnings.push({
      code: "UNKNOWN_OPERATION",
      severity: "info",
      attr: ATTR.OPERATION_NAME,
      message: `Unknown operation "${operation}". Expected one of: ${GENAI_OPERATIONS.join(", ")}.`,
    });
  }

  // --- deprecation scan --------------------------------------------------
  for (const [oldKey, { replacedBy, since }] of Object.entries(DEPRECATED_ATTRS)) {
    if (attributes[oldKey] !== undefined && attributes[oldKey] !== null) {
      warnings.push({
        code: "DEPRECATED_ATTR",
        severity: "warn",
        attr: oldKey,
        message: `\`${oldKey}\` was deprecated in semconv ${since} and replaced by \`${replacedBy}\`. Upgrade your instrumentation.`,
      });
    }
  }

  // --- provider / model --------------------------------------------------
  const providerCoalesced = coalesce(attributes, [ATTR.PROVIDER_NAME, "gen_ai.system"]);
  const provider = toStr(providerCoalesced.value);
  const model = toStr(
    attributes[ATTR.REQUEST_MODEL] ?? attributes[ATTR.RESPONSE_MODEL],
  );

  if (operation !== null && MODEL_OPERATIONS.has(operation)) {
    if (provider === null) {
      warnings.push({
        code: "MISSING_PROVIDER",
        severity: "warn",
        attr: ATTR.PROVIDER_NAME,
        message: `Model span is missing \`${ATTR.PROVIDER_NAME}\`. Cost attribution will fall back to heuristics.`,
      });
    }
    if (model === null) {
      warnings.push({
        code: "MISSING_MODEL",
        severity: "warn",
        attr: ATTR.REQUEST_MODEL,
        message: `Model span is missing \`${ATTR.REQUEST_MODEL}\`.`,
      });
    }
  }

  // --- token usage (coalesce, never sum) ---------------------------------
  const inputCoalesced = coalesce(attributes, [
    ATTR.USAGE_INPUT_TOKENS,
    "gen_ai.usage.prompt_tokens",
  ]);
  const outputCoalesced = coalesce(attributes, [
    ATTR.USAGE_OUTPUT_TOKENS,
    "gen_ai.usage.completion_tokens",
  ]);

  const reasoningTokens = toNumber(attributes[ATTR.USAGE_REASONING_TOKENS]);
  const inputTokens = toNumber(inputCoalesced.value);
  const outputTokens = toNumber(outputCoalesced.value);

  for (const [label, c] of [
    ["input", inputCoalesced],
    ["output", outputCoalesced],
  ] as const) {
    if (c.present.length > 1) {
      warnings.push({
        code: "TOKEN_ATTR_CONFLICT",
        severity: "error",
        attr: c.present[0],
        message: `Both ${c.present.map((k) => `\`${k}\``).join(" and ")} are set. Coalesced to \`${c.usedKey}\` — summing would double-count ${label} tokens.`,
      });
    }
  }

  const usage: TokenUsage =
    inputTokens === null && outputTokens === null && reasoningTokens === null
      ? EMPTY_USAGE
      : {
          inputTokens,
          outputTokens,
          reasoningTokens,
          totalTokens: (inputTokens ?? 0) + (outputTokens ?? 0) + (reasoningTokens ?? 0),
        };

  if (
    isReasoningModel(model, attributes) &&
    operation !== null &&
    MODEL_OPERATIONS.has(operation) &&
    reasoningTokens === null
  ) {
    warnings.push({
      code: "MISSING_REASONING_TOKENS",
      severity: "warn",
      attr: ATTR.USAGE_REASONING_TOKENS,
      message: `"${model}" looks like a reasoning model but \`${ATTR.USAGE_REASONING_TOKENS}\` is absent. Reported cost may be 5–20x too low.`,
    });
  }

  // --- messages ----------------------------------------------------------
  const events = normalizeEvents(span.events);
  const inputMessages =
    parseMessages(
      attributes[ATTR.INPUT_MESSAGES] ?? attributes["gen_ai.prompt"],
    ) ?? messagesFromEvents(events, "input");
  const outputMessages =
    parseMessages(
      attributes[ATTR.OUTPUT_MESSAGES] ?? attributes["gen_ai.completion"],
    ) ?? messagesFromEvents(events, "output");

  if (attributes["gen_ai.prompt"] !== undefined) {
    warnings.push({
      code: "DEPRECATED_ATTR",
      severity: "info",
      attr: "gen_ai.prompt",
      message: `Content captured in the \`gen_ai.prompt\` attribute (SPAN_ONLY mode) bloats span size. Prefer EVENT_ONLY so spans stay lean.`,
    });
  }

  // --- timing ------------------------------------------------------------
  const startTimeNs = parseNanos(span.startTimeUnixNano);
  const endTimeNs = parseNanos(span.endTimeUnixNano);
  let durationNs = endTimeNs - startTimeNs;
  if (durationNs < 0n) {
    warnings.push({
      code: "NEGATIVE_DURATION",
      severity: "error",
      message: `endTimeUnixNano precedes startTimeUnixNano (duration ${durationNs}ns). Clock skew or a bad exporter.`,
    });
    durationNs = 0n;
  }

  // --- status ------------------------------------------------------------
  const statusCode = span.status?.code ?? StatusCode.UNSET;
  const statusMessage = span.status?.message ?? null;
  const errorType = toStr(attributes[ATTR.ERROR_TYPE]);

  if (statusCode === StatusCode.ERROR || errorType !== null) {
    warnings.push({
      code: "SPAN_ERROR",
      severity: "error",
      attr: ATTR.ERROR_TYPE,
      message:
        errorType !== null
          ? `Span failed with error.type="${errorType}".`
          : `Span status is ERROR but \`${ATTR.ERROR_TYPE}\` is unset — add it so failures can be grouped.`,
    });
  }

  // --- tool --------------------------------------------------------------
  const toolName = toStr(attributes[ATTR.TOOL_NAME]);
  if (operation === "execute_tool" && toolName === null) {
    warnings.push({
      code: "MISSING_TOOL_NAME",
      severity: "warn",
      attr: ATTR.TOOL_NAME,
      message: `\`${ATTR.TOOL_NAME}\` is required on execute_tool spans.`,
    });
  }

  return {
    traceId: span.traceId ?? "",
    spanId: span.spanId ?? "",
    parentSpanId: span.parentSpanId ? span.parentSpanId : null,
    name: span.name ?? "",
    kind: span.kind ?? 0,
    operation,
    operationInferred,
    startTimeNs,
    endTimeNs,
    durationNs,
    statusCode,
    statusMessage,
    provider,
    model,
    agentName: toStr(attributes[ATTR.AGENT_NAME]),
    agentId: toStr(attributes[ATTR.AGENT_ID]),
    toolName,
    toolCallId: toStr(attributes[ATTR.TOOL_CALL_ID]),
    conversationId: toStr(attributes[ATTR.CONVERSATION_ID]),
    usage,
    inputMessages,
    outputMessages,
    errorType,
    attributes,
    resourceAttributes,
    events,
    scopeName: opts.scopeName ?? null,
    warnings,
  };
}

export const hasMessageEvents = (span: NormalizedSpan): boolean =>
  span.events.some((e) => MESSAGE_EVENT_NAMES.has(e.name));
