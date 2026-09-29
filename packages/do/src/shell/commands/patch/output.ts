// The bytes `patch` writes: a patched file as a plan over the held original,
// and reject files in unified form.
//
// A patched file is never assembled in memory. Its plan names ranges of the
// original and lines of the diff, and is streamed out in bounded chunks. A
// line without a final newline gains one when anything follows it.

import type { RetainedBudget } from "../../exec/context.js";
import type { Hunk } from "./hunk.js";
import type { FileLines } from "./locate.js";
import type { Line } from "./text.js";

export type Segment =
  | { readonly kind: "file"; readonly from: number; readonly to: number }
  | { readonly kind: "line"; readonly line: Line };

export class Plan {
  readonly segments: Segment[] = [];

  copy(from: number, to: number): void {
    if (to <= from) return;
    const last = this.segments[this.segments.length - 1];
    if (last?.kind === "file" && last.to === from) {
      this.segments[this.segments.length - 1] = { kind: "file", from: last.from, to };
      return;
    }
    this.segments.push({ kind: "file", from, to });
  }

  add(line: Line): void {
    this.segments.push({ kind: "line", line });
  }

  isEmpty(): boolean {
    return this.segments.every((segment) =>
      segment.kind === "file" ? segment.to <= segment.from : false,
    );
  }
}

const OUTPUT_CHUNK = 64 * 1024;
const NEWLINE = new Uint8Array([0x0a]);

/** Stream a plan in chunks of at most 64 KiB, reserved while they are built. */
export function* render(
  plan: Plan,
  file: FileLines | null,
  budget: RetainedBudget,
): Generator<Uint8Array, void, undefined> {
  const pieces = (function* (): Generator<Uint8Array, void, undefined> {
    let pending = false;
    for (const segment of plan.segments) {
      if (segment.kind === "line") {
        if (pending) yield NEWLINE;
        if (segment.line.bytes.length > 0) yield segment.line.bytes;
        if (segment.line.newline) yield NEWLINE;
        pending = !segment.line.newline;
        continue;
      }
      if (file === null || segment.to <= segment.from) continue;
      if (pending) yield NEWLINE;
      yield file.bytes.subarray(file.start(segment.from), file.start(segment.to));
      pending = segment.to >= file.count && !file.newline(file.count - 1);
    }
  })();
  yield* chunked(pieces, budget, "patch output");
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

/** A failed hunk as the reject file shows it, renumbered for the new file. */
export interface Reject {
  readonly hunk: Hunk;
  readonly shift: number;
}

const ENCODER = new TextEncoder();

/** A reject file section: the header and each hunk, removals before additions. */
export function* rejectSection(
  oldName: string,
  newName: string,
  rejects: readonly Reject[],
): Generator<Uint8Array, void, undefined> {
  yield ENCODER.encode(`--- ${oldName}\n+++ ${newName}\n`);
  for (const { hunk, shift } of rejects) {
    const oldRange = range(hunk.oldFirst + shift, hunk.oldCount);
    const newRange = range(hunk.newFirst + shift, hunk.newCount);
    yield ENCODER.encode(`@@ -${oldRange} +${newRange} @@`);
    yield hunk.heading;
    yield NEWLINE;
    let run: Line[] = [];
    let added: Line[] = [];
    const flush = function* (): Generator<Uint8Array, void, undefined> {
      for (const line of run) yield* rejectLine("-", line);
      for (const line of added) yield* rejectLine("+", line);
      run = [];
      added = [];
    };
    for (const entry of hunk.lines) {
      if (entry.kind === " ") {
        yield* flush();
        yield* rejectLine(" ", entry.line);
      } else if (entry.kind === "-") run.push(entry.line);
      else added.push(entry.line);
    }
    yield* flush();
  }
}

// GNU writes a reject line without a newline exactly as it was, with no
// `\ No newline at end of file` marker after it.
function* rejectLine(kind: string, line: Line): Generator<Uint8Array, void, undefined> {
  yield ENCODER.encode(kind);
  if (line.bytes.length > 0) yield line.bytes;
  if (line.newline) yield NEWLINE;
}

function range(first: number, count: number): string {
  if (count === 0) return `${first - 1},0`;
  if (count === 1) return `${first}`;
  return `${first},${count}`;
}
