// A pull reader over an async byte source. Everything the wire protocol
// needs is framed in pkt-lines, which are at most 65524 bytes, so the
// reader never holds more than one frame plus whatever the source handed
// over last.

import { concat, utf8Decoder } from "../bytes.js";
import { CorruptError } from "../errors.js";

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
  #buffer: Uint8Array = new Uint8Array(0);
  #done = false;

  constructor(source: AsyncIterable<Uint8Array>) {
    this.#source = source[Symbol.asyncIterator]();
  }

  async #fill(): Promise<boolean> {
    if (this.#done) return false;
    const next = await this.#source.next();
    if (next.done === true) {
      this.#done = true;
      return false;
    }
    const value = next.value;
    if (value.length === 0) return this.#fill();
    this.#buffer = this.#buffer.length === 0 ? value : concat([this.#buffer, value]);
    return true;
  }

  async #ensure(length: number): Promise<boolean> {
    while (this.#buffer.length < length) {
      if (!(await this.#fill())) return false;
    }
    return true;
  }

  #take(length: number): Uint8Array {
    const out = this.#buffer.subarray(0, length);
    this.#buffer = this.#buffer.subarray(length);
    return out;
  }

  /** The next pkt-line, or null at end of stream. */
  async readPkt(): Promise<Pkt | null> {
    if (!(await this.#ensure(4))) {
      if (this.#buffer.length !== 0) throw new CorruptError("truncated pkt-line length");
      return null;
    }
    const length = parseLength(this.#buffer);
    if (length === 0) {
      this.#take(4);
      return { kind: "flush", payload: new Uint8Array(0) };
    }
    if (length === 1) {
      this.#take(4);
      return { kind: "delim", payload: new Uint8Array(0) };
    }
    if (length < 4) throw new CorruptError(`bad pkt-line length ${length}`);
    if (!(await this.#ensure(length))) throw new CorruptError("truncated pkt-line");
    const frame = this.#take(length);
    return { kind: "line", payload: frame.subarray(4) };
  }

  /** Everything not yet consumed, streamed on. */
  async *rest(): AsyncGenerator<Uint8Array> {
    if (this.#buffer.length > 0) {
      yield this.#buffer;
      this.#buffer = new Uint8Array(0);
    }
    for (;;) {
      const next = await this.#source.next();
      if (next.done === true) return;
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
