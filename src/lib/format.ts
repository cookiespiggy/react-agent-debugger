/** Display helpers. Durations are nanoseconds (the unit everything is stored in). */

export function formatDuration(ns: number): string {
  if (!Number.isFinite(ns) || ns < 0) return "—";
  if (ns < 1_000) return `${Math.round(ns)}ns`;
  if (ns < 1_000_000) return `${(ns / 1_000).toFixed(1)}µs`;
  if (ns < 1_000_000_000) return `${(ns / 1_000_000).toFixed(1)}ms`;
  return `${(ns / 1_000_000_000).toFixed(2)}s`;
}

/** Compact form for dense waterfall rows. */
export function formatDurationShort(ns: number): string {
  if (!Number.isFinite(ns) || ns < 0) return "—";
  if (ns < 1_000) return `${Math.round(ns)}ns`;
  if (ns < 1_000_000) return `${Math.round(ns / 1_000)}µs`;
  if (ns < 1_000_000_000) return `${Math.round(ns / 1_000_000)}ms`;
  return `${(ns / 1_000_000_000).toFixed(2)}s`;
}

export function formatTokens(n: number | null | undefined): string {
  if (n === null || n === undefined) return "—";
  if (n < 1000) return String(n);
  if (n < 1_000_000) return `${(n / 1000).toFixed(1)}k`;
  return `${(n / 1_000_000).toFixed(2)}M`;
}

export function formatNumber(n: number | null | undefined): string {
  if (n === null || n === undefined) return "—";
  return n.toLocaleString("en-US");
}

const TIME_FMT = new Intl.DateTimeFormat("en-GB", {
  hour: "2-digit",
  minute: "2-digit",
  second: "2-digit",
  hour12: false,
});

export function formatClock(epochMs: number): string {
  return TIME_FMT.format(new Date(epochMs));
}

export function formatRelative(epochMs: number, now = Date.now()): string {
  const deltaSec = Math.round((now - epochMs) / 1000);
  if (deltaSec < 60) return `${deltaSec}s ago`;
  if (deltaSec < 3600) return `${Math.round(deltaSec / 60)}m ago`;
  if (deltaSec < 86400) return `${Math.round(deltaSec / 3600)}h ago`;
  return `${Math.round(deltaSec / 86400)}d ago`;
}

/** Fraction of total, clamped to [0,1]. */
export function ratio(part: number, total: number): number {
  if (!Number.isFinite(part) || !Number.isFinite(total) || total <= 0) return 0;
  return Math.min(1, Math.max(0, part / total));
}

export function percent(part: number, total: number): string {
  const r = ratio(part, total);
  return r === 0 ? "0%" : r < 0.01 ? "<1%" : `${Math.round(r * 100)}%`;
}
