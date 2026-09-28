// jv_get, jv_set, and the path operations built on them (src/jv_aux.c).
// Every construction is charged first: `.[536870000] = 1` is a legal jq
// program that allocates half a billion slots.

import { compareValues, equalValues } from "./compare.js";
import { JqError } from "./errors.js";
import { type Recursion, trampoline } from "./recursion.js";
import {
  codePointLength,
  isArray,
  isNumber,
  isObject,
  type JqArray,
  type JqObject,
  type JqValue,
  kindOf,
  numberValue,
  sliceCodePoints,
  utf8Length,
} from "./value.js";

/** Reserves an estimate of bytes about to be built. */
export type Charge = (bytes: number) => void;

const INT_MAX = 2_147_483_647;
const INT_MIN = -2_147_483_648;
const MAX_ARRAY_INDEX = INT_MAX >> 2;

export function arrayBytes(length: number): number {
  return 16 + 8 * length;
}

export function stringBytes(text: string): number {
  return 16 + 2 * text.length;
}

export function objectBytes(size: number): number {
  return 32 + 48 * size;
}

/** C's `(int)` cast of a double: truncation, clamped to int. */
export function toInt(value: number): number {
  if (value < INT_MIN) return INT_MIN;
  if (value > INT_MAX) return INT_MAX;
  return Math.trunc(value);
}

export function indexError(target: JqValue, key: JqValue): JqError {
  if (typeof key === "string" && utf8Length(key) < 30) {
    return new JqError(`Cannot index ${kindOf(target)} with string "${key}"`);
  }
  return new JqError(`Cannot index ${kindOf(target)} with ${kindOf(key)}`);
}

export function jvGet(target: JqValue, key: JqValue): JqValue {
  if (isObject(target) && typeof key === "string") return target.get(key) ?? null;
  if (isArray(target) && isNumber(key)) {
    const index = numberValue(key);
    if (Number.isNaN(index)) return null;
    let position = toInt(index);
    if (position < 0) position += target.length;
    return position >= 0 ? (target[position] ?? null) : null;
  }
  if ((isArray(target) || typeof target === "string") && isObject(key)) {
    const length = typeof target === "string" ? codePointLength(target) : target.length;
    const { start, end } = parseSlice(length, key);
    return typeof target === "string"
      ? sliceCodePoints(target, start, end)
      : target.slice(start, end);
  }
  if (isArray(target) && isArray(key)) return arrayIndexes(target, key);
  if (target === null && (typeof key === "string" || isNumber(key) || isObject(key))) return null;
  throw indexError(target, key);
}

function arrayIndexes(target: JqArray, key: JqArray): JqValue[] {
  const found: JqValue[] = [];
  if (key.length === 0) return found;
  for (let start = 0; start < target.length; start++) {
    let matches = true;
    for (let offset = 0; offset < key.length && matches; offset++) {
      const item = target[start + offset];
      matches = item !== undefined && equalValues(item, key[offset] ?? null);
    }
    if (matches) found.push(start);
  }
  return found;
}

export function parseSlice(length: number, slice: JqObject): { start: number; end: number } {
  const startValue = slice.has("start") ? (slice.get("start") ?? null) : undefined;
  const endValue = slice.has("end") ? (slice.get("end") ?? null) : undefined;
  const from = startValue === null ? 0 : startValue;
  const to = endValue === null ? length : endValue;
  if (from === undefined || to === undefined || !isNumber(from) || !isNumber(to)) {
    throw new JqError("Array/string slice indices must be integers");
  }
  let startDouble = numberValue(from);
  let endDouble = numberValue(to);
  if (Number.isNaN(startDouble)) startDouble = 0;
  if (startDouble < 0) startDouble += length;
  if (startDouble < 0) startDouble = 0;
  if (startDouble > length) startDouble = length;
  const start = Math.min(Math.trunc(startDouble), INT_MAX);
  if (Number.isNaN(endDouble)) endDouble = length;
  if (endDouble < 0) endDouble += length;
  if (endDouble < 0) endDouble = start;
  let end = endDouble > INT_MAX ? INT_MAX : Math.trunc(endDouble);
  if (end > length) end = length;
  if (end < length && end < endDouble) end += 1;
  if (end < start) end = start;
  return { start, end };
}

export function jvSet(target: JqValue, key: JqValue, value: JqValue, charge: Charge): JqValue {
  const isNull = target === null;
  if (typeof key === "string" && (isObject(target) || isNull)) {
    const out = new Map(isObject(target) ? target : []);
    charge(objectBytes(out.size + 1));
    out.set(key, value);
    return out;
  }
  if (isNumber(key) && (isArray(target) || isNull)) {
    const index = numberValue(key);
    if (Number.isNaN(index)) throw new JqError("Cannot set array element at NaN index");
    return arraySet(isArray(target) ? target : [], toInt(index), value, charge);
  }
  if (isObject(key) && (isArray(target) || isNull)) {
    const array = isArray(target) ? target : [];
    const { start, end } = parseSlice(array.length, key);
    if (!isArray(value))
      throw new JqError("A slice of an array can only be assigned another array");
    charge(arrayBytes(array.length - (end - start) + value.length));
    return [...array.slice(0, start), ...value, ...array.slice(end)];
  }
  if (isObject(key) && typeof target === "string") throw new JqError("Cannot update string slices");
  throw new JqError(`Cannot update field at ${kindOf(key)} index of ${kindOf(target)}`);
}

function arraySet(array: JqArray, index: number, value: JqValue, charge: Charge): JqValue[] {
  const position = index < 0 ? array.length + index : index;
  if (position < 0) throw new JqError("Out of bounds negative array index");
  if (position > MAX_ARRAY_INDEX) throw new JqError("Array index too large");
  const length = Math.max(array.length, position + 1);
  charge(arrayBytes(length));
  const out = array.slice();
  while (out.length < position) out.push(null);
  out[position] = value;
  return out;
}

export function getPath(root: JqValue, path: JqValue): JqValue {
  if (!isArray(path)) throw new JqError("Path must be specified as an array");
  let current = root;
  for (const key of path) current = jvGet(current, key);
  return current;
}

export function setPath(root: JqValue, path: JqValue, value: JqValue, charge: Charge): JqValue {
  if (!isArray(path)) throw new JqError("Path must be specified as an array");
  return setFrom(root, path, value, charge);
}

/** Reads down the path, then rebuilds each level bottom-up; no recursion over depth. */
function setFrom(root: JqValue, path: JqArray, value: JqValue, charge: Charge): JqValue {
  const levels: JqValue[] = [root];
  let current = root;
  for (const key of path) {
    current = jvGet(current, key);
    levels.push(current);
  }
  let result = value;
  for (let at = path.length - 1; at >= 0; at--) {
    result = jvSet(levels[at] ?? null, path[at] ?? null, result, charge);
  }
  return result;
}

export function deletePaths(root: JqValue, paths: JqValue, charge: Charge): JqValue {
  if (!isArray(paths)) throw new JqError("Paths must be specified as an array");
  const sorted = [...paths].sort(compareValues);
  const checked: JqArray[] = [];
  for (const path of sorted) {
    if (!isArray(path)) throw new JqError(`Path must be specified as array, not ${kindOf(path)}`);
    checked.push(path);
  }
  if (checked.length === 0) return root;
  if (checked[0]?.length === 0) return null;
  return trampoline(deleteSorted(root, checked, 0, charge));
}

function* deleteSorted(
  root: JqValue,
  paths: readonly JqArray[],
  at: number,
  charge: Charge,
): Recursion<JqValue> {
  let object = root;
  const keys: JqValue[] = [];
  for (let first = 0; first < paths.length; ) {
    const key = paths[first]?.[at] ?? null;
    let last = first;
    while (last < paths.length && equalValues(key, paths[last]?.[at] ?? null)) last++;
    if (paths[first]?.length === at + 1) keys.push(key);
    else {
      const child = jvGet(object, key);
      if (child !== null) {
        object = jvSet(
          object,
          key,
          yield deleteSorted(child, paths.slice(first, last), at + 1, charge),
          charge,
        );
      }
    }
    first = last;
  }
  return deleteKeys(object, keys, charge);
}

function deleteKeys(target: JqValue, keys: readonly JqValue[], charge: Charge): JqValue {
  if (target === null || keys.length === 0) return target;
  if (isArray(target)) {
    const doomed = new Set<number>();
    const ranges: Array<{ start: number; end: number }> = [];
    for (const key of keys) {
      if (isNumber(key)) {
        const index = toInt(numberValue(key));
        doomed.add(numberValue(key) < 0 ? target.length + index : index);
      } else if (isObject(key)) ranges.push(parseSlice(target.length, key));
      else throw new JqError(`Cannot delete ${kindOf(key)} element of array`);
    }
    charge(arrayBytes(target.length));
    return target.filter(
      (_, index) =>
        !doomed.has(index) && !ranges.some((range) => range.start <= index && index < range.end),
    );
  }
  if (isObject(target)) {
    const out = new Map(target);
    for (const key of keys) {
      if (typeof key !== "string")
        throw new JqError(`Cannot delete ${kindOf(key)} field of object`);
      out.delete(key);
    }
    charge(objectBytes(out.size));
    return out;
  }
  throw new JqError(`Cannot delete fields from ${kindOf(target)}`);
}
