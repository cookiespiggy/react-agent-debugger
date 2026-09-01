import Database from "better-sqlite3";
import fs from "node:fs";
import path from "node:path";
import type { OtlpSpan } from "../otlp/types";
import type { SpanView, TraceView } from "../trace/tree";

/**
 * SQLite-backed trace store.
 *
 * Server-only. Two tables:
 *  - `traces`  — one row per trace, with the full TraceView as JSON. Read-heavy,
 *                avoids joins for the common "render this trace" path.
 *  - `spans`   — flattened index. Enables cross-trace analytics later
 *                (e.g. p95 latency of every `web_search` call) without scanning JSON.
 */

const DATA_DIR = path.join(process.cwd(), "data");
const DB_PATH = path.join(DATA_DIR, "traces.db");

const SCHEMA = `
CREATE TABLE IF NOT EXISTS traces (
  trace_id        TEXT PRIMARY KEY,
  started_at_ms   INTEGER NOT NULL,
  duration_ns     INTEGER NOT NULL,
  span_count      INTEGER NOT NULL DEFAULT 0,
  input_tokens    INTEGER NOT NULL DEFAULT 0,
  output_tokens   INTEGER NOT NULL DEFAULT 0,
  reasoning_tokens INTEGER NOT NULL DEFAULT 0,
  total_tokens    INTEGER NOT NULL DEFAULT 0,
  model_calls     INTEGER NOT NULL DEFAULT 0,
  tool_calls      INTEGER NOT NULL DEFAULT 0,
  error_count     INTEGER NOT NULL DEFAULT 0,
  warning_count   INTEGER NOT NULL DEFAULT 0,
  agent_name      TEXT,
  conversation_id TEXT,
  models          TEXT NOT NULL DEFAULT '[]',
  payload         TEXT NOT NULL,
  created_at      INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_traces_started  ON traces(started_at_ms DESC);
CREATE INDEX IF NOT EXISTS idx_traces_errors   ON traces(error_count);
CREATE INDEX IF NOT EXISTS idx_traces_agent    ON traces(agent_name);

CREATE TABLE IF NOT EXISTS spans (
  trace_id         TEXT NOT NULL,
  span_id          TEXT NOT NULL,
  parent_span_id   TEXT,
  name             TEXT,
  operation        TEXT,
  start_offset_ns  INTEGER NOT NULL DEFAULT 0,
  duration_ns      INTEGER NOT NULL DEFAULT 0,
  self_duration_ns INTEGER NOT NULL DEFAULT 0,
  model            TEXT,
  provider         TEXT,
  tool_name        TEXT,
  agent_name       TEXT,
  status_code      INTEGER NOT NULL DEFAULT 0,
  error_type       TEXT,
  input_tokens     INTEGER,
  output_tokens    INTEGER,
  reasoning_tokens INTEGER,
  depth            INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (trace_id, span_id)
);

CREATE INDEX IF NOT EXISTS idx_spans_operation ON spans(operation);
CREATE INDEX IF NOT EXISTS idx_spans_tool      ON spans(tool_name);
CREATE INDEX IF NOT EXISTS idx_spans_model     ON spans(model);
CREATE INDEX IF NOT EXISTS idx_spans_trace     ON spans(trace_id);

-- Original OTLP spans, kept verbatim.
--
-- Exporters commonly split one trace across several batches. Storing the raw
-- wire form (pure JSON — no BigInt, unlike the normalized shape) lets us merge
-- later batches into an existing trace and rebuild the derived view idempotently.
CREATE TABLE IF NOT EXISTS raw_spans (
  trace_id   TEXT NOT NULL,
  span_id    TEXT NOT NULL,
  payload    TEXT NOT NULL,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (trace_id, span_id)
);

CREATE INDEX IF NOT EXISTS idx_raw_spans_trace ON raw_spans(trace_id);
`;

// Next.js dev-mode hot reload re-evaluates modules; cache on globalThis so we
// don't leak file handles or re-run migrations every save.
declare global {
  // eslint-disable-next-line no-var
  var __radDb: Database.Database | undefined;
}

function init(): Database.Database {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  const db = new Database(DB_PATH);
  db.pragma("journal_mode = WAL");
  db.pragma("synchronous = NORMAL");
  db.pragma("foreign_keys = ON");
  db.exec(SCHEMA);
  return db;
}

export function getDb(): Database.Database {
  if (!globalThis.__radDb) {
    globalThis.__radDb = init();
  }
  return globalThis.__radDb;
}

export interface TraceListItem {
  traceId: string;
  startedAtMs: number;
  durationNs: number;
  spanCount: number;
  inputTokens: number;
  outputTokens: number;
  reasoningTokens: number;
  totalTokens: number;
  modelCalls: number;
  toolCalls: number;
  errorCount: number;
  warningCount: number;
  agentName: string | null;
  conversationId: string | null;
  models: string[];
}

/** Row shape as returned by SQLite — snake_case, matching the table columns. */
interface TraceRow {
  trace_id: string;
  started_at_ms: number;
  duration_ns: number;
  span_count: number;
  input_tokens: number;
  output_tokens: number;
  reasoning_tokens: number;
  total_tokens: number;
  model_calls: number;
  tool_calls: number;
  error_count: number;
  warning_count: number;
  agent_name: string | null;
  conversation_id: string | null;
  models: string;
}

const LIST_COLUMNS = `
  trace_id, started_at_ms, duration_ns, span_count,
  input_tokens, output_tokens, reasoning_tokens, total_tokens,
  model_calls, tool_calls, error_count, warning_count,
  agent_name, conversation_id, models
`;

function rowToListItem(row: TraceRow): TraceListItem {
  let models: string[] = [];
  try {
    const parsed: unknown = JSON.parse(row.models);
    if (Array.isArray(parsed)) models = parsed.filter((m): m is string => typeof m === "string");
  } catch {
    models = [];
  }
  return {
    traceId: row.trace_id,
    startedAtMs: row.started_at_ms,
    durationNs: row.duration_ns,
    spanCount: row.span_count,
    inputTokens: row.input_tokens,
    outputTokens: row.output_tokens,
    reasoningTokens: row.reasoning_tokens,
    totalTokens: row.total_tokens,
    modelCalls: row.model_calls,
    toolCalls: row.tool_calls,
    errorCount: row.error_count,
    warningCount: row.warning_count,
    agentName: row.agent_name,
    conversationId: row.conversation_id,
    models,
  };
}

export function insertTrace(view: TraceView): void {
  const db = getDb();
  const insertTraceStmt = db.prepare(`
    INSERT INTO traces (
      trace_id, started_at_ms, duration_ns, span_count,
      input_tokens, output_tokens, reasoning_tokens, total_tokens,
      model_calls, tool_calls, error_count, warning_count,
      agent_name, conversation_id, models, payload, created_at
    ) VALUES (
      @trace_id, @started_at_ms, @duration_ns, @span_count,
      @input_tokens, @output_tokens, @reasoning_tokens, @total_tokens,
      @model_calls, @tool_calls, @error_count, @warning_count,
      @agent_name, @conversation_id, @models, @payload, @created_at
    )
    ON CONFLICT(trace_id) DO UPDATE SET
      started_at_ms    = excluded.started_at_ms,
      duration_ns      = excluded.duration_ns,
      span_count       = excluded.span_count,
      input_tokens     = excluded.input_tokens,
      output_tokens    = excluded.output_tokens,
      reasoning_tokens = excluded.reasoning_tokens,
      total_tokens     = excluded.total_tokens,
      model_calls      = excluded.model_calls,
      tool_calls       = excluded.tool_calls,
      error_count      = excluded.error_count,
      warning_count    = excluded.warning_count,
      agent_name       = excluded.agent_name,
      conversation_id  = excluded.conversation_id,
      models           = excluded.models,
      payload          = excluded.payload,
      created_at       = excluded.created_at
  `);

  const insertSpanStmt = db.prepare(`
    INSERT INTO spans (
      trace_id, span_id, parent_span_id, name, operation,
      start_offset_ns, duration_ns, self_duration_ns,
      model, provider, tool_name, agent_name,
      status_code, error_type, input_tokens, output_tokens, reasoning_tokens, depth
    ) VALUES (
      @trace_id, @span_id, @parent_span_id, @name, @operation,
      @start_offset_ns, @duration_ns, @self_duration_ns,
      @model, @provider, @tool_name, @agent_name,
      @status_code, @error_type, @input_tokens, @output_tokens, @reasoning_tokens, @depth
    )
    ON CONFLICT(trace_id, span_id) DO UPDATE SET
      parent_span_id   = excluded.parent_span_id,
      name             = excluded.name,
      operation        = excluded.operation,
      start_offset_ns  = excluded.start_offset_ns,
      duration_ns      = excluded.duration_ns,
      self_duration_ns = excluded.self_duration_ns,
      model            = excluded.model,
      provider         = excluded.provider,
      tool_name        = excluded.tool_name,
      agent_name       = excluded.agent_name,
      status_code      = excluded.status_code,
      error_type       = excluded.error_type,
      input_tokens     = excluded.input_tokens,
      output_tokens    = excluded.output_tokens,
      reasoning_tokens = excluded.reasoning_tokens,
      depth            = excluded.depth
  `);

  const deleteSpansStmt = db.prepare(`DELETE FROM spans WHERE trace_id = ?`);

  const spanRow = (span: SpanView) => ({
    trace_id: view.traceId,
    span_id: span.spanId,
    parent_span_id: span.parentSpanId,
    name: span.name,
    operation: span.operation,
    start_offset_ns: Math.round(span.startOffsetNs),
    duration_ns: Math.round(span.durationNs),
    self_duration_ns: Math.round(span.selfDurationNs),
    model: span.model,
    provider: span.provider,
    tool_name: span.toolName,
    agent_name: span.agentName,
    status_code: span.statusCode,
    error_type: span.errorType,
    input_tokens: span.usage.inputTokens,
    output_tokens: span.usage.outputTokens,
    reasoning_tokens: span.usage.reasoningTokens,
    depth: span.depth,
  });

  const run = db.transaction(() => {
    insertTraceStmt.run({
      trace_id: view.traceId,
      started_at_ms: view.startedAtMs,
      duration_ns: Math.round(view.durationNs),
      span_count: view.totals.spanCount,
      input_tokens: view.totals.inputTokens,
      output_tokens: view.totals.outputTokens,
      reasoning_tokens: view.totals.reasoningTokens,
      total_tokens: view.totals.totalTokens,
      model_calls: view.totals.modelCalls,
      tool_calls: view.totals.toolCalls,
      error_count: view.totals.errorCount,
      warning_count: view.totals.warningCount,
      agent_name: view.agentName,
      conversation_id: view.conversationId,
      models: JSON.stringify(view.models),
      payload: JSON.stringify(view),
      created_at: Date.now(),
    });

    // Replace the span index wholesale: a re-exported trace may have merged
    // spans from multiple OTLP batches, so upsert alone would leave stale rows.
    deleteSpansStmt.run(view.traceId);
    for (const id of view.orderedIds) {
      const span = view.byId[id];
      if (span) insertSpanStmt.run(spanRow(span));
    }
  });

  run();
}

export interface ListTracesOptions {
  limit?: number;
  onlyErrors?: boolean;
  query?: string;
}

export function listTraces(opts: ListTracesOptions = {}): TraceListItem[] {
  const db = getDb();
  const { limit = 100, onlyErrors = false, query } = opts;

  const where: string[] = [];
  const params: unknown[] = [];

  if (onlyErrors) where.push("error_count > 0");
  if (query) {
    where.push("(agent_name LIKE ? OR conversation_id LIKE ? OR trace_id LIKE ?)");
    const like = `%${query}%`;
    params.push(like, like, like);
  }

  const sql = `
    SELECT ${LIST_COLUMNS}
    FROM traces
    ${where.length ? `WHERE ${where.join(" AND ")}` : ""}
    ORDER BY started_at_ms DESC
    LIMIT ?
  `;
  params.push(limit);

  const rows = db.prepare(sql).all(...params) as TraceRow[];
  return rows.map(rowToListItem);
}

export function getTrace(traceId: string): TraceView | null {
  const db = getDb();
  const row = db
    .prepare(`SELECT payload FROM traces WHERE trace_id = ?`)
    .get(traceId) as { payload: string } | undefined;
  if (!row) return null;
  try {
    return JSON.parse(row.payload) as TraceView;
  } catch {
    return null;
  }
}

export function deleteTrace(traceId: string): void {
  const db = getDb();
  const run = db.transaction(() => {
    db.prepare(`DELETE FROM spans WHERE trace_id = ?`).run(traceId);
    db.prepare(`DELETE FROM traces WHERE trace_id = ?`).run(traceId);
  });
  run();
}

export function clearAll(): void {
  const db = getDb();
  const run = db.transaction(() => {
    db.prepare(`DELETE FROM spans`).run();
    db.prepare(`DELETE FROM traces`).run();
  });
  run();
}

/** An original OTLP span plus its surrounding context, stored verbatim as JSON. */
export interface RawSpanRecord {
  span: OtlpSpan;
  resourceAttributes: Record<string, unknown>;
  scopeName: string | null;
}

interface RawSpanRow {
  trace_id: string;
  span_id: string;
  payload: string;
}

export function upsertRawSpans(traceId: string, records: RawSpanRecord[]): void {
  if (records.length === 0) return;
  const db = getDb();
  const stmt = db.prepare(`
    INSERT INTO raw_spans (trace_id, span_id, payload, updated_at)
    VALUES (?, ?, ?, ?)
    ON CONFLICT(trace_id, span_id) DO UPDATE SET
      payload = excluded.payload,
      updated_at = excluded.updated_at
  `);
  const run = db.transaction(() => {
    const now = Date.now();
    for (const r of records) {
      stmt.run(traceId, r.span.spanId, JSON.stringify(r), now);
    }
  });
  run();
}

export function getRawSpans(traceId: string): RawSpanRecord[] {
  const db = getDb();
  const rows = db
    .prepare(`SELECT trace_id, span_id, payload FROM raw_spans WHERE trace_id = ?`)
    .all(traceId) as RawSpanRow[];

  const out: RawSpanRecord[] = [];
  for (const row of rows) {
    try {
      out.push(JSON.parse(row.payload) as RawSpanRecord);
    } catch {
      // Skip rows corrupted by a schema change; the trace still renders without them.
    }
  }
  return out;
}

/**
 * Drop raw spans that no longer belong to a retained trace.
 * Raw spans exist only to merge late-arriving batches, so once a trace falls
 * out of the retention window they are dead weight.
 */
export function pruneRawSpans(keepTraces = 200): void {
  const db = getDb();
  db.prepare(`
    DELETE FROM raw_spans
    WHERE trace_id NOT IN (
      SELECT trace_id FROM traces ORDER BY started_at_ms DESC LIMIT ?
    )
  `).run(keepTraces);
}

export function stats(): { traceCount: number; spanCount: number } {
  const db = getDb();
  const t = db.prepare(`SELECT COUNT(*) AS n FROM traces`).get() as { n: number };
  const s = db.prepare(`SELECT COUNT(*) AS n FROM spans`).get() as { n: number };
  return { traceCount: t.n, spanCount: s.n };
}
