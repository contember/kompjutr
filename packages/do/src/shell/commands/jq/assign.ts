// Assignment: `=`, `|=`, and the arithmetic updates, as jq's `_assign` and
// `_modify` define them. Paths are taken from the original input; each update
// reads the value at its path in the result built so far.

import { identical } from "./compare.js";
import { truncatedDump } from "./dump.js";
import { JqError } from "./errors.js";
import { binary } from "./operators.js";
import { deletePaths, getPath, setPath } from "./paths.js";
import {
  type Closure,
  type Env,
  type Frame,
  type JqPath,
  PathStep,
  plain,
  type Results,
  type Runtime,
  root,
  valueFrame,
} from "./runtime.js";
import type { AssignOperator, BinaryOperator, Node } from "./syntax/ast.js";
import { type JqValue, truthy } from "./value.js";

/** `path(f)`: the paths f reaches, each checked against the value it ends on. */
export function* paths(
  runtime: Runtime,
  closure: Closure,
  value: JqValue,
): Generator<JqPath, void, undefined> {
  for (const frame of runtime.evaluate(
    runtime,
    closure.node,
    { value, path: PathStep.EMPTY, at: value },
    closure.env,
  )) {
    if (!identical(frame.value, frame.at)) {
      throw new JqError(`Invalid path expression with result ${truncatedDump(frame.value, 30)}`);
    }
    yield frame.path?.toArray() ?? [];
  }
}

const UPDATE_OPERATORS = new Map<AssignOperator, BinaryOperator>([
  ["+=", "+"],
  ["-=", "-"],
  ["*=", "*"],
  ["/=", "/"],
  ["%=", "%"],
]);

export function* assign(
  runtime: Runtime,
  operator: AssignOperator,
  left: Node,
  right: Node,
  input: Frame,
  env: Env,
): Results {
  const target: Closure = { node: left, env };
  if (operator === "|=") {
    yield valueFrame(input, modify(runtime, target, input.value, { node: right, env }));
    return;
  }
  for (const rhs of runtime.evaluate(runtime, right, plain(input), env)) {
    if (operator === "=") {
      let result = input.value;
      for (const path of paths(runtime, target, input.value)) {
        result = setPath(result, path, rhs.value, runtime.charge);
      }
      yield valueFrame(input, result);
      continue;
    }
    const arithmetic = UPDATE_OPERATORS.get(operator);
    const update = (current: JqValue): JqValue =>
      arithmetic === undefined
        ? truthy(current)
          ? current
          : rhs.value
        : binary(arithmetic, current, rhs.value, runtime.charge);
    yield valueFrame(input, modifyWith(runtime, target, input.value, update));
  }
}

/** `_modify(paths; f)`: the first output of f replaces each path; none deletes it. */
export function modify(
  runtime: Runtime,
  target: Closure,
  value: JqValue,
  update: Closure,
): JqValue {
  return modifyWith(runtime, target, value, (current) => {
    const results = runtime.evaluate(runtime, update.node, root(current), update.env);
    try {
      const first = results.next();
      return first.done === true ? undefined : first.value.value;
    } finally {
      results.return();
    }
  });
}

function modifyWith(
  runtime: Runtime,
  target: Closure,
  value: JqValue,
  update: (current: JqValue) => JqValue | undefined,
): JqValue {
  let result = value;
  const doomed: JqValue[] = [];
  for (const path of paths(runtime, target, value)) {
    const replacement = update(getPath(result, path));
    if (replacement === undefined) doomed.push(path);
    else result = setPath(result, path, replacement, runtime.charge);
  }
  return doomed.length === 0 ? result : deletePaths(result, doomed, runtime.charge);
}
