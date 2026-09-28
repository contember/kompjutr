// Split a stream into delimiter-terminated records, the delimiter excluded.
// `lines()` in exec/bytes.ts is this with a fixed newline; `sort -z` needs NUL.

import { type ByteStream, concat } from "../../exec/bytes.js";
import type { RetainedBudget } from "../../exec/context.js";

export async function* records(
  stream: ByteStream,
  delimiter: number,
  budget: RetainedBudget,
): AsyncGenerator<Uint8Array, void, undefined> {
  let carry: Uint8Array | null = null;
  let releaseCarry: (() => void) | null = null;
  try {
    for await (const chunk of stream) {
      let start = 0;
      for (let index = 0; index < chunk.length; index++) {
        if (chunk[index] !== delimiter) continue;
        const slice = chunk.subarray(start, index);
        start = index + 1;
        if (carry === null) {
          yield slice;
          continue;
        }
        const releaseJoined = budget.retain(carry.length + slice.length, "record carry");
        const joined = concat([carry, slice]);
        releaseCarry?.();
        carry = null;
        releaseCarry = null;
        try {
          yield joined;
        } finally {
          releaseJoined();
        }
      }
      if (start < chunk.length) {
        const rest = chunk.subarray(start);
        const releaseNext = budget.retain((carry?.length ?? 0) + rest.length, "record carry");
        const next: Uint8Array = carry === null ? rest.slice() : concat([carry, rest]);
        releaseCarry?.();
        carry = next;
        releaseCarry = releaseNext;
      }
    }
    if (carry !== null && carry.length > 0) yield carry;
  } finally {
    releaseCarry?.();
  }
}
