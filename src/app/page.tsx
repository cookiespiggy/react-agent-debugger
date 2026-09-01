import Link from "next/link";
import { listTraces, stats, type TraceListItem } from "@/lib/db";
import {
  formatDuration,
  formatNumber,
  formatRelative,
  formatTokens,
} from "@/lib/format";
import { ClearTracesButton } from "@/components/ClearTracesButton";

// Reads SQLite on every request — must never be statically rendered.
export const dynamic = "force-dynamic";

interface PageProps {
  searchParams: Promise<{ errors?: string; q?: string }>;
}

export default async function TracesPage({ searchParams }: PageProps) {
  const sp = await searchParams;
  const onlyErrors = sp.errors === "1";
  const query = (sp.q ?? "").trim();

  let traces: TraceListItem[] = [];
  let dbError: string | null = null;
  let totals = { traceCount: 0, spanCount: 0 };

  try {
    traces = listTraces({ onlyErrors, query: query || undefined, limit: 200 });
    totals = stats();
  } catch (err) {
    dbError = err instanceof Error ? err.message : String(err);
  }

  const errorTraces = traces.filter((t) => t.errorCount > 0).length;

  return (
    <main className="mx-auto max-w-[1440px] px-6 py-10">
      <header className="mb-8 flex flex-wrap items-start justify-between gap-4">
        <div>
          <div className="flex items-center gap-3">
            <div className="flex h-8 w-8 items-center justify-center rounded-md border border-line bg-surface-2">
              <span className="font-mono text-xs text-accent">R</span>
            </div>
            <h1 className="text-lg font-medium tracking-tight">ReactAgentDebugger</h1>
          </div>
          <p className="mt-2 max-w-2xl text-sm text-fg-muted">
            Replay and diagnose ReAct agent runs. Ingests OTLP spans using the
            OpenTelemetry GenAI semantic conventions.
          </p>
        </div>

        <div className="flex items-center gap-3">
          <code className="rounded-md border border-line bg-surface px-2.5 py-1.5 font-mono text-xs text-fg-muted">
            POST /api/v1/traces
          </code>
          <Link
            href="/analytics"
            className="rounded-md border border-line bg-surface px-2.5 py-1.5 font-mono text-xs text-accent transition-colors hover:bg-surface-2"
          >
            Analytics
          </Link>
          {totals.traceCount > 0 && <ClearTracesButton />}
        </div>
      </header>

      {dbError && (
        <div className="mb-6 rounded-lg border border-danger-dim bg-danger/5 px-4 py-3 text-sm text-danger">
          Failed to read the trace store: {dbError}
        </div>
      )}

      {traces.length > 0 && (
        <section className="mb-6 grid grid-cols-2 gap-3 sm:grid-cols-4">
          <StatCard label="Traces" value={formatNumber(totals.traceCount)} />
          <StatCard label="Spans" value={formatNumber(totals.spanCount)} />
          <StatCard
            label="With errors"
            value={formatNumber(errorTraces)}
            tone={errorTraces > 0 ? "danger" : "default"}
          />
          <StatCard
            label="Tokens"
            value={formatTokens(traces.reduce((sum, t) => sum + t.totalTokens, 0))}
          />
        </section>
      )}

      <FilterBar onlyErrors={onlyErrors} query={query} hasTraces={traces.length > 0} />

      {traces.length === 0 ? (
        <EmptyState filtered={onlyErrors || query.length > 0} />
      ) : (
        <div className="overflow-hidden rounded-lg border border-line bg-surface">
          <div className="grid grid-cols-[1fr_auto] items-center gap-4 border-b border-line bg-surface-2 px-4 py-2.5 font-mono text-[11px] uppercase tracking-wider text-fg-subtle">
            <div>Trace</div>
            <div className="hidden grid-cols-[70px_90px_90px_110px_90px] gap-4 sm:grid">
              <div className="text-right">Spans</div>
              <div className="text-right">Duration</div>
              <div className="text-right">Tokens</div>
              <div className="text-right">Issues</div>
              <div className="text-right">Age</div>
            </div>
          </div>

          <ul className="divide-y divide-line">
            {traces.map((trace) => (
              <li key={trace.traceId}>
                <Link
                  href={`/traces/${trace.traceId}`}
                  className="grid grid-cols-[1fr_auto] items-center gap-4 px-4 py-3 transition-colors hover:bg-surface-2"
                >
                  <div className="min-w-0">
                    <div className="flex items-center gap-2">
                      <span
                        className={`h-1.5 w-1.5 shrink-0 rounded-full ${
                          trace.errorCount > 0
                            ? "bg-danger"
                            : trace.warningCount > 0
                              ? "bg-warn"
                              : "bg-ok"
                        }`}
                      />
                      <span className="truncate text-sm font-medium">
                        {trace.agentName ?? "unnamed agent"}
                      </span>
                      <code className="shrink-0 font-mono text-[11px] text-fg-subtle">
                        {trace.traceId.slice(0, 12)}
                      </code>
                    </div>
                    <div className="mt-1 flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-fg-subtle">
                      <span className="font-mono">
                        {trace.modelCalls} calls · {trace.toolCalls} tools
                      </span>
                      {trace.models.length > 0 && (
                        <span className="font-mono truncate">
                          {trace.models.join(", ")}
                        </span>
                      )}
                    </div>
                  </div>

                  <div className="hidden grid-cols-[70px_90px_90px_110px_90px] items-center gap-4 text-right font-mono text-xs sm:grid">
                    <div className="nums text-fg-muted">{trace.spanCount}</div>
                    <div className="nums text-fg-muted">
                      {formatDuration(trace.durationNs)}
                    </div>
                    <div className="nums text-fg-muted">
                      {formatTokens(trace.totalTokens)}
                    </div>
                    <div className="flex items-center justify-end gap-1.5">
                      {trace.errorCount > 0 && (
                        <Badge tone="danger">{trace.errorCount} err</Badge>
                      )}
                      {trace.warningCount > 0 && (
                        <Badge tone="warn">{trace.warningCount} warn</Badge>
                      )}
                      {trace.errorCount === 0 && trace.warningCount === 0 && (
                        <span className="text-fg-subtle">—</span>
                      )}
                    </div>
                    <div className="nums text-fg-subtle">
                      {formatRelative(trace.startedAtMs)}
                    </div>
                  </div>
                </Link>
              </li>
            ))}
          </ul>
        </div>
      )}
    </main>
  );
}

function StatCard({
  label,
  value,
  tone = "default",
}: {
  label: string;
  value: string;
  tone?: "default" | "danger";
}) {
  return (
    <div className="rounded-lg border border-line bg-surface px-4 py-3">
      <div className="text-[11px] uppercase tracking-wider text-fg-subtle">
        {label}
      </div>
      <div
        className={`nums mt-1 text-xl font-medium ${
          tone === "danger" ? "text-danger" : "text-fg"
        }`}
      >
        {value}
      </div>
    </div>
  );
}

function Badge({
  children,
  tone,
}: {
  children: React.ReactNode;
  tone: "danger" | "warn";
}) {
  const cls =
    tone === "danger"
      ? "border-danger-dim bg-danger/10 text-danger"
      : "border-tool-dim bg-warn/10 text-warn";
  return (
    <span
      className={`rounded border px-1.5 py-0.5 font-mono text-[10px] leading-none ${cls}`}
    >
      {children}
    </span>
  );
}

function FilterBar({
  onlyErrors,
  query,
  hasTraces,
}: {
  onlyErrors: boolean;
  query: string;
  hasTraces: boolean;
}) {
  if (!hasTraces) return null;

  return (
    <form className="mb-3 flex flex-wrap items-center gap-3" action="/">
      <input
        type="text"
        name="q"
        defaultValue={query}
        placeholder="Filter by agent, conversation, trace id…"
        className="h-8 w-72 rounded-md border border-line bg-surface px-3 text-sm text-fg placeholder:text-fg-subtle focus:border-accent-dim focus:outline-none"
      />
      <label className="flex h-8 cursor-pointer items-center gap-2 rounded-md border border-line bg-surface px-3 text-sm text-fg-muted transition-colors hover:bg-surface-2">
        <input
          type="checkbox"
          name="errors"
          value="1"
          defaultChecked={onlyErrors}
          className="h-3 w-3 accent-accent"
        />
        Errors only
      </label>
      <button
        type="submit"
        className="h-8 rounded-md border border-line bg-surface-2 px-3 text-sm text-fg-muted transition-colors hover:text-fg"
      >
        Apply
      </button>
    </form>
  );
}

function EmptyState({ filtered }: { filtered: boolean }) {
  if (filtered) {
    return (
      <div className="rounded-lg border border-line bg-surface px-6 py-16 text-center">
        <p className="text-sm text-fg-muted">No traces match these filters.</p>
        <Link href="/" className="mt-3 inline-block text-sm text-accent hover:underline">
          Clear filters
        </Link>
      </div>
    );
  }

  return (
    <div className="rounded-lg border border-line bg-surface px-6 py-14">
      <div className="mx-auto max-w-2xl">
        <h2 className="text-center text-sm font-medium">No traces yet</h2>
        <p className="mt-2 text-center text-sm text-fg-muted">
          Point any OpenTelemetry-instrumented agent at this collector.
        </p>

        <div className="mt-6 rounded-md border border-line bg-canvas px-4 py-3">
          <div className="mb-2 text-[11px] uppercase tracking-wider text-fg-subtle">
            Environment variables
          </div>
          <pre className="overflow-x-auto font-mono text-xs leading-relaxed text-fg-muted">
            {`OTEL_EXPORTER_OTLP_ENDPOINT=http://localhost:3000/api/v1
OTEL_EXPORTER_OTLP_PROTOCOL=http/protobuf   # or http/json`}
          </pre>
        </div>

        <div className="mt-4 rounded-md border border-line bg-canvas px-4 py-3">
          <div className="mb-2 text-[11px] uppercase tracking-wider text-fg-subtle">
            Or generate sample traces
          </div>
          <pre className="overflow-x-auto font-mono text-xs text-fg-muted">
            npm run mock
          </pre>
          <p className="mt-2 text-xs text-fg-subtle">
            Emits six scenarios: a clean ReAct loop, a retry storm, a pre-v1.37
            SDK, a reasoning model under-reporting tokens, runaway context
            growth, and a cascading failure.
          </p>
        </div>
      </div>
    </div>
  );
}
