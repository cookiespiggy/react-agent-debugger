import type { SpanView, TraceView } from "@/lib/trace/tree";
import type {
  ReplayContext,
  ReplayMessage,
  ReplayToolSpec,
  RecordedToolOutput,
  ToolCall,
} from "./types";

/**
 * Reconstruct a ReAct conversation from OTel spans.
 *
 * This is the load-bearing part of forking: to replay from step N we need the
 * exact message list the model saw at that point. Everything is recovered from
 * captured `gen_ai.input.messages` / `gen_ai.output.messages` content plus tool
 * spans; where the spans are genuinely ambiguous we record a warning rather
 * than silently guessing.
 */

interface FlatMessage {
  role: string;
  content: string;
}

/** Normalise the several shapes captured content can take into role/content pairs. */
function extractMessages(value: unknown): FlatMessage[] {
  if (value === null || value === undefined) return [];

  if (Array.isArray(value)) {
    const out: FlatMessage[] = [];
    for (const item of value) {
      if (item === null || typeof item !== "object" || Array.isArray(item)) continue;
      const record = item as Record<string, unknown>;
      const content = record.content;
      out.push({
        role: String(record.role ?? "user"),
        content: typeof content === "string" ? content : JSON.stringify(content ?? ""),
      });
    }
    return out;
  }

  if (typeof value === "string") {
    const trimmed = value.trim();
    if (!trimmed) return [];
    if (trimmed.startsWith("[") || trimmed.startsWith("{")) {
      try {
        return extractMessages(JSON.parse(trimmed));
      } catch {
        return [{ role: "user", content: value }];
      }
    }
    return [{ role: "user", content: value }];
  }

  if (typeof value === "object") {
    const record = value as Record<string, unknown>;
    if ("content" in record) return extractMessages([record]);
    // A single role/content payload, or an unknown object: stringify it.
    return [{ role: String(record.role ?? "user"), content: JSON.stringify(record) }];
  }

  return [];
}

function byStartOrder(trace: TraceView): SpanView[] {
  return trace.orderedIds
    .map((id) => trace.byId[id])
    .filter((s): s is SpanView => s !== undefined)
    .sort((a, b) => a.startOffsetNs - b.startOffsetNs);
}

export function buildReplayContext(
  trace: TraceView,
  forkSpanId: string,
): ReplayContext {
  const warnings: string[] = [];
  const ordered = byStartOrder(trace);

  const forkIndex = ordered.findIndex((s) => s.spanId === forkSpanId);
  const forkSpan =
    forkIndex >= 0 ? ordered[forkIndex]! : (trace.byId[forkSpanId] ?? null);

  if (!forkSpan) {
    throw new Error(`Span ${forkSpanId} not found in trace ${trace.traceId}`);
  }

  // Everything up to and including the fork point is history; the replay
  // generates what comes after.
  const history = forkIndex >= 0 ? ordered.slice(0, forkIndex + 1) : ordered;

  const messages: ReplayMessage[] = [];
  const recordedOutputs: Record<string, RecordedToolOutput> = {};
  const toolNames = new Set<string>();

  let seeded = false;
  let model: string | null = null;
  let provider: string | null = null;
  let systemPrompt: string | null = null;

  for (let i = 0; i < history.length; i++) {
    const span = history[i]!;
    const next = history[i + 1];

    const isModelCall =
      span.operation === "chat" || span.operation === "text_completion";

    if (isModelCall) {
      if (!seeded) {
        const input = extractMessages(span.inputMessages);
        for (const m of input) {
          if (m.role === "system" && systemPrompt === null) systemPrompt = m.content;
          messages.push({ role: m.role as ReplayMessage["role"], content: m.content });
        }
        seeded = true;
        if (input.length === 0) {
          warnings.push(
            `No captured input messages on "${span.name}". The replay starts with an empty context — enable message content capture to fork accurately.`,
          );
        }
      }

      model = span.model ?? model;
      provider = span.provider ?? provider;

      const output = extractMessages(span.outputMessages);
      const assistantText = output.map((m) => m.content).join("\n").trim();

      // Look ahead: if the model span is immediately followed by a tool
      // execution, that call was the model's requested action. OTel spans do
      // not carry the arguments, so they are replayed as empty.
      const toolCalls: ToolCall[] = [];
      if (next && next.operation === "execute_tool") {
        toolCalls.push({
          id: next.toolCallId ?? `call_${next.spanId.slice(0, 8)}`,
          type: "function",
          function: {
            name: next.toolName ?? "unknown_tool",
            arguments: "{}",
          },
        });
      }

      messages.push({
        role: "assistant",
        content: assistantText.length > 0 ? assistantText : null,
        ...(toolCalls.length > 0 ? { tool_calls: toolCalls } : {}),
      });

      if (output.length === 0) {
        warnings.push(
          `No captured output for "${span.name}". Assistant turns will be reconstructed without their text.`,
        );
      }
      continue;
    }

    if (span.operation === "execute_tool") {
      const toolName = span.toolName ?? "unknown_tool";
      toolNames.add(toolName);

      const rawOutput = span.attributes["tool.output"];
      const output =
        typeof rawOutput === "string" ? rawOutput : (JSON.stringify(rawOutput ?? "") ?? "");
      const errorType = span.errorType ?? (span.statusCode === 2 ? "Error" : null);

      recordedOutputs[toolName] = { output, errorType, durationNs: span.durationNs };

      messages.push({
        role: "tool",
        content: output,
        name: toolName,
        tool_call_id: span.toolCallId ?? `call_${span.spanId.slice(0, 8)}`,
      });
    }
  }

  // Tools discovered later in the trace are still offered, so a replay is not
  // locked out of an action just because the fork point preceded its first use.
  for (const span of ordered) {
    if (span.operation === "execute_tool" && span.toolName) {
      toolNames.add(span.toolName);
      if (!recordedOutputs[span.toolName]) {
        const rawOutput = span.attributes["tool.output"];
        recordedOutputs[span.toolName] = {
          output: typeof rawOutput === "string" ? rawOutput : "",
          errorType: span.errorType ?? null,
          durationNs: span.durationNs,
        };
      }
    }
  }

  const tools: ReplayToolSpec[] = [...toolNames].map((name) => ({
    name,
    description: `Recovered from trace. Recorded result: ${
      recordedOutputs[name]?.errorType
        ? `failed (${recordedOutputs[name]!.errorType})`
        : recordedOutputs[name]?.output || "(empty)"
    }`,
    parameters: { type: "object", properties: {}, additionalProperties: true },
    schemaRecovered: false,
  }));

  if (tools.length > 0) {
    warnings.push(
      `Tool argument schemas are not present in OTel spans. ${tools.length} tool(s) are offered with a permissive schema; models will infer arguments from names alone.`,
    );
  }

  if (messages.length === 0) {
    warnings.push(
      "Could not reconstruct any messages. The trace may not have captured prompt content.",
    );
  }

  return {
    traceId: trace.traceId,
    forkSpanId,
    forkSpanName: forkSpan.name,
    messages,
    model,
    provider,
    tools,
    recordedOutputs,
    systemPrompt,
    warnings,
  };
}
