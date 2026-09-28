// Variable and function bindings: destructuring patterns and the scopes they
// extend. Key expressions in object patterns run against the value being
// destructured, in the scope outside the pattern.

import { jvGet } from "./paths.js";
import { type Env, type FunctionEntry, type Runtime, root } from "./runtime.js";
import type { Pattern } from "./syntax/ast.js";
import type { JqValue } from "./value.js";

export const EMPTY_ENV: Env = { variables: null, functions: null, labels: null };

export function* destructure(
  runtime: Runtime,
  pattern: Pattern,
  value: JqValue,
  env: Env,
): Generator<Env, void, undefined> {
  switch (pattern.kind) {
    case "variable":
      yield withVariable(env, pattern.name, value);
      return;
    case "array":
      yield* destructureItems(runtime, pattern.items, 0, value, env);
      return;
    case "object":
      yield* destructureEntries(runtime, pattern.entries, 0, value, env, env);
      return;
  }
}

function* destructureItems(
  runtime: Runtime,
  items: readonly Pattern[],
  at: number,
  value: JqValue,
  env: Env,
): Generator<Env, void, undefined> {
  const item = items[at];
  if (item === undefined) {
    yield env;
    return;
  }
  for (const bound of destructure(runtime, item, jvGet(value, at), env)) {
    yield* destructureItems(runtime, items, at + 1, value, bound);
  }
}

function* destructureEntries(
  runtime: Runtime,
  entries: Extract<Pattern, { kind: "object" }>["entries"],
  at: number,
  value: JqValue,
  outer: Env,
  env: Env,
): Generator<Env, void, undefined> {
  const entry = entries[at];
  if (entry === undefined) {
    yield env;
    return;
  }
  for (const key of runtime.evaluate(runtime, entry.key, root(value), outer)) {
    const member = jvGet(value, key.value);
    const named = entry.binding === null ? env : withVariable(env, entry.binding.name, member);
    const bindings =
      entry.pattern === null
        ? singleEnv(named)
        : destructure(runtime, entry.pattern, member, named);
    for (const bound of bindings)
      yield* destructureEntries(runtime, entries, at + 1, value, outer, bound);
  }
}

function* singleEnv(env: Env): Generator<Env, void, undefined> {
  yield env;
}

export function withVariable(env: Env, name: string, value: JqValue): Env {
  return { ...env, variables: { name, value, parent: env.variables } };
}

export function withFunction(env: Env, key: string, entry: FunctionEntry): Env {
  return { ...env, functions: { name: key, value: entry, parent: env.functions } };
}
