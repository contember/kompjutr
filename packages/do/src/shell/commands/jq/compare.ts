// jv_cmp, jv_equal, and jv_contains: jq's total order and structural tests.
// Two literals compare as exact decimals; anything else compares as doubles,
// with NaN ordered below every number.

import { comparePaths } from "../../../fs/path.js";
import { sortedKeys } from "./dump.js";
import {
  compareLiterals,
  isArray,
  isNumber,
  JqLiteral,
  type JqNumber,
  type JqValue,
  kindRank,
  numberValue,
} from "./value.js";

export function compareNumbers(a: JqNumber, b: JqNumber): number {
  if (a instanceof JqLiteral && b instanceof JqLiteral) return compareLiterals(a, b);
  const left = numberValue(a);
  const right = numberValue(b);
  return left < right ? -1 : left === right ? 0 : 1;
}

export function compareValues(a: JqValue, b: JqValue): number {
  const rankA = kindRank(a);
  const rankB = kindRank(b);
  if (rankA !== rankB) return rankA < rankB ? -1 : 1;
  if (isNumber(a) && isNumber(b)) {
    if (Number.isNaN(numberValue(a))) return compareValues(null, b);
    if (Number.isNaN(numberValue(b))) return compareValues(a, null);
    return compareNumbers(a, b);
  }
  if (typeof a === "string" && typeof b === "string") return Math.sign(comparePaths(a, b));
  if (isArray(a) && isArray(b)) {
    const shared = Math.min(a.length, b.length);
    for (let index = 0; index < shared; index++) {
      const order = compareValues(a[index] ?? null, b[index] ?? null);
      if (order !== 0) return order;
    }
    return a.length === b.length ? 0 : a.length < b.length ? -1 : 1;
  }
  if (a instanceof Map && b instanceof Map) {
    const keysA = sortedKeys(a);
    const keysB = sortedKeys(b);
    const order = compareValues(keysA, keysB);
    if (order !== 0) return order;
    for (const key of keysA) {
      const next = compareValues(a.get(key) ?? null, b.get(key) ?? null);
      if (next !== 0) return next;
    }
  }
  return 0;
}

export function equalValues(a: JqValue, b: JqValue): boolean {
  if (a === b) return true;
  if (kindRank(a) !== kindRank(b)) return false;
  if (isNumber(a) && isNumber(b)) return compareNumbers(a, b) === 0;
  if (isArray(a) && isArray(b)) {
    if (a.length !== b.length) return false;
    for (let index = 0; index < a.length; index++) {
      if (!equalValues(a[index] ?? null, b[index] ?? null)) return false;
    }
    return true;
  }
  if (a instanceof Map && b instanceof Map) {
    if (a.size !== b.size) return false;
    for (const [key, value] of a) {
      if (!b.has(key) || !equalValues(value, b.get(key) ?? null)) return false;
    }
    return true;
  }
  return false;
}

/** Same kind in jq's sense: true and false are different kinds. */
export function sameKind(a: JqValue, b: JqValue): boolean {
  return kindRank(a) === kindRank(b);
}

export function containsValue(a: JqValue, b: JqValue): boolean {
  if (!sameKind(a, b)) return false;
  if (a instanceof Map && b instanceof Map) {
    for (const [key, value] of b) {
      if (!a.has(key) || !containsValue(a.get(key) ?? null, value)) return false;
    }
    return true;
  }
  if (isArray(a) && isArray(b)) {
    return b.every((wanted) => a.some((item) => containsValue(item, wanted)));
  }
  if (typeof a === "string" && typeof b === "string") return a.includes(b);
  return equalValues(a, b);
}

/** jv_identical: the same allocation, or the same scalar bits. */
export function identical(a: JqValue, b: JqValue): boolean {
  return Object.is(a, b);
}

/** Stable sort by keys, as jv_sort does with its index tiebreak. */
export function sortByKeys<T>(items: readonly T[], keys: readonly JqValue[]): T[] {
  const entries = items.map((item, index) => ({ item, key: keys[index] ?? null, index }));
  entries.sort((left, right) => compareValues(left.key, right.key) || left.index - right.index);
  return entries.map((entry) => entry.item);
}
