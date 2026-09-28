// C-coded jq builtins over values and collections, with jq's error texts.

import { comparePaths } from "../../../../fs/path.js";
import { compareValues, containsValue, equalValues, sameKind, sortByKeys } from "../compare.js";
import { dumpString, truncatedDump } from "../dump.js";
import { JqError, typeError, typeError2 } from "../errors.js";
import { parseJsonText } from "../json-parse.js";
import { arrayBytes, type Charge, deletePaths, setPath, stringBytes, toInt } from "../paths.js";
import {
  absLiteral,
  codePointLength,
  isArray,
  isNumber,
  isObject,
  type JqArray,
  JqLiteral,
  type JqValue,
  kindOf,
  numberValue,
  parseLiteral,
  truthy,
  utf8Length,
} from "../value.js";
import { type Natives, unary, withArgs } from "./native.js";

export function registerCore(natives: Natives): void {
  natives.set(
    "not/0",
    unary((value) => !truthy(value)),
  );
  natives.set("length/0", unary(length));
  natives.set(
    "utf8bytelength/0",
    unary((value) => {
      if (typeof value !== "string") throw typeError(value, "only strings have UTF-8 byte length");
      return utf8Length(value);
    }),
  );
  natives.set("type/0", unary(kindOf));
  natives.set(
    "keys/0",
    unary((value, runtime) => keys(value, true, runtime.charge)),
  );
  natives.set(
    "keys_unsorted/0",
    unary((value, runtime) => keys(value, false, runtime.charge)),
  );
  natives.set(
    "has/1",
    withArgs((value, [key]) => has(value, key ?? null)),
  );
  natives.set(
    "contains/1",
    withArgs((value, [other]) => {
      const wanted = other ?? null;
      if (!sameKind(value, wanted))
        throw typeError2(value, wanted, "cannot have their containment checked");
      return containsValue(value, wanted);
    }),
  );
  natives.set(
    "setpath/2",
    withArgs((value, [path, replacement], runtime) =>
      setPath(value, path ?? null, replacement ?? null, runtime.charge),
    ),
  );
  natives.set(
    "delpaths/1",
    withArgs((value, [paths], runtime) => deletePaths(value, paths ?? null, runtime.charge)),
  );
  natives.set(
    "tojson/0",
    unary((value, runtime) => charged(dumpString(value), runtime.charge)),
  );
  natives.set("fromjson/0", unary(fromJson));
  natives.set("tonumber/0", unary(toNumber));
  natives.set(
    "tostring/0",
    unary((value, runtime) =>
      typeof value === "string" ? value : charged(dumpString(value), runtime.charge),
    ),
  );
  natives.set(
    "sort/0",
    unary((value) => sortBy(value, arrayOf(value, "cannot be sorted, as it is not an array"))),
  );
  natives.set(
    "_sort_by_impl/1",
    withArgs((value, [keys]) => sortBy(value, pairedKeys(value, keys ?? null))),
  );
  natives.set(
    "_group_by_impl/1",
    withArgs((value, [keys]) => groupBy(value, pairedKeys(value, keys ?? null))),
  );
  natives.set(
    "unique/0",
    unary((value) => uniqueBy(value, arrayOf(value, "cannot be sorted, as it is not an array"))),
  );
  natives.set(
    "_unique_by_impl/1",
    withArgs((value, [keys]) => uniqueBy(value, pairedKeys(value, keys ?? null))),
  );
  natives.set(
    "min/0",
    unary((value) => extreme(value, value, true)),
  );
  natives.set(
    "max/0",
    unary((value) => extreme(value, value, false)),
  );
  natives.set(
    "_min_by_impl/1",
    withArgs((value, [keys]) => extreme(value, keys ?? null, true)),
  );
  natives.set(
    "_max_by_impl/1",
    withArgs((value, [keys]) => extreme(value, keys ?? null, false)),
  );
  natives.set(
    "_flatten/1",
    withArgs((value, [depth], runtime) => flatten(value, depth ?? null, runtime.charge)),
  );
  natives.set(
    "infinite/0",
    unary(() => Infinity),
  );
  natives.set(
    "nan/0",
    unary(() => Number.NaN),
  );
  natives.set(
    "isinfinite/0",
    unary((value) => isNumber(value) && Math.abs(numberValue(value)) === Infinity),
  );
  natives.set(
    "isnan/0",
    unary((value) => isNumber(value) && Number.isNaN(numberValue(value))),
  );
  natives.set(
    "have_literal_numbers/0",
    unary(() => true),
  );
  natives.set(
    "have_decnum/0",
    unary(() => true),
  );
  for (const [name, math] of MATH) {
    natives.set(
      `${name}/0`,
      unary((value) => {
        if (!isNumber(value)) throw typeError(value, "number required");
        return math(numberValue(value));
      }),
    );
  }
  natives.set(
    "pow/2",
    withArgs((_, [base, exponent]) => {
      if (base === undefined || !isNumber(base)) throw typeError(base ?? null, "number required");
      if (exponent === undefined || !isNumber(exponent))
        throw typeError(exponent ?? null, "number required");
      return numberValue(base) ** numberValue(exponent);
    }),
  );
}

const MATH: ReadonlyArray<readonly [string, (value: number) => number]> = [
  ["floor", Math.floor],
  ["ceil", Math.ceil],
  ["round", (value) => (value < 0 ? -Math.round(-value) : Math.round(value))],
  ["fabs", Math.abs],
  ["sqrt", Math.sqrt],
  ["log", Math.log],
  ["log2", Math.log2],
  ["log10", Math.log10],
  ["exp", Math.exp],
  ["exp10", (value) => 10 ** value],
  ["trunc", Math.trunc],
];

function charged(text: string, charge: Charge): string {
  charge(stringBytes(text));
  return text;
}

function length(value: JqValue): JqValue {
  if (isArray(value)) return value.length;
  if (isObject(value)) return value.size;
  if (typeof value === "string") return codePointLength(value);
  if (value instanceof JqLiteral) return absLiteral(value);
  if (typeof value === "number") return Math.abs(value);
  if (value === null) return 0;
  throw typeError(value, "has no length");
}

function keys(value: JqValue, sorted: boolean, charge: Charge): JqValue {
  if (isObject(value)) {
    charge(arrayBytes(value.size));
    const names = [...value.keys()];
    return sorted ? names.sort(comparePaths) : names;
  }
  if (isArray(value)) {
    charge(arrayBytes(value.length));
    return value.map((_, index) => index);
  }
  throw typeError(value, "has no keys");
}

function has(value: JqValue, key: JqValue): JqValue {
  if (value === null) return false;
  if (isObject(value) && typeof key === "string") return value.has(key);
  if (isArray(value) && isNumber(key)) {
    const index = numberValue(key);
    if (Number.isNaN(index)) return false;
    const position = toInt(index);
    return position >= 0 && position < value.length;
  }
  throw new JqError(`Cannot check whether ${kindOf(value)} has a ${kindOf(key)} key`);
}

function fromJson(value: JqValue): JqValue {
  if (typeof value !== "string") throw typeError(value, "only strings can be parsed");
  const parsed = parseJsonText(value);
  if (parsed.kind === "error") throw new JqError(parsed.message);
  return parsed.value;
}

function toNumber(value: JqValue): JqValue {
  if (isNumber(value)) return value;
  if (typeof value === "string") {
    const parsed = parseLiteral(value);
    if (parsed !== null) return parsed;
  }
  throw typeError(value, "cannot be parsed as a number");
}

function arrayOf(value: JqValue, message: string): JqArray {
  if (!isArray(value)) throw typeError(value, message);
  return value;
}

function pairedKeys(value: JqValue, keys: JqValue): JqArray {
  if (!isArray(value) || !isArray(keys) || value.length !== keys.length) {
    throw typeError2(value, keys, "cannot be sorted, as they are not both arrays");
  }
  return keys;
}

function sortBy(value: JqValue, keys: JqArray): JqValue {
  return sortByKeys(isArray(value) ? value : [], keys);
}

function sortedEntries(value: JqValue, keys: JqArray): Array<{ item: JqValue; key: JqValue }> {
  const items = isArray(value) ? value : [];
  const entries = items.map((item, index) => ({ item, key: keys[index] ?? null }));
  return sortByKeys(entries, keys);
}

function groupBy(value: JqValue, keys: JqArray): JqValue {
  const groups: JqValue[][] = [];
  let current: JqValue | undefined;
  for (const entry of sortedEntries(value, keys)) {
    const last = groups[groups.length - 1];
    if (last !== undefined && current !== undefined && equalValues(current, entry.key))
      last.push(entry.item);
    else {
      groups.push([entry.item]);
      current = entry.key;
    }
  }
  return groups;
}

function uniqueBy(value: JqValue, keys: JqArray): JqValue {
  const out: JqValue[] = [];
  let current: JqValue | undefined;
  for (const entry of sortedEntries(value, keys)) {
    if (current !== undefined && equalValues(current, entry.key)) continue;
    out.push(entry.item);
    current = entry.key;
  }
  return out;
}

function extreme(value: JqValue, keys: JqValue, minimum: boolean): JqValue {
  if (!isArray(value) || !isArray(keys)) throw typeError2(value, keys, "cannot be iterated over");
  if (value.length !== keys.length) throw typeError2(value, keys, "have wrong length");
  if (value.length === 0) return null;
  let best = value[0] ?? null;
  let bestKey = keys[0] ?? null;
  for (let index = 1; index < value.length; index++) {
    const key = keys[index] ?? null;
    if (compareValues(key, bestKey) < 0 === minimum) {
      best = value[index] ?? null;
      bestKey = key;
    }
  }
  return best;
}

function flatten(value: JqValue, depth: JqValue, charge: Charge): JqValue {
  const out: JqValue[] = [];
  flattenInto(out, value, depth);
  charge(arrayBytes(out.length));
  return out;
}

/** jq's `_flatten`, on an explicit stack so 10,000-deep arrays do not overflow. */
function flattenInto(out: JqValue[], value: JqValue, depth: JqValue): void {
  const items = isArray(value) ? value : isObject(value) ? [...value.values()] : null;
  if (items === null) {
    throw new JqError(`Cannot iterate over ${kindOf(value)} (${truncatedDump(value)})`);
  }
  const stack: Array<{ items: readonly JqValue[]; index: number; depth: JqValue }> = [
    { items, index: 0, depth },
  ];
  for (let top = stack[0]; top !== undefined; top = stack[stack.length - 1]) {
    if (top.index >= top.items.length) {
      stack.pop();
      continue;
    }
    const item = top.items[top.index] ?? null;
    top.index++;
    if (isArray(item) && !equalValues(top.depth, 0)) {
      if (!isNumber(top.depth)) throw typeError2(top.depth, 1, "cannot be subtracted");
      stack.push({ items: item, index: 0, depth: numberValue(top.depth) - 1 });
    } else out.push(item);
  }
}
