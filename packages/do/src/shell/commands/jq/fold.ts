// reduce and foreach. A reduce step settles what it built except the new
// state, whose size stays reserved. `. + E` and `.[K] = V` with E, K, and V
// independent of `.` update a state this loop alone holds in place: jq does
// the same through its refcount-one fast path, and copying instead makes the
// common accumulate-into-an-array reduction quadratic.

import { destructure } from "./bindings.js";
import { arrayBytes, objectBytes, toInt } from "./paths.js";
import {
  deepSize,
  type Env,
  type Frame,
  forgetSize,
  plain,
  type Results,
  type Runtime,
  root,
  valueFrame,
} from "./runtime.js";
import type { Node } from "./syntax/ast.js";
import { isArray, isNumber, isObject, type JqValue, numberValue } from "./value.js";

type Plan =
  | { readonly kind: "append"; readonly operand: Node }
  | { readonly kind: "set"; readonly key: Node; readonly value: Node }
  | null;

const MAX_ARRAY_INDEX = 2_147_483_647 >> 2;

interface State {
  value: JqValue;
  /** The same container as `value` when this loop alone holds it. */
  owned: JqValue[] | Map<string, JqValue> | null;
  /** Its size estimate, kept current across in-place steps. */
  size: number;
}

export function* reduce(
  runtime: Runtime,
  node: Extract<Node, { kind: "reduce" }>,
  input: Frame,
  env: Env,
): Results {
  const plan = planOf(node.update);
  for (const init of runtime.evaluate(runtime, node.init, plain(input), env)) {
    const state: State = { value: init.value, owned: null, size: deepSize(init.value) };
    let held: (() => void) | null = null;
    const source = runtime.evaluate(runtime, node.source, plain(input), env);
    try {
      for (;;) {
        const advanced = runtime.scoped(() => {
          const step = source.next();
          if (step.done === true) return false;
          for (const bound of destructure(runtime, node.pattern, step.value.value, env)) {
            if (plan !== null && inPlace(runtime, plan, state, bound)) continue;
            let last: JqValue | undefined;
            for (const frame of runtime.evaluate(runtime, node.update, root(state.value), bound))
              last = frame.value;
            state.value = last === undefined ? null : last;
            state.owned = null;
            state.size = deepSize(state.value);
          }
          return true;
        });
        if (!advanced) break;
        const release = runtime.budget.retain(state.size, "jq reduce state");
        held?.();
        held = release;
      }
    } finally {
      held?.();
      source.return();
    }
    if (state.owned !== null) forgetSize(state.owned);
    runtime.charge(deepSize(state.value));
    yield valueFrame(input, state.value);
  }
}

export function* foreach(
  runtime: Runtime,
  node: Extract<Node, { kind: "foreach" }>,
  input: Frame,
  env: Env,
): Results {
  for (const init of runtime.evaluate(runtime, node.init, plain(input), env)) {
    let state = init.value;
    for (const item of runtime.evaluate(runtime, node.source, plain(input), env)) {
      for (const bound of destructure(runtime, node.pattern, item.value, env)) {
        for (const frame of runtime.evaluate(runtime, node.update, root(state), bound)) {
          state = frame.value;
          if (node.extract === null) yield valueFrame(input, state);
          else {
            for (const out of runtime.evaluate(runtime, node.extract, root(state), bound)) {
              yield valueFrame(input, out.value);
            }
          }
        }
      }
    }
  }
}

const PLANS = new WeakMap<Node, Plan>();

function planOf(update: Node): Plan {
  const cached = PLANS.get(update);
  if (cached !== undefined) return cached;
  let plan: Plan = null;
  if (
    update.kind === "binary" &&
    update.operator === "+" &&
    update.left.kind === "identity" &&
    independent(update.right)
  ) {
    plan = { kind: "append", operand: update.right };
  } else if (
    update.kind === "assign" &&
    update.operator === "=" &&
    update.left.kind === "index" &&
    !update.left.optional &&
    update.left.target.kind === "identity" &&
    independent(update.left.key) &&
    independent(update.right)
  ) {
    plan = { kind: "set", key: update.left.key, value: update.right };
  }
  PLANS.set(update, plan);
  return plan;
}

/** True when the node never reads its input, so it cannot observe the state. */
function independent(node: Node | null): boolean {
  if (node === null) return true;
  switch (node.kind) {
    case "literal":
    case "variable":
      return true;
    case "array":
      return independent(node.body);
    case "object":
      return node.entries.every((entry) => independent(entry.key) && independent(entry.value));
    case "string":
      return node.parts.every((part) => typeof part === "string" || independent(part));
    case "negate":
      return independent(node.body);
    case "pipe":
      return independent(node.left);
    case "binary":
    case "and":
    case "or":
    case "alternative":
    case "comma":
      return independent(node.left) && independent(node.right);
    case "index":
      return independent(node.target) && independent(node.key);
    case "iterate":
      return independent(node.target);
    case "if":
      return (
        node.otherwise !== null &&
        independent(node.condition) &&
        independent(node.then) &&
        independent(node.otherwise)
      );
    default:
      return false;
  }
}

function single(runtime: Runtime, node: Node, state: JqValue, env: Env): JqValue | undefined {
  let found: JqValue | undefined;
  let count = 0;
  for (const frame of runtime.evaluate(runtime, node, root(state), env)) {
    found = frame.value;
    count++;
  }
  return count === 1 ? found : undefined;
}

/** Applies the planned update in place; false means "evaluate it normally". */
function inPlace(runtime: Runtime, plan: NonNullable<Plan>, state: State, env: Env): boolean {
  if (plan.kind === "append") {
    const operand = single(runtime, plan.operand, state.value, env);
    if (operand === undefined) return false;
    if (isArray(state.value) && isArray(operand)) {
      const target = ownedArray(runtime, state);
      runtime.charge(arrayBytes(operand.length));
      for (const item of operand) target.push(item);
      state.size += deepSize(operand) - 16;
      return true;
    }
    if (isObject(state.value) && isObject(operand)) {
      const target = ownedObject(runtime, state);
      runtime.charge(objectBytes(operand.size));
      for (const [key, value] of operand) {
        const previous = target.get(key);
        target.set(key, value);
        state.size +=
          deepSize(value) - (previous === undefined ? -48 - 2 * key.length : deepSize(previous));
      }
      return true;
    }
    return false;
  }
  const value = single(runtime, plan.value, state.value, env);
  if (value === undefined) return false;
  const key = single(runtime, plan.key, state.value, env);
  if (key === undefined) return false;
  if (isObject(state.value) && typeof key === "string") {
    const target = ownedObject(runtime, state);
    runtime.charge(objectBytes(1));
    const previous = target.get(key);
    target.set(key, value);
    state.size +=
      deepSize(value) - (previous === undefined ? -48 - 2 * key.length : deepSize(previous));
    return true;
  }
  if (isArray(state.value) && isNumber(key) && !Number.isNaN(numberValue(key))) {
    let index = toInt(numberValue(key));
    if (index < 0) index += state.value.length;
    if (index < 0 || index > MAX_ARRAY_INDEX) return false;
    const target = ownedArray(runtime, state);
    runtime.charge(arrayBytes(Math.max(0, index + 1 - target.length)));
    while (target.length <= index) {
      target.push(null);
      state.size += 16;
    }
    state.size += deepSize(value) - deepSize(target[index] ?? null);
    target[index] = value;
    return true;
  }
  return false;
}

function ownedArray(runtime: Runtime, state: State): JqValue[] {
  if (Array.isArray(state.owned) && state.owned === state.value) return state.owned;
  const copy = isArray(state.value) ? state.value.slice() : [];
  runtime.charge(arrayBytes(copy.length));
  state.value = copy;
  state.owned = copy;
  return copy;
}

function ownedObject(runtime: Runtime, state: State): Map<string, JqValue> {
  if (state.owned instanceof Map && state.owned === state.value) return state.owned;
  const copy = new Map(isObject(state.value) ? state.value : []);
  runtime.charge(objectBytes(copy.size));
  state.value = copy;
  state.owned = copy;
  return copy;
}
