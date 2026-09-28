// GNU diff's normal and unified output over an edit script. A change group is
// a maximal run of removed and added lines between the same unchanged lines;
// unified hunks join groups whose unchanged gap is at most twice the context.

import type { EditScript } from "./myers.js";

export interface Line {
  readonly text: Uint8Array;
  /** False only for a final line without a newline. */
  readonly terminated: boolean;
}

interface Group {
  readonly aStart: number;
  readonly aEnd: number;
  readonly bStart: number;
  readonly bEnd: number;
}

const ENCODER = new TextEncoder();
const NO_NEWLINE = ENCODER.encode("\\ No newline at end of file\n");

export function groups(script: EditScript): Group[] {
  const found: Group[] = [];
  let i = 0;
  let j = 0;
  while (i < script.removed.length || j < script.added.length) {
    if (script.removed[i] !== 1 && script.added[j] !== 1) {
      i++;
      j++;
      continue;
    }
    const aStart = i;
    const bStart = j;
    while (script.removed[i] === 1) i++;
    while (script.added[j] === 1) j++;
    found.push({ aStart, aEnd: i, bStart, bEnd: j });
  }
  return found;
}

export function* normal(
  changes: readonly Group[],
  a: readonly Line[],
  b: readonly Line[],
): Generator<Uint8Array, void, undefined> {
  for (const group of changes) {
    const removes = group.aEnd > group.aStart;
    const adds = group.bEnd > group.bStart;
    const kind = removes && adds ? "c" : removes ? "d" : "a";
    const left = removes ? range(group.aStart, group.aEnd) : String(group.aStart);
    const right = adds ? range(group.bStart, group.bEnd) : String(group.bStart);
    yield ENCODER.encode(`${left}${kind}${right}\n`);
    for (let index = group.aStart; index < group.aEnd; index++) yield* line("< ", a[index]);
    if (removes && adds) yield ENCODER.encode("---\n");
    for (let index = group.bStart; index < group.bEnd; index++) yield* line("> ", b[index]);
  }
}

export function* unified(
  changes: readonly Group[],
  a: readonly Line[],
  b: readonly Line[],
  context: number,
): Generator<Uint8Array, void, undefined> {
  let first = 0;
  while (first < changes.length) {
    let last = first;
    while (last + 1 < changes.length && joins(changes[last], changes[last + 1], context)) last++;
    const opening = changes[first];
    const closing = changes[last];
    if (opening === undefined || closing === undefined) return;

    const lead = Math.min(context, opening.aStart);
    const aFrom = opening.aStart - lead;
    const bFrom = opening.bStart - lead;
    const trail = Math.min(context, a.length - closing.aEnd);
    const aTo = closing.aEnd + trail;
    const bTo = closing.bEnd + trail;
    yield ENCODER.encode(`@@ -${span(aFrom, aTo)} +${span(bFrom, bTo)} @@\n`);

    let i = aFrom;
    for (let index = first; index <= last; index++) {
      const group = changes[index];
      if (group === undefined) continue;
      for (; i < group.aStart; i++) yield* line(" ", a[i]);
      for (let k = group.aStart; k < group.aEnd; k++) yield* line("-", a[k]);
      for (let k = group.bStart; k < group.bEnd; k++) yield* line("+", b[k]);
      i = group.aEnd;
    }
    for (; i < aTo; i++) yield* line(" ", a[i]);
    first = last + 1;
  }
}

function joins(left: Group | undefined, right: Group | undefined, context: number): boolean {
  if (left === undefined || right === undefined) return false;
  return right.aStart - left.aEnd <= 2 * context;
}

/** Normal-format lines: `N` or `N,M`, one-based and inclusive. */
function range(start: number, end: number): string {
  return end - start === 1 ? `${start + 1}` : `${start + 1},${end}`;
}

/** Unified-format spans: an empty span names the line before it. */
function span(start: number, end: number): string {
  const count = end - start;
  if (count === 0) return `${start},0`;
  if (count === 1) return `${start + 1}`;
  return `${start + 1},${count}`;
}

function* line(prefix: string, value: Line | undefined): Generator<Uint8Array, void, undefined> {
  if (value === undefined) return;
  yield ENCODER.encode(prefix);
  yield value.text;
  yield ENCODER.encode("\n");
  if (!value.terminated) yield NO_NEWLINE;
}
