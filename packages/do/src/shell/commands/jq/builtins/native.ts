// Adapters from plain functions to natives. Arguments of a C-coded jq builtin
// are evaluated as a cartesian product with the last argument outermost.

import { evaluate } from "../evaluate.js";
import {
  type Closure,
  type Frame,
  type Native,
  plain,
  type Runtime,
  valueFrame,
} from "../runtime.js";
import type { JqValue } from "../value.js";

export type Natives = Map<string, Native>;

export function unary(body: (value: JqValue, runtime: Runtime) => JqValue): Native {
  return function* (runtime, input) {
    yield valueFrame(input, body(input.value, runtime));
  };
}

export function withArgs(
  body: (value: JqValue, args: readonly JqValue[], runtime: Runtime) => JqValue,
): Native {
  return function* (runtime, input, args) {
    for (const values of argumentProduct(runtime, input, args, args.length - 1, [])) {
      yield valueFrame(input, body(input.value, values, runtime));
    }
  };
}

export function* argumentProduct(
  runtime: Runtime,
  input: Frame,
  args: readonly Closure[],
  at: number,
  chosen: readonly JqValue[],
): Generator<JqValue[], void, undefined> {
  const arg = args[at];
  if (arg === undefined) {
    yield [...chosen];
    return;
  }
  for (const frame of evaluate(runtime, arg.node, plain(input), arg.env)) {
    const next = [...chosen];
    next[at] = frame.value;
    yield* argumentProduct(runtime, input, args, at - 1, next);
  }
}

/** The values of one argument, as a `$name` parameter binds them. */
export function* values(
  runtime: Runtime,
  input: Frame,
  arg: Closure | undefined,
): Generator<JqValue, void, undefined> {
  if (arg === undefined) return;
  for (const frame of evaluate(runtime, arg.node, plain(input), arg.env)) yield frame.value;
}
