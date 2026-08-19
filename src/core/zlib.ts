// Every deflate/inflate in the package goes through here.
//
// `node:zlib` is native and several times quicker than a JS port, so it
// serves every case where the output is small enough to hold. pako covers
// the one case it cannot: an object too large to materialise, where the
// bytes have to be consumed incrementally and the caller still needs to
// know where the compressed stream ended.

import * as zlib from "node:zlib";

import pako from "pako";

/** Output chunk for the streaming inflater. See the note in InflateStream. */
const INFLATE_CHUNK = 16 * 1024;

function asBytes(buffer: Uint8Array): Uint8Array {
  return buffer.constructor === Uint8Array
    ? buffer
    : new Uint8Array(buffer.buffer, buffer.byteOffset, buffer.byteLength);
}

function isTruncated(error: unknown): boolean {
  return (
    typeof error === "object" && error !== null && "code" in error && error.code === "Z_BUF_ERROR"
  );
}

/**
 * Unpack `{ info: true }`'s result. @types/node declares the plain
 * `Buffer` return only, so the shape is checked rather than asserted.
 */
function readInfoResult(result: unknown): { data: Uint8Array; consumed: number } {
  if (
    typeof result !== "object" ||
    result === null ||
    !("buffer" in result) ||
    !("engine" in result)
  ) {
    throw new Error("node:zlib did not return an info result");
  }
  const { buffer, engine } = result;
  if (!(buffer instanceof Uint8Array)) throw new Error("node:zlib info result has no buffer");
  if (
    typeof engine !== "object" ||
    engine === null ||
    !("bytesWritten" in engine) ||
    typeof engine.bytesWritten !== "number"
  ) {
    throw new Error("node:zlib info result has no bytesWritten");
  }
  return { data: asBytes(buffer), consumed: engine.bytesWritten };
}

export function deflate(data: Uint8Array): Uint8Array {
  return asBytes(zlib.deflateSync(data));
}

/** Inflate a buffer that holds exactly one zlib stream. */
export function inflate(data: Uint8Array): Uint8Array {
  return asBytes(zlib.inflateSync(data));
}

/**
 * Inflate the zlib stream at the start of `input`, ignoring whatever
 * follows it. Returns `null` when `input` stops mid-stream — the caller
 * should widen the window and retry. Any other malformed input throws.
 */
export function inflatePrefix(input: Uint8Array): { data: Uint8Array; consumed: number } | null {
  try {
    const result: unknown = zlib.inflateSync(input, { info: true });
    return readInfoResult(result);
  } catch (error) {
    if (isTruncated(error)) return null;
    throw error;
  }
}

/**
 * Incremental inflate for objects too large to hold in memory. Output
 * arrives through `onData` and is not retained; `push` reports how much of
 * the pushed input the stream used, which is how a pack scan finds the
 * next entry.
 */
export class InflateStream {
  readonly #inflate: pako.Inflate;
  #inflated = 0;

  constructor(onData: (chunk: Uint8Array) => void) {
    // pako's default 64 KiB output chunk is large enough that V8 keeps each
    // inflate's backing store in its array-buffer arena, so arena use grows
    // with the number of live streams rather than with the working set.
    // dgit measured a 53 MB pack peaking near 250 MB of buffers this way.
    // Only oversized entries stream here, so our exposure is far smaller —
    // but a tighter chunk costs nothing and keeps the bound honest.
    this.#inflate = new pako.Inflate({ chunkSize: INFLATE_CHUNK });
    this.#inflate.onData = (chunk) => {
      if (!(chunk instanceof Uint8Array)) throw new Error("inflate produced a non-binary chunk");
      this.#inflated += chunk.length;
      onData(chunk);
    };
  }

  get ended(): boolean {
    return this.#inflate.ended;
  }

  /** Total bytes produced so far. */
  get inflated(): number {
    return this.#inflated;
  }

  /** Feed compressed bytes; returns how many of them were consumed. */
  push(chunk: Uint8Array): number {
    if (this.#inflate.ended) return 0;
    this.#inflate.push(chunk, false);
    if (this.#inflate.err) throw new Error(`inflate failed: ${this.#inflate.msg}`);
    return this.#inflate.ended ? chunk.length - this.#inflate.strm.avail_in : chunk.length;
  }
}
