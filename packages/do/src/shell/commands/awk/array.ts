// awk associative arrays: a Map from the canonical string subscript to its
// value. `for (k in a)` visits keys in insertion order; deleting a key and
// adding it again moves it to the end. mawk visits its hash-table order
// instead, which is deliberately not reproduced.

import type { Value } from "./values.js";

export interface Entry {
  value: Value;
}

/** A subscript as the program produced it: an integral number, or text. */
export type Subscript =
  | { readonly kind: "integer"; readonly value: number }
  | { readonly kind: "string"; readonly value: string };

function keyOf(subscript: Subscript): string {
  if (subscript.kind === "string") return subscript.value;
  const value = subscript.value;
  return Math.abs(value) < 2 ** 53 ? String(value) : BigInt(value).toString();
}

export class AwkArray {
  /** Retained bytes charged for this array's keys and values; kept by the runtime. */
  bytes = 0;
  #entries = new Map<string, Entry>();

  get size(): number {
    return this.#entries.size;
  }

  find(subscript: Subscript, create: boolean): Entry | null {
    const key = keyOf(subscript);
    const found = this.#entries.get(key);
    if (found !== undefined) return found;
    if (!create) return null;
    const entry: Entry = { value: null };
    this.#entries.set(key, entry);
    return entry;
  }

  delete(subscript: Subscript): void {
    this.#entries.delete(keyOf(subscript));
  }

  clear(): void {
    this.#entries = new Map();
  }

  /** Replace the contents with `values` as elements 1..n, as `split` does. */
  load(values: readonly Value[]): void {
    this.#entries = new Map(values.map((value, index) => [String(index + 1), { value }]));
  }

  /** A snapshot of the keys, in insertion order. */
  keys(): string[] {
    return Array.from(this.#entries.keys());
  }
}
