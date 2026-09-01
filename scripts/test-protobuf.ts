/**
 * Round-trip check for the hand-written OTLP protobuf decoder.
 *
 * Encodes spans with a minimal writer built directly from the OTLP proto
 * definition, POSTs them as application/x-protobuf (the OTel SDK default),
 * then reads the stored trace back and asserts every field survived — in
 * particular the two representations that are easy to get wrong: int64 varints
 * and fixed64 nanosecond timestamps.
 */

import { getTrace } from "../src/lib/db";

class PbWriter {
  private chunks: Buffer[] = [];

  tag(field: number, wire: number): void {
    this.varint((field << 3) | wire);
  }

  varint(value: number): void {
    let v = value >>> 0;
    const out: number[] = [];
    while (v > 0x7f) {
      out.push((v & 0x7f) | 0x80);
      v >>>= 7;
    }
    out.push(v);
    this.chunks.push(Buffer.from(out));
  }

  fixed64(value: bigint): void {
    const buf = Buffer.alloc(8);
    buf.writeBigUInt64LE(value);
    this.chunks.push(buf);
  }

  private delimited(buf: Buffer): void {
    this.varint(buf.length);
    this.chunks.push(buf);
  }

  string(value: string): void {
    this.delimited(Buffer.from(value, "utf8"));
  }

  /** Length-prefixed bytes: tag must already have been written by the caller. */
  bytes(value: Buffer): void {
    this.delimited(value);
  }

  /** Append raw bytes with no tag and no length prefix (nesting helper). */
  append(value: Buffer): void {
    this.chunks.push(value);
  }

  message(field: number, build: (w: PbWriter) => void): void {
    const inner = new PbWriter();
    build(inner);
    this.tag(field, 2);
    this.delimited(inner.build());
  }

  build(): Buffer {
    return Buffer.concat(this.chunks);
  }
}

// stringValue is field 1 with wire type 2 (length-delimited). Write tag then
// bytes directly — wrapping in message() would add a second length prefix.
const anyString =
  (value: string) =>
  (w: PbWriter) => {
    w.tag(1, 2);
    w.string(value);
  };

const anyInt = (value: number) => (w: PbWriter) => {
  w.tag(3, 0);
  w.varint(value);
};

const keyValue =
  (key: string, value: (w: PbWriter) => void) =>
  (w: PbWriter) => {
    w.tag(1, 2);
    w.string(key);
    w.message(2, value);
  };

const TRACE_ID = "aabbccddeeff00112233445566778899";
const ROOT_SPAN_ID = "99aabbccddeeff00";
const CHILD_SPAN_ID = "1122334455667788";

const ROOT_START = 1_800_000_000_000_000_000n;
const CHILD_START = ROOT_START + 500_000_000n;
const CHILD_END = CHILD_START + 2_500_000_000n;
const ROOT_END = CHILD_END + 300_000_000n;

function writeSpan(
  w: PbWriter,
  spanId: string,
  name: string,
  kind: number,
  start: bigint,
  end: bigint,
  attrs: ((w: PbWriter) => void)[],
  parentSpanId?: string,
): void {
  w.tag(1, 2);
  w.bytes(Buffer.from(TRACE_ID, "hex"));
  w.tag(2, 2);
  w.bytes(Buffer.from(spanId, "hex"));
  if (parentSpanId) {
    w.tag(4, 2);
    w.bytes(Buffer.from(parentSpanId, "hex"));
  }
  w.tag(5, 2);
  w.string(name);
  w.tag(6, 0);
  w.varint(kind);
  w.tag(7, 1);
  w.fixed64(start);
  w.tag(8, 1);
  w.fixed64(end);
  for (const attr of attrs) {
    w.message(9, attr);
  }
  // status { code = 3 } => OK
  w.tag(15, 2);
  const status = new PbWriter();
  status.tag(3, 0);
  status.varint(1);
  w.bytes(status.build());
}

const rootSpan = new PbWriter();
writeSpan(
  rootSpan,
  ROOT_SPAN_ID,
  "invoke_agent protobuf-test-agent",
  1, // INTERNAL
  ROOT_START,
  ROOT_END,
  [
    keyValue("gen_ai.operation.name", anyString("invoke_agent")),
    keyValue("gen_ai.agent.name", anyString("protobuf-test-agent")),
    keyValue("gen_ai.conversation.id", anyString("conv_pb_1")),
  ],
);

const childSpan = new PbWriter();
writeSpan(
  childSpan,
  CHILD_SPAN_ID,
  "chat o4-mini",
  3, // CLIENT
  CHILD_START,
  CHILD_END,
  [
    keyValue("gen_ai.operation.name", anyString("chat")),
    keyValue("gen_ai.provider.name", anyString("openai")),
    keyValue("gen_ai.request.model", anyString("o4-mini")),
    keyValue("gen_ai.usage.input_tokens", anyInt(1500)),
    keyValue("gen_ai.usage.output_tokens", anyInt(240)),
    keyValue("gen_ai.usage.reasoning.output_tokens", anyInt(9100)),
  ],
  ROOT_SPAN_ID,
);

// message() emits tag + length, so the callback must append the raw payload
// only — adding another length prefix here corrupts the stream.
// ScopeSpans { repeated Span spans = 2; }
const scopeSpans = new PbWriter();
scopeSpans.message(2, (w) => w.append(rootSpan.build()));
scopeSpans.message(2, (w) => w.append(childSpan.build()));

// ResourceSpans { repeated ScopeSpans scope_spans = 2; }
const resourceSpans = new PbWriter();
resourceSpans.message(2, (w) => w.append(scopeSpans.build()));

// ExportTraceServiceRequest { repeated ResourceSpans resource_spans = 1; }
const request = new PbWriter();
request.message(1, (w) => w.append(resourceSpans.build()));

const payload = request.build();

async function main(): Promise<void> {
  const res = await fetch("http://localhost:3000/api/v1/traces", {
    method: "POST",
    headers: { "content-type": "application/x-protobuf" },
    // Node's Buffer is not assignable to BodyInit; a plain Uint8Array is.
    body: new Uint8Array(payload),
  });

  const body = await res.text();
  console.log(`POST /api/v1/traces -> ${res.status} ${body}`);
  if (!res.ok) {
    process.exitCode = 1;
    return;
  }

  const trace = getTrace(TRACE_ID);
  if (!trace) {
    console.error("FAIL: trace missing after ingest");
    process.exitCode = 1;
    return;
  }

  const spans = trace.orderedIds.map((id) => trace.byId[id]!);
  const chat = spans.find((s) => s.operation === "chat");
  const agent = spans.find((s) => s.operation === "invoke_agent");

  const checks: [string, boolean, string][] = [
    ["spans ingested", spans.length === 2, `got ${spans.length}`],
    ["tree assembled (1 root)", trace.rootIds.length === 1, `got ${trace.rootIds.length}`],
    ["chat nested under agent", chat?.depth === 1, `depth ${chat?.depth}`],
    ["model decoded", chat?.model === "o4-mini", `got ${chat?.model}`],
    ["provider decoded", chat?.provider === "openai", `got ${chat?.provider}`],
    ["input tokens (int64)", chat?.usage.inputTokens === 1500, `got ${chat?.usage.inputTokens}`],
    ["output tokens (int64)", chat?.usage.outputTokens === 240, `got ${chat?.usage.outputTokens}`],
    [
      "reasoning tokens (int64)",
      chat?.usage.reasoningTokens === 9100,
      `got ${chat?.usage.reasoningTokens}`,
    ],
    [
      "total = sum",
      chat?.usage.totalTokens === 1500 + 240 + 9100,
      `got ${chat?.usage.totalTokens}`,
    ],
    [
      "duration from fixed64 ns",
      chat?.durationNs === 2_500_000_000,
      `got ${chat?.durationNs}`,
    ],
    [
      "start offset from fixed64 ns",
      chat?.startOffsetNs === 500_000_000,
      `got ${chat?.startOffsetNs}`,
    ],
    ["span kind", chat?.kind === 3, `got ${chat?.kind}`],
    ["span name", chat?.name === "chat o4-mini", `got ${chat?.name}`],
    [
      "agent name decoded",
      agent?.agentName === "protobuf-test-agent",
      `got ${agent?.agentName}`,
    ],
    [
      "no reasoning-token warning",
      (chat?.warnings ?? []).filter((w) => w.code === "MISSING_REASONING_TOKENS").length === 0,
      "unexpectedly warned despite reporting reasoning tokens",
    ],
  ];

  let failed = 0;
  for (const [label, ok, detail] of checks) {
    console.log(`  ${ok ? "✓" : "✗"} ${label}${ok ? "" : ` — ${detail}`}`);
    if (!ok) failed += 1;
  }

  console.log(
    failed === 0
      ? "\nprotobuf round-trip: ALL PASS"
      : `\nprotobuf round-trip: ${failed} FAILURE(S)`,
  );
  if (failed > 0) process.exitCode = 1;
}

void main();
