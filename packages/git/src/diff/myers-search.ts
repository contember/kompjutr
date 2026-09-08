// SPDX-License-Identifier: LGPL-2.1-or-later
//
// Ported from the xdiff library as it appears in git, which derives from
// LibXDiff, Copyright (C) 2003 Davide Libenzi <davidel@xmailserver.org>.
// LGPL-2.1-or-later, like the original. See ./LICENSE — this directory is
// the one part of kompjutr that is not MIT.

import type { Environment, Side } from "./myers-state.js";

export const MAX_COST_MIN = 256;
export const HEUR_MIN_COST = 256;
export const SNAKE_CNT = 20;
const K_HEUR = 4;
const LINE_MAX = Number.MAX_SAFE_INTEGER;

/** A k-vector over diagonals, which run negative as well as positive. */
export class Diagonals {
  readonly #values: Float64Array;
  readonly #offset: number;

  constructor(size: number, offset: number) {
    this.#values = new Float64Array(size);
    this.#offset = offset;
  }

  get(diagonal: number): number {
    return this.#values[diagonal + this.#offset]!;
  }

  set(diagonal: number, value: number): void {
    this.#values[diagonal + this.#offset] = value;
  }
}

interface Split {
  i1: number;
  i2: number;
  minimalLow: boolean;
  minimalHigh: boolean;
}

function hashAt(side: Side, index: number): number {
  return side.classes[side.reference[index]!]!;
}

/** `xdl_recs_cmp`: divide the box at a middle snake and recurse. */
export function compare(
  left: Side,
  off1: number,
  lim1: number,
  right: Side,
  off2: number,
  lim2: number,
  forward: Diagonals,
  backward: Diagonals,
  needMinimal: boolean,
  environment: Environment,
): void {
  let low1 = off1;
  let low2 = off2;
  let high1 = lim1;
  let high2 = lim2;
  while (low1 < high1 && low2 < high2 && hashAt(left, low1) === hashAt(right, low2)) {
    low1++;
    low2++;
  }
  while (low1 < high1 && low2 < high2 && hashAt(left, high1 - 1) === hashAt(right, high2 - 1)) {
    high1--;
    high2--;
  }

  if (low1 === high1) {
    for (; low2 < high2; low2++) right.changed.set(right.reference[low2]!, true);
    return;
  }
  if (low2 === high2) {
    for (; low1 < high1; low1++) left.changed.set(left.reference[low1]!, true);
    return;
  }

  const split = findSplit(
    left,
    low1,
    high1,
    right,
    low2,
    high2,
    forward,
    backward,
    needMinimal,
    environment,
  );
  compare(
    left,
    low1,
    split.i1,
    right,
    low2,
    split.i2,
    forward,
    backward,
    split.minimalLow,
    environment,
  );
  compare(
    left,
    split.i1,
    high1,
    right,
    split.i2,
    high2,
    forward,
    backward,
    split.minimalHigh,
    environment,
  );
}

/** `xdl_split`: the bidirectional Myers scan, with git's cost heuristics. */
function findSplit(
  left: Side,
  off1: number,
  lim1: number,
  right: Side,
  off2: number,
  lim2: number,
  forward: Diagonals,
  backward: Diagonals,
  needMinimal: boolean,
  environment: Environment,
): Split {
  const dmin = off1 - lim2;
  const dmax = lim1 - off2;
  const forwardMid = off1 - off2;
  const backwardMid = lim1 - lim2;
  const odd = ((forwardMid - backwardMid) & 1) === 1;
  let forwardMin = forwardMid;
  let forwardMax = forwardMid;
  let backwardMin = backwardMid;
  let backwardMax = backwardMid;

  forward.set(forwardMid, off1);
  backward.set(backwardMid, lim1);

  for (let cost = 1; ; cost++) {
    let sawSnake = false;

    if (forwardMin > dmin) forward.set(--forwardMin - 1, -1);
    else forwardMin++;
    if (forwardMax < dmax) forward.set(++forwardMax + 1, -1);
    else forwardMax--;

    for (let d = forwardMax; d >= forwardMin; d -= 2) {
      let i1 =
        forward.get(d - 1) >= forward.get(d + 1) ? forward.get(d - 1) + 1 : forward.get(d + 1);
      const previous = i1;
      let i2 = i1 - d;
      while (i1 < lim1 && i2 < lim2 && hashAt(left, i1) === hashAt(right, i2)) {
        i1++;
        i2++;
      }
      if (i1 - previous > environment.snakeCount) sawSnake = true;
      forward.set(d, i1);
      if (odd && backwardMin <= d && d <= backwardMax && backward.get(d) <= i1) {
        return { i1, i2, minimalLow: true, minimalHigh: true };
      }
    }

    if (backwardMin > dmin) backward.set(--backwardMin - 1, LINE_MAX);
    else backwardMin++;
    if (backwardMax < dmax) backward.set(++backwardMax + 1, LINE_MAX);
    else backwardMax--;

    for (let d = backwardMax; d >= backwardMin; d -= 2) {
      let i1 =
        backward.get(d - 1) < backward.get(d + 1) ? backward.get(d - 1) : backward.get(d + 1) - 1;
      const previous = i1;
      let i2 = i1 - d;
      while (i1 > off1 && i2 > off2 && hashAt(left, i1 - 1) === hashAt(right, i2 - 1)) {
        i1--;
        i2--;
      }
      if (previous - i1 > environment.snakeCount) sawSnake = true;
      backward.set(d, i1);
      if (!odd && forwardMin <= d && d <= forwardMax && i1 <= forward.get(d)) {
        return { i1, i2, minimalLow: true, minimalHigh: true };
      }
    }

    if (needMinimal) continue;

    // Past a certain cost a long enough snake is good enough: take it and
    // stop paying for minimality.
    if (sawSnake && cost > environment.heuristicMinimum) {
      let best = 0;
      let candidate: Split | null = null;
      for (let d = forwardMax; d >= forwardMin; d -= 2) {
        const distance = d > forwardMid ? d - forwardMid : forwardMid - d;
        const i1 = forward.get(d);
        const i2 = i1 - d;
        const reach = i1 - off1 + (i2 - off2) - distance;
        if (
          reach > K_HEUR * cost &&
          reach > best &&
          off1 + environment.snakeCount <= i1 &&
          i1 < lim1 &&
          off2 + environment.snakeCount <= i2 &&
          i2 < lim2
        ) {
          for (let k = 1; hashAt(left, i1 - k) === hashAt(right, i2 - k); k++) {
            if (k === environment.snakeCount) {
              best = reach;
              candidate = { i1, i2, minimalLow: true, minimalHigh: false };
              break;
            }
          }
        }
      }
      if (candidate !== null) return candidate;

      best = 0;
      for (let d = backwardMax; d >= backwardMin; d -= 2) {
        const distance = d > backwardMid ? d - backwardMid : backwardMid - d;
        const i1 = backward.get(d);
        const i2 = i1 - d;
        const reach = lim1 - i1 + (lim2 - i2) - distance;
        if (
          reach > K_HEUR * cost &&
          reach > best &&
          off1 < i1 &&
          i1 <= lim1 - environment.snakeCount &&
          off2 < i2 &&
          i2 <= lim2 - environment.snakeCount
        ) {
          for (let k = 0; hashAt(left, i1 + k) === hashAt(right, i2 + k); k++) {
            if (k === environment.snakeCount - 1) {
              best = reach;
              candidate = { i1, i2, minimalLow: false, minimalHigh: true };
              break;
            }
          }
        }
      }
      if (candidate !== null) return candidate;
    }

    // Enough is enough: take the furthest reaching path from either side.
    if (cost >= environment.maxCost) {
      let forwardBest = -1;
      let forwardBest1 = -1;
      for (let d = forwardMax; d >= forwardMin; d -= 2) {
        let i1 = Math.min(forward.get(d), lim1);
        let i2 = i1 - d;
        if (lim2 < i2) {
          i1 = lim2 + d;
          i2 = lim2;
        }
        if (forwardBest < i1 + i2) {
          forwardBest = i1 + i2;
          forwardBest1 = i1;
        }
      }

      let backwardBest = LINE_MAX;
      let backwardBest1 = LINE_MAX;
      for (let d = backwardMax; d >= backwardMin; d -= 2) {
        let i1 = Math.max(off1, backward.get(d));
        let i2 = i1 - d;
        if (i2 < off2) {
          i1 = off2 + d;
          i2 = off2;
        }
        if (i1 + i2 < backwardBest) {
          backwardBest = i1 + i2;
          backwardBest1 = i1;
        }
      }

      if (lim1 + lim2 - backwardBest < forwardBest - (off1 + off2)) {
        return {
          i1: forwardBest1,
          i2: forwardBest - forwardBest1,
          minimalLow: true,
          minimalHigh: false,
        };
      }
      return {
        i1: backwardBest1,
        i2: backwardBest - backwardBest1,
        minimalLow: false,
        minimalHigh: true,
      };
    }
  }
}
