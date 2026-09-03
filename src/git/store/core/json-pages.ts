import { CorruptError } from "../../common/errors.js";
import { refTextBytes } from "../refs/ref-validation.js";
import type { RefRow } from "./contracts.js";

export const JSON_ENCODER = new TextEncoder();
export const JSON_BATCH_ROWS = 2_048;
export const JSON_BATCH_BYTES = 1_500_000;

interface RefLogJsonEvent {
  refName: string;
  oldRaw: string | null;
  newRaw: string | null;
  oldOid: string | null;
  newOid: string | null;
  actorName: string | null;
  actorEmail: string | null;
  reason: string;
}

export function utf8ByteLength(value: string): number {
  let bytes = 0;
  for (let index = 0; index < value.length; index++) {
    const unit = value.charCodeAt(index);
    if (unit >= 0xd800 && unit <= 0xdbff) {
      const low = value.charCodeAt(index + 1);
      if (low >= 0xdc00 && low <= 0xdfff) index++;
      bytes += low >= 0xdc00 && low <= 0xdfff ? 4 : 3;
    } else if (unit >= 0xdc00 && unit <= 0xdfff) {
      bytes += 3;
    } else {
      bytes += unit < 0x80 ? 1 : unit < 0x800 ? 2 : 3;
    }
  }
  return bytes;
}

export function jsonStringMaxUnits(value: string): number {
  let units = 2;
  for (let index = 0; index < value.length; index++) {
    const unit = value.charCodeAt(index);
    if (
      unit === 0x22 ||
      unit === 0x5c ||
      unit === 0x08 ||
      unit === 0x09 ||
      unit === 0x0a ||
      unit === 0x0c ||
      unit === 0x0d
    ) {
      units += 2;
    } else if (unit < 0x20) {
      units += 6;
    } else if (unit >= 0xd800 && unit <= 0xdbff) {
      const low = value.charCodeAt(index + 1);
      if (low >= 0xdc00 && low <= 0xdfff) {
        units += 2;
        index++;
      } else {
        units += 6;
      }
    } else if (unit >= 0xdc00 && unit <= 0xdfff) {
      units += 6;
    } else {
      units++;
    }
  }
  return units;
}

export function jsonStringEncodedBytes(value: string): number {
  let bytes = 2;
  for (let index = 0; index < value.length; index++) {
    const unit = value.charCodeAt(index);
    if (
      unit === 0x22 ||
      unit === 0x5c ||
      unit === 0x08 ||
      unit === 0x09 ||
      unit === 0x0a ||
      unit === 0x0c ||
      unit === 0x0d
    ) {
      bytes += 2;
    } else if (unit < 0x20) {
      bytes += 6;
    } else if (unit >= 0xd800 && unit <= 0xdbff) {
      const low = value.charCodeAt(index + 1);
      if (low >= 0xdc00 && low <= 0xdfff) {
        bytes += 4;
        index++;
      } else {
        bytes += 6;
      }
    } else if (unit >= 0xdc00 && unit <= 0xdfff) {
      bytes += 6;
    } else {
      bytes += unit < 0x80 ? 1 : unit < 0x800 ? 2 : 3;
    }
  }
  return bytes;
}

export function refRowJsonMaxUnits(row: RefRow): number {
  return 19 + jsonStringMaxUnits(row.name) + jsonStringMaxUnits(row.target);
}

export function* jsonPages<T>(items: Iterable<T>, _label: string): Generator<string> {
  let rows: string[] = [];
  let bytes = 2;
  const emit = function* (): Generator<string> {
    const joined = rows.join(",");
    yield `[${joined}]`;
  };
  for (const item of items) {
    const row = JSON.stringify(item);
    const rowBytes = refTextBytes(row, "JSON batch row", "input");
    const separator = rows.length === 0 ? 0 : 1;
    if (
      rows.length > 0 &&
      (rows.length >= JSON_BATCH_ROWS || bytes + separator + rowBytes > JSON_BATCH_BYTES)
    ) {
      yield* emit();
      rows = [];
      bytes = 2;
    }
    bytes += (rows.length === 0 ? 0 : 1) + rowBytes;
    rows.push(row);
    if (bytes >= JSON_BATCH_BYTES) {
      yield* emit();
      rows = [];
      bytes = 2;
    }
  }
  if (rows.length > 0) yield* emit();
}

export function refLogEventJsonMaxUnits(event: RefLogJsonEvent): number {
  return (
    512 +
    6 *
      (event.refName.length +
        (event.oldRaw?.length ?? 0) +
        (event.newRaw?.length ?? 0) +
        (event.oldOid?.length ?? 0) +
        (event.newOid?.length ?? 0) +
        (event.actorName?.length ?? 0) +
        (event.actorEmail?.length ?? 0) +
        event.reason.length)
  );
}

export function requireBooleanProbe(value: unknown, label: string): boolean {
  if (value !== 0 && value !== 1) throw new CorruptError(`${label} returned an invalid value`);
  return value === 1;
}

export function isThenableResult(value: unknown): boolean {
  if ((typeof value !== "object" || value === null) && typeof value !== "function") return false;
  return typeof Reflect.get(value, "then") === "function";
}
