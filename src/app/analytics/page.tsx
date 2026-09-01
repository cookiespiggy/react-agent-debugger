import Link from "next/link";
import { aggregateSpans, hasIndexedSpans, type AggregateRow } from "@/lib/trace/analytics";
import { formatDuration, formatNumber, formatTokens } from "@/lib/format";

// Reads SQLite on every request — must never be statically rendered.
export const dynamic = "force-dynamic";

export default function AnalyticsPage() {
  const empty = !hasIndexedSpans();
  const tools = empty ? [] : aggregateSpans("tool");
  const models = empty ? [] : aggregateSpans("model");

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
          Cross-run analytics
        </h1>
        <p className="mt-1 max-w-2xl text-[12px] leading-relaxed text-fg-subtle">
          Aggregated over every ingested run. A debugger explains one trace;
          this finds the systematic problems — the tool that is always slow,
          the model that always errors.
        </p>
      </header>

      {empty ? (
        <p className="rounded-lg border border-line bg-surface px-4 py-10 text-center text-sm text-fg-subtle">
          Nothing ingested yet. Send OTLP spans to{" "}
          <code className="font-mono">POST /api/v1/traces</code>.
        </p>
      ) : (
        <div className="space-y-8">
          <section>
            <h2 className="mb-2 text-[11px] uppercase tracking-wider text-fg-subtle">
              Tools
            </h2>
            <AggregateTable rows={tools} kind="tool" />
          </section>

          <section>
            <h2 className="mb-2 text-[11px] uppercase tracking-wider text-fg-subtle">
              Models
            </h2>
            <AggregateTable rows={models} kind="model" />
          </section>
        </div>
      )}
    </main>
  );
}

function AggregateTable({
  rows,
  kind,
}: {
  rows: AggregateRow[];
  kind: "tool" | "model";
}) {
  if (rows.length === 0) {
    return (
      <p className="rounded-lg border border-line bg-surface px-4 py-6 text-center text-sm text-fg-subtle">
        No {kind} spans indexed.
      </p>
    );
  }

  return (
    <div className="overflow-x-auto rounded-lg border border-line bg-surface">
      <table className="w-full text-sm">
        <thead>
          <tr className="border-b border-line bg-surface-2 font-mono text-[10px] uppercase tracking-wider text-fg-subtle">
            <th className="px-4 py-2 text-left font-normal">{kind}</th>
            <th className="px-3 py-2 text-right font-normal">Calls</th>
            <th className="px-3 py-2 text-right font-normal">Errors</th>
            <th className="px-3 py-2 text-right font-normal">Error rate</th>
            <th className="px-3 py-2 text-right font-normal">p50</th>
            <th className="px-3 py-2 text-right font-normal">p95</th>
            <th className="px-4 py-2 text-right font-normal">Total tokens</th>
          </tr>
        </thead>
        <tbody className="divide-y divide-line font-mono text-xs">
          {rows.map((row) => (
            <AggregateRowView key={row.key} row={row} />
          ))}
        </tbody>
      </table>
    </div>
  );
}

function AggregateRowView({ row }: { row: AggregateRow }) {
  const errTone =
    row.errorRate >= 0.25
      ? "text-danger"
      : row.errorRate > 0
        ? "text-warn"
        : "text-fg-subtle";

  return (
    <tr>
      <td className="max-w-[280px] truncate px-4 py-2 text-fg">{row.key}</td>
      <td className="nums px-3 py-2 text-right text-fg-muted">
        {formatNumber(row.calls)}
      </td>
      <td className="nums px-3 py-2 text-right text-fg-muted">
        {formatNumber(row.errorCount)}
      </td>
      <td className={`nums px-3 py-2 text-right ${errTone}`}>
        {(row.errorRate * 100).toFixed(0)}%
      </td>
      <td className="nums px-3 py-2 text-right text-fg-muted">
        {formatDuration(row.p50Ns)}
      </td>
      <td className="nums px-3 py-2 text-right text-fg">
        {formatDuration(row.p95Ns)}
      </td>
      <td className="nums px-4 py-2 text-right text-fg-muted">
        {formatTokens(row.totalTokens)}
      </td>
    </tr>
  );
}
