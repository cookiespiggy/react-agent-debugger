"use client";

import { memo } from "react";
import type { SpanView, TraceView } from "@/lib/trace/tree";
import { formatDurationShort } from "@/lib/format";

/**
 * Span timeline.
 *
 * Each bar shows total duration; the darker inner portion is **self time**
 * (duration minus time covered by children). A bar that is mostly pale means
 * the span is waiting on its children; mostly dark means the span itself is
 * the bottleneck. That distinction is the whole point of a waterfall.
 */

const ROW_HEIGHT = 30;
const INDENT_PX = 14;

type Tone = { bar: string; track: string; text: string };

const TONE_BY_GROUP: Record<string, Tone> = {
  agent: { bar: "bg-agent", track: "bg-agent/25", text: "text-agent" },
  model: { bar: "bg-model", track: "bg-model/25", text: "text-model" },
  tool: { bar: "bg-tool", track: "bg-tool/25", text: "text-tool" },
  retrieval: { bar: "bg-retrieval", track: "bg-retrieval/25", text: "text-retrieval" },
};

const NEUTRAL_TONE: Tone = {
  bar: "bg-fg-subtle",
  track: "bg-fg-subtle/25",
  text: "text-fg-muted",
};

const ERROR_TONE: Tone = {
  bar: "bg-danger",
  track: "bg-danger/25",
  text: "text-danger",
};

const OPERATION_GROUP: Record<string, "agent" | "model" | "tool" | "retrieval"> = {
  create_agent: "agent",
  invoke_agent: "agent",
  invoke_workflow: "agent",
  execute_tool: "tool",
  chat: "model",
  text_completion: "model",
  embeddings: "model",
  generate_content: "model",
  retrieval: "retrieval",
};

function toneFor(span: SpanView): Tone {
  const failed = span.statusCode === 2 || span.errorType !== null;
  if (failed) return ERROR_TONE;
  const group = span.operation ? OPERATION_GROUP[span.operation] : undefined;
  return group ? TONE_BY_GROUP[group]! : NEUTRAL_TONE;
}

/** The label people actually scan for: model name, tool name, or agent name. */
function spanLabel(span: SpanView): string {
  if (span.operation === "execute_tool") return span.toolName ?? span.name;
  if (span.operation === "chat" || span.operation === "text_completion")
    return span.model ?? span.name;
  if (span.operation === "invoke_agent" || span.operation === "create_agent")
    return span.agentName ?? span.name;
  return span.name;
}

const SHORT_OP: Record<string, string> = {
  create_agent: "agent",
  invoke_agent: "agent",
  invoke_workflow: "step",
  execute_tool: "tool",
  chat: "chat",
  text_completion: "cmpl",
  embeddings: "embed",
  generate_content: "gen",
  retrieval: "rag",
};

/** Pick a "nice" tick interval yielding roughly 5–8 gridlines. */
function tickStep(durationNs: number): number {
  if (durationNs <= 0) return 1_000_000_000;
  const steps = [
    1e5, 2.5e5, 5e5, 1e6, 2.5e6, 5e6, 1e7, 2.5e7, 5e7, 1e8, 2.5e8, 5e8, 1e9,
    2.5e9, 5e9, 1e10, 2.5e10, 5e10, 1e11, 3e11, 6e11,
  ];
  const target = durationNs / 6;
  return steps.find((s) => s >= target) ?? steps[steps.length - 1]!;
}

interface WaterfallProps {
  trace: TraceView;
  rows: string[];
  selectedId: string | null;
  collapsed: ReadonlySet<string>;
  onSelect: (id: string) => void;
  onToggle: (id: string) => void;
}

function WaterfallImpl({
  trace,
  rows,
  selectedId,
  collapsed,
  onSelect,
  onToggle,
}: WaterfallProps) {
  const total = trace.durationNs;
  const step = tickStep(total);
  const tickCount = total > 0 ? Math.floor(total / step) : 0;

  const toPct = (valueNs: number): number => (total > 0 ? (valueNs / total) * 100 : 0);

  const ticks: { pos: number; label: string }[] = [];
  for (let i = 0; i <= tickCount; i++) {
    const value = i * step;
    ticks.push({ pos: toPct(value), label: formatDurationShort(value) });
  }

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      {/* Time ruler */}
      <div className="flex shrink-0 border-b border-line bg-surface-2">
        <div className="w-[46%] min-w-[280px] max-w-[560px] shrink-0 px-3 py-1.5 font-mono text-[10px] uppercase tracking-wider text-fg-subtle">
          Span
        </div>
        <div className="relative flex-1">
          {ticks.map((tick, i) => (
            <span
              key={i}
              className="absolute top-1.5 font-mono text-[10px] text-fg-subtle"
              style={{ left: `${tick.pos}%` }}
            >
              {i === 0 ? "" : tick.label}
            </span>
          ))}
          <div className="h-6" />
        </div>
      </div>

      {/* Rows */}
      <div className="min-h-0 flex-1 overflow-auto">
        {rows.length === 0 ? (
          <div className="px-4 py-12 text-center text-sm text-fg-subtle">
            No spans match the current filters.
          </div>
        ) : (
          rows.map((id) => {
            const span = trace.byId[id];
            if (!span) return null;

            const tone = toneFor(span);
            const isSelected = id === selectedId;
            const hasChildren = span.childIds.length > 0;
            const isCollapsed = collapsed.has(id);

            const left = toPct(span.startOffsetNs);
            const width = Math.max(toPct(span.durationNs), 0.2);
            const selfRatio =
              span.durationNs > 0 ? span.selfDurationNs / span.durationNs : 1;

            const errorInSubtree = span.subtree.errorCount > 0;
            const warnInSubtree = span.subtree.warningCount > 0;

            return (
              <div
                key={id}
                data-span-row={id}
                role="button"
                tabIndex={0}
                onClick={() => onSelect(id)}
                onKeyDown={(e) => {
                  if (e.key === "Enter" || e.key === " ") {
                    e.preventDefault();
                    onSelect(id);
                  }
                }}
                style={{ height: ROW_HEIGHT }}
                className={`group flex cursor-pointer items-center border-b border-line/40 outline-none transition-colors ${
                  isSelected ? "bg-accent/10" : "hover:bg-surface-2"
                }`}
              >
                {/* Tree label */}
                <div
                  className="flex w-[46%] min-w-[280px] max-w-[560px] shrink-0 items-center gap-1.5 pr-3"
                  style={{ paddingLeft: 12 + span.depth * INDENT_PX }}
                >
                  {hasChildren ? (
                    <button
                      type="button"
                      aria-label={isCollapsed ? "Expand" : "Collapse"}
                      onClick={(e) => {
                        e.stopPropagation();
                        onToggle(id);
                      }}
                      className="flex h-4 w-4 shrink-0 items-center justify-center rounded text-fg-subtle transition-colors hover:bg-surface-3 hover:text-fg"
                    >
                      <svg
                        width="8"
                        height="8"
                        viewBox="0 0 8 8"
                        className={`transition-transform ${isCollapsed ? "" : "rotate-90"}`}
                      >
                        <path d="M2 1l4 3-4 3z" fill="currentColor" />
                      </svg>
                    </button>
                  ) : (
                    <span className="h-4 w-4 shrink-0" />
                  )}

                  <span
                    className={`shrink-0 rounded px-1 font-mono text-[10px] leading-[15px] ${tone.track} ${tone.text}`}
                  >
                    {span.operation ? SHORT_OP[span.operation] ?? "span" : "?"}
                  </span>

                  <span
                    className={`truncate text-[13px] ${
                      isSelected ? "text-fg" : "text-fg-muted"
                    }`}
                    title={spanLabel(span)}
                  >
                    {spanLabel(span)}
                  </span>

                  {span.operationInferred && (
                    <span
                      className="shrink-0 font-mono text-[10px] text-fg-subtle"
                      title="Operation inferred from span name — gen_ai.operation.name was missing"
                    >
                      ~
                    </span>
                  )}

                  <span className="ml-auto flex shrink-0 items-center gap-1.5">
                    {errorInSubtree && span.subtree.errorCount > 0 && (
                      <span
                        className="rounded bg-danger/15 px-1 font-mono text-[10px] text-danger"
                        title={`${span.subtree.errorCount} error(s) in subtree`}
                      >
                        {span.subtree.errorCount}
                      </span>
                    )}
                    {warnInSubtree && (
                      <span
                        className="font-mono text-[10px] text-warn"
                        title={`${span.subtree.warningCount} data-quality warning(s)`}
                      >
                        ▲
                      </span>
                    )}
                    <span className="nums w-14 text-right font-mono text-[11px] text-fg-subtle">
                      {formatDurationShort(span.selfDurationNs)}
                    </span>
                  </span>
                </div>

                {/* Timeline */}
                <div className="relative min-w-0 flex-1 self-stretch">
                  {/* Gridlines */}
                  {ticks.map((tick, i) => (
                    <span
                      key={i}
                      className="absolute inset-y-0 w-px bg-line/40"
                      style={{ left: `${tick.pos}%` }}
                    />
                  ))}

                  <div
                    className={`absolute top-1/2 h-3.5 -translate-y-1/2 overflow-hidden rounded-[3px] ${tone.track}`}
                    style={{ left: `${left}%`, width: `${width}%` }}
                    title={`${span.name}\ntotal ${formatDurationShort(span.durationNs)} · self ${formatDurationShort(span.selfDurationNs)}`}
                  >
                    <div
                      className={`h-full ${tone.bar}`}
                      style={{ width: `${Math.min(100, Math.max(0, selfRatio * 100))}%` }}
                    />
                  </div>

                  {width < 12 && (
                    <span
                      className="absolute top-1/2 -translate-y-1/2 whitespace-nowrap pl-1 font-mono text-[10px] text-fg-subtle"
                      style={{ left: `${left + width}%` }}
                    >
                      {formatDurationShort(span.durationNs)}
                    </span>
                  )}
                </div>
              </div>
            );
          })
        )}
      </div>

      {/* Legend */}
      <div className="flex shrink-0 flex-wrap items-center gap-x-4 gap-y-1 border-t border-line bg-surface-2 px-3 py-1.5 font-mono text-[10px] text-fg-subtle">
        {(["agent", "model", "tool", "retrieval"] as const).map((group) => {
          const tone = TONE_BY_GROUP[group]!;
          return (
            <span key={group} className="flex items-center gap-1.5">
              <span className={`h-2 w-3 rounded-[2px] ${tone.bar}`} />
              {group}
            </span>
          );
        })}
        <span className="flex items-center gap-1.5">
          <span className="h-2 w-3 rounded-[2px] bg-danger" />
          error
        </span>
        <span className="ml-auto">
          dark = self time · pale = waiting on children
        </span>
      </div>
    </div>
  );
}

export const Waterfall = memo(WaterfallImpl);
