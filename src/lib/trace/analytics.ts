import { getDb } from "../db";

/**
 * Cross-run analytics over the flattened `spans` index.
 *
 * A debugger answers "what happened in this run"; analytics answers "what is
 * systematically wrong across every run" — the tool that is always slow, the
 * model that always errors. This reads only from the indexed columns, so it
 * stays cheap even as the trace store grows.
 */

export interface AggregateRow {
  key: string;
  calls: number;
  errorCount: number;
  errorRate: number;
  p50Ns: number;
  p95Ns: number;
  totalTokens: number;
  avgTokens: number;
}

export type AggregateDimension = "tool" | "model";

interface SpanRow {
  key: string;
  duration_ns: number;
  status_code: number;
  error_type: string | null;
  input_tokens: number | null;
  output_tokens: number | null;
  reasoning_tokens: number | null;
}

/** Nearest-rank percentile — good enough for triage, no interpolation. */
function percentile(sorted: number[], p: number): number {
  if (sorted.length === 0) return 0;
  const idx = Math.min(
    sorted.length - 1,
    Math.max(0, Math.ceil(p * sorted.length) - 1),
  );
  return sorted[idx]!;
}

const MODEL_OPERATIONS_SQL = `('chat', 'text_completion', 'generate_content', 'embeddings', 'retrieval')`;

function loadRows(dimension: AggregateDimension): Map<string, SpanRow[]> {
  const db = getDb();
  const where =
    dimension === "tool"
      ? `WHERE tool_name IS NOT NULL AND operation = 'execute_tool'`
      : `WHERE model IS NOT NULL AND operation IN ${MODEL_OPERATIONS_SQL}`;

  const rows = db
    .prepare(
      `SELECT ${dimension === "tool" ? "tool_name" : "model"} AS key,
              duration_ns, status_code, error_type,
              input_tokens, output_tokens, reasoning_tokens
       FROM spans
       ${where}`,
    )
    .all() as SpanRow[];

  const grouped = new Map<string, SpanRow[]>();
  for (const row of rows) {
    const list = grouped.get(row.key);
    if (list) list.push(row);
    else grouped.set(row.key, [row]);
  }
  return grouped;
}

export function aggregateSpans(dimension: AggregateDimension): AggregateRow[] {
  const grouped = loadRows(dimension);

  const out: AggregateRow[] = [];
  for (const [key, rows] of grouped) {
    const durations = rows
      .map((r) => r.duration_ns)
      .filter((d) => d > 0)
      .sort((a, b) => a - b);
    const errorCount = rows.filter(
      (r) => r.status_code === 2 || r.error_type !== null,
    ).length;
    const totalTokens = rows.reduce(
      (sum, r) =>
        sum + (r.input_tokens ?? 0) + (r.output_tokens ?? 0) + (r.reasoning_tokens ?? 0),
      0,
    );

    out.push({
      key,
      calls: rows.length,
      errorCount,
      errorRate: rows.length ? errorCount / rows.length : 0,
      p50Ns: percentile(durations, 0.5),
      p95Ns: percentile(durations, 0.95),
      totalTokens,
      avgTokens: rows.length ? Math.round(totalTokens / rows.length) : 0,
    });
  }

  // Worst first: by error rate, then by p95 latency.
  return out.sort((a, b) => {
    if (b.errorRate !== a.errorRate) return b.errorRate - a.errorRate;
    return b.p95Ns - a.p95Ns;
  });
}

/** Spans index empty (nothing ingested yet). */
export function hasIndexedSpans(): boolean {
  const db = getDb();
  const row = db.prepare(`SELECT COUNT(*) AS n FROM spans`).get() as { n: number };
  return row.n > 0;
}
