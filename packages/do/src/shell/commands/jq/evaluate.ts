// The evaluator: one generator per node, pulled lazily, so `first(f)` and
// `limit` stop the work behind them. Output order follows jq's backtracking:
// for a binary operator and a function's arguments the right-hand side is the
// outer loop; for an index its key; for object construction the first entry.

import { assign } from "./assign.js";
import { destructure, EMPTY_ENV, withFunction, withVariable } from "./bindings.js";
import { identical } from "./compare.js";
import { truncatedDump } from "./dump.js";
import { JqError, typeError } from "./errors.js";
import { foreach, reduce } from "./fold.js";
import { formatValue } from "./formats.js";
import { binary } from "./operators.js";
import { arrayBytes, jvGet, objectBytes, stringBytes } from "./paths.js";
import {
  type Closure,
  type Env,
  type Frame,
  type FunctionEntry,
  lookup,
  plain,
  type Results,
  type Runtime,
  valueFrame,
} from "./runtime.js";
import type { Definition, Node } from "./syntax/ast.js";
import {
  isArray,
  isNumber,
  isObject,
  JqLiteral,
  type JqObject,
  type JqValue,
  kindOf,
  negateLiteral,
  truthy,
} from "./value.js";

export function* evaluate(runtime: Runtime, node: Node, input: Frame, env: Env): Results {
  switch (node.kind) {
    case "identity":
      yield input;
      return;
    case "literal":
      yield valueFrame(input, node.value);
      return;
    case "index":
      if (node.key.kind === "literal") {
        yield* indexAll(runtime, node.target, node.key.value, node.optional, input, env);
        return;
      }
      for (const key of evaluate(runtime, node.key, plain(input), env)) {
        yield* indexAll(runtime, node.target, key.value, node.optional, input, env);
      }
      return;
    case "slice":
      yield* slice(runtime, node, input, env);
      return;
    case "iterate":
      for (const target of evaluate(runtime, node.target, input, env)) {
        yield* iterate(target, node.optional);
      }
      return;
    case "string":
      for (const text of interpolate(
        runtime,
        node.parts,
        node.parts.length,
        node.format,
        input,
        env,
      )) {
        runtime.charge(stringBytes(text));
        yield valueFrame(input, text);
      }
      return;
    case "format":
      yield valueFrame(input, formatValue(node.name, input.value, runtime.charge));
      return;
    case "array":
      yield valueFrame(input, collect(runtime, node.body, input, env));
      return;
    case "object":
      for (const object of construct(runtime, node.entries, 0, new Map(), input, env)) {
        runtime.charge(objectBytes(object.size));
        yield valueFrame(input, object);
      }
      return;
    case "negate":
      for (const frame of evaluate(runtime, node.body, input, env)) {
        const value = frame.value;
        if (!isNumber(value)) throw typeError(value, "cannot be negated");
        yield valueFrame(frame, value instanceof JqLiteral ? negateLiteral(value) : -value);
      }
      return;
    case "pipe":
      for (const left of evaluate(runtime, node.left, input, env)) {
        yield* evaluate(runtime, node.right, left, env);
      }
      return;
    case "comma":
      yield* evaluate(runtime, node.left, input, env);
      yield* evaluate(runtime, node.right, input, env);
      return;
    case "binary":
      for (const right of evaluate(runtime, node.right, plain(input), env)) {
        for (const left of evaluate(runtime, node.left, plain(input), env)) {
          yield valueFrame(input, binary(node.operator, left.value, right.value, runtime.charge));
        }
      }
      return;
    case "and":
    case "or":
      for (const left of evaluate(runtime, node.left, plain(input), env)) {
        const decided = node.kind === "and" ? !truthy(left.value) : truthy(left.value);
        if (decided) {
          yield valueFrame(input, node.kind === "or");
          continue;
        }
        for (const right of evaluate(runtime, node.right, plain(input), env)) {
          yield valueFrame(input, truthy(right.value));
        }
      }
      return;
    case "alternative": {
      let found = false;
      for (const frame of evaluate(runtime, node.left, input, env)) {
        if (!truthy(frame.value)) continue;
        found = true;
        yield frame;
      }
      if (!found) yield* evaluate(runtime, node.right, input, env);
      return;
    }
    case "assign":
      yield* assign(runtime, node.operator, node.left, node.right, input, env);
      return;
    case "if":
      for (const condition of evaluate(runtime, node.condition, plain(input), env)) {
        if (truthy(condition.value)) yield* evaluate(runtime, node.then, input, env);
        else if (node.otherwise !== null) yield* evaluate(runtime, node.otherwise, input, env);
        else yield input;
      }
      return;
    case "try":
      yield* attempt(runtime, node.body, node.handler, input, env);
      return;
    case "reduce":
      yield* reduce(runtime, node, input, env);
      return;
    case "foreach":
      yield* foreach(runtime, node, input, env);
      return;
    case "bind":
      for (const source of evaluate(runtime, node.source, plain(input), env)) {
        for (const bound of destructure(runtime, node.pattern, source.value, env)) {
          yield* evaluate(runtime, node.body, input, bound);
        }
      }
      return;
    case "variable":
      yield valueFrame(input, lookup(env.variables, node.name) ?? null);
      return;
    case "call":
      yield* call(runtime, node.name, node.args, input, env);
      return;
    case "define": {
      const entry: FunctionEntry = { kind: "definition", definition: node.definition, env };
      const key = `${node.definition.name}/${node.definition.params.length}`;
      yield* evaluate(runtime, node.body, input, withFunction(env, key, entry));
      return;
    }
    case "label": {
      const id: JqObject = new Map([["__jq", runtime.nextLabel()]]);
      const labels = { name: node.name, value: id, parent: env.labels };
      try {
        yield* evaluate(runtime, node.body, input, { ...env, labels });
      } catch (error) {
        if (!(error instanceof JqError && error.value === id)) throw error;
      }
      return;
    }
    case "break":
      throw new JqError(lookup(env.labels, node.name) ?? null);
  }
}

function* indexAll(
  runtime: Runtime,
  targetNode: Node,
  key: JqValue,
  optional: boolean,
  input: Frame,
  env: Env,
): Results {
  for (const target of evaluate(runtime, targetNode, input, env)) {
    const step = indexStep(target, key, optional);
    if (step !== null) yield step;
  }
}

/** One INDEX step: jv_get plus the path bookkeeping jq does around it. */
export function indexStep(target: Frame, key: JqValue, optional: boolean): Frame | null {
  if (target.path !== null && !identical(target.value, target.at)) {
    throw new JqError(
      `Invalid path expression near attempt to access element ${truncatedDump(key)} of ${truncatedDump(target.value, 30)}`,
    );
  }
  let value: JqValue;
  try {
    value = jvGet(target.value, key);
  } catch (error) {
    if (optional && error instanceof JqError) return null;
    throw error;
  }
  return { value, path: target.path === null ? null : target.path.append(key), at: value };
}

function* slice(
  runtime: Runtime,
  node: Extract<Node, { kind: "slice" }>,
  input: Frame,
  env: Env,
): Results {
  const bound = (part: Node | null): Results =>
    part === null ? single(valueFrame(input, null)) : evaluate(runtime, part, plain(input), env);
  for (const from of bound(node.from)) {
    for (const to of bound(node.to)) {
      const key: JqObject = new Map([
        ["start", from.value],
        ["end", to.value],
      ]);
      yield* indexAll(runtime, node.target, key, node.optional, input, env);
    }
  }
}

function* single(frame: Frame): Results {
  yield frame;
}

export function* iterate(target: Frame, optional: boolean): Results {
  const tracked = target.path;
  if (tracked !== null && !identical(target.value, target.at)) {
    throw new JqError(
      `Invalid path expression near attempt to iterate through ${truncatedDump(target.value, 30)}`,
    );
  }
  const container = target.value;
  if (isArray(container)) {
    for (let index = 0; index < container.length; index++) {
      const value = container[index] ?? null;
      yield { value, path: tracked === null ? null : tracked.append(index), at: value };
    }
  } else if (isObject(container)) {
    for (const [key, value] of container) {
      yield { value, path: tracked === null ? null : tracked.append(key), at: value };
    }
  } else if (!optional) {
    throw new JqError(`Cannot iterate over ${kindOf(container)} (${truncatedDump(container)})`);
  }
}

/** String parts; a later interpolation is the outer loop, as jq's `+` chain makes it. */
function* interpolate(
  runtime: Runtime,
  parts: ReadonlyArray<string | Node>,
  count: number,
  format: string | null,
  input: Frame,
  env: Env,
): Generator<string, void, undefined> {
  if (count === 0) {
    yield "";
    return;
  }
  const part = parts[count - 1] ?? "";
  if (typeof part === "string") {
    for (const prefix of interpolate(runtime, parts, count - 1, format, input, env))
      yield prefix + part;
    return;
  }
  for (const frame of evaluate(runtime, part, plain(input), env)) {
    const formatted = formatValue(format ?? "text", frame.value, runtime.charge);
    if (typeof formatted !== "string") throw typeError(formatted, "cannot be added");
    for (const prefix of interpolate(runtime, parts, count - 1, format, input, env))
      yield prefix + formatted;
  }
}

export function collect(runtime: Runtime, body: Node | null, input: Frame, env: Env): JqValue[] {
  const items: JqValue[] = [];
  runtime.charge(arrayBytes(0));
  if (body === null) return items;
  for (const frame of evaluate(runtime, body, plain(input), env)) {
    runtime.charge(8);
    items.push(frame.value);
  }
  return items;
}

function* construct(
  runtime: Runtime,
  entries: Extract<Node, { kind: "object" }>["entries"],
  at: number,
  built: ReadonlyMap<string, JqValue>,
  input: Frame,
  env: Env,
): Generator<JqObject, void, undefined> {
  const entry = entries[at];
  if (entry === undefined) {
    yield built;
    return;
  }
  for (const key of evaluate(runtime, entry.key, plain(input), env)) {
    const name = key.value;
    if (typeof name !== "string") {
      throw new JqError(`Cannot use ${kindOf(name)} (${truncatedDump(name)}) as object key`);
    }
    for (const value of evaluate(runtime, entry.value, plain(input), env)) {
      const next = new Map(built);
      next.set(name, value.value);
      yield* construct(runtime, entries, at + 1, next, input, env);
    }
  }
}

function* attempt(
  runtime: Runtime,
  body: Node,
  handler: Node | null,
  input: Frame,
  env: Env,
): Results {
  const results = evaluate(runtime, body, input, env);
  try {
    for (;;) {
      let step: IteratorResult<Frame, void>;
      try {
        step = results.next();
      } catch (error) {
        if (!(error instanceof JqError)) throw error;
        if (handler !== null)
          yield* evaluate(runtime, handler, valueFrame(input, error.value), env);
        return;
      }
      if (step.done === true) return;
      yield step.value;
    }
  } finally {
    results.return();
  }
}

function* call(
  runtime: Runtime,
  name: string,
  args: readonly Node[],
  input: Frame,
  env: Env,
): Results {
  const key = `${name}/${args.length}`;
  const entry = lookup(env.functions, key);
  if (entry?.kind === "closure") {
    yield* evaluate(runtime, entry.closure.node, input, entry.closure.env);
    return;
  }
  const closures = args.map((node): Closure => ({ node, env }));
  if (entry?.kind === "definition") {
    yield* invoke(runtime, entry.definition, entry.env, input, closures);
    return;
  }
  const global = runtime.globals.get(key);
  if (global === undefined) throw new Error(`jq: unresolved function ${key}`);
  if (typeof global === "function") yield* global(runtime, input, closures);
  else yield* invoke(runtime, global, EMPTY_ENV, input, closures);
}

/** A `def` call: closure parameters bind lazily, `$name` ones as a cartesian product. */
function* invoke(
  runtime: Runtime,
  definition: Definition,
  definitionEnv: Env,
  input: Frame,
  args: readonly Closure[],
  at = 0,
  bound: Env = definitionEnv,
): Results {
  const param = definition.params[at];
  const arg = args[at];
  if (param === undefined || arg === undefined) {
    yield* evaluate(runtime, definition.body, input, bound);
    return;
  }
  const withClosure = withFunction(bound, `${param.name}/0`, { kind: "closure", closure: arg });
  if (!param.value) {
    yield* invoke(runtime, definition, definitionEnv, input, args, at + 1, withClosure);
    return;
  }
  for (const value of evaluate(runtime, arg.node, plain(input), arg.env)) {
    const next = withVariable(withClosure, param.name, value.value);
    yield* invoke(runtime, definition, definitionEnv, input, args, at + 1, next);
  }
}
