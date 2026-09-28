// uucore's LIST grammar for `cut -b/-c/-f`: `N`, `N-M`, `N-`, `-M`, separated by
// commas or spaces, merged when they overlap (adjacent ranges stay apart,
// which `--output-delimiter` can see).

import { quote } from "./records.js";

export interface Range {
  readonly low: number;
  readonly high: number;
}

/** `usize::MAX - 1`: an open end. Larger than any line, so arithmetic stays exact. */
export const OPEN_END = Number.POSITIVE_INFINITY;
const USIZE_MAX = 18_446_744_073_709_551_615n;

export class ListError extends Error {}

export function parseList(list: string): Range[] {
  const ranges: Range[] = [];
  for (const item of list.split(/[, ]/)) {
    try {
      ranges.push(parseRange(item));
    } catch (error) {
      if (!(error instanceof ListError)) throw error;
      throw new ListError(`range ${quote(item)} was invalid: ${error.message}`);
    }
  }
  return merge(ranges);
}

export function complement(ranges: readonly Range[]): Range[] {
  const complements: Range[] = [];
  let previousHigh = 0;
  for (const range of ranges) {
    if (range.low > previousHigh + 1)
      complements.push({ low: previousHigh + 1, high: range.low - 1 });
    previousHigh = range.high;
  }
  if (previousHigh !== OPEN_END) complements.push({ low: previousHigh + 1, high: OPEN_END });
  return complements;
}

function parseRange(item: string): Range {
  const dash = item.indexOf("-");
  if (dash === -1) {
    const value = parsePosition(item);
    return { low: value, high: value };
  }
  const low = item.slice(0, dash);
  const high = item.slice(dash + 1);
  if (low === "" && high === "") throw new ListError("invalid range with no endpoint");
  if (high === "") return { low: parsePosition(low), high: OPEN_END };
  if (low === "") return { low: 1, high: parsePosition(high) };
  const range = { low: parsePosition(low), high: parsePosition(high) };
  if (range.low > range.high) throw new ListError("high end of range less than low end");
  return range;
}

/** Rust's `usize` parse: optional `+`, decimal digits, no overflow. */
function parsePosition(text: string): number {
  const digits = text.startsWith("+") ? text.slice(1) : text;
  if (!/^[0-9]+$/.test(digits)) throw new ListError("failed to parse range");
  const value = BigInt(digits);
  if (value > USIZE_MAX) throw new ListError("failed to parse range");
  if (value === 0n) throw new ListError("fields and positions are numbered from 1");
  if (value === USIZE_MAX) throw new ListError("byte/character offset is too large");
  return value >= USIZE_MAX - 1n ? OPEN_END : Number(value);
}

function merge(input: readonly Range[]): Range[] {
  const sorted = [...input].sort(byBounds);
  const merged: Range[] = [];
  for (const range of sorted) {
    const previous = merged[merged.length - 1];
    if (previous !== undefined && range.low <= previous.high) {
      merged[merged.length - 1] = { low: previous.low, high: Math.max(previous.high, range.high) };
      continue;
    }
    merged.push(range);
  }
  return merged;
}

function byBounds(left: Range, right: Range): number {
  if (left.low !== right.low) return left.low < right.low ? -1 : 1;
  if (left.high !== right.high) return left.high < right.high ? -1 : 1;
  return 0;
}
