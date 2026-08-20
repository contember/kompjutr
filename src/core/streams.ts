// Sorted-stream primitives. Every streaming walk in this package — the index,
// a tree, the working tree — is ordered by `comparePaths`, so two of them can
// be merged with one item of live state per side and no buffering.

/** Unpaired surrogates encode to U+FFFD, which is what TextEncoder writes. */
const REPLACEMENT = 0xfffd;

/** Code point at `index`, folding an unpaired surrogate to U+FFFD. */
function pointAt(text: string, index: number): number {
  const unit = text.charCodeAt(index);
  if ((unit & 0xf800) !== 0xd800) return unit;
  if ((unit & 0xfc00) === 0xd800) {
    // Out of range gives NaN, and NaN & 0xfc00 is 0, so no bounds check.
    const low = text.charCodeAt(index + 1);
    if ((low & 0xfc00) === 0xdc00) return 0x10000 + ((unit - 0xd800) << 10) + (low - 0xdc00);
  }
  return REPLACEMENT;
}

/**
 * UTF-8 byte order, the order SQLite gives TEXT and git gives tree entries.
 *
 * JavaScript's `<` compares UTF-16 code units and disagrees above the BMP:
 * "\u{1F600}" encodes to F0 9F 98 80 and so sorts after U+E000 (EE 80 80),
 * but its leading surrogate 0xD83D sorts before 0xE000. Comparing by code
 * point instead is exact, because UTF-8 byte order and code point order
 * coincide — and it needs no encoding buffer.
 */
export function comparePaths(left: string, right: string): number {
  const leftLength = left.length;
  const rightLength = right.length;
  let leftIndex = 0;
  let rightIndex = 0;

  while (leftIndex < leftLength && rightIndex < rightLength) {
    const leftUnit = left.charCodeAt(leftIndex);
    const rightUnit = right.charCodeAt(rightIndex);
    // Equal non-surrogate units are equal code points; skip the decode.
    if (leftUnit === rightUnit && (leftUnit & 0xf800) !== 0xd800) {
      leftIndex++;
      rightIndex++;
      continue;
    }
    const leftPoint = pointAt(left, leftIndex);
    const rightPoint = pointAt(right, rightIndex);
    if (leftPoint !== rightPoint) return leftPoint < rightPoint ? -1 : 1;
    // Equal code points span equally many units, so one width covers both.
    const width = leftPoint >= 0x10000 ? 2 : 1;
    leftIndex += width;
    rightIndex += width;
  }

  if (leftIndex < leftLength) return 1;
  if (rightIndex < rightLength) return -1;
  return 0;
}

/** A generator you can look one item ahead in without consuming it. */
export interface Peekable<T> {
  peek(): T | undefined;
  next(): T | undefined;
}

/**
 * One item of lookahead over `source`. Exactly one item is ever buffered, and
 * the source is pulled only when `peek`/`next` needs an item it does not hold.
 *
 * A source that yields `undefined` is indistinguishable from an exhausted one.
 */
export function peekable<T>(source: Iterable<T>): Peekable<T> {
  const iterator = source[Symbol.iterator]();
  let ahead: T | undefined;
  let buffered = false;
  let drained = false;

  function fill(): void {
    if (buffered || drained) return;
    const step = iterator.next();
    if (step.done === true) {
      drained = true;
      return;
    }
    ahead = step.value;
    buffered = true;
  }

  return {
    peek(): T | undefined {
      fill();
      return buffered ? ahead : undefined;
    },
    next(): T | undefined {
      fill();
      if (!buffered) return undefined;
      const value = ahead;
      ahead = undefined;
      buffered = false;
      return value;
    },
  };
}

/** One path, and whichever of the two streams carried it. */
export interface JoinedRow<L, R> {
  path: string;
  left: L | undefined;
  right: R | undefined;
}

/**
 * Walk two path-sorted streams together, yielding each path once with
 * whichever sides have it. Live state is one item per side.
 *
 * ASSUMES both inputs are already ascending by `comparePaths`. Nothing checks
 * it — an out-of-order input silently produces out-of-order rows rather than
 * an error, because verifying it would mean keeping the previous key of each
 * side alive, and this is the one place that must stay at one item per side.
 *
 * Equal keys pair one to one: a key repeated on one side (index rows share a
 * path across stages) yields once per repeat, and only the first of them sees
 * the other side.
 */
export function* joinSorted<L, R>(
  left: Iterable<L>,
  right: Iterable<R>,
  keyOf: { left: (item: L) => string; right: (item: R) => string },
): Generator<JoinedRow<L, R>> {
  const leftSide = peekable(left);
  const rightSide = peekable(right);

  for (;;) {
    const leftHead = leftSide.peek();
    const rightHead = rightSide.peek();

    if (leftHead === undefined) {
      if (rightHead === undefined) return;
      rightSide.next();
      yield { path: keyOf.right(rightHead), left: undefined, right: rightHead };
      continue;
    }
    const leftKey = keyOf.left(leftHead);
    if (rightHead === undefined) {
      leftSide.next();
      yield { path: leftKey, left: leftHead, right: undefined };
      continue;
    }

    const rightKey = keyOf.right(rightHead);
    const order = comparePaths(leftKey, rightKey);
    if (order <= 0) leftSide.next();
    if (order >= 0) rightSide.next();
    yield {
      path: order <= 0 ? leftKey : rightKey,
      left: order <= 0 ? leftHead : undefined,
      right: order >= 0 ? rightHead : undefined,
    };
  }
}

/** One path, and whichever of the three streams carried it. */
export interface JoinedRow3<A, B, C> {
  path: string;
  a: A | undefined;
  b: B | undefined;
  c: C | undefined;
}

/**
 * Walk three path-sorted streams together. Live state is one item per stream.
 *
 * Fixed at three rather than variadic: the element types are heterogeneous
 * (a tree entry, an index row, a bare path), and an array form collapses them
 * to a union and loses the per-side type. Three is also the only arity
 * anything here needs — `status` compares HEAD, the index and the worktree.
 *
 * Nesting two `joinSorted` calls would do the same work, but it allocates two
 * rows per path on the hottest walk in the package and reaches the HEAD entry
 * as `row.left?.left`.
 *
 * Same assumptions as `joinSorted`: inputs ascending by `comparePaths`,
 * unchecked, and a repeated key yields once per repeat.
 */
export function* joinSorted3<A, B, C>(
  a: Iterable<A>,
  b: Iterable<B>,
  c: Iterable<C>,
  keyOf: { a: (item: A) => string; b: (item: B) => string; c: (item: C) => string },
): Generator<JoinedRow3<A, B, C>> {
  const sideA = peekable(a);
  const sideB = peekable(b);
  const sideC = peekable(c);

  for (;;) {
    const headA = sideA.peek();
    const headB = sideB.peek();
    const headC = sideC.peek();
    if (headA === undefined && headB === undefined && headC === undefined) return;

    const keyA = headA === undefined ? undefined : keyOf.a(headA);
    const keyB = headB === undefined ? undefined : keyOf.b(headB);
    const keyC = headC === undefined ? undefined : keyOf.c(headC);

    let path = keyA ?? keyB ?? keyC ?? "";
    if (keyB !== undefined && comparePaths(keyB, path) < 0) path = keyB;
    if (keyC !== undefined && comparePaths(keyC, path) < 0) path = keyC;

    const takeA = keyA === path;
    const takeB = keyB === path;
    const takeC = keyC === path;
    if (takeA) sideA.next();
    if (takeB) sideB.next();
    if (takeC) sideC.next();

    yield {
      path,
      a: takeA ? headA : undefined,
      b: takeB ? headB : undefined,
      c: takeC ? headC : undefined,
    };
  }
}
