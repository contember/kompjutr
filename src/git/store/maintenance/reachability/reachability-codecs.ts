import { isOid } from "../../../common/bytes.js";
import { CorruptError } from "../../../common/errors.js";
import type { ObjectType } from "../../../common/objects.js";

export function safeInteger(
  value: unknown,
  label: string,
  minimum: number,
  maximum = Number.MAX_SAFE_INTEGER,
): number {
  if (
    typeof value !== "number" ||
    !Number.isSafeInteger(value) ||
    value < minimum ||
    value > maximum
  ) {
    throw new CorruptError(`${label} is not a bounded safe integer`);
  }
  return value;
}

export function booleanInteger(value: unknown, label: string): boolean {
  if (value !== 0 && value !== 1) throw new CorruptError(`${label} is not boolean`);
  return value === 1;
}

export function objectType(value: unknown, label: string): ObjectType {
  if (value !== "blob" && value !== "tree" && value !== "commit" && value !== "tag") {
    throw new CorruptError(`${label} is invalid`);
  }
  return value;
}

export function oidField(value: unknown, label: string): string {
  if (typeof value !== "string" || !isOid(value)) {
    throw new CorruptError(`${label} is invalid`);
  }
  return value;
}

export function bytesField(value: unknown, label: string): Uint8Array {
  if (value instanceof Uint8Array) return value;
  if (value instanceof ArrayBuffer) return new Uint8Array(value);
  throw new CorruptError(`${label} is not a BLOB`);
}
