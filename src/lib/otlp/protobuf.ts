import type {
  AnyValue,
  ExportTraceServiceRequest,
  KeyValue,
  OtlpSpan,
  ResourceSpans,
  ScopeSpans,
  SpanEvent,
  SpanLink,
  SpanStatus,
} from "./types";

/**
 * Minimal decoder for OTLP/HTTP `application/x-protobuf` — the **default**
 * protocol of every OTel SDK exporter, so a receiver that only speaks JSON
 * would be useless in practice.
 *
 * Hand-rolled on purpose: pulling in `@opentelemetry/otlp-transformer` drags
 * `protobufjs` plus the whole OTel API/core tree into a local debugger. The
 * OTLP proto schema is standardised and stable, so ~200 lines of wire-format
 * reading is the smaller dependency.
 *
 * Spec: https://opentelemetry.io/docs/specs/otlp/#binary-protobuf-encoding
 */

const WIRE_VARINT = 0;
const WIRE_FIXED64 = 1;
const WIRE_LEN_DELIMITED = 2;
const WIRE_FIXED32 = 5;

class PbReader {
  private pos = 0;

  constructor(private readonly buf: Buffer) {}

  get done(): boolean {
    return this.pos >= this.buf.length;
  }

  /** Read a tag. Returns null at end of buffer. */
  readTag(): { field: number; wireType: number } | null {
    if (this.done) return null;
    const v = this.readVarint();
    return { field: v >>> 3, wireType: v & 0x07 };
  }

  /** varint as a JS number. Only for fields known to be small (tags, lengths, enums). */
  readVarint(): number {
    let result = 0;
    let shift = 1;
    for (let i = 0; i < 10; i++) {
      if (this.pos >= this.buf.length) throw new Error("OTLP: truncated varint");
      const b = this.buf[this.pos++]!;
      result += (b & 0x7f) * shift;
      if ((b & 0x80) === 0) return result;
      shift *= 128;
    }
    throw new Error("OTLP: varint exceeds 10 bytes");
  }

  /** varint as BigInt, for int64 values. Handles two's-complement negatives. */
  readVarint64(): bigint {
    let result = 0n;
    let shift = 0n;
    for (let i = 0; i < 10; i++) {
      if (this.pos >= this.buf.length) throw new Error("OTLP: truncated int64");
      const b = BigInt(this.buf[this.pos++]!);
      result |= (b & 0x7fn) << shift;
      if ((b & 0x80n) === 0n) {
        // int64 varints encode negatives as unsigned 2^64-complement.
        if (result >= 1n << 63n) result -= 1n << 64n;
        return result;
      }
      shift += 7n;
    }
    throw new Error("OTLP: int64 exceeds 10 bytes");
  }

  readFixed64(): bigint {
    if (this.pos + 8 > this.buf.length) throw new Error("OTLP: truncated fixed64");
    const lo = this.buf.readUInt32LE(this.pos);
    const hi = this.buf.readUInt32LE(this.pos + 4);
    this.pos += 8;
    return (BigInt(hi) << 32n) | BigInt(lo);
  }

  readFixed32(): number {
    if (this.pos + 4 > this.buf.length) throw new Error("OTLP: truncated fixed32");
    const v = this.buf.readUInt32LE(this.pos);
    this.pos += 4;
    return v;
  }

  readDouble(): number {
    if (this.pos + 8 > this.buf.length) throw new Error("OTLP: truncated double");
    const v = this.buf.readDoubleLE(this.pos);
    this.pos += 8;
    return v;
  }

  readBytes(): Buffer {
    const len = this.readVarint();
    if (len < 0 || this.pos + len > this.buf.length) {
      throw new Error("OTLP: truncated length-delimited field");
    }
    const slice = this.buf.subarray(this.pos, this.pos + len);
    this.pos += len;
    return slice;
  }

  readString(): string {
    return this.readBytes().toString("utf8");
  }

  /** Read a nested message and parse it with the supplied function. */
  readMessage<T>(parse: (r: PbReader) => T): T {
    return parse(new PbReader(this.readBytes()));
  }

  /** Consume an unknown field so forward compatibility is preserved. */
  skip(wireType: number): void {
    switch (wireType) {
      case WIRE_VARINT:
        this.readVarint64();
        break;
      case WIRE_FIXED64:
        this.readFixed64();
        break;
      case WIRE_LEN_DELIMITED:
        this.readBytes();
        break;
      case WIRE_FIXED32:
        this.readFixed32();
        break;
      default:
        throw new Error(`OTLP: unsupported wire type ${wireType}`);
    }
  }
}

function parseAnyValue(r: PbReader): AnyValue {
  // An empty AnyValue carries no oneof field at all.
  let value: AnyValue = { stringValue: "" };

  while (!r.done) {
    const tag = r.readTag();
    if (!tag) break;
    const { field, wireType } = tag;

    switch (field) {
      case 1:
        value = { stringValue: r.readString() };
        break;
      case 2:
        value = { boolValue: r.readVarint() !== 0 };
        break;
      case 3:
        // Keep as string to match the JSON encoding, where int64 is a string.
        value = { intValue: r.readVarint64().toString() };
        break;
      case 4:
        value = { doubleValue: r.readDouble() };
        break;
      case 5:
        value = {
          arrayValue: r.readMessage((rr) => {
            const values: AnyValue[] = [];
            while (!rr.done) {
              const t = rr.readTag();
              if (!t) break;
              if (t.field === 1 && t.wireType === WIRE_LEN_DELIMITED) {
                values.push(rr.readMessage(parseAnyValue));
              } else {
                rr.skip(t.wireType);
              }
            }
            return { values };
          }),
        };
        break;
      case 6:
        value = {
          kvlistValue: r.readMessage((rr) => {
            const values: KeyValue[] = [];
            while (!rr.done) {
              const t = rr.readTag();
              if (!t) break;
              if (t.field === 1 && t.wireType === WIRE_LEN_DELIMITED) {
                values.push(rr.readMessage(parseKeyValue));
              } else {
                rr.skip(t.wireType);
              }
            }
            return { values };
          }),
        };
        break;
      case 7:
        value = { bytesValue: r.readBytes().toString("base64") };
        break;
      default:
        r.skip(wireType);
    }
  }

  return value;
}

function parseKeyValue(r: PbReader): KeyValue {
  const kv: KeyValue = { key: "", value: { stringValue: "" } };

  while (!r.done) {
    const tag = r.readTag();
    if (!tag) break;
    const { field, wireType } = tag;

    if (field === 1 && wireType === WIRE_LEN_DELIMITED) {
      kv.key = r.readString();
    } else if (field === 2 && wireType === WIRE_LEN_DELIMITED) {
      kv.value = r.readMessage(parseAnyValue);
    } else {
      r.skip(wireType);
    }
  }

  return kv;
}

function parseStatus(r: PbReader): SpanStatus {
  const status: SpanStatus = {};
  while (!r.done) {
    const tag = r.readTag();
    if (!tag) break;
    const { field, wireType } = tag;
    if (field === 2 && wireType === WIRE_LEN_DELIMITED) {
      status.message = r.readString();
    } else if (field === 3 && wireType === WIRE_VARINT) {
      status.code = r.readVarint();
    } else {
      r.skip(wireType);
    }
  }
  return status;
}

function parseEvent(r: PbReader): SpanEvent {
  const event: SpanEvent = { timeUnixNano: "0", name: "" };
  const attributes: KeyValue[] = [];

  while (!r.done) {
    const tag = r.readTag();
    if (!tag) break;
    const { field, wireType } = tag;

    switch (field) {
      case 1:
        event.timeUnixNano = r.readFixed64().toString();
        break;
      case 2:
        event.name = r.readString();
        break;
      case 3:
        attributes.push(r.readMessage(parseKeyValue));
        break;
      case 4:
        event.droppedAttributesCount = r.readVarint();
        break;
      default:
        r.skip(wireType);
    }
  }

  if (attributes.length) event.attributes = attributes;
  return event;
}

function parseLink(r: PbReader): SpanLink {
  const link: SpanLink = { traceId: "", spanId: "" };
  const attributes: KeyValue[] = [];

  while (!r.done) {
    const tag = r.readTag();
    if (!tag) break;
    const { field, wireType } = tag;

    switch (field) {
      case 1:
        link.traceId = r.readBytes().toString("hex");
        break;
      case 2:
        link.spanId = r.readBytes().toString("hex");
        break;
      case 3:
        link.traceState = r.readString();
        break;
      case 4:
        attributes.push(r.readMessage(parseKeyValue));
        break;
      case 5:
        link.droppedAttributesCount = r.readVarint();
        break;
      default:
        r.skip(wireType);
    }
  }

  if (attributes.length) link.attributes = attributes;
  return link;
}

function parseSpan(r: PbReader): OtlpSpan {
  const span: OtlpSpan = {
    traceId: "",
    spanId: "",
    name: "",
    startTimeUnixNano: "0",
    endTimeUnixNano: "0",
  };
  const attributes: KeyValue[] = [];
  const events: SpanEvent[] = [];
  const links: SpanLink[] = [];

  while (!r.done) {
    const tag = r.readTag();
    if (!tag) break;
    const { field, wireType } = tag;

    switch (field) {
      case 1:
        span.traceId = r.readBytes().toString("hex");
        break;
      case 2:
        span.spanId = r.readBytes().toString("hex");
        break;
      case 3:
        span.traceState = r.readString();
        break;
      case 4:
        span.parentSpanId = r.readBytes().toString("hex");
        break;
      case 5:
        span.name = r.readString();
        break;
      case 6:
        span.kind = r.readVarint();
        break;
      case 7:
        span.startTimeUnixNano = r.readFixed64().toString();
        break;
      case 8:
        span.endTimeUnixNano = r.readFixed64().toString();
        break;
      case 9:
        attributes.push(r.readMessage(parseKeyValue));
        break;
      case 10:
        span.droppedAttributesCount = r.readVarint();
        break;
      case 11:
        events.push(r.readMessage(parseEvent));
        break;
      case 12:
        span.droppedEventsCount = r.readVarint();
        break;
      case 13:
        links.push(r.readMessage(parseLink));
        break;
      case 14:
        span.droppedLinksCount = r.readVarint();
        break;
      case 15:
        span.status = r.readMessage(parseStatus);
        break;
      case 16:
        span.flags = r.readFixed32();
        break;
      default:
        r.skip(wireType);
    }
  }

  if (attributes.length) span.attributes = attributes;
  if (events.length) span.events = events;
  if (links.length) span.links = links;
  // Empty parent bytes mean "no parent" — normalise to undefined.
  if (span.parentSpanId === "") span.parentSpanId = undefined;

  return span;
}

function parseScopeSpans(r: PbReader): ScopeSpans {
  const scopeSpans: ScopeSpans = { spans: [] };

  while (!r.done) {
    const tag = r.readTag();
    if (!tag) break;
    const { field, wireType } = tag;

    switch (field) {
      case 1:
        scopeSpans.scope = r.readMessage((rr) => {
          const scope: ScopeSpans["scope"] = {};
          const attributes: KeyValue[] = [];
          while (!rr.done) {
            const t = rr.readTag();
            if (!t) break;
            if (t.field === 1 && t.wireType === WIRE_LEN_DELIMITED) scope.name = rr.readString();
            else if (t.field === 2 && t.wireType === WIRE_LEN_DELIMITED) scope.version = rr.readString();
            else if (t.field === 3 && t.wireType === WIRE_LEN_DELIMITED) attributes.push(rr.readMessage(parseKeyValue));
            else if (t.field === 4 && t.wireType === WIRE_VARINT) scope.droppedAttributesCount = rr.readVarint();
            else rr.skip(t.wireType);
          }
          if (attributes.length) scope.attributes = attributes;
          return scope;
        });
        break;
      case 2:
        scopeSpans.spans.push(r.readMessage(parseSpan));
        break;
      case 3:
        scopeSpans.schemaUrl = r.readString();
        break;
      default:
        r.skip(wireType);
    }
  }

  return scopeSpans;
}

function parseResourceSpans(r: PbReader): ResourceSpans {
  const resourceSpans: ResourceSpans = { scopeSpans: [] };

  while (!r.done) {
    const tag = r.readTag();
    if (!tag) break;
    const { field, wireType } = tag;

    switch (field) {
      case 1:
        resourceSpans.resource = r.readMessage((rr) => {
          const attributes: KeyValue[] = [];
          let dropped: number | undefined;
          while (!rr.done) {
            const t = rr.readTag();
            if (!t) break;
            if (t.field === 1 && t.wireType === WIRE_LEN_DELIMITED) attributes.push(rr.readMessage(parseKeyValue));
            else if (t.field === 2 && t.wireType === WIRE_VARINT) dropped = rr.readVarint();
            else rr.skip(t.wireType);
          }
          const resource: ResourceSpans["resource"] = { attributes };
          if (dropped !== undefined) resource.droppedAttributesCount = dropped;
          return resource;
        });
        break;
      case 2:
        resourceSpans.scopeSpans.push(r.readMessage(parseScopeSpans));
        break;
      case 3:
        resourceSpans.schemaUrl = r.readString();
        break;
      default:
        r.skip(wireType);
    }
  }

  return resourceSpans;
}

/**
 * Decode an ExportTraceServiceRequest from protobuf bytes into the same shape
 * the JSON encoding produces, so downstream code is protocol-agnostic.
 */
export function decodeProtobufExportRequest(buf: Buffer): ExportTraceServiceRequest {
  const r = new PbReader(buf);
  const resourceSpans: ResourceSpans[] = [];

  while (!r.done) {
    const tag = r.readTag();
    if (!tag) break;
    if (tag.field === 1 && tag.wireType === WIRE_LEN_DELIMITED) {
      resourceSpans.push(r.readMessage(parseResourceSpans));
    } else {
      r.skip(tag.wireType);
    }
  }

  return { resourceSpans };
}

/** True when the buffer looks like protobuf rather than JSON. */
export function looksLikeProtobuf(buf: Buffer): boolean {
  if (buf.length === 0) return false;
  const first = buf[0]!;
  // JSON payloads start with whitespace or `{`.
  return first !== 0x7b /* { */ && first !== 0x20 && first !== 0x0a && first !== 0x09;
}
