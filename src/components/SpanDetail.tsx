"use client";

import { useState } from "react";
import { OPERATION_META, SPAN_KIND_LABEL } from "@/lib/genai/semconv";
import { formatDuration, formatNumber, percent } from "@/lib/format";
import type { SpanView } from "@/lib/trace/tree";
import type { WarningSeverity } from "@/lib/genai/normalize";

type Tab = "overview" | "messages" | "attributes" | "events";

const TABS: { id: Tab; label: string }[] = [
  { id: "overview", label: "Overview" },
  { id: "messages", label: "Messages" },
  { id: "attributes", label: "Attributes" },
  { id: "events", label: "Events" },
];

const SEVERITY_STYLE: Record<WarningSeverity, string> = {
  error: "border-danger-dim bg-danger/5 text-danger",
  warn: "border-tool-dim bg-warn/5 text-warn",
  info: "border-line bg-surface-2 text-fg-muted",
};

const SEVERITY_MARK: Record<WarningSeverity, string> = {
  error: "✕",
  warn: "▲",
  info: "i",
};

const ROLE_STYLE: Record<string, string> = {
  system: "border-line bg-surface-2 text-fg-muted",
  user: "border-accent-dim bg-accent/5 text-fg",
  assistant: "border-agent-dim bg-agent/5 text-fg",
  tool: "border-tool-dim bg-tool/5 text-fg",
};

interface SpanDetailProps {
  span: SpanView;
  traceDurationNs: number;
}

export function SpanDetail({ span, traceDurationNs }: SpanDetailProps) {
  const [tab, setTab] = useState<Tab>("overview");

  const meta = span.operation ? OPERATION_META[span.operation] : undefined;
  const failed = span.statusCode === 2 || span.errorType !== null;

  const { inputTokens, outputTokens, reasoningTokens, totalTokens } = span.usage;
  const reasoningShare =
    totalTokens && totalTokens > 0 ? (reasoningTokens ?? 0) / totalTokens : 0;

  return (
    <div className="flex h-full min-h-0 flex-col">
      {/* Header */}
      <div className="shrink-0 border-b border-line px-4 py-3">
        <div className="flex items-center gap-2">
          <span
            className={`rounded px-1.5 py-0.5 font-mono text-[10px] uppercase tracking-wide ${
              failed
                ? "bg-danger/15 text-danger"
                : "bg-surface-3 text-fg-muted"
            }`}
          >
            {span.operation ?? "unknown"}
          </span>
          <h2 className="truncate text-sm font-medium" title={span.name}>
            {span.name}
          </h2>
        </div>

        <div className="mt-2 flex flex-wrap items-center gap-x-3 gap-y-1 font-mono text-[11px] text-fg-subtle">
          <span>{SPAN_KIND_LABEL[span.kind] ?? `kind ${span.kind}`}</span>
          <span>{formatDuration(span.durationNs)}</span>
          <span>{percent(span.durationNs, traceDurationNs)} of trace</span>
          {span.model && <span className="text-model">{span.model}</span>}
          {span.toolName && <span className="text-tool">{span.toolName}</span>}
        </div>

        <div className="mt-1 font-mono text-[10px] text-fg-subtle">
          span_id {span.spanId.slice(0, 16)}
          {span.parentSpanId && ` · parent ${span.parentSpanId.slice(0, 16)}`}
        </div>
      </div>

      {/* Warnings — always visible, they are the actionable part. */}
      {span.warnings.length > 0 && (
        <div className="shrink-0 space-y-1.5 border-b border-line px-4 py-3">
          {span.warnings.map((warning, i) => (
            <div
              key={i}
              className={`rounded-md border px-2.5 py-2 text-[11px] leading-relaxed ${SEVERITY_STYLE[warning.severity]}`}
            >
              <span className="mr-1.5 font-mono">{SEVERITY_MARK[warning.severity]}</span>
              {warning.message}
              {warning.attr && (
                <code className="ml-1 font-mono text-[10px] opacity-70">
                  ({warning.attr})
                </code>
              )}
            </div>
          ))}
        </div>
      )}

      {/* Tabs */}
      <div className="flex shrink-0 border-b border-line">
        {TABS.map((t) => {
          const count =
            t.id === "events"
              ? span.events.length
              : t.id === "attributes"
                ? Object.keys(span.attributes).length
                : null;
          return (
            <button
              key={t.id}
              type="button"
              onClick={() => setTab(t.id)}
              className={`px-3 py-2 text-xs transition-colors ${
                tab === t.id
                  ? "border-b-2 border-accent text-fg"
                  : "text-fg-subtle hover:text-fg-muted"
              }`}
            >
              {t.label}
              {count !== null && count > 0 && (
                <span className="ml-1 font-mono text-[10px] text-fg-subtle">{count}</span>
              )}
            </button>
          );
        })}
      </div>

      {/* Body */}
      <div className="min-h-0 flex-1 overflow-auto px-4 py-3">
        {tab === "overview" && (
          <div className="space-y-4">
            <Section title="Timing">
              <Field label="Duration" value={formatDuration(span.durationNs)} />
              <Field
                label="Self time"
                value={`${formatDuration(span.selfDurationNs)} (${percent(span.selfDurationNs, span.durationNs)})`}
                hint="Excludes time covered by child spans"
              />
              <Field
                label="Start offset"
                value={formatDuration(span.startOffsetNs)}
              />
            </Section>

            {totalTokens !== null && totalTokens > 0 && (
              <Section title="Token usage">
                <Field label="Input" value={formatNumber(inputTokens)} />
                <Field label="Output" value={formatNumber(outputTokens)} />
                <Field
                  label="Reasoning"
                  value={formatNumber(reasoningTokens)}
                  tone={reasoningShare > 0.5 ? "warn" : "default"}
                />
                <Field label="Total" value={formatNumber(totalTokens)} />
                {reasoningShare > 0.5 && (
                  <p className="mt-1 text-[11px] leading-relaxed text-warn">
                    Reasoning tokens are {Math.round(reasoningShare * 100)}% of
                    this call. Instrumentation that omits{" "}
                    <code className="font-mono">
                      gen_ai.usage.reasoning.output_tokens
                    </code>{" "}
                    would understate this cost by roughly{" "}
                    {Math.round(totalTokens / Math.max(1, (inputTokens ?? 0) + (outputTokens ?? 0)))}×.
                  </p>
                )}
              </Section>
            )}

            <Section title="Identity">
              {meta && <Field label="Operation" value={meta.label} />}
              {span.provider && <Field label="Provider" value={span.provider} />}
              {span.agentName && <Field label="Agent" value={span.agentName} />}
              {span.toolCallId && <Field label="Tool call" value={span.toolCallId} />}
              {span.conversationId && (
                <Field label="Conversation" value={span.conversationId} />
              )}
            </Section>

            <Section title="Status">
              <Field
                label="Code"
                value={
                  span.statusCode === 2
                    ? "ERROR"
                    : span.statusCode === 1
                      ? "OK"
                      : "UNSET"
                }
                tone={span.statusCode === 2 ? "danger" : "default"}
              />
              {span.errorType && (
                <Field label="error.type" value={span.errorType} tone="danger" />
              )}
              {span.statusMessage && (
                <Field label="Message" value={span.statusMessage} tone="danger" />
              )}
            </Section>
          </div>
        )}

        {tab === "messages" && (
          <div className="space-y-5">
            <MessagePanel title="Input" value={span.inputMessages} />
            <MessagePanel title="Output" value={span.outputMessages} />
            {!span.inputMessages && !span.outputMessages && (
              <p className="text-xs text-fg-subtle">
                No message content captured. Set{" "}
                <code className="font-mono">
                  OTEL_INSTRUMENTATION_GENAI_CAPTURE_MESSAGE_CONTENT
                </code>{" "}
                to <code className="font-mono">EVENT_ONLY</code> or{" "}
                <code className="font-mono">SPAN_AND_EVENT</code> to record
                prompts and completions.
              </p>
            )}
          </div>
        )}

        {tab === "attributes" && <AttributeTable attributes={span.attributes} />}

        {tab === "events" &&
          (span.events.length === 0 ? (
            <p className="text-xs text-fg-subtle">No events on this span.</p>
          ) : (
            <div className="space-y-2">
              {span.events.map((event, i) => (
                <div key={i} className="rounded-md border border-line bg-surface-2 p-2.5">
                  <div className="flex items-baseline justify-between gap-2">
                    <span className="font-mono text-[11px] text-accent">
                      {event.name}
                    </span>
                    <span className="nums font-mono text-[10px] text-fg-subtle">
                      +{formatDuration(event.offsetNs)}
                    </span>
                  </div>
                  <AttributeTable
                    attributes={event.attributes}
                    className="mt-2 border-t border-line pt-2"
                  />
                </div>
              ))}
            </div>
          ))}
      </div>
    </div>
  );
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div>
      <div className="mb-1.5 text-[10px] uppercase tracking-wider text-fg-subtle">
        {title}
      </div>
      <div className="space-y-0.5">{children}</div>
    </div>
  );
}

function Field({
  label,
  value,
  hint,
  tone = "default",
}: {
  label: string;
  value: string;
  hint?: string;
  tone?: "default" | "danger" | "warn";
}) {
  const valueCls =
    tone === "danger" ? "text-danger" : tone === "warn" ? "text-warn" : "text-fg";
  return (
    <div className="flex items-baseline justify-between gap-3 py-0.5" title={hint}>
      <span className="shrink-0 font-mono text-[11px] text-fg-subtle">{label}</span>
      <span className={`nums break-all text-right font-mono text-[11px] ${valueCls}`}>
        {value}
      </span>
    </div>
  );
}

function AttributeTable({
  attributes,
  className = "",
}: {
  attributes: Record<string, unknown>;
  className?: string;
}) {
  const entries = Object.entries(attributes);
  if (entries.length === 0) {
    return <p className="text-xs text-fg-subtle">No attributes.</p>;
  }

  return (
    <div className={`space-y-0.5 ${className}`}>
      {entries.map(([key, value]) => (
        <div key={key} className="flex items-start justify-between gap-3 py-0.5">
          <span
            className={`shrink-0 break-all font-mono text-[11px] ${
              key.startsWith("gen_ai.") ? "text-accent" : "text-fg-subtle"
            }`}
          >
            {key}
          </span>
          <span className="nums break-all text-right font-mono text-[11px] text-fg">
            {typeof value === "string" ? value : JSON.stringify(value)}
          </span>
        </div>
      ))}
    </div>
  );
}

function JsonBlock({ value }: { value: unknown }) {
  return (
    <pre className="max-h-96 overflow-auto rounded-md border border-line bg-canvas p-2.5 font-mono text-[11px] leading-relaxed text-fg-muted">
      {JSON.stringify(value, null, 2)}
    </pre>
  );
}

function MessagePanel({ title, value }: { title: string; value: unknown }) {
  if (value === null || value === undefined) return null;

  // Render as chat bubbles only when the shape is a list of {role, content}.
  const isChat =
    Array.isArray(value) &&
    value.every(
      (m) =>
        m !== null &&
        typeof m === "object" &&
        !Array.isArray(m) &&
        "content" in (m as Record<string, unknown>),
    );

  return (
    <div>
      <div className="mb-1.5 text-[10px] uppercase tracking-wider text-fg-subtle">
        {title}
      </div>
      {isChat ? (
        <div className="space-y-2">
          {(value as Record<string, unknown>[]).map((msg, i) => {
            const role = String(msg.role ?? "unknown");
            const content = String(msg.content ?? "");
            return (
              <div
                key={i}
                className={`rounded-md border px-2.5 py-2 ${ROLE_STYLE[role] ?? ROLE_STYLE.system}`}
              >
                <div className="mb-1 font-mono text-[10px] uppercase tracking-wider text-fg-subtle">
                  {role}
                </div>
                <div className="max-h-64 overflow-auto whitespace-pre-wrap text-[12px] leading-relaxed">
                  {content}
                </div>
              </div>
            );
          })}
        </div>
      ) : (
        <JsonBlock value={value} />
      )}
    </div>
  );
}
