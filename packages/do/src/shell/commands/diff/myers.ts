// A minimal edit script between two line sequences, in linear space: Myers'
// O(ND) search, split at the middle snake and applied recursively. Lines are
// compared as interned integers. The result marks which lines each side
// changes; `shiftBoundaries` then places each ambiguous run of changes as GNU
// diff does, so hunks read the same way.

export interface EditScript {
  readonly removed: Uint8Array;
  readonly added: Uint8Array;
}

export function editScript(a: Int32Array, b: Int32Array): EditScript {
  const removed = new Uint8Array(a.length);
  const added = new Uint8Array(b.length);
  compare(a, 0, a.length, b, 0, b.length, removed, added);
  shiftBoundaries(a, removed, added);
  shiftBoundaries(b, added, removed);
  return { removed, added };
}

function compare(
  a: Int32Array,
  aLow: number,
  aHigh: number,
  b: Int32Array,
  bLow: number,
  bHigh: number,
  removed: Uint8Array,
  added: Uint8Array,
): void {
  let aStart = aLow;
  let bStart = bLow;
  let aEnd = aHigh;
  let bEnd = bHigh;
  while (aStart < aEnd && bStart < bEnd && a[aStart] === b[bStart]) {
    aStart++;
    bStart++;
  }
  while (aEnd > aStart && bEnd > bStart && a[aEnd - 1] === b[bEnd - 1]) {
    aEnd--;
    bEnd--;
  }
  if (aStart === aEnd) {
    added.fill(1, bStart, bEnd);
    return;
  }
  if (bStart === bEnd) {
    removed.fill(1, aStart, aEnd);
    return;
  }
  const split = middleSnake(a, aStart, aEnd, b, bStart, bEnd);
  if (split === null) {
    removed.fill(1, aStart, aEnd);
    added.fill(1, bStart, bEnd);
    return;
  }
  compare(a, aStart, aStart + split.x, b, bStart, bStart + split.y, removed, added);
  compare(a, aStart + split.x, aEnd, b, bStart + split.y, bEnd, removed, added);
}

/**
 * The point where a forward and a reverse furthest-reaching path overlap, in
 * coordinates relative to the lower corner. Both halves around it are
 * strictly smaller, so the recursion ends.
 */
function middleSnake(
  a: Int32Array,
  aLow: number,
  aHigh: number,
  b: Int32Array,
  bLow: number,
  bHigh: number,
): { x: number; y: number } | null {
  const n = aHigh - aLow;
  const m = bHigh - bLow;
  const maxD = Math.ceil((n + m) / 2);
  const offset = maxD;
  const size = 2 * maxD + 2;
  const forward = new Int32Array(size).fill(-1);
  const reverse = new Int32Array(size).fill(-1);
  forward[offset + 1] = 0;
  reverse[offset + 1] = 0;
  const delta = n - m;
  const odd = delta % 2 !== 0;
  let forwardStart = 0;
  let forwardEnd = 0;
  let reverseStart = 0;
  let reverseEnd = 0;

  for (let d = 0; d < maxD; d++) {
    for (let k = -d + forwardStart; k <= d - forwardEnd; k += 2) {
      const index = offset + k;
      const down = k === -d || (k !== d && at(forward, index - 1) < at(forward, index + 1));
      let x = down ? at(forward, index + 1) : at(forward, index - 1) + 1;
      let y = x - k;
      while (x < n && y < m && a[aLow + x] === b[bLow + y]) {
        x++;
        y++;
      }
      forward[index] = x;
      if (x > n) {
        forwardEnd += 2;
      } else if (y > m) {
        forwardStart += 2;
      } else if (odd) {
        const mirror = offset + delta - k;
        if (mirror >= 0 && mirror < size && at(reverse, mirror) !== -1) {
          if (x >= n - at(reverse, mirror)) return { x, y };
        }
      }
    }

    for (let k = -d + reverseStart; k <= d - reverseEnd; k += 2) {
      const index = offset + k;
      const down = k === -d || (k !== d && at(reverse, index - 1) < at(reverse, index + 1));
      let x = down ? at(reverse, index + 1) : at(reverse, index - 1) + 1;
      let y = x - k;
      while (x < n && y < m && a[aHigh - 1 - x] === b[bHigh - 1 - y]) {
        x++;
        y++;
      }
      reverse[index] = x;
      if (x > n) {
        reverseEnd += 2;
      } else if (y > m) {
        reverseStart += 2;
      } else if (!odd) {
        const mirror = offset + delta - k;
        if (mirror >= 0 && mirror < size && at(forward, mirror) !== -1) {
          const forwardX = at(forward, mirror);
          if (forwardX >= n - x) return { x: forwardX, y: forwardX - (mirror - offset) };
        }
      }
    }
  }
  return null;
}

function at(values: Int32Array, index: number): number {
  return values[index] ?? -1;
}

/**
 * Places each run of changed lines where equal lines leave it ambiguous. A run
 * may move while the line it would uncover equals the line it would cover. It
 * settles in the lowest position that shares a gap between unchanged lines
 * with a run in the other file, so the two form one hunk; without one, as low
 * as it can go. A move that merges runs starts the placement again.
 */
function shiftBoundaries(lines: Int32Array, changed: Uint8Array, otherChanged: Uint8Array): void {
  const otherGaps = runGaps(otherChanged);
  const length = lines.length;
  let start = 0;
  let unchangedBefore = 0;
  while (start < length) {
    if (changed[start] === 0) {
      start++;
      unchangedBefore++;
      continue;
    }
    let end = start;
    while (end < length && changed[end] === 1) end++;

    let merged = true;
    let steps = 0;
    let settle = 0;
    while (merged) {
      merged = false;
      // Up as far as it goes, absorbing any run it reaches.
      for (;;) {
        if (start > 0 && changed[start - 1] === 1) {
          start--;
          continue;
        }
        if (start === 0 || lines[start - 1] !== lines[end - 1]) break;
        changed[--start] = 1;
        changed[--end] = 0;
        unchangedBefore--;
      }
      // Down as far as it goes, noting each position that meets the other file.
      steps = 0;
      settle = -1;
      for (;;) {
        if (otherGaps.has(unchangedBefore)) settle = steps;
        if (end >= length || lines[start] !== lines[end]) break;
        changed[start++] = 0;
        changed[end++] = 1;
        unchangedBefore++;
        steps++;
        if (end < length && changed[end] === 1) {
          while (end < length && changed[end] === 1) end++;
          merged = true;
        }
      }
    }

    for (let back = settle < 0 ? 0 : steps - settle; back > 0; back--) {
      changed[--start] = 1;
      changed[--end] = 0;
      unchangedBefore--;
    }
    start = end;
  }
}

/** For each run of changes, how many unchanged lines precede it. */
function runGaps(changed: Uint8Array): Set<number> {
  const gaps = new Set<number>();
  let unchanged = 0;
  for (let index = 0; index < changed.length; index++) {
    if (changed[index] === 0) {
      unchanged++;
    } else if (index === 0 || changed[index - 1] === 0) {
      gaps.add(unchanged);
    }
  }
  return gaps;
}
