import Link from "next/link";
import { notFound } from "next/navigation";
import { getTrace } from "@/lib/db";
import { formatDuration, formatNumber, formatTokens } from "@/lib/format";
import { diffSpanSequence, summarizeDiff, type SpanDiffRow } from "@/lib/trace/diff";
import { analyzeTrace, type Insight } from "@/lib/trace/insights";
import type { TraceView } from "@/lib/trace/tree";

export const dynamic = "force-dynamic";

interface PageProps {
  searchParams: Promise<{ a?: string; b?: string }>;
}

export default async function ComparePage({ searchParams }: PageProps) {
  const { a, b } = await searchParams;
  if (!a || !b) notFound();

  const traceA = getTrace(a);
  const traceB = getTrace(b);
  if (!traceA || !traceB) notFound();

  const labelA = roleOf(traceA, traceB) ?? "Trace A";
  const labelB = roleOf(traceB, traceA) ?? "Trace B";
  const isForkCompare =
    traceA.sourceTraceId === traceB.traceId ||
    traceB.sourceTraceId === traceA.traceId;

  const orderedA = ordered(traceA);
  const orderedB = ordered(traceB);

  const rows = diffSpanSequence(orderedA, orderedB);
  const summary = summarizeDiff(rows);

  const insightsA = analyzeTrace(traceA);
  const insightsB = analyzeTrace(traceB);

  const idOf = (i: Insight) => i.id;
  const resolved = insightsA.filter(
    (ia) => !insightsB.some((ib) => idOf(ib) === idOf(ia)),
  );
  const persisted = insightsA.filter((ia) =>
    insightsB.some((ib) => idOf(ib) === idOf(ia)),
  );
  const introduced = insightsB.filter(
    (ib) => !insightsA.some((ia) => idOf(ia) === idOf(ib)),
  );

  return (
    <main className="mx-auto max-w-[1200px] px-6 py-8">
      <header className="mb-6">
        <Link
          href="/"
          className="text-xs text-fg-muted transition-colors hover:text-fg"
        >
          ← Traces
        </Link>
        <h1 className="mt-2 text-lg font-medium tracking-tight">
          Replay comparison
        </h1>
        <p className="mt-1 max-w-2xl text-[12px] leading-relaxed text-fg-subtle">
          {isForkCompare
            ? "One of these is a replay forked from the other. The Diagnosis block shows whether the change solved the original problem or just moved it; the Metric block quantifies the difference."
            : "Two runs side by side. The Diagnosis block shows which problems were resolved, persisted, or introduced between them."}
        </p>
        <div className="mt-3 grid grid-cols-2 gap-3">
          <TraceCard trace={traceA} label={labelA} />
          <TraceCard trace={traceB} label={labelB} />
        </div>
      </header>

      {/* Metrics */}
      <section className="mb-6">
        <h2 className="mb-2 text-[11px] uppercase tracking-wider text-fg-subtle">
          Metrics
        </h2>
        <div className="overflow-hidden rounded-lg border border-line bg-surface">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-line bg-surface-2 font-mono text-[10px] uppercase tracking-wider text-fg-subtle">
                <th className="px-4 py-2 text-left font-normal">Metric</th>
                <th className="px-4 py-2 text-right font-normal">Original</th>
                <th className="px-4 py-2 text-right font-normal">Replay</th>
                <th className="px-4 py-2 text-right font-normal">Delta</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-line font-mono text-xs">
              <MetricRow
                label="Duration"
                a={traceA.durationNs}
                b={traceB.durationNs}
                format={formatDuration}
                lowerIsBetter
              />
              <MetricRow
                label="Spans"
                a={traceA.totals.spanCount}
                b={traceB.totals.spanCount}
                format={formatNumber}
              />
              <MetricRow
                label="Model calls"
                a={traceA.totals.modelCalls}
                b={traceB.totals.modelCalls}
                format={formatNumber}
                lowerIsBetter
              />
              <MetricRow
                label="Tool calls"
                a={traceA.totals.toolCalls}
                b={traceB.totals.toolCalls}
                format={formatNumber}
                lowerIsBetter
              />
              <MetricRow
                label="Input tokens"
                a={traceA.totals.inputTokens}
                b={traceB.totals.inputTokens}
                format={formatTokens}
                lowerIsBetter
              />
              <MetricRow
                label="Output tokens"
                a={traceA.totals.outputTokens}
                b={traceB.totals.outputTokens}
                format={formatTokens}
              />
              <MetricRow
                label="Reasoning tokens"
                a={traceA.totals.reasoningTokens}
                b={traceB.totals.reasoningTokens}
                format={formatTokens}
              />
              <MetricRow
                label="Total tokens"
                a={traceA.totals.totalTokens}
                b={traceB.totals.totalTokens}
                format={formatTokens}
                lowerIsBetter
              />
              <MetricRow
                label="Errors"
                a={traceA.totals.errorCount}
                b={traceB.totals.errorCount}
                format={formatNumber}
                lowerIsBetter
              />
              <MetricRow
                label="Warnings"
                a={traceA.totals.warningCount}
                b={traceB.totals.warningCount}
                format={formatNumber}
                lowerIsBetter
              />
            </tbody>
          </table>
        </div>
      </section>

      {/* Diagnosis diff — did the change actually help? */}
      <section className="mb-6">
        <h2 className="mb-2 text-[11px] uppercase tracking-wider text-fg-subtle">
          Diagnosis
        </h2>
        <p className="mb-2 max-w-2xl text-[11px] leading-relaxed text-fg-subtle">
          Did the change actually help? Each finding from either run is checked
          against the other.
        </p>
        <div className="mb-3 flex flex-wrap items-center gap-x-4 gap-y-1.5 font-mono text-[10px]">
          <span className="flex items-center gap-1.5">
            <span className="h-2 w-2 rounded-full bg-ok" /> Resolved
            <span className="text-fg-subtle">— fixed by the change</span>
          </span>
          <span className="flex items-center gap-1.5">
            <span className="h-2 w-2 rounded-full bg-warn" /> Persisted
            <span className="text-fg-subtle">— still present</span>
          </span>
          <span className="flex items-center gap-1.5">
            <span className="h-2 w-2 rounded-full bg-danger" /> Introduced
            <span className="text-fg-subtle">— new side effect</span>
          </span>
        </div>
        <div className="space-y-3">
          {resolved.length === 0 &&
          persisted.length === 0 &&
          introduced.length === 0 ? (
            <p className="rounded-lg border border-line bg-surface px-4 py-6 text-center text-sm text-fg-subtle">
              Neither run has any findings.
            </p>
          ) : (
            <>
              {resolved.length > 0 && (
                <InsightGroup
                  title="Resolved"
                  tone="ok"
                  note="Present in the original, gone in the replay."
                  insights={resolved}
                  traceId={traceA.traceId}
                />
              )}
              {introduced.length > 0 && (
                <InsightGroup
                  title="Introduced"
                  tone="danger"
                  note="New in the replay — a side effect of the change."
                  insights={introduced}
                  traceId={traceB.traceId}
                />
              )}
              {persisted.length > 0 && (
                <InsightGroup
                  title="Persisted"
                  tone="warn"
                  note="Still present after the change."
                  insights={persisted}
                  traceId={traceB.traceId}
                />
              )}
            </>
          )}
        </div>
      </section>

      {/* Span sequence */}
      <section>
        <h2 className="mb-2 flex items-center gap-3 text-[11px] uppercase tracking-wider text-fg-subtle">
          Span sequence
          <span className="font-mono normal-case tracking-normal">
            <span className="text-ok">{summary.same} same</span>
            {summary.added > 0 && (
              <span className="ml-2 text-accent">+{summary.added}</span>
            )}
            {summary.removed > 0 && (
              <span className="ml-2 text-danger">−{summary.removed}</span>
            )}
          </span>
        </h2>

        <div className="overflow-hidden rounded-lg border border-line bg-surface">
          {rows.length === 0 ? (
            <p className="px-4 py-8 text-center text-sm text-fg-subtle">
              No spans to compare.
            </p>
          ) : (
            <ul className="divide-y divide-line font-mono text-[11px]">
              {rows.map((row, i) => (
                <DiffRowView key={i} row={row} />
              ))}
            </ul>
          )}
        </div>
      </section>
    </main>
  );
}

function roleOf(trace: TraceView, other: TraceView): string | null {
  if (trace.sourceTraceId === other.traceId) return "Replay";
  if (other.sourceTraceId === trace.traceId) return "Original";
  return null;
}

function ordered(trace: TraceView) {
  return trace.orderedIds
    .map((id) => trace.byId[id])
    .filter((s): s is NonNullable<typeof s> => s !== undefined)
    .sort((x, y) => x.startOffsetNs - y.startOffsetNs);
}

function TraceCard({ trace, label }: { trace: TraceView; label: string }) {
  return (
    <div className="rounded-lg border border-line bg-surface px-3 py-2.5">
      <div className="flex items-baseline gap-2">
        <span className="text-[10px] uppercase tracking-wider text-fg-subtle">
          {label}
        </span>
        <span className="truncate text-sm">{trace.agentName ?? "unnamed"}</span>
      </div>
      <div className="mt-1 flex items-center gap-2 font-mono text-[10px] text-fg-subtle">
        <code>{trace.traceId.slice(0, 12)}</code>
        <Link
          href={`/traces/${trace.traceId}`}
          className="text-accent hover:underline"
        >
          open
        </Link>
      </div>
    </div>
  );
}

function MetricRow({
  label,
  a,
  b,
  format,
  lowerIsBetter = false,
}: {
  label: string;
  a: number;
  b: number;
  format: (n: number) => string;
  lowerIsBetter?: boolean;
}) {
  const delta = b - a;
  let tone = "text-fg-subtle";
  if (delta !== 0 && lowerIsBetter) {
    tone = delta < 0 ? "text-ok" : "text-warn";
  } else if (delta !== 0) {
    tone = "text-fg-muted";
  }

  return (
    <tr>
      <td className="px-4 py-2 text-fg-muted">{label}</td>
      <td className="nums px-4 py-2 text-right text-fg-muted">{format(a)}</td>
      <td className="nums px-4 py-2 text-right text-fg">{format(b)}</td>
      <td className={`nums px-4 py-2 text-right ${tone}`}>
        {delta === 0
          ? "—"
          : `${delta > 0 ? "+" : "−"}${format(Math.abs(delta))}`}
      </td>
    </tr>
  );
}

function InsightGroup({
  title,
  tone,
  note,
  insights,
  traceId,
}: {
  title: string;
  tone: "ok" | "warn" | "danger";
  note: string;
  insights: Insight[];
  traceId: string;
}) {
  const toneCls =
    tone === "ok"
      ? "border-ok/40 bg-ok/5"
      : tone === "danger"
        ? "border-danger-dim bg-danger/5"
        : "border-tool-dim bg-warn/5";

  return (
    <div className={`rounded-lg border px-3 py-2.5 ${toneCls}`}>
      <div className="flex items-baseline gap-2">
        <span className="text-[11px] font-medium uppercase tracking-wider">
          {title}
        </span>
        <span className="font-mono text-[10px] text-fg-subtle">{note}</span>
      </div>
      <ul className="mt-2 space-y-2">
        {insights.map((insight) => (
          <li key={insight.id} className="text-[12px] leading-relaxed">
            <span className="font-medium">{insight.title}</span>
            <p className="mt-0.5 text-[11px] text-fg-muted">{insight.detail}</p>
            <Link
              href={`/traces/${traceId}`}
              className="mt-1 inline-block font-mono text-[10px] text-accent hover:underline"
            >
              view spans →
            </Link>
          </li>
        ))}
      </ul>
    </div>
  );
}

function DiffRowView({ row }: { row: SpanDiffRow }) {
  const marker =
    row.kind === "same" ? " " : row.kind === "added" ? "+" : "−";
  const tone =
    row.kind === "same"
      ? "text-fg-subtle"
      : row.kind === "added"
        ? "text-accent"
        : "text-danger";
  const bg =
    row.kind === "added"
      ? "bg-accent/5"
      : row.kind === "removed"
        ? "bg-danger/5"
        : "";

  const span = row.b ?? row.a;
  if (!span) return null;

  const label = span.toolName ?? span.model ?? span.name;

  return (
    <li className={`flex items-center gap-2 px-4 py-1.5 ${bg}`}>
      <span className={`w-3 shrink-0 ${tone}`}>{marker}</span>
      <span className="w-10 shrink-0 text-right text-fg-subtle">
        {span.operation ?? "?"}
      </span>
      <span className="truncate text-fg-muted">{label}</span>
      <span className="ml-auto shrink-0 text-fg-subtle">
        {formatDuration(span.durationNs)}
      </span>
      {span.errorType && (
        <span className="shrink-0 rounded bg-danger/15 px-1 text-[10px] text-danger">
          {span.errorType}
        </span>
      )}
    </li>
  );
}
