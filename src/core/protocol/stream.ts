// Derived from dgit (MIT, Copyright (c) 2026 Divy Srivastava),
// https://github.com/littledivy/dgit — the strict four-byte length parser is adapted from dgit's src/git/pktline.ts.
//
// A pull reader over an async byte source. Everything the wire protocol
// needs is framed in pkt-lines, which are at most 65,520 bytes, so the
// reader never holds more than one frame plus whatever the source handed
// over last.

import { utf8Decoder } from "../bytes.js";
import { CorruptError, GitError } from "../errors.js";

/** Caller-owned chunks may be larger; the reader rejects them before retention. */
export const MAX_PROTOCOL_SOURCE_CHUNK_BYTES = 1024 * 1024;

/** Four-byte prefix included. Git's pkt-line payload ceiling is 65,516 bytes. */
export const MAX_PKT_FRAME_BYTES = 65_520;

export type PktKind = "line" | "flush" | "delim";

export interface Pkt {
  kind: PktKind;
  payload: Uint8Array;
}

export function pktText(pkt: Pkt): string {
  const text = utf8Decoder.decode(pkt.payload);
  return text.endsWith("\n") ? text.slice(0, -1) : text;
}

export class ByteReader {
  readonly #source: AsyncIterator<Uint8Array>;
  #chunk: Uint8Array = new Uint8Array(0);
  #offset = 0;
  #done = false;

  constructor(source: AsyncIterable<Uint8Array>) {
    this.#source = source[Symbol.asyncIterator]();
  }

  async #advance(): Promise<boolean> {
    while (!this.#done) {
      const next = await this.#source.next();
      if (next.done === true) {
        this.#done = true;
        return false;
      }
      if (next.value.length > MAX_PROTOCOL_SOURCE_CHUNK_BYTES) {
        throw new GitError(
          "E2BIG",
          `protocol source chunk exceeds ${MAX_PROTOCOL_SOURCE_CHUNK_BYTES} bytes`,
        );
      }
      if (next.value.length === 0) continue;
      this.#chunk = next.value;
      this.#offset = 0;
      return true;
    }
    return false;
  }

  async #takeExact(length: number): Promise<Uint8Array | null> {
    if (length === 0) return new Uint8Array(0);
    if (this.#offset === this.#chunk.length && !(await this.#advance())) return null;

    const available = this.#chunk.length - this.#offset;
    if (available >= length) {
      const out = this.#chunk.subarray(this.#offset, this.#offset + length);
      this.#offset += length;
      return out;
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
    let header: Uint8Array | null;
    try {
      header = await this.#takeExact(4);
    } catch (error) {
      if (error instanceof CorruptError) throw new CorruptError("truncated pkt-line length");
      throw error;
    }
    if (header === null) return null;
    const length = parseLength(header);
    if (length === 0) {
      return { kind: "flush", payload: new Uint8Array(0) };
    }
    if (length === 1) {
      return { kind: "delim", payload: new Uint8Array(0) };
    }
    if (length < 4) throw new CorruptError(`bad pkt-line length ${length}`);
    if (length > MAX_PKT_FRAME_BYTES) {
      throw new CorruptError(`pkt-line exceeds ${MAX_PKT_FRAME_BYTES} bytes`);
    }
    const payload = await this.#takeExact(length - 4);
    if (payload === null) throw new CorruptError("truncated pkt-line");
    return { kind: "line", payload };
  }

  /** Everything not yet consumed, streamed on. */
  async *rest(): AsyncGenerator<Uint8Array> {
    if (this.#offset < this.#chunk.length) {
      yield this.#chunk.subarray(this.#offset);
      this.#offset = this.#chunk.length;
    }
    for (;;) {
      const next = await this.#source.next();
      if (next.done === true) return;
      if (next.value.length > MAX_PROTOCOL_SOURCE_CHUNK_BYTES) {
        throw new GitError(
          "E2BIG",
          `protocol source chunk exceeds ${MAX_PROTOCOL_SOURCE_CHUNK_BYTES} bytes`,
        );
      }
      if (next.value.length > 0) yield next.value;
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
