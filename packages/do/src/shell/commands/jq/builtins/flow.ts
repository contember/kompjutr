// Builtins that steer evaluation rather than compute a value: generators,
// path tracking, inputs, and diagnostics. `range` and `recurse` are the
// bounded forms of jq's loops (ADR-0027): a range whose count jq could never
// finish, and a recursion that can revisit a value, are refused.

import { paths } from "../assign.js";
import { compareValues, identical } from "../compare.js";
import { truncatedDump } from "../dump.js";
import { JqError, JqRefusal, typeError2 } from "../errors.js";
import { evaluate, iterate } from "../evaluate.js";
import { plus } from "../operators.js";
import { arrayBytes, getPath } from "../paths.js";
import {
  type Closure,
  type Frame,
  type Native,
  plain,
  type Results,
  type Runtime,
  valueFrame,
} from "../runtime.js";
import { isArray, isNumber, type JqNumber, type JqValue, numberValue, truthy } from "../value.js";
import { type Natives, values } from "./native.js";

export function registerFlow(natives: Natives): void {
  natives.set("empty/0", function* () {});
  natives.set("error/0", (_, input) => {
    throw new JqError(input.value);
  });
  natives.set("path/1", function* (runtime, input, [f]) {
    if (f === undefined) return;
    for (const path of paths(runtime, f, input.value)) {
      runtime.charge(arrayBytes(path.length));
      yield valueFrame(input, [...path]);
    }
  });
  natives.set("getpath/1", getpath);
  natives.set("first/1", function* (runtime, input, [f]) {
    if (f === undefined) return;
    const results = evaluate(runtime, f.node, input, f.env);
    try {
      const step = results.next();
      if (step.done !== true) yield step.value;
    } finally {
      results.return();
    }
  });
  natives.set("last/1", function* (runtime, input, [f]) {
    if (f === undefined) return;
    let last: JqValue | undefined;
    for (const frame of evaluate(runtime, f.node, input, f.env)) last = frame.value;
    if (last !== undefined) yield valueFrame(input, last);
  });
  natives.set("limit/2", (runtime, input, [count, f]) =>
    counted(runtime, input, count, f, "limit"),
  );
  natives.set("skip/2", (runtime, input, [count, f]) => counted(runtime, input, count, f, "skip"));
  natives.set("range/2", function* (runtime, input, [from, upto]) {
    for (const start of values(runtime, input, from)) {
      for (const end of values(runtime, input, upto)) yield* range(input, start, end);
    }
  });
  natives.set("range/3", function* (runtime, input, [from, upto, by]) {
    for (const start of values(runtime, input, from)) {
      for (const end of values(runtime, input, upto)) {
        for (const step of values(runtime, input, by))
          yield* steppedRange(runtime, input, start, end, step);
      }
    }
  });
  natives.set("recurse/0", (runtime, input) => descend(runtime, input, null, null));
  natives.set("recurse/1", (runtime, input, [f]) => descend(runtime, input, f ?? null, null));
  natives.set("recurse/2", (runtime, input, [f, condition]) =>
    descend(runtime, input, f ?? null, condition ?? null),
  );
  natives.set("input/0", function* (runtime, input) {
    const next = runtime.host.input();
    if (next === undefined) throw new JqError("break");
    yield valueFrame(input, next.value);
  });
  natives.set("inputs/0", function* (runtime, input) {
    for (let next = runtime.host.input(); next !== undefined; next = runtime.host.input()) {
      yield valueFrame(input, next.value);
    }
  });
  natives.set("debug/0", function* (runtime, input) {
    runtime.host.debug(input.value);
    yield input;
  });
  natives.set("stderr/0", function* (runtime, input) {
    runtime.host.stderr(input.value);
    yield input;
  });
  natives.set("env/0", function* (runtime, input) {
    yield valueFrame(input, runtime.host.environment);
  });
  natives.set("now/0", function* (runtime, input) {
    yield valueFrame(input, runtime.host.now() / 1000);
  });
  natives.set("input_filename/0", function* (runtime, input) {
    yield valueFrame(input, runtime.host.inputFilename());
  });
}

/** getpath/1 extends a tracked path only when its input is the value at that path. */
const getpath: Native = function* (runtime, input, [path]) {
  for (const wanted of values(runtime, input, path)) {
    const value = getPath(input.value, wanted);
    if (input.path !== null && isArray(wanted) && identical(input.value, input.at)) {
      yield { value, path: [...input.path, ...wanted], at: value };
    } else yield valueFrame(input, value);
  }
};

function* counted(
  runtime: Runtime,
  input: Frame,
  count: Closure | undefined,
  f: Closure | undefined,
  kind: "limit" | "skip",
): Results {
  if (f === undefined) return;
  for (const n of values(runtime, input, count)) {
    const order = compareValues(n, 0);
    if (order < 0) throw new JqError(`${kind} doesn't support negative count`);
    if (order === 0) {
      if (kind === "skip") yield* evaluate(runtime, f.node, input, f.env);
      continue;
    }
    let remaining = n;
    const results = evaluate(runtime, f.node, input, f.env);
    try {
      for (const frame of results) {
        if (!isNumber(remaining)) throw typeError2(remaining, 1, "cannot be subtracted");
        remaining = numberValue(remaining) - 1;
        if (kind === "limit") {
          yield frame;
          if (numberValue(remaining) <= 0) break;
        } else if (numberValue(remaining) < 0) yield frame;
      }
    } finally {
      results.return();
    }
  }
}

/** The RANGE opcode: from `start` while below `end`, by adding 1. */
function* range(input: Frame, start: JqValue, end: JqValue): Results {
  if (!isNumber(start) || !isNumber(end)) throw new JqError("Range bounds must be numeric");
  const upto = numberValue(end);
  const first = numberValue(start);
  if (Number.isNaN(first) || Number.isNaN(upto) || (upto === Infinity && first < upto))
    unbounded("range");
  let current: JqNumber = start;
  while (numberValue(current) < upto) {
    yield valueFrame(input, current);
    const now = numberValue(current);
    if (now + 1 === now) unbounded("range");
    current = now + 1;
  }
}

function unbounded(name: string): never {
  throw new JqRefusal(`${name} with a bound it can never reach is not supported`);
}

/** jq's `range($init; $upto; $by)`: a while loop over jq's `<`, `>`, and `+`. */
function* steppedRange(
  runtime: Runtime,
  input: Frame,
  start: JqValue,
  end: JqValue,
  by: JqValue,
): Results {
  const direction = compareValues(by, 0);
  if (direction === 0) return;
  if (!isNumber(start) || !isNumber(end) || !isNumber(by)) {
    throw new JqRefusal("range/3 over non-numbers is not supported");
  }
  const within = (value: JqValue): boolean => {
    const order = compareValues(value, end);
    return direction > 0 ? order < 0 : order > 0;
  };
  if (within(start) && numberValue(end) === (direction > 0 ? Infinity : -Infinity))
    unbounded("range/3");
  let current: JqValue = start;
  while (within(current)) {
    yield valueFrame(input, current);
    const next = plus(current, by, runtime.charge);
    if (identical(next, current)) unbounded("range/3");
    current = next;
  }
}

/**
 * recurse, recurse(f), recurse(f; cond). The resolver admits f only when it
 * is a chain of index and iterate steps, so every child is part of its
 * parent; the one way around that is a null reached again from null.
 */
function* descend(
  runtime: Runtime,
  input: Frame,
  f: Closure | null,
  condition: Closure | null,
): Results {
  yield input;
  if (f === null) {
    if (input.path !== null && !identical(input.value, input.at)) {
      throw new JqError(
        `Invalid path expression near attempt to iterate through ${truncatedDump(input.value, 30)}`,
      );
    }
    for (const child of iterate(input, true)) yield* descend(runtime, child, null, null);
    return;
  }
  for (const child of evaluate(runtime, f.node, input, f.env)) {
    if (condition !== null && !admits(runtime, condition, child)) continue;
    if (child.value === null && input.value === null) {
      throw new JqRefusal(
        "recurse(f) that maps null to null never terminates and is not supported",
      );
    }
    yield* descend(runtime, child, f, condition);
  }
}

function admits(runtime: Runtime, condition: Closure, child: Frame): boolean {
  for (const frame of evaluate(runtime, condition.node, plain(child), condition.env)) {
    if (truthy(frame.value)) return true;
  }
  return false;
}
