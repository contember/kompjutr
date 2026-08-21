// Commands work on bytes, not strings.
//
// A pipeline that decodes to UTF-8 at every stage corrupts binary content
// and pays two copies per stage. Decoding happens once, at the boundary, and
// only when the caller asked for text. A stream is therefore a generator of
// chunks — not of lines — so `cat` can forward a file unchanged and a file
// with no trailing newline does not grow one on the way through.

/** A stage's output. Sync because the whole filesystem API is sync. */
export type ByteStream = Generator<Uint8Array, void, undefined>;

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
export function drain(stream: ByteStream): Uint8Array {
  return concat([...stream]);
}

/**
 * Split a chunk stream into lines, newline excluded.
 *
 * A trailing fragment with no newline is still a line — `printf 'a\nb'` has
 * two — and `sawTrailingNewline` records which it was, so a stage can put
 * the file back the way it found it.
 */
export function* lines(stream: ByteStream): Generator<Uint8Array, void, undefined> {
  let carry: Uint8Array | null = null;
  for (const chunk of stream) {
    let start = 0;
    for (let index = 0; index < chunk.length; index++) {
      if (chunk[index] !== NEWLINE) continue;
      const slice = chunk.subarray(start, index);
      yield carry === null ? slice : concat([carry, slice]);
      carry = null;
      start = index + 1;
    }
    if (start < chunk.length) {
      const rest = chunk.subarray(start);
      carry = carry === null ? rest.slice() : concat([carry, rest]);
    }
  }
  if (carry !== null && carry.length > 0) yield carry;
}

/** Re-join lines, each terminated. The inverse of `lines` for text input. */
export function* terminated(source: Iterable<Uint8Array>): Generator<Uint8Array, void, undefined> {
  for (const line of source) {
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
