import type { SpanView } from "./tree";

/**
 * Sequence diff for two traces, used to answer "what did the replay do
 * differently?" — the whole point of forking.
 */

export type DiffKind = "same" | "removed" | "added";

export interface SpanDiffRow {
  kind: DiffKind;
  a?: SpanView;
  b?: SpanView;
}

/**
 * Spans are compared on structure rather than identity: span ids and
 * timestamps always differ between two runs, so matching on those would mark
 * everything as changed.
 */
export function spanSignature(span: SpanView): string {
  const target = span.toolName ?? span.model ?? span.name;
  return `${span.depth}|${span.operation ?? "?"}|${target}`;
}

/**
 * Longest-common-subsequence diff.
 * Traces are tens to low hundreds of spans, so the O(n·m) table is fine and
 * the result is a minimal edit script, which is what makes the view readable.
 */
export function diffSpanSequence(a: SpanView[], b: SpanView[]): SpanDiffRow[] {
  const n = a.length;
  const m = b.length;

  // dp[i][j] = LCS length of a.slice(i) and b.slice(j)
  const dp: number[][] = Array.from({ length: n + 1 }, () =>
    new Array<number>(m + 1).fill(0),
  );

  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      dp[i]![j] =
        spanSignature(a[i]!) === spanSignature(b[j]!)
          ? dp[i + 1]![j + 1]! + 1
          : Math.max(dp[i + 1]![j]!, dp[i]![j + 1]!);
    }
  }

  const rows: SpanDiffRow[] = [];
  let i = 0;
  let j = 0;

  while (i < n && j < m) {
    if (spanSignature(a[i]!) === spanSignature(b[j]!)) {
      rows.push({ kind: "same", a: a[i]!, b: b[j]! });
      i += 1;
      j += 1;
    } else if (dp[i + 1]![j]! >= dp[i]![j + 1]!) {
      rows.push({ kind: "removed", a: a[i]! });
      i += 1;
    } else {
      rows.push({ kind: "added", b: b[j]! });
      j += 1;
    }
  }

  while (i < n) {
    rows.push({ kind: "removed", a: a[i]! });
    i += 1;
  }
  while (j < m) {
    rows.push({ kind: "added", b: b[j]! });
    j += 1;
  }

  return rows;
}

export interface DiffSummary {
  same: number;
  added: number;
  removed: number;
}

export function summarizeDiff(rows: SpanDiffRow[]): DiffSummary {
  return rows.reduce<DiffSummary>(
    (acc, row) => {
      if (row.kind === "same") acc.same += 1;
      else if (row.kind === "added") acc.added += 1;
      else acc.removed += 1;
      return acc;
    },
    { same: 0, added: 0, removed: 0 },
  );
}
