import type { AnyValue, KeyValue } from "./types";

/**
 * Decode a single OTLP AnyValue into a plain JS value.
 *
 * int64 is decoded to a number only when it is exactly representable; larger
 * values are preserved as strings so nothing is silently rounded.
 */
export function decodeAnyValue(value: AnyValue | undefined): unknown {
  if (value === undefined || value === null) return null;

  if ("stringValue" in value) return value.stringValue;
  if ("boolValue" in value) return value.boolValue;
  if ("doubleValue" in value) return value.doubleValue;
  if ("bytesValue" in value) return value.bytesValue;

  if ("intValue" in value) {
    const raw = value.intValue;
    const asBig = Number(raw);
    return Number.isSafeInteger(asBig) ? asBig : raw;
  }

  if ("arrayValue" in value) {
    return (value.arrayValue?.values ?? []).map(decodeAnyValue);
  }

  if ("kvlistValue" in value) {
    return decodeAttributes(value.kvlistValue?.values ?? []);
  }

  return null;
}

/** Decode an OTLP KeyValue list into a flat object. Later keys win. */
export function decodeAttributes(attrs: KeyValue[] | undefined): Record<string, unknown> {
  if (!attrs?.length) return {};
  const out: Record<string, unknown> = {};
  for (const { key, value } of attrs) {
    if (!key) continue;
    out[key] = decodeAnyValue(value);
  }
  return out;
}

/**
 * Parse a nanosecond timestamp string into BigInt.
 * Tolerates inputs that were (incorrectly) serialized as JSON numbers.
 */
export function parseNanos(raw: string | number | undefined | null): bigint {
  if (raw === undefined || raw === null || raw === "") return 0n;
  if (typeof raw === "number") {
    return Number.isFinite(raw) ? BigInt(Math.round(raw)) : 0n;
  }
  try {
    return BigInt(raw);
  } catch {
    const asNum = Number(raw);
    return Number.isFinite(asNum) ? BigInt(Math.round(asNum)) : 0n;
  }
}
