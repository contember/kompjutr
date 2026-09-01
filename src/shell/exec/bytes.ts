// Commands work on bytes, not strings.
//
// A pipeline that decodes to UTF-8 at every stage corrupts binary content
// and pays two copies per stage. Decoding happens once, at the boundary, and
// only when the caller asked for text. A stream is therefore a generator of
// chunks — not of lines — so `cat` can forward a file unchanged and a file
// with no trailing newline does not grow one on the way through.

import type { RetainedBudget } from "./context.js";

/** A stage's output. Producers may be synchronous or asynchronous. */
export type ByteStream =
  | IterableIterator<Uint8Array, void, undefined>
  | AsyncIterableIterator<Uint8Array, void, undefined>;

const UNUSED_RESTORERS = new WeakMap<ByteStream, (bytes: Uint8Array) => void>();

/** Attach a private pushback seam used by a run-owned stdin borrow. */
export function withUnusedRestorer(
  stream: ByteStream,
  restore: (bytes: Uint8Array) => void,
): ByteStream {
  UNUSED_RESTORERS.set(stream, restore);
  return stream;
}

/** Return a suffix when a consumer stops inside one chunk. */
export function restoreUnused(stream: ByteStream, bytes: Uint8Array): void {
  if (bytes.length === 0) return;
  UNUSED_RESTORERS.get(stream)?.(bytes);
}

export function isAsyncByteStream(
  stream: ByteStream,
): stream is AsyncIterableIterator<Uint8Array, void, undefined> {
  return Symbol.asyncIterator in stream;
}

export async function close(stream: ByteStream | null): Promise<void> {
  if (stream?.return !== undefined) await stream.return();
}

/** Release owned resources on completion, rejection, or an unstarted close. */
export function owned(stream: ByteStream, release: () => void): ByteStream {
  return new OwnedByteStream(stream, release);
}

class OwnedByteStream implements AsyncIterableIterator<Uint8Array, void, undefined> {
  #closed = false;

  constructor(
    private readonly source: ByteStream,
    private readonly release: () => void,
  ) {}

  [Symbol.asyncIterator](): AsyncIterableIterator<Uint8Array, void, undefined> {
    return this;
  }

  async next(..._args: [] | [undefined]): Promise<IteratorResult<Uint8Array, void>> {
    if (this.#closed) return { done: true, value: undefined };
    try {
      const next = await this.source.next();
      if (next.done) await this.#finish(false);
      return next;
    } catch (error) {
      await this.#finish(true);
      throw error;
    }
  }

  async return(_value?: undefined): Promise<IteratorResult<Uint8Array, void>> {
    await this.#finish(true);
    return { done: true, value: undefined };
  }

  async throw(error: unknown): Promise<IteratorResult<Uint8Array, void>> {
    await this.#finish(true);
    throw error;
  }

  async #finish(closeSource: boolean): Promise<void> {
    if (this.#closed) return;
    this.#closed = true;
    try {
      if (closeSource) await close(this.source);
    } finally {
      this.release();
    }
  }
}

export const NEWLINE = 0x0a;

const ENCODER = new TextEncoder();
const DECODER = new TextDecoder();

export function encode(text: string): Uint8Array {
  return ENCODER.encode(text);
}

export function decode(bytes: Uint8Array): string {
  return DECODER.decode(bytes);
}

export function concat(chunks: readonly Uint8Array[]): Uint8Array {
  let total = 0;
  for (const chunk of chunks) total += chunk.length;
  const out = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    out.set(chunk, offset);
    offset += chunk.length;
  }
  return out;
}

/** Everything a stream produces, in one buffer. */
export async function drain(stream: ByteStream): Promise<Uint8Array> {
  const chunks: Uint8Array[] = [];
  for await (const chunk of stream) chunks.push(chunk);
  return concat(chunks);
}

export interface HeldBytes {
  readonly bytes: Uint8Array;
  release(): void;
}

/** Drain semantic input under the shared retained-memory ceiling. */
export async function drainBounded(
  stream: ByteStream,
  budget: RetainedBudget,
  label: string,
): Promise<HeldBytes> {
  const chunks: Uint8Array[] = [];
  const releases: Array<() => void> = [];
  try {
    for await (const chunk of stream) {
      releases.push(budget.retain(chunk.length, label));
      chunks.push(chunk);
    }
    if (chunks.length === 1) {
      const only = chunks[0];
      if (only === undefined) throw new Error("drainBounded: missing retained chunk");
      return {
        bytes: only,
        release: idempotent(() => {
          for (const release of releases) release();
        }),
      };
    }
    let total = 0;
    for (const chunk of chunks) total += chunk.length;
    const releaseJoined = budget.retain(total, `${label} join`);
    try {
      const bytes = concat(chunks);
      for (const release of releases) release();
      return {
        bytes,
        release: releaseJoined,
      };
    } catch (error) {
      releaseJoined();
      throw error;
    }
  } catch (error) {
    for (const release of releases) release();
    throw error;
  }
}

function idempotent(release: () => void): () => void {
  let released = false;
  return () => {
    if (released) return;
    released = true;
    release();
  };
}

/**
 * Split a chunk stream into lines, newline excluded.
 *
 * A trailing fragment with no newline is still a line — `printf 'a\nb'` has
 * two — and `sawTrailingNewline` records which it was, so a stage can put
 * the file back the way it found it.
 */
export async function* lines(
  stream: ByteStream,
  budget?: RetainedBudget,
): AsyncGenerator<Uint8Array, void, undefined> {
  let carry: Uint8Array | null = null;
  let releaseCarry: (() => void) | null = null;
  try {
    for await (const chunk of stream) {
      let start = 0;
      for (let index = 0; index < chunk.length; index++) {
        if (chunk[index] !== NEWLINE) continue;
        const slice = chunk.subarray(start, index);
        if (carry === null) {
          const releaseLine = budget?.retain(slice.length, "line") ?? (() => {});
          try {
            yield slice;
          } finally {
            releaseLine();
          }
        } else {
          const joinedLength = carry.length + slice.length;
          const releaseJoined = budget?.retain(joinedLength, "line carry") ?? (() => {});
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
        start = index + 1;
      }
      if (start < chunk.length) {
        const rest = chunk.subarray(start);
        const nextLength = (carry?.length ?? 0) + rest.length;
        const releaseNext = budget?.retain(nextLength, "line carry") ?? (() => {});
        const next: Uint8Array = carry === null ? rest.slice() : concat([carry, rest]);
        releaseCarry?.();
        carry = next;
        releaseCarry = releaseNext;
      }
    }
    if (carry !== null && carry.length > 0) {
      try {
        yield carry;
      } finally {
        releaseCarry?.();
        releaseCarry = null;
        carry = null;
      }
    }
  } finally {
    releaseCarry?.();
  }
}

/** Re-join lines, each terminated. The inverse of `lines` for text input. */
export async function* terminated(
  source: Iterable<Uint8Array> | AsyncIterable<Uint8Array>,
): AsyncGenerator<Uint8Array, void, undefined> {
  for await (const line of source) {
    const out = new Uint8Array(line.length + 1);
    out.set(line, 0);
    out[line.length] = NEWLINE;
    yield out;
  }
}

/** One line of text, terminated. The common case for a command's own output. */
export function line(text: string): Uint8Array {
  return encode(`${text}\n`);
}

export function* one(bytes: Uint8Array): ByteStream {
  if (bytes.length > 0) yield bytes;
}

export function* empty(): ByteStream {
  // Nothing.
}

export function equals(left: Uint8Array, right: Uint8Array): boolean {
  if (left.length !== right.length) return false;
  for (let index = 0; index < left.length; index++) {
    if (left[index] !== right[index]) return false;
  }
  return true;
}

/**
 * Where a buffer first looks binary, or -1.
 *
 * A NUL byte anywhere makes the file binary, not one in a leading window:
 * both real greps report a NUL that appears well past any prefix they might
 * have sniffed, and rg prints the offset. The buffer is already in memory,
 * so scanning all of it costs no I/O.
 */
export function firstNul(bytes: Uint8Array): number {
  for (let index = 0; index < bytes.length; index++) {
    if (bytes[index] === 0) return index;
  }
  return -1;
}
