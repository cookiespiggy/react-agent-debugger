import type { AnyValue, KeyValue } from "./types";

/** Encode plain JS values as OTLP attributes (the inverse of `decode.ts`). */

function toAnyValue(value: unknown): AnyValue {
  if (typeof value === "string") return { stringValue: value };
  if (typeof value === "boolean") return { boolValue: value };
  if (typeof value === "number") {
    return Number.isInteger(value) ? { intValue: String(value) } : { doubleValue: value };
  }
  if (value === null || value === undefined) return { stringValue: "" };
  if (Array.isArray(value)) {
    return { arrayValue: { values: value.map(toAnyValue) } };
  }
  if (typeof value === "object") {
    return {
      kvlistValue: {
        values: Object.entries(value as Record<string, unknown>).map(([key, v]) => ({
          key,
          value: toAnyValue(v),
        })),
      },
    };
  }
  return { stringValue: String(value) };
}

export function toOtlpAttributes(attrs: Record<string, unknown>): KeyValue[] {
  return Object.entries(attrs)
    .filter(([, v]) => v !== undefined && v !== null)
    .map(([key, value]) => ({ key, value: toAnyValue(value) }));
}

/** Nanoseconds since epoch, as a string — OTLP's 64-bit representation. */
export function nowNs(): bigint {
  return BigInt(Date.now()) * 1_000_000n;
}

export function nsFromMs(ms: number): bigint {
  return BigInt(Math.max(0, Math.round(ms))) * 1_000_000n;
}
