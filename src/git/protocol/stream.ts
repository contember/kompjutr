// Derived from dgit (MIT, Copyright (c) 2026 Divy Srivastava),
// https://github.com/littledivy/dgit — the strict four-byte length parser is adapted from dgit's src/git/pktline.ts.
//
// A pull reader over an async byte source. Everything the wire protocol
// needs is framed in pkt-lines, which are at most 65,520 bytes, so the
// reader never holds more than one frame plus whatever the source handed
// over last.

import { utf8Decoder } from "../common/bytes.js";
import { CorruptError, GitError } from "../common/errors.js";
import { MAX_PKT_FRAME_BYTES } from "./pktline.js";

export { MAX_PKT_FRAME_BYTES } from "./pktline.js";

const EMPTY = new Uint8Array(0);

export type PktKind = "line" | "flush" | "delim";

export interface Pkt {
  kind: PktKind;
  payload: Uint8Array;
}

export function abortedError(signal: AbortSignal): GitError {
  return new GitError("EABORTED", "network operation aborted", { cause: signal.reason });
}

export function throwIfAborted(signal: AbortSignal | undefined): void {
  if (signal?.aborted === true) throw abortedError(signal);
}

export async function abortable<T>(
  operation: PromiseLike<T>,
  signal: AbortSignal | undefined,
): Promise<T> {
  throwIfAborted(signal);
  if (signal === undefined) return await operation;
  return await new Promise<T>((resolve, reject) => {
    const abort = (): void => reject(abortedError(signal));
    signal.addEventListener("abort", abort, { once: true });
    Promise.resolve(operation).then(resolve, reject).finally(() => {
      signal.removeEventListener("abort", abort);
    });
  });
}

export function pktText(pkt: Pkt): string {
  const text = utf8Decoder.decode(pkt.payload);
  return text.endsWith("\n") ? text.slice(0, -1) : text;
}

export class ByteReader {
  readonly #source: AsyncIterator<Uint8Array>;
  readonly #signal: AbortSignal | undefined;
  #chunk: Uint8Array = EMPTY;
  #offset = 0;
  #done = false;
  #releasePromise: Promise<void> | null = null;

  constructor(source: AsyncIterable<Uint8Array>, signal?: AbortSignal) {
    this.#source = source[Symbol.asyncIterator]();
    this.#signal = signal;
  }

  /** Finalize the source once and release the current parse frame. */
  release(): Promise<void> {
    if (this.#releasePromise !== null) return this.#releasePromise;
    this.#releasePromise = Promise.resolve()
      .then(async () => {
        await this.#source.return?.();
      })
      .finally(() => {
        this.#chunk = EMPTY;
        this.#offset = 0;
        this.#done = true;
      });
    return this.#releasePromise;
  }

  async #advance(): Promise<boolean> {
    while (!this.#done) {
      const next = await abortable(this.#source.next(), this.#signal);
      if (next.done === true) {
        this.#done = true;
        return false;
      }
      if (next.value.length === 0) continue;
      this.#chunk = next.value;
      this.#offset = 0;
      return true;
    }
    return false;
  }

  async #takeExact(length: number): Promise<Uint8Array | null> {
    if (length === 0) return EMPTY;
    if (this.#offset === this.#chunk.length && !(await this.#advance())) return null;

    const available = this.#chunk.length - this.#offset;
    if (available >= length) {
      const bytes = this.#chunk.subarray(this.#offset, this.#offset + length);
      this.#offset += length;
      return bytes;
    }

    // A frame crossing source chunks owns only the exact bytes it needs.
    const out = new Uint8Array(length);
    let written = 0;
    while (written < length) {
      const remaining = this.#chunk.length - this.#offset;
      if (remaining > 0) {
        const take = Math.min(remaining, length - written);
        out.set(this.#chunk.subarray(this.#offset, this.#offset + take), written);
        this.#offset += take;
        written += take;
      }
      if (written < length && !(await this.#advance())) {
        throw new CorruptError("truncated pkt-line");
      }
    }
    return out;
  }

  /** The next pkt-line, or null at end of stream. */
  async readPkt(): Promise<Pkt | null> {
    try {
      throwIfAborted(this.#signal);
      let header: Uint8Array | null;
      try {
        header = await this.#takeExact(4);
      } catch (error) {
        if (error instanceof CorruptError) throw new CorruptError("truncated pkt-line length");
        throw error;
      }
      if (header === null) {
        await this.release();
        return null;
      }
      const length = parseLength(header);
      if (length === 0) {
        return { kind: "flush", payload: EMPTY };
      }
      if (length === 1) {
        return { kind: "delim", payload: EMPTY };
      }
      if (length < 4) throw new CorruptError(`bad pkt-line length ${length}`);
      if (length > MAX_PKT_FRAME_BYTES) {
        throw new CorruptError(`pkt-line exceeds ${MAX_PKT_FRAME_BYTES} bytes`);
      }
      const payload = await this.#takeExact(length - 4);
      if (payload === null) throw new CorruptError("truncated pkt-line");
      return { kind: "line", payload };
    } catch (error) {
      try {
        await this.release();
      } catch {
        // Preserve the protocol/source failure after cleanup.
      }
      throw error;
    }
  }

  /** Everything not yet consumed, streamed on. */
  async *rest(): AsyncGenerator<Uint8Array> {
    try {
      throwIfAborted(this.#signal);
      if (this.#offset < this.#chunk.length) {
        yield this.#chunk.subarray(this.#offset);
        this.#offset = this.#chunk.length;
      }
      while (await this.#advance()) {
        const chunk = this.#chunk;
        this.#offset = chunk.length;
        yield chunk;
      }
    } finally {
      await this.release();
    }
  }
}

/**
 * Strict four-byte hex. `parseInt` is too lenient for framing a remote's
 * bytes: it accepts leading spaces and stops at the first non-digit, so a
 * malformed length would silently desync the stream.
 */
function parseLength(buffer: Uint8Array): number {
  let value = 0;
  for (let i = 0; i < 4; i++) {
    const char = buffer[i]!;
    let digit: number;
    if (char >= 0x30 && char <= 0x39) digit = char - 0x30;
    else if (char >= 0x61 && char <= 0x66) digit = char - 0x57;
    else if (char >= 0x41 && char <= 0x46) digit = char - 0x37;
    else throw new CorruptError("bad pkt-line length");
    value = (value << 4) | digit;
  }
  return value;
}
