import { ATTR, SpanKind, StatusCode } from "@/lib/genai/semconv";
import { nsFromMs } from "@/lib/otlp/encode";
import { callChat, LlmError, type ChatResult } from "./llm";
import { newTraceId, ReplayTracer } from "./tracer";
import type {
  ReplayConfig,
  ReplayMessage,
  ReplayResult,
  ReplayStepResult,
  RecordedToolOutput,
} from "./types";

/**
 * Re-execute an agent run from a chosen fork point.
 *
 * Default behaviour is deterministic: tools replay their recorded results, so
 * the run reproduces what happened. Only explicit overrides change the outcome,
 * which is what turns this into counterfactual analysis — "if this timeout had
 * returned a value, would the agent still have looped?"
 *
 * The original agent's code is never involved. That is the point: the trace is
 * the specification, so a fork works even for agents you cannot run locally.
 */

function applySystemPrompt(
  messages: ReplayMessage[],
  systemPrompt: string | undefined,
): void {
  if (!systemPrompt) return;
  const index = messages.findIndex((m) => m.role === "system");
  if (index >= 0) {
    messages[index] = { ...messages[index]!, content: systemPrompt };
  } else {
    messages.unshift({ role: "system", content: systemPrompt });
  }
}

interface ResolvedTool {
  output: string;
  errorType: string | null;
  durationNs: number;
  overridden: boolean;
}

function resolveToolOutput(
  name: string,
  overrides: Record<string, string> | undefined,
  recorded: Record<string, RecordedToolOutput> | undefined,
): ResolvedTool {
  const override = overrides?.[name];
  if (override !== undefined) {
    return { output: override, errorType: null, durationNs: 0, overridden: true };
  }

  const rec = recorded?.[name];
  if (!rec) {
    return { output: "", errorType: "UnknownTool", durationNs: 0, overridden: false };
  }

  return {
    output: rec.output,
    errorType: rec.errorType,
    durationNs: rec.durationNs,
    overridden: false,
  };
}

export async function runReplay(config: ReplayConfig): Promise<ReplayResult> {
  const { context, overrides, maxSteps, llm } = config;

  const traceId = newTraceId();
  const tracer = new ReplayTracer(traceId, config.otlpEndpoint, {
    "service.name": "react-agent-debugger-replay",
    "telemetry.sdk.language": "nodejs",
    "replay.source_trace_id": context.traceId,
    "replay.fork_span_id": context.forkSpanId,
  });

  const messages: ReplayMessage[] = context.messages.map((m) => ({ ...m }));
  applySystemPrompt(messages, overrides.systemPrompt);

  const model = overrides.model ?? context.model ?? llm.model;
  const agentName = `replay:${context.traceId.slice(0, 8)}`;

  const traceStartNs = BigInt(Date.now()) * 1_000_000n;
  let cursorNs = traceStartNs;

  const rootSpanId = tracer.newSpanId();
  const loopSpanId = tracer.newSpanId();

  // Emit placeholders up front so the trace shows up immediately; the final
  // push below overwrites them with real timings (ingest upserts by span_id).
  tracer.push({
    spanId: rootSpanId,
    parentSpanId: null,
    name: `invoke_agent ${agentName}`,
    operation: "invoke_agent",
    kind: SpanKind.CLIENT,
    startNs: traceStartNs,
    endNs: cursorNs + nsFromMs(1),
    attributes: { [ATTR.AGENT_NAME]: agentName, "replay.in_progress": true },
  });
  tracer.push({
    spanId: loopSpanId,
    parentSpanId: rootSpanId,
    name: `invoke_agent ${agentName}`,
    operation: "invoke_agent",
    kind: SpanKind.INTERNAL,
    startNs: traceStartNs,
    endNs: cursorNs + nsFromMs(1),
    attributes: { [ATTR.AGENT_NAME]: agentName, "replay.in_progress": true },
  });
  await tracer.flush();

  const steps: ReplayStepResult[] = [];
  let finalAnswer: string | null = null;
  let stoppedReason: ReplayResult["stoppedReason"] = "max_steps";
  let errorMessage: string | undefined;

  for (let step = 0; step < maxSteps; step++) {
    const stepStartNs = cursorNs;
    const chatSpanId = tracer.newSpanId();

    let result: ChatResult;
    try {
      result = await callChat({ ...llm, model }, messages, context.tools);
    } catch (err) {
      errorMessage =
        err instanceof LlmError
          ? `${err.message}${err.body ? ` — ${err.body}` : ""}`
          : err instanceof Error
            ? err.message
            : String(err);
      stoppedReason = "error";

      const endNs = cursorNs + nsFromMs(1);
      tracer.push({
        spanId: chatSpanId,
        parentSpanId: loopSpanId,
        name: `chat ${model}`,
        operation: "chat",
        kind: SpanKind.CLIENT,
        startNs: stepStartNs,
        endNs,
        attributes: {
          [ATTR.REQUEST_MODEL]: model,
          [ATTR.PROVIDER_NAME]: llm.baseUrl,
          [ATTR.ERROR_TYPE]: "ReplayError",
        },
        status: { code: StatusCode.ERROR, message: errorMessage },
      });
      cursorNs = endNs;
      break;
    }

    const chatEndNs = stepStartNs + nsFromMs(Math.max(1, result.latencyMs));

    tracer.push({
      spanId: chatSpanId,
      parentSpanId: loopSpanId,
      name: `chat ${model}`,
      operation: "chat",
      kind: SpanKind.CLIENT,
      startNs: stepStartNs,
      endNs: chatEndNs,
      attributes: {
        [ATTR.PROVIDER_NAME]: llm.baseUrl,
        [ATTR.REQUEST_MODEL]: model,
        [ATTR.RESPONSE_MODEL]: result.model,
        [ATTR.USAGE_INPUT_TOKENS]: result.usage.inputTokens ?? undefined,
        [ATTR.USAGE_OUTPUT_TOKENS]: result.usage.outputTokens ?? undefined,
        [ATTR.USAGE_REASONING_TOKENS]: result.usage.reasoningTokens ?? undefined,
        [ATTR.INPUT_MESSAGES]: JSON.stringify(messages),
        [ATTR.OUTPUT_MESSAGES]: JSON.stringify([
          { role: "assistant", content: result.content ?? "" },
        ]),
      },
    });

    cursorNs = chatEndNs;

    messages.push({
      role: "assistant",
      content: result.content,
      ...(result.toolCalls.length > 0 ? { tool_calls: result.toolCalls } : {}),
    });

    const toolResults: ReplayStepResult["toolCalls"] = [];

    if (result.toolCalls.length > 0) {
      for (const toolCall of result.toolCalls) {
        const resolved = resolveToolOutput(
          toolCall.function.name,
          overrides.toolOutputs,
          context.recordedOutputs,
        );

        const toolStartNs = cursorNs;
        const toolEndNs = toolStartNs + BigInt(Math.max(0, Math.round(resolved.durationNs)));

        tracer.push({
          parentSpanId: chatSpanId,
          name: `execute_tool ${toolCall.function.name}`,
          operation: "execute_tool",
          kind: SpanKind.INTERNAL,
          startNs: toolStartNs,
          endNs: toolEndNs,
          attributes: {
            [ATTR.TOOL_NAME]: toolCall.function.name,
            [ATTR.TOOL_CALL_ID]: toolCall.id,
            "tool.arguments": toolCall.function.arguments,
            "tool.output": resolved.output,
            "tool.replayed": true,
            "tool.output_overridden": resolved.overridden,
            ...(resolved.errorType ? { [ATTR.ERROR_TYPE]: resolved.errorType } : {}),
          },
          status: resolved.errorType
            ? {
                code: StatusCode.ERROR,
                message: resolved.output || resolved.errorType,
              }
            : { code: StatusCode.OK },
        });

        cursorNs = toolEndNs;
        // A failed tool usually surfaces its exception text to the model, and
        // the model's next move depends on seeing it. Replay an empty failure
        // as its error type, otherwise the model cannot know it should retry.
        const toolContent =
          resolved.output || (resolved.errorType ? `Error: ${resolved.errorType}` : "");
        messages.push({
          role: "tool",
          content: toolContent,
          name: toolCall.function.name,
          tool_call_id: toolCall.id,
        });
        toolResults.push({
          name: toolCall.function.name,
          output: resolved.output,
          overridden: resolved.overridden,
        });
      }
    } else {
      finalAnswer = result.content;
      stoppedReason = "completed";
    }

    steps.push({
      step,
      finishReason: result.finishReason,
      inputTokens: result.usage.inputTokens,
      outputTokens: result.usage.outputTokens,
      reasoningTokens: result.usage.reasoningTokens,
      durationMs: result.latencyMs,
      toolCalls: toolResults,
      assistantText: result.content,
    });

    await tracer.flush();

    if (stoppedReason === "completed") break;
  }

  const traceEndNs = cursorNs + nsFromMs(1);

  tracer.push({
    spanId: loopSpanId,
    parentSpanId: rootSpanId,
    name: `invoke_agent ${agentName}`,
    operation: "invoke_agent",
    kind: SpanKind.INTERNAL,
    startNs: traceStartNs,
    endNs: traceEndNs,
    attributes: {
      [ATTR.AGENT_NAME]: agentName,
      "replay.source_trace_id": context.traceId,
      "replay.max_steps": maxSteps,
    },
    ...(errorMessage
      ? { status: { code: StatusCode.ERROR, message: errorMessage } }
      : {}),
  });

  tracer.push({
    spanId: rootSpanId,
    parentSpanId: null,
    name: `invoke_agent ${agentName}`,
    operation: "invoke_agent",
    kind: SpanKind.CLIENT,
    startNs: traceStartNs,
    endNs: traceEndNs,
    attributes: {
      [ATTR.AGENT_NAME]: agentName,
      [ATTR.CONVERSATION_ID]: `replay:${context.traceId.slice(0, 12)}`,
      "replay.source_trace_id": context.traceId,
      "replay.fork_span_id": context.forkSpanId,
      "replay.fork_span_name": context.forkSpanName,
      "replay.model_override": overrides.model ?? null,
      "replay.system_prompt_overridden": Boolean(overrides.systemPrompt),
      "replay.tool_overrides":
        Object.keys(overrides.toolOutputs ?? {}).join(",") || null,
      "replay.steps": steps.length,
    },
    status: errorMessage
      ? { code: StatusCode.ERROR, message: errorMessage }
      : { code: StatusCode.OK },
  });

  await tracer.flush();

  const totals = steps.reduce(
    (acc, s) => ({
      inputTokens: acc.inputTokens + (s.inputTokens ?? 0),
      outputTokens: acc.outputTokens + (s.outputTokens ?? 0),
      reasoningTokens: acc.reasoningTokens + (s.reasoningTokens ?? 0),
      durationMs: acc.durationMs + s.durationMs,
      toolCalls: acc.toolCalls + s.toolCalls.length,
    }),
    { inputTokens: 0, outputTokens: 0, reasoningTokens: 0, durationMs: 0, toolCalls: 0 },
  );

  return {
    traceId,
    sourceTraceId: context.traceId,
    forkSpanId: context.forkSpanId,
    steps,
    finalAnswer,
    stoppedReason,
    ...(errorMessage ? { error: errorMessage } : {}),
    totals,
  };
}
