// SPDX-License-Identifier: LGPL-2.1-or-later
//
// Ported from Git's xdiff/xmerge.c at 94f057755b7941b321fd11fec1b2e3ca5313a4e0
// (v2.54.0). LibXDiff is Copyright (C) 2003-2006 Davide Libenzi and
// Johannes E. Schindelin. LGPL-2.1-or-later, like the original.

import { GitError } from "../common/errors.js";

export function bytesEqual(left: Uint8Array, right: Uint8Array): boolean {
  if (left.length !== right.length) return false;
  for (let index = 0; index < left.length; index++) {
    if (left[index] !== right[index]) return false;
  }
  return true;
}

export function identityMergeContent(
  base: Uint8Array,
  current: Uint8Array,
  incoming: Uint8Array,
): Uint8Array | null {
  if (bytesEqual(current, incoming)) return current;
  if (bytesEqual(base, current)) return incoming;
  if (bytesEqual(base, incoming)) return current;
  return null;
}

export function byteLength(bytes: Uint8Array | null): number {
  return bytes?.length ?? 0;
}

export function addSize(size: number, addition: number, limit: number): number {
  const next = checkedSum([size, addition], "output");
  if (next > limit) throw tooBig("text merge output", limit);
  return next;
}

export function checkedSum(values: number[], resource: string): number {
  let sum = 0;
  for (const value of values) {
    sum += value;
    if (!Number.isSafeInteger(sum))
      throw new GitError("E2BIG", `text merge ${resource} exceeds safe capacity`);
  }
  return sum;
}

export function safeProduct(left: number, right: number, resource: string): number {
  const product = left * right;
  if (!Number.isSafeInteger(product))
    throw new GitError("E2BIG", `text merge ${resource} exceeds safe capacity`);
  return product;
}

export function tooBig(resource: string, limit: number): GitError {
  return new GitError("E2BIG", `${resource} exceeds ${limit}`);
}
