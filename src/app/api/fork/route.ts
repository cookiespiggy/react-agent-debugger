import { z } from "zod";
import { getTrace } from "@/lib/db";
import { buildReplayContext } from "@/lib/replay/context";
import { runReplay } from "@/lib/replay/engine";

/**
 * Fork API.
 *
 *   GET  — reconstruct the replay context (no credentials needed, nothing runs)
 *   POST — execute the replay against an LLM
 *
 * The API key is read from the server environment only. It is never echoed to
 * the client; `llmConfigured` tells the UI whether replay is possible.
 */

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const MAX_STEPS_LIMIT = 15;

const ForkRequestSchema = z.object({
  traceId: z.string().regex(/^[0-9a-f]{32}$/i, "invalid trace id"),
  forkSpanId: z.string().regex(/^[0-9a-f]{16}$/i, "invalid span id"),
  maxSteps: z.number().int().min(1).max(MAX_STEPS_LIMIT).default(6),
  overrides: z
    .object({
      systemPrompt: z.string().max(20_000).optional(),
      model: z.string().max(200).optional(),
      toolOutputs: z.record(z.string(), z.string().max(50_000)).optional(),
    })
    .default({}),
});

interface LlmEnv {
  baseUrl: string;
  apiKey: string | null;
  model: string | null;
}

function readLlmEnv(): LlmEnv {
  return {
    baseUrl: process.env.REPLAY_LLM_BASE_URL?.trim() || "https://api.openai.com/v1",
    apiKey: process.env.REPLAY_LLM_API_KEY?.trim() || null,
    model: process.env.REPLAY_LLM_MODEL?.trim() || null,
  };
}

/** Derive our own OTLP endpoint from the incoming request. */
function otlpEndpointFrom(request: Request): string {
  const host = request.headers.get("host") ?? "localhost:3000";
  const proto = request.headers.get("x-forwarded-proto") ?? "http";
  return `${proto}://${host}/api/v1/traces`;
}

function fail(message: string, status = 400): Response {
  return Response.json({ error: message }, { status });
}

export async function GET(request: Request): Promise<Response> {
  const url = new URL(request.url);
  const traceId = url.searchParams.get("traceId");
  const forkSpanId = url.searchParams.get("spanId");

  if (!traceId || !forkSpanId) {
    return fail("Both traceId and spanId are required.");
  }

  let trace;
  try {
    trace = getTrace(traceId);
  } catch (err) {
    return fail(`Could not read trace: ${err instanceof Error ? err.message : err}`, 500);
  }
  if (!trace) return fail("Trace not found.", 404);

  let context;
  try {
    context = buildReplayContext(trace, forkSpanId);
  } catch (err) {
    return fail(err instanceof Error ? err.message : String(err));
  }

  const env = readLlmEnv();

  return Response.json({
    context,
    llmConfigured: env.apiKey !== null,
    baseUrl: env.baseUrl,
    defaultModel: env.model ?? context.model ?? trace.models[0] ?? null,
    availableModels: trace.models,
    maxStepsLimit: MAX_STEPS_LIMIT,
  });
}

export async function POST(request: Request): Promise<Response> {
  let payload: unknown;
  try {
    payload = await request.json();
  } catch {
    return fail("Request body must be JSON.");
  }

  const parsed = ForkRequestSchema.safeParse(payload);
  if (!parsed.success) {
    return fail(
      `Invalid request: ${parsed.error.issues.map((i) => `${i.path.join(".")} ${i.message}`).join("; ")}`,
    );
  }

  const { traceId, forkSpanId, maxSteps, overrides } = parsed.data;

  const env = readLlmEnv();
  if (!env.apiKey) {
    return fail(
      "Replay requires REPLAY_LLM_API_KEY to be set in the server environment.",
      503,
    );
  }

  let trace;
  try {
    trace = getTrace(traceId);
  } catch (err) {
    return fail(`Could not read trace: ${err instanceof Error ? err.message : err}`, 500);
  }
  if (!trace) return fail("Trace not found.", 404);

  let context;
  try {
    context = buildReplayContext(trace, forkSpanId);
  } catch (err) {
    return fail(err instanceof Error ? err.message : String(err));
  }

  try {
    const result = await runReplay({
      context,
      overrides,
      maxSteps,
      llm: {
        baseUrl: env.baseUrl,
        apiKey: env.apiKey,
        model: env.model ?? context.model ?? "gpt-4.1",
      },
      otlpEndpoint: otlpEndpointFrom(request),
    });

    return Response.json(result);
  } catch (err) {
    return fail(
      `Replay failed: ${err instanceof Error ? err.message : String(err)}`,
      500,
    );
  }
}
