"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useCallback, useEffect, useMemo, useState } from "react";
import { formatDuration, formatNumber, formatTokens } from "@/lib/format";
import { analyzeTrace, type Insight, type InsightSeverity } from "@/lib/trace/insights";
import type { SpanView, TraceView } from "@/lib/trace/tree";
import { ForkPanel } from "./ForkPanel";
import { SpanDetail } from "./SpanDetail";
import { Waterfall } from "./Waterfall";

interface Filters {
  query: string;
  onlyErrors: boolean;
  onlyWarnings: boolean;
}

const EMPTY_FILTERS: Filters = { query: "", onlyErrors: false, onlyWarnings: false };

function isFailed(span: SpanView): boolean {
  return span.statusCode === 2 || span.errorType !== null;
}

function matchesFilters(span: SpanView, filters: Filters): boolean {
  if (filters.onlyErrors && !isFailed(span)) return false;
  if (filters.onlyWarnings && span.warnings.length === 0) return false;

  const q = filters.query.trim().toLowerCase();
  if (q) {
    const haystack = [
      span.name,
      span.operation ?? "",
      span.model ?? "",
      span.toolName ?? "",
      span.agentName ?? "",
      span.errorType ?? "",
    ]
      .join(" ")
      .toLowerCase();
    if (!haystack.includes(q)) return false;
  }
  return true;
}

/**
 * Bottom-up pass: keep a span if it matches, or if anything in its subtree does.
 * Preserving ancestors keeps the tree readable instead of orphaning matches.
 */
function buildMatchSet(trace: TraceView, filters: Filters): Set<string> | null {
  const q = filters.query.trim();
  if (!q && !filters.onlyErrors && !filters.onlyWarnings) return null;

  const keep = new Set<string>();
  const visit = (id: string): boolean => {
    const span = trace.byId[id];
    if (!span) return false;
    let anyChild = false;
    for (const childId of span.childIds) {
      if (visit(childId)) anyChild = true;
    }
    const self = matchesFilters(span, filters);
    if (self || anyChild) keep.add(id);
    return self || anyChild;
  };

  for (const rootId of trace.rootIds) visit(rootId);
  return keep;
}

function hasCollapsedAncestor(
  trace: TraceView,
  spanId: string,
  collapsed: ReadonlySet<string>,
): boolean {
  let cur = trace.byId[spanId]?.parentSpanId ?? null;
  while (cur) {
    if (collapsed.has(cur)) return true;
    cur = trace.byId[cur]?.parentSpanId ?? null;
  }
  return false;
}

export function TraceExplorer({ trace }: { trace: TraceView }) {
  const [selectedId, setSelectedId] = useState<string | null>(
    trace.rootIds[0] ?? trace.orderedIds[0] ?? null,
  );
  const [collapsed, setCollapsed] = useState<ReadonlySet<string>>(new Set());
  const [filters, setFilters] = useState<Filters>(EMPTY_FILTERS);
  const [showInsights, setShowInsights] = useState(true);
  const [forkOpen, setForkOpen] = useState(false);

  const insights = useMemo(() => analyzeTrace(trace), [trace]);

  const matchSet = useMemo(() => buildMatchSet(trace, filters), [trace, filters]);

  const rows = useMemo(() => {
    return trace.orderedIds.filter((id) => {
      if (matchSet && !matchSet.has(id)) return false;
      return !hasCollapsedAncestor(trace, id, collapsed);
    });
  }, [trace, matchSet, collapsed]);

  const selected = selectedId ? (trace.byId[selectedId] ?? null) : null;

  const toggle = useCallback((id: string) => {
    setCollapsed((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }, []);

  const collapseAll = useCallback(() => {
    const ids = trace.orderedIds.filter((id) => (trace.byId[id]?.childIds.length ?? 0) > 0);
    setCollapsed(new Set(ids));
  }, [trace]);

  const router = useRouter();

  // A finished replay is an ordinary trace, so refreshing the route data is
  // all that is needed to make it show up in the trace list.
  const handleReplayComplete = useCallback(() => {
    router.refresh();
  }, [router]);

  // Keyboard navigation — a debugger you must mouse around is a slow debugger.
  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      const target = e.target as HTMLElement | null;
      if (target && (target.tagName === "INPUT" || target.tagName === "TEXTAREA")) return;
      if (e.metaKey || e.ctrlKey || e.altKey) return;

      const currentIndex = selectedId ? rows.indexOf(selectedId) : -1;

      if (e.key === "j" || e.key === "ArrowDown") {
        e.preventDefault();
        const next = rows[Math.min(currentIndex + 1, rows.length - 1)];
        if (next) setSelectedId(next);
      } else if (e.key === "k" || e.key === "ArrowUp") {
        e.preventDefault();
        const prev = rows[Math.max(currentIndex - 1, 0)];
        if (prev) setSelectedId(prev);
      } else if (e.key === "h" && selectedId) {
        e.preventDefault();
        toggle(selectedId);
      }
    };

    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [rows, selectedId, toggle]);

  // Keep the selected row in view when moving by keyboard.
  useEffect(() => {
    if (!selectedId) return;
    const el = document.querySelector(`[data-span-row="${selectedId}"]`);
    el?.scrollIntoView({ block: "nearest" });
  }, [selectedId]);

  const focusInsight = (insight: Insight) => {
    const first = insight.spanIds.find((id) => trace.byId[id]);
    if (!first) return;
    setSelectedId(first);
    // Reveal the target if an ancestor is collapsed.
    setCollapsed((prev) => {
      const next = new Set(prev);
      let cur = trace.byId[first]?.parentSpanId ?? null;
      while (cur) {
        next.delete(cur);
        cur = trace.byId[cur]?.parentSpanId ?? null;
      }
      return next;
    });
  };

  const { totals } = trace;

  return (
    <div className="flex h-screen flex-col overflow-hidden">
      {/* ---------------------------------------------------------- header */}
      <header className="shrink-0 border-b border-line bg-surface">
        <div className="flex items-center gap-3 px-4 py-2.5">
          <Link
            href="/"
            className="shrink-0 rounded border border-line px-2 py-1 text-xs text-fg-muted transition-colors hover:bg-surface-2 hover:text-fg"
          >
            ← Traces
          </Link>
          <h1 className="truncate text-sm font-medium">
            {trace.agentName ?? "unnamed agent"}
          </h1>
          <code className="shrink-0 font-mono text-[11px] text-fg-subtle">
            {trace.traceId.slice(0, 16)}
          </code>

          <div className="ml-auto flex shrink-0 items-center gap-4 font-mono text-[11px]">
            <Metric label="duration" value={formatDuration(trace.durationNs)} />
            <Metric label="spans" value={formatNumber(totals.spanCount)} />
            <Metric
              label="tokens"
              value={formatTokens(totals.totalTokens)}
              sub={
                totals.reasoningTokens > 0
                  ? `${formatTokens(totals.reasoningTokens)} reasoning`
                  : undefined
              }
            />
            <Metric
              label="calls"
              value={`${totals.modelCalls}m / ${totals.toolCalls}t`}
            />
            {totals.errorCount > 0 && (
              <Metric label="errors" value={String(totals.errorCount)} tone="danger" />
            )}
            {totals.warningCount > 0 && (
              <Metric label="warnings" value={String(totals.warningCount)} tone="warn" />
            )}
          </div>
        </div>

        {trace.models.length > 0 && (
          <div className="flex items-center gap-2 border-t border-line px-4 py-1.5 font-mono text-[11px] text-fg-subtle">
            <span>models</span>
            {trace.models.map((m) => (
              <span key={m} className="rounded bg-surface-2 px-1.5 py-0.5 text-model">
                {m}
              </span>
            ))}
            {trace.conversationId && (
              <>
                <span className="ml-2">conversation</span>
                <span className="rounded bg-surface-2 px-1.5 py-0.5">
                  {trace.conversationId}
                </span>
              </>
            )}
          </div>
        )}
      </header>

      {/* -------------------------------------------------------- insights */}
      {insights.length > 0 && (
        <section className="shrink-0 border-b border-line bg-surface-2">
          <button
            type="button"
            onClick={() => setShowInsights((v) => !v)}
            className="flex w-full items-center gap-2 px-4 py-2 text-left transition-colors hover:bg-surface-3"
          >
            <span className="text-[11px] uppercase tracking-wider text-fg-subtle">
              Diagnosis
            </span>
            <span className="rounded bg-surface-3 px-1.5 font-mono text-[10px] text-fg-muted">
              {insights.length}
            </span>
            <span className="ml-auto font-mono text-[10px] text-fg-subtle">
              {showInsights ? "hide" : "show"}
            </span>
          </button>

          {showInsights && (
            <div className="space-y-1.5 px-4 pb-3">
              {insights.map((insight) => (
                <button
                  key={insight.id}
                  type="button"
                  onClick={() => focusInsight(insight)}
                  className={`w-full rounded-md border px-3 py-2 text-left transition-colors hover:brightness-125 ${INSIGHT_STYLE[insight.severity]}`}
                >
                  <div className="flex items-baseline gap-2">
                    <span className="font-mono text-[10px] uppercase tracking-wider">
                      {insight.severity}
                    </span>
                    <span className="text-[12px] font-medium">{insight.title}</span>
                    <span className="ml-auto shrink-0 font-mono text-[10px] opacity-70">
                      {insight.spanIds.length} span
                      {insight.spanIds.length === 1 ? "" : "s"} →
                    </span>
                  </div>
                  <p className="mt-1 text-[11px] leading-relaxed opacity-90">
                    {insight.detail}
                  </p>
                </button>
              ))}
            </div>
          )}
        </section>
      )}

      {/* --------------------------------------------------------- toolbar */}
      <div className="flex shrink-0 flex-wrap items-center gap-2 border-b border-line bg-surface px-4 py-2">
        <input
          type="text"
          value={filters.query}
          onChange={(e) => setFilters((f) => ({ ...f, query: e.target.value }))}
          placeholder="Filter spans by name, model, tool…"
          className="h-7 w-64 rounded border border-line bg-canvas px-2.5 text-xs text-fg placeholder:text-fg-subtle focus:border-accent-dim focus:outline-none"
        />

        <ToggleChip
          active={filters.onlyErrors}
          onClick={() => setFilters((f) => ({ ...f, onlyErrors: !f.onlyErrors }))}
          activeClass="border-danger-dim bg-danger/10 text-danger"
        >
          Errors
        </ToggleChip>

        <ToggleChip
          active={filters.onlyWarnings}
          onClick={() => setFilters((f) => ({ ...f, onlyWarnings: !f.onlyWarnings }))}
          activeClass="border-tool-dim bg-warn/10 text-warn"
        >
          Warnings
        </ToggleChip>

        <button
          type="button"
          onClick={() => setForkOpen((v) => !v)}
          disabled={!selected}
          className={`h-7 rounded border px-2.5 text-xs transition-colors disabled:opacity-40 ${
            forkOpen
              ? "border-accent-dim bg-accent/10 text-accent"
              : "border-line text-fg-muted hover:bg-surface-2 hover:text-fg"
          }`}
          title="Replay this run from the selected span"
        >
          {forkOpen ? "Forking" : "Fork"}
        </button>

        <div className="ml-auto flex items-center gap-2">
          <span className="font-mono text-[10px] text-fg-subtle">
            {rows.length}/{totals.spanCount} shown
          </span>
          <button
            type="button"
            onClick={collapseAll}
            className="h-7 rounded border border-line px-2 text-xs text-fg-muted transition-colors hover:bg-surface-2 hover:text-fg"
          >
            Collapse all
          </button>
          <button
            type="button"
            onClick={() => setCollapsed(new Set())}
            className="h-7 rounded border border-line px-2 text-xs text-fg-muted transition-colors hover:bg-surface-2 hover:text-fg"
          >
            Expand all
          </button>
        </div>

        <span className="w-full font-mono text-[10px] text-fg-subtle/70">
          j / k or ↑ ↓ to move · h to fold
        </span>
      </div>

      {/* ------------------------------------------------------------ body */}
      <div className="flex min-h-0 flex-1">
        <div className="min-w-0 flex-1">
          <Waterfall
            trace={trace}
            rows={rows}
            selectedId={selectedId}
            collapsed={collapsed}
            onSelect={setSelectedId}
            onToggle={toggle}
          />
        </div>

        <aside className="w-[400px] shrink-0 border-l border-line bg-surface">
          {!selected ? (
            <div className="p-4 text-sm text-fg-subtle">Select a span.</div>
          ) : forkOpen ? (
            <ForkPanel
              trace={trace}
              span={selected}
              onClose={() => setForkOpen(false)}
              onComplete={handleReplayComplete}
            />
          ) : (
            <SpanDetail span={selected} traceDurationNs={trace.durationNs} />
          )}
        </aside>
      </div>
    </div>
  );
}

const INSIGHT_STYLE: Record<InsightSeverity, string> = {
  critical: "border-danger-dim bg-danger/5 text-danger",
  warning: "border-tool-dim bg-warn/5 text-warn",
  info: "border-accent-dim bg-accent/5 text-fg",
};

function Metric({
  label,
  value,
  sub,
  tone = "default",
}: {
  label: string;
  value: string;
  sub?: string;
  tone?: "default" | "danger" | "warn";
}) {
  const cls =
    tone === "danger" ? "text-danger" : tone === "warn" ? "text-warn" : "text-fg";
  return (
    <span className="flex items-baseline gap-1">
      <span className="text-fg-subtle">{label}</span>
      <span className={`nums ${cls}`}>{value}</span>
      {sub && <span className="text-[10px] text-fg-subtle">{sub}</span>}
    </span>
  );
}

function ToggleChip({
  children,
  active,
  onClick,
  activeClass,
}: {
  children: React.ReactNode;
  active: boolean;
  onClick: () => void;
  activeClass: string;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={`h-7 rounded border px-2.5 text-xs transition-colors ${
        active ? activeClass : "border-line text-fg-muted hover:bg-surface-2 hover:text-fg"
      }`}
    >
      {children}
    </button>
  );
}
