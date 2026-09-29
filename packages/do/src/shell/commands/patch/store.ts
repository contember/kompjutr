// Compact, reserved storage for one file patch.
//
// A diff with a million one-line hunks must not become a million objects.
// Hunk lines are offsets into the held diff, and hunks, plan steps, and
// rejects are rows of typed arrays, each reserved on the retained budget as
// it grows; the objects that read them are made on demand and dropped.

import type { RetainedBudget } from "../../exec/context.js";

const INITIAL_ROWS = 1;
const INITIAL_LINES = 4;

/** Rows of numbers, grown by doubling; the reservation follows the capacity. */
export class Rows {
  #data: Float64Array;
  #count = 0;
  #release: () => void;

  constructor(
    readonly width: number,
    private readonly budget: RetainedBudget,
    private readonly label: string,
  ) {
    this.#release = () => {};
    this.#data = new Float64Array(0);
  }

  get count(): number {
    return this.#count;
  }

  push(...values: readonly number[]): number {
    if ((this.#count + 1) * this.width > this.#data.length) this.#grow();
    const base = this.#count * this.width;
    for (let field = 0; field < this.width; field++) this.#data[base + field] = values[field] ?? 0;
    return this.#count++;
  }

  get(row: number, field: number): number {
    return this.#data[row * this.width + field] ?? 0;
  }

  set(row: number, field: number, value: number): void {
    this.#data[row * this.width + field] = value;
  }

  truncate(count: number): void {
    this.#count = Math.min(this.#count, count);
  }

  release(): void {
    this.#release();
  }

  // The larger array is reserved before the smaller one is copied and dropped.
  #grow(): void {
    const capacity = Math.max(INITIAL_ROWS, (this.#data.length / this.width) * 2);
    const release = this.budget.retain(capacity * this.width * 8, this.label);
    const data = new Float64Array(capacity * this.width);
    data.set(this.#data);
    this.#data = data;
    this.#release();
    this.#release = release;
  }
}

const NO_NEWLINE = 4;
const KIND_MASK = 3;

/** Hunk lines of one file patch: a kind byte and an offset and length into the diff. */
export class LineRows {
  #kinds = new Uint8Array(0);
  #starts = new Uint32Array(0);
  #lengths = new Uint32Array(0);
  #count = 0;
  #release: () => void = () => {};

  constructor(private readonly budget: RetainedBudget) {}

  get count(): number {
    return this.#count;
  }

  push(kind: number, start: number, length: number, newline: boolean): void {
    if (this.#count === this.#kinds.length) this.#grow();
    this.#kinds[this.#count] = kind | (newline ? 0 : NO_NEWLINE);
    this.#starts[this.#count] = start;
    this.#lengths[this.#count] = length;
    this.#count++;
  }

  dropLastNewline(): void {
    const last = this.#count - 1;
    this.#kinds[last] = (this.#kinds[last] ?? 0) | NO_NEWLINE;
  }

  kind(line: number): number {
    return (this.#kinds[line] ?? 0) & KIND_MASK;
  }

  newline(line: number): boolean {
    return ((this.#kinds[line] ?? 0) & NO_NEWLINE) === 0;
  }

  start(line: number): number {
    return this.#starts[line] ?? 0;
  }

  length(line: number): number {
    return this.#lengths[line] ?? 0;
  }

  truncate(count: number): void {
    this.#count = Math.min(this.#count, count);
  }

  release(): void {
    this.#release();
  }

  #grow(): void {
    const capacity = Math.max(INITIAL_LINES, this.#kinds.length * 2);
    const release = this.budget.retain(capacity * 9, "patch hunk lines");
    const kinds = new Uint8Array(capacity);
    const starts = new Uint32Array(capacity);
    const lengths = new Uint32Array(capacity);
    kinds.set(this.#kinds);
    starts.set(this.#starts);
    lengths.set(this.#lengths);
    this.#kinds = kinds;
    this.#starts = starts;
    this.#lengths = lengths;
    this.#release();
    this.#release = release;
  }
}
