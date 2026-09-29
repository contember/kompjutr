// The bytes `patch` writes: a patched file as a plan over the held original,
// and reject files in unified form.
//
// A patched file is never assembled in memory. Its plan names ranges of the
// original and lines of the diff, and is streamed out in bounded chunks. A
// line without a final newline gains one when anything follows it.

import type { RetainedBudget } from "../../exec/context.js";
import type { FileLines } from "./file-lines.js";
import { ADDED, CONTEXT, Hunk, type HunkStore, REMOVED } from "./hunk.js";
import { Rows } from "./store.js";

const COPY = 0;
const PLACE = 1;

/**
 * The patched file as steps: copy a range of the original, or place an
 * applied hunk: its added lines, and its context lines taken from the file at
 * `at` where they lie at or past `floor`, up to `kept` old lines.
 */
export class Plan {
  readonly #steps: Rows;
  #empty = true;

  constructor(
    readonly store: HunkStore,
    budget: RetainedBudget,
  ) {
    this.#steps = new Rows(6, budget, "patch plan");
  }

  copy(from: number, to: number): void {
    if (to <= from) return;
    this.#empty = false;
    this.#steps.push(COPY, from, to);
  }

  place(hunk: Hunk, at: number, kept: number, floor: number, lines: number): void {
    let old = 0;
    for (let index = 0; index < hunk.count && this.#empty; index++) {
      const kind = hunk.kind(index);
      if (kind === ADDED) this.#empty = false;
      else if (old >= kept) break;
      else {
        if (kind === CONTEXT && at + old >= floor && at + old < lines) this.#empty = false;
        old++;
      }
    }
    this.#steps.push(PLACE, hunk.index, hunk.swapped ? 1 : 0, at, kept, floor);
  }

  isEmpty(): boolean {
    return this.#empty;
  }

  release(): void {
    this.#steps.release();
  }

  *steps(): Generator<Step, void, undefined> {
    for (let row = 0; row < this.#steps.count; row++) {
      const field = (index: number): number => this.#steps.get(row, index);
      if (field(0) === COPY) yield { kind: "copy", from: field(1), to: field(2) };
      else {
        const hunk = new Hunk(this.store, field(1), field(2) === 1);
        yield { kind: "hunk", hunk, at: field(3), kept: field(4), floor: field(5) };
      }
    }
  }
}

type Step =
  | { readonly kind: "copy"; readonly from: number; readonly to: number }
  | {
      readonly kind: "hunk";
      readonly hunk: Hunk;
      readonly at: number;
      readonly kept: number;
      readonly floor: number;
    };

/** Failed hunks with the shift that renumbers them for the new file. */
export class Rejects {
  readonly #rows: Rows;

  constructor(
    readonly store: HunkStore,
    budget: RetainedBudget,
  ) {
    this.#rows = new Rows(3, budget, "patch rejects");
  }

  get count(): number {
    return this.#rows.count;
  }

  add(hunk: Hunk, shift: number): void {
    this.#rows.push(hunk.index, hunk.swapped ? 1 : 0, shift);
  }

  release(): void {
    this.#rows.release();
  }

  *entries(): Generator<{ readonly hunk: Hunk; readonly shift: number }, void, undefined> {
    for (let row = 0; row < this.#rows.count; row++) {
      const hunk = new Hunk(this.store, this.#rows.get(row, 0), this.#rows.get(row, 1) === 1);
      yield { hunk, shift: this.#rows.get(row, 2) };
    }
  }
}

const OUTPUT_CHUNK = 64 * 1024;
const NEWLINE = new Uint8Array([0x0a]);

/** Stream a plan in chunks of at most 64 KiB, reserved while they are built. */
export function* render(
  plan: Plan,
  file: FileLines,
  budget: RetainedBudget,
): Generator<Uint8Array, void, undefined> {
  yield* chunked(pieces(plan, file), budget, "patch output");
}

function* pieces(plan: Plan, file: FileLines): Generator<Uint8Array, void, undefined> {
  let pending = false;
  const range = function* (from: number, to: number): Generator<Uint8Array, void, undefined> {
    if (to <= from) return;
    if (pending) yield NEWLINE;
    yield file.bytes.subarray(file.start(from), file.start(to));
    pending = to >= file.count && !file.newline(file.count - 1);
  };
  for (const step of plan.steps()) {
    if (step.kind === "copy") {
      yield* range(step.from, step.to);
      continue;
    }
    const { hunk, at, kept, floor } = step;
    let old = 0;
    for (let index = 0; index < hunk.count; index++) {
      const kind = hunk.kind(index);
      if (kind === ADDED) {
        if (pending) yield NEWLINE;
        const bytes = hunk.bytes(index);
        if (bytes.length > 0) yield bytes;
        const newline = hunk.newline(index);
        if (newline) yield NEWLINE;
        pending = !newline;
        continue;
      }
      if (old >= kept) break;
      const line = at + old;
      if (kind === CONTEXT && line >= floor && line < file.count) yield* range(line, line + 1);
      old++;
    }
  }
}

export function* chunked(
  pieces: Iterable<Uint8Array>,
  budget: RetainedBudget,
  label: string,
): Generator<Uint8Array, void, undefined> {
  // Coalescing only saves statements, so the buffer shrinks to fit a tight budget.
  const size = Math.max(1, Math.min(OUTPUT_CHUNK, Math.floor(budget.available / 2)));
  const release = budget.retain(size, label);
  try {
    const buffer = new Uint8Array(size);
    let used = 0;
    for (const piece of pieces) {
      let at = 0;
      while (at < piece.length) {
        const length = Math.min(size - used, piece.length - at);
        buffer.set(piece.subarray(at, at + length), used);
        used += length;
        at += length;
        if (used === size) {
          yield buffer.slice();
          used = 0;
        }
      }
    }
    if (used > 0) yield buffer.slice(0, used);
  } finally {
    release();
  }
}

const ENCODER = new TextEncoder();

/** A reject file section: the header and each hunk, removals before additions. */
export function* rejectSection(
  header: string,
  rejects: Rejects,
): Generator<Uint8Array, void, undefined> {
  yield ENCODER.encode(header);
  for (const { hunk, shift } of rejects.entries()) {
    const oldRange = range(hunk.oldFirst + shift, hunk.oldCount);
    const newRange = range(hunk.newFirst + shift, hunk.newCount);
    yield ENCODER.encode(`@@ -${oldRange} +${newRange} @@`);
    yield hunk.heading;
    yield NEWLINE;
    let index = 0;
    while (index < hunk.count) {
      if (hunk.kind(index) === CONTEXT) {
        yield* rejectLine(" ", hunk, index);
        index++;
        continue;
      }
      let end = index;
      while (end < hunk.count && hunk.kind(end) !== CONTEXT) end++;
      for (let line = index; line < end; line++) {
        if (hunk.kind(line) === REMOVED) yield* rejectLine("-", hunk, line);
      }
      for (let line = index; line < end; line++) {
        if (hunk.kind(line) === ADDED) yield* rejectLine("+", hunk, line);
      }
      index = end;
    }
  }
}

// GNU writes a reject line without a newline exactly as it was, with no
// `\ No newline at end of file` marker after it.
function* rejectLine(
  kind: string,
  hunk: Hunk,
  index: number,
): Generator<Uint8Array, void, undefined> {
  yield ENCODER.encode(kind);
  const bytes = hunk.bytes(index);
  if (bytes.length > 0) yield bytes;
  if (hunk.newline(index)) yield NEWLINE;
}

function range(first: number, count: number): string {
  if (count === 0) return `${first - 1},0`;
  if (count === 1) return `${first}`;
  return `${first},${count}`;
}
