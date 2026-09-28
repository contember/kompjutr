// What the evaluator threads through a run. A Frame is a value together with
// the path it was reached by while `path(f)` is being tracked; `at` is the
// value at that path, and a path step is legal only on that very value, which
// is how jq detects `path(sort | .[0])`.

import type { RetainedBudget } from "../../exec/context.js";
import { type Recursion, trampoline } from "./recursion.js";
import type { Definition, Node } from "./syntax/ast.js";
import { isArray, type JqArray, JqLiteral, type JqObject, type JqValue } from "./value.js";

export type JqPath = readonly JqValue[];

/**
 * A tracked path as a chain of steps, so one step costs O(1) and a frame deep
 * in a 10,000-level value does not copy the whole path.
 */
export class PathStep {
  constructor(
    readonly parent: PathStep | null,
    readonly key: JqValue,
  ) {}

  static readonly EMPTY = new PathStep(null, null);

  append(key: JqValue): PathStep {
    return new PathStep(this, key);
  }

  toArray(): JqValue[] {
    const keys: JqValue[] = [];
    for (
      let step: PathStep | null = this;
      step !== null && step !== PathStep.EMPTY;
      step = step.parent
    ) {
      keys.push(step.key);
    }
    return keys.reverse();
  }
}

export interface Frame {
  readonly value: JqValue;
  readonly path: PathStep | null;
  readonly at: JqValue;
}

export type Results = Generator<Frame, void, undefined>;

export interface Closure {
  readonly node: Node;
  readonly env: Env;
}

export type FunctionEntry =
  | { readonly kind: "definition"; readonly definition: Definition; readonly env: Env }
  | { readonly kind: "closure"; readonly closure: Closure };

export interface Env {
  readonly variables: Scope<JqValue> | null;
  readonly functions: Scope<FunctionEntry> | null;
  readonly labels: Scope<JqObject> | null;
}

export interface Scope<T> {
  readonly name: string;
  readonly value: T;
  readonly parent: Scope<T> | null;
}

export type Evaluator = (runtime: Runtime, node: Node, input: Frame, env: Env) => Results;

export type Native = (runtime: Runtime, input: Frame, args: readonly Closure[]) => Results;

/** The command's side of a run: inputs, clock, environment, and diagnostics. */
export interface Host {
  /** The next input value, or undefined when inputs are exhausted. */
  input(): { readonly value: JqValue } | undefined;
  inputFilename(): JqValue;
  readonly environment: JqObject;
  now(): number;
  debug(value: JqValue): void;
  stderr(value: JqValue): void;
}

/**
 * Charges made while one input is processed. A reduce or foreach step opens a
 * nested ledger and settles it when the step ends, keeping only the state.
 */
export class Ledger {
  #releases: Array<() => void> = [];

  constructor(
    private readonly budget: RetainedBudget,
    private readonly label: string,
  ) {}

  charge(bytes: number): void {
    this.#releases.push(this.budget.retain(Math.max(0, Math.ceil(bytes)), this.label));
  }

  settle(): void {
    for (const release of this.#releases) release();
    this.#releases = [];
  }
}

export class Runtime {
  ledger: Ledger;
  #labels = 0;

  constructor(
    readonly host: Host,
    readonly budget: RetainedBudget,
    readonly globals: ReadonlyMap<string, Native | Definition>,
    readonly evaluate: Evaluator,
  ) {
    this.ledger = new Ledger(budget, "jq value");
  }

  readonly charge = (bytes: number): void => {
    this.ledger.charge(bytes);
  };

  nextLabel(): number {
    return this.#labels++;
  }

  /** Runs `body` against a nested ledger that is settled when it returns. */
  scoped<T>(body: () => T): T {
    const outer = this.ledger;
    this.ledger = new Ledger(this.budget, "jq value");
    try {
      return body();
    } finally {
      this.ledger.settle();
      this.ledger = outer;
    }
  }
}

export function lookup<T>(scope: Scope<T> | null, name: string): T | undefined {
  for (let current = scope; current !== null; current = current.parent) {
    if (current.name === name) return current.value;
  }
  return undefined;
}

export function valueFrame(input: Frame, value: JqValue): Frame {
  return { value, path: input.path, at: input.at };
}

/** A subexpression's input: the same value, with path tracking off. */
export function plain(input: Frame): Frame {
  return input.path === null ? input : { value: input.value, path: null, at: null };
}

export function root(value: JqValue): Frame {
  return { value, path: null, at: null };
}

const SIZES = new WeakMap<object, number>();

/** Records a container's size when it is known from its parts, as for a concatenation. */
export function knownSize(value: JqArray, left: JqArray, right: JqArray): void {
  const leftSize = SIZES.get(left);
  if (leftSize !== undefined) SIZES.set(value, leftSize + deepSize(right) - 16);
}

/** Drops a cached size after the container was changed in place. */
export function forgetSize(value: object): void {
  SIZES.delete(value);
}

/** An estimate of the memory a value holds, cached per container. */
export function deepSize(value: JqValue): number {
  const scalar = scalarSize(value);
  return scalar ?? trampoline(sizeWalk(value));
}

function scalarSize(value: JqValue): number | null {
  if (value === null || typeof value === "boolean" || typeof value === "number") return 8;
  if (typeof value === "string") return 16 + 2 * value.length;
  if (value instanceof JqLiteral) return 32 + value.digits.length;
  return SIZES.get(value) ?? null;
}

function* sizeWalk(value: JqValue): Recursion<number> {
  const scalar = scalarSize(value);
  if (
    scalar !== null ||
    value === null ||
    typeof value !== "object" ||
    value instanceof JqLiteral
  ) {
    return scalar ?? 0;
  }
  let size: number;
  if (isArray(value)) {
    size = 16;
    for (const item of value) size += 8 + (scalarSize(item) ?? (yield sizeWalk(item)));
  } else {
    size = 32;
    for (const [key, item] of value) {
      size += 48 + 2 * key.length + (scalarSize(item) ?? (yield sizeWalk(item)));
    }
  }
  SIZES.set(value, size);
  return size;
}
