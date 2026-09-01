"use client";

import { useCallback, useEffect, useState } from "react";
import { formatNumber, formatTokens } from "@/lib/format";
import type { ReplayContext, ReplayResult } from "@/lib/replay/types";
import type { SpanView, TraceView } from "@/lib/trace/tree";

interface ForkContextResponse {
  context: ReplayContext;
  llmConfigured: boolean;
  baseUrl: string;
  defaultModel: string | null;
  availableModels: string[];
  maxStepsLimit: number;
}

interface ForkPanelProps {
  trace: TraceView;
  span: SpanView;
  onClose: () => void;
  onComplete: (result: ReplayResult) => void;
}

const ROLE_STYLE: Record<string, string> = {
  system: "border-line bg-surface-2 text-fg-muted",
  user: "border-accent-dim bg-accent/5 text-fg",
  assistant: "border-agent-dim bg-agent/5 text-fg",
  tool: "border-tool-dim bg-tool/5 text-fg",
};

export function ForkPanel({ trace, span, onClose, onComplete }: ForkPanelProps) {
  const [data, setData] = useState<ForkContextResponse | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  const [toolOverrides, setToolOverrides] = useState<Record<string, string>>({});
  const [systemPrompt, setSystemPrompt] = useState<string | null>(null);
  const [model, setModel] = useState<string>("");
  const [maxSteps, setMaxSteps] = useState(6);

  const [running, setRunning] = useState(false);
  const [result, setResult] = useState<ReplayResult | null>(null);
  const [runError, setRunError] = useState<string | null>(null);
  const [showMessages, setShowMessages] = useState(false);
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setLoadError(null);

    fetch(
      `/api/fork?traceId=${encodeURIComponent(trace.traceId)}&spanId=${encodeURIComponent(span.spanId)}`,
    )
      .then(async (res) => {
        const body = await res.json();
        if (!res.ok) throw new Error(body?.error ?? `HTTP ${res.status}`);
        return body as ForkContextResponse;
      })
      .then((body) => {
        if (cancelled) return;
        setData(body);
        setModel(body.defaultModel ?? "");
      })
      .catch((err: unknown) => {
        if (cancelled) return;
        setLoadError(err instanceof Error ? err.message : String(err));
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });

    return () => {
      cancelled = true;
    };
  }, [trace.traceId, span.spanId]);

  const context = data?.context ?? null;

  const run = useCallback(async () => {
    if (!context) return;
    setRunning(true);
    setRunError(null);
    setResult(null);

    const overrides: {
      systemPrompt?: string;
      model?: string;
      toolOutputs?: Record<string, string>;
    } = {};

    if (systemPrompt !== null && systemPrompt !== context.systemPrompt) {
      overrides.systemPrompt = systemPrompt;
    }
    if (model && model !== (data?.defaultModel ?? context.model)) {
      overrides.model = model;
    }
    if (Object.keys(toolOverrides).length > 0) {
      overrides.toolOutputs = toolOverrides;
    }

    try {
      const res = await fetch("/api/fork", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          traceId: trace.traceId,
          forkSpanId: span.spanId,
          maxSteps,
          overrides,
        }),
      });
      const body = await res.json();
      if (!res.ok) throw new Error(body?.error ?? `HTTP ${res.status}`);
      const replay = body as ReplayResult;
      setResult(replay);
      onComplete(replay);
    } catch (err) {
      setRunError(err instanceof Error ? err.message : String(err));
    } finally {
      setRunning(false);
    }
  }, [
    context,
    systemPrompt,
    model,
    toolOverrides,
    maxSteps,
    trace.traceId,
    span.spanId,
    data?.defaultModel,
    onComplete,
  ]);

  if (loading) {
    return (
      <div className="p-4 text-sm text-fg-subtle">Rebuilding context…</div>
    );
  }

  if (loadError) {
    return (
      <div className="p-4">
        <div className="rounded-md border border-danger-dim bg-danger/5 px-3 py-2 text-xs text-danger">
          {loadError}
        </div>
        <button
          type="button"
          onClick={onClose}
          className="mt-3 h-7 rounded border border-line px-2.5 text-xs text-fg-muted hover:bg-surface-2"
        >
          Back
        </button>
      </div>
    );
  }

  if (!context || !data) return null;

  const overrideCount = Object.keys(toolOverrides).length;

  return (
    <div className="flex h-full min-h-0 flex-col">
      {/* Header */}
      <div className="shrink-0 border-b border-line px-4 py-3">
        <div className="flex items-center gap-2">
          <span className="rounded bg-accent/15 px-1.5 py-0.5 font-mono text-[10px] uppercase tracking-wide text-accent">
            fork
          </span>
          <h2 className="truncate text-sm font-medium">Replay from here</h2>
          <button
            type="button"
            onClick={onClose}
            className="ml-auto shrink-0 rounded border border-line px-2 py-0.5 text-xs text-fg-muted hover:bg-surface-2 hover:text-fg"
          >
            Close
          </button>
        </div>
        <p className="mt-1.5 font-mono text-[11px] text-fg-subtle">
          resume after <span className="text-fg-muted">{context.forkSpanName}</span>
        </p>
      </div>

      <div className="min-h-0 flex-1 space-y-4 overflow-auto px-4 py-3">
        {/* Principle */}
        <div className="rounded-md border border-line bg-surface-2 px-3 py-2 text-[11px] leading-relaxed text-fg-muted">
          Fork re-runs the agent from this step. Leave tool results recorded to{" "}
          <span className="text-fg">reproduce</span> the original run; override
          one to run a <span className="text-accent">counterfactual</span> — then
          open the comparison to see exactly what changed.
        </div>

        {/* Reconstruction warnings */}
        {context.warnings.length > 0 && (
          <div className="space-y-1.5">
            {context.warnings.map((warning, i) => (
              <div
                key={i}
                className="rounded-md border border-tool-dim bg-warn/5 px-2.5 py-2 text-[11px] leading-relaxed text-warn"
              >
                <span className="mr-1 font-mono">▲</span>
                {warning}
              </div>
            ))}
          </div>
        )}

        {/* Rebuilt context */}
        <section>
          <div className="mb-1.5 flex items-center gap-2">
            <span className="text-[10px] uppercase tracking-wider text-fg-subtle">
              Rebuilt context
            </span>
            <span className="font-mono text-[10px] text-fg-subtle">
              {context.messages.length} messages
            </span>
            <button
              type="button"
              onClick={() => setShowMessages((v) => !v)}
              className="ml-auto text-[10px] text-accent hover:underline"
            >
              {showMessages ? "hide" : "show"}
            </button>
            <button
              type="button"
              onClick={() => {
                void navigator.clipboard
                  .writeText(JSON.stringify(context, null, 2))
                  .then(() => {
                    setCopied(true);
                    setTimeout(() => setCopied(false), 1500);
                  });
              }}
              className="text-[10px] text-accent hover:underline"
            >
              {copied ? "copied" : "copy json"}
            </button>
          </div>

          {showMessages && (
            <div className="space-y-1.5">
              {context.messages.map((msg, i) => (
                <div
                  key={i}
                  className={`rounded-md border px-2.5 py-1.5 ${ROLE_STYLE[msg.role] ?? ROLE_STYLE.system}`}
                >
                  <div className="mb-0.5 flex items-center gap-1.5 font-mono text-[10px] uppercase tracking-wider text-fg-subtle">
                    {msg.role}
                    {msg.name && <span>· {msg.name}</span>}
                    {msg.tool_calls && msg.tool_calls.length > 0 && (
                      <span className="text-tool">
                        → {msg.tool_calls.map((tc) => tc.function.name).join(", ")}
                      </span>
                    )}
                  </div>
                  <div className="max-h-40 overflow-auto whitespace-pre-wrap text-[11px] leading-relaxed">
                    {msg.content ?? "(empty)"}
                  </div>
                </div>
              ))}
            </div>
          )}
        </section>

        {/* Tool overrides */}
        {context.tools.length > 0 && (
          <section>
            <div className="mb-1.5 flex items-center gap-2">
              <span className="text-[10px] uppercase tracking-wider text-fg-subtle">
                Tool results
              </span>
              <span className="font-mono text-[10px] text-fg-subtle">
                {overrideCount} overridden
              </span>
            </div>
            <p className="mb-2 text-[11px] leading-relaxed text-fg-subtle">
              Replays return the recorded result by default, reproducing the
              original run. Change a value to test a counterfactual — e.g. what
              happens if that timeout had succeeded.
            </p>
            <div className="space-y-2">
              {context.tools.map((tool) => {
                const recorded = context.recordedOutputs[tool.name];
                const overridden = toolOverrides[tool.name] !== undefined;
                return (
                  <div key={tool.name}>
                    <div className="mb-1 flex items-center gap-1.5">
                      <span className="font-mono text-[11px] text-tool">
                        {tool.name}
                      </span>
                      {recorded?.errorType && (
                        <span className="rounded bg-danger/15 px-1 font-mono text-[10px] text-danger">
                          {recorded.errorType}
                        </span>
                      )}
                      {overridden ? (
                        <button
                          type="button"
                          onClick={() =>
                            setToolOverrides((prev) => {
                              const next = { ...prev };
                              delete next[tool.name];
                              return next;
                            })
                          }
                          className="ml-auto text-[10px] text-accent hover:underline"
                        >
                          reset
                        </button>
                      ) : (
                        <span className="ml-auto font-mono text-[10px] text-fg-subtle">
                          recorded
                        </span>
                      )}
                    </div>
                    <textarea
                      value={toolOverrides[tool.name] ?? recorded?.output ?? ""}
                      onChange={(e) =>
                        setToolOverrides((prev) => ({
                          ...prev,
                          [tool.name]: e.target.value,
                        }))
                      }
                      rows={2}
                      className={`w-full resize-y rounded border bg-canvas px-2 py-1.5 font-mono text-[11px] text-fg focus:outline-none ${
                        overridden
                          ? "border-accent-dim focus:border-accent"
                          : "border-line focus:border-line-strong"
                      }`}
                    />
                  </div>
                );
              })}
            </div>
          </section>
        )}

        {/* Model */}
        <section>
          <div className="mb-1.5 text-[10px] uppercase tracking-wider text-fg-subtle">
            Model
          </div>
          <input
            type="text"
            value={model}
            onChange={(e) => setModel(e.target.value)}
            list="fork-model-options"
            placeholder="model id"
            className="h-7 w-full rounded border border-line bg-canvas px-2 font-mono text-[11px] text-fg placeholder:text-fg-subtle focus:border-accent-dim focus:outline-none"
          />
          <datalist id="fork-model-options">
            {data.availableModels.map((m) => (
              <option key={m} value={m} />
            ))}
          </datalist>
          {model !== (data.defaultModel ?? context.model) && (
            <p className="mt-1 text-[11px] text-accent">
              Swapping the model isolates whether the failure is model-specific.
            </p>
          )}
        </section>

        {/* System prompt */}
        {context.systemPrompt !== null && (
          <section>
            <div className="mb-1.5 flex items-center gap-2">
              <span className="text-[10px] uppercase tracking-wider text-fg-subtle">
                System prompt
              </span>
              {systemPrompt !== null &&
                systemPrompt !== context.systemPrompt && (
                  <button
                    type="button"
                    onClick={() => setSystemPrompt(null)}
                    className="ml-auto text-[10px] text-accent hover:underline"
                  >
                    reset
                  </button>
                )}
            </div>
            <textarea
              value={systemPrompt ?? context.systemPrompt}
              onChange={(e) => setSystemPrompt(e.target.value)}
              rows={4}
              className="w-full resize-y rounded border border-line bg-canvas px-2 py-1.5 font-mono text-[11px] leading-relaxed text-fg focus:border-accent-dim focus:outline-none"
            />
          </section>
        )}

        {/* Steps */}
        <section>
          <div className="mb-1.5 text-[10px] uppercase tracking-wider text-fg-subtle">
            Max steps
          </div>
          <input
            type="number"
            min={1}
            max={data.maxStepsLimit}
            value={maxSteps}
            onChange={(e) =>
              setMaxSteps(
                Math.max(1, Math.min(data.maxStepsLimit, Number(e.target.value) || 1)),
              )
            }
            className="nums h-7 w-20 rounded border border-line bg-canvas px-2 font-mono text-[11px] text-fg focus:border-accent-dim focus:outline-none"
          />
        </section>

        {/* Result / error */}
        {runError && (
          <div className="rounded-md border border-danger-dim bg-danger/5 px-2.5 py-2 text-[11px] leading-relaxed text-danger">
            {runError}
          </div>
        )}

        {result && (
          <section className="rounded-md border border-line bg-surface-2 p-3">
            <div className="mb-2 font-mono text-[10px] uppercase tracking-wider text-fg-subtle">
              Result
            </div>
            <dl className="space-y-0.5 font-mono text-[11px]">
              <Row
                label="stopped"
                value={
                  result.stoppedReason === "completed"
                    ? "completed"
                    : result.stoppedReason === "max_steps"
                      ? "hit max steps"
                      : "error"
                }
                tone={result.stoppedReason === "completed" ? "ok" : "warn"}
              />
              <Row label="steps" value={String(result.steps.length)} />
              <Row label="tool calls" value={String(result.totals.toolCalls)} />
              <Row
                label="tokens"
                value={formatTokens(
                  result.totals.inputTokens +
                    result.totals.outputTokens +
                    result.totals.reasoningTokens,
                )}
              />
            </dl>

            {result.finalAnswer && (
              <div className="mt-2 max-h-32 overflow-auto rounded border border-line bg-canvas px-2 py-1.5 text-[11px] leading-relaxed text-fg-muted">
                {result.finalAnswer}
              </div>
            )}

            <div className="mt-3 flex flex-wrap gap-2">
              <a
                href={`/traces/${result.traceId}`}
                className="rounded border border-line px-2 py-1 text-[11px] text-accent hover:bg-surface-3"
              >
                Open replay trace
              </a>
              <a
                href={`/compare?a=${result.sourceTraceId}&b=${result.traceId}`}
                className="rounded border border-accent-dim bg-accent/10 px-2 py-1 text-[11px] text-accent hover:bg-accent/20"
              >
                Compare with original
              </a>
            </div>
          </section>
        )}
      </div>

      {/* Footer */}
      <div className="shrink-0 border-t border-line px-4 py-3">
        {!data.llmConfigured ? (
          <div className="space-y-2">
            <p className="text-[11px] leading-relaxed text-fg-subtle">
              Set <code className="font-mono text-fg-muted">REPLAY_LLM_API_KEY</code>{" "}
              in the server environment to execute replays. The rebuilt context
              above is still useful on its own.
            </p>
            <pre className="overflow-x-auto rounded border border-line bg-canvas px-2.5 py-2 font-mono text-[10px] leading-relaxed text-fg-muted">
              {`REPLAY_LLM_API_KEY=sk-...
REPLAY_LLM_BASE_URL=https://api.openai.com/v1  # optional
REPLAY_LLM_MODEL=gpt-4.1                      # optional`}
            </pre>
          </div>
        ) : (
          <button
            type="button"
            onClick={() => void run()}
            disabled={running}
            className="h-8 w-full rounded border border-accent-dim bg-accent/10 text-xs text-accent transition-colors hover:bg-accent/20 disabled:opacity-50"
          >
            {running ? "Replaying…" : "Run replay"}
          </button>
        )}
        <p className="mt-2 font-mono text-[10px] leading-relaxed text-fg-subtle">
          base url {data.baseUrl}
        </p>
      </div>
    </div>
  );
}

function Row({
  label,
  value,
  tone = "default",
}: {
  label: string;
  value: string;
  tone?: "default" | "ok" | "warn";
}) {
  const cls =
    tone === "ok" ? "text-ok" : tone === "warn" ? "text-warn" : "text-fg";
  return (
    <div className="flex items-baseline justify-between gap-3">
      <dt className="text-fg-subtle">{label}</dt>
      <dd className={`nums ${cls}`}>{value}</dd>
    </div>
  );
}
