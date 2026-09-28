// Builtins that walk a whole value — `walk(f)` and `tostream` — and `halt`.
// jq defines the walks recursively; here they run on an explicit stack, so
// they cost no JavaScript stack on 10,000-deep input and are bounded by the
// input's structure.

import { JqHalt, typeError } from "../errors.js";
import { arrayBytes, objectBytes } from "../paths.js";
import {
  type Closure,
  PathStep,
  type Results,
  type Runtime,
  root,
  valueFrame,
} from "../runtime.js";
import { isArray, isNumber, isObject, type JqValue, numberValue } from "../value.js";
import { type Natives, values } from "./native.js";

export function registerStructure(natives: Natives): void {
  natives.set("walk/1", function* (runtime, input, [f]) {
    if (f === undefined) return;
    for (const value of walk(runtime, input.value, f)) yield valueFrame(input, value);
  });
  natives.set("tostream/0", function* (runtime, input) {
    for (const event of stream(input.value)) {
      const path = event[0] ?? null;
      runtime.charge(arrayBytes(event.length) + (isArray(path) ? arrayBytes(path.length) : 0));
      yield valueFrame(input, event);
    }
  });
  natives.set("halt/0", () => {
    throw new JqHalt(0, undefined);
  });
  natives.set("halt_error/1", function* (runtime, input, [code]) {
    for (const status of values(runtime, input, code)) {
      if (!isNumber(status)) throw typeError(input.value, "halt_error/1: number required");
      throw new JqHalt(Math.trunc(numberValue(status)), input.value);
    }
    yield* [];
  });
}

interface WalkTask {
  readonly value: JqValue;
  /** Object children keep only f's first output; a child without one is dropped. */
  readonly first: boolean;
  readonly key: string | null;
  readonly children: ReadonlyArray<readonly [string | null, JqValue]>;
  index: number;
  readonly items: JqValue[];
  readonly entries: Map<string, JqValue>;
}

/**
 * jq's `def walk(f): def w: if type == "object" then map_values(w) elif
 * type == "array" then map(w) else . end | f; w;` bottom-up.
 */
function walk(runtime: Runtime, value: JqValue, f: Closure): JqValue[] {
  const task = (item: JqValue, first: boolean, key: string | null): WalkTask => ({
    value: item,
    first,
    key,
    children: isArray(item)
      ? item.map((child): readonly [string | null, JqValue] => [null, child])
      : isObject(item)
        ? [...item]
        : [],
    index: 0,
    items: [],
    entries: new Map(),
  });
  const stack = [task(value, false, null)];
  for (;;) {
    const top = stack[stack.length - 1];
    if (top === undefined) return [];
    const next = top.children[top.index];
    if (next !== undefined) {
      top.index++;
      stack.push(task(next[1], isObject(top.value), next[0]));
      continue;
    }
    stack.pop();
    let rebuilt: JqValue = top.value;
    if (isArray(top.value)) {
      runtime.charge(arrayBytes(top.items.length));
      rebuilt = top.items;
    } else if (isObject(top.value)) {
      runtime.charge(objectBytes(top.entries.size));
      rebuilt = top.entries;
    }
    const outputs = apply(runtime, f, rebuilt, top.first);
    const parent = stack[stack.length - 1];
    if (parent === undefined) return outputs;
    if (isArray(parent.value)) parent.items.push(...outputs);
    else if (top.key !== null && outputs[0] !== undefined) parent.entries.set(top.key, outputs[0]);
  }
}

function apply(runtime: Runtime, f: Closure, value: JqValue, first: boolean): JqValue[] {
  const outputs: JqValue[] = [];
  const results: Results = runtime.evaluate(runtime, f.node, root(value), f.env);
  try {
    for (const frame of results) {
      outputs.push(frame.value);
      if (first) break;
    }
  } finally {
    results.return();
  }
  return outputs;
}

interface StreamTask {
  readonly value: JqValue;
  readonly path: PathStep;
  readonly children: ReadonlyArray<readonly [JqValue, JqValue]>;
  index: number;
}

/**
 * jq's tostream: leaves as [path, value] and, after a non-empty container's
 * children, [path of its last child], in post order.
 */
function* stream(value: JqValue): Generator<JqValue[], void, undefined> {
  const task = (item: JqValue, path: PathStep): StreamTask => ({
    value: item,
    path,
    children: isArray(item)
      ? item.map((child, index): readonly [JqValue, JqValue] => [index, child])
      : isObject(item)
        ? [...item]
        : [],
    index: 0,
  });
  const stack = [task(value, PathStep.EMPTY)];
  for (let top = stack[0]; top !== undefined; top = stack[stack.length - 1]) {
    const next = top.children[top.index];
    if (next !== undefined) {
      top.index++;
      stack.push(task(next[1], top.path.append(next[0])));
      continue;
    }
    stack.pop();
    const last = top.children[top.children.length - 1];
    if (last === undefined) yield [top.path.toArray(), top.value];
    else yield [top.path.append(last[0]).toArray()];
  }
}
