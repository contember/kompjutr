// Derived from dgit (MIT, Copyright (c) 2026 Divy Srivastava),
// https://github.com/littledivy/dgit — the strict four-byte length parser is adapted from dgit's src/git/pktline.ts.
//
// A pull reader over an async byte source. Everything the wire protocol
// needs is framed in pkt-lines, which are at most 65,520 bytes, so the
// reader never holds more than one frame plus whatever the source handed
// over last.

import { utf8Decoder } from "../bytes.js";
import { CorruptError } from "../errors.js";
import type { TransportOperationBudget } from "../ops/transport-budget.js";
import { MAX_PKT_FRAME_BYTES } from "./pktline.js";

export { MAX_PKT_FRAME_BYTES } from "./pktline.js";

const READER_FIXED_BYTES = 128;
const EMPTY = new Uint8Array(0);

export type PktKind = "line" | "flush" | "delim";

export interface Pkt {
  kind: PktKind;
  payload: Uint8Array;
}

interface ExactRead {
  readonly bytes: Uint8Array;
  readonly ownedBytes: number;
}

export function pktText(pkt: Pkt): string {
  const text = utf8Decoder.decode(pkt.payload);
  return text.endsWith("\n") ? text.slice(0, -1) : text;
}

export class ByteReader {
  readonly #source: AsyncIterator<Uint8Array>;
  #chunk: Uint8Array = EMPTY;
  #offset = 0;
  #done = false;
  #frameMemoryBytes = 0;
  readonly #operationBase: number;
  #releasePromise: Promise<void> | null = null;

  constructor(
    source: AsyncIterable<Uint8Array>,
    private readonly operationBudget?: TransportOperationBudget,
    private readonly memoryPart = "protocol-pkt-reader",
  ) {
    this.#source = source[Symbol.asyncIterator]();
    this.#operationBase = operationBudget?.memory(memoryPart) ?? 0;
  }

  /** Finalize the source once and release the current parse frame. */
  release(): Promise<void> {
    if (this.#releasePromise !== null) return this.#releasePromise;
    this.#releasePromise = Promise.resolve()
      .then(async () => {
        await this.#source.return?.();
      })
      .finally(() => {
        this.#setFrameMemory(0);
        this.#chunk = EMPTY;
        this.#offset = 0;
        this.#done = true;
      });
    return this.#releasePromise;
  }

  async #advance(): Promise<boolean> {
    while (!this.#done) {
      const next = await this.#source.next();
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

  async #takeExact(length: number, liveOwnedBytes: number): Promise<ExactRead | null> {
    if (length === 0) return { bytes: EMPTY, ownedBytes: 0 };
    if (this.#offset === this.#chunk.length && !(await this.#advance())) return null;

    const available = this.#chunk.length - this.#offset;
    if (available >= length) {
      this.#setFrameMemory(liveOwnedBytes, true);
      const bytes = this.#chunk.subarray(this.#offset, this.#offset + length);
      this.#offset += length;
      return { bytes, ownedBytes: 0 };
    }

    // A frame crossing source chunks owns only the exact bytes it needs.
    this.#setFrameMemory(liveOwnedBytes + length, true);
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
    return { bytes: out, ownedBytes: length };
  }

  /** The next pkt-line, or null at end of stream. */
  async readPkt(): Promise<Pkt | null> {
    try {
      this.#setFrameMemory(0, true);
      let header: ExactRead | null;
      try {
        header = await this.#takeExact(4, 0);
      } catch (error) {
        if (error instanceof CorruptError) throw new CorruptError("truncated pkt-line length");
        throw error;
      }
      if (header === null) {
        await this.release();
        return null;
      }
      const length = parseLength(header.bytes);
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
      const payload = await this.#takeExact(length - 4, header.ownedBytes);
      if (payload === null) throw new CorruptError("truncated pkt-line");
      this.#setFrameMemory(header.ownedBytes + payload.ownedBytes, true);
      return { kind: "line", payload: payload.bytes };
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
    this.#setFrameMemory(0);
    try {
      if (this.#offset < this.#chunk.length) {
        yield this.#chunk.subarray(this.#offset);
        this.#offset = this.#chunk.length;
      }
      for (;;) {
        const next = await this.#source.next();
        if (next.done === true) return;
        if (next.value.length > 0) yield next.value;
      }
    } finally {
      await this.release();
    }
  }

  #setFrameMemory(ownedBytes: number, retained = false): void {
    const bytes = retained ? READER_FIXED_BYTES + ownedBytes : ownedBytes;
    if (bytes === this.#frameMemoryBytes) return;
    this.operationBudget?.setMemory(this.memoryPart, this.#operationBase + bytes);
    this.#frameMemoryBytes = bytes;
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
