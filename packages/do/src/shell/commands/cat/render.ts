// `cat`'s display options as one state machine over the concatenated input.
// The state crosses chunk and file boundaries, as it does in cat: line
// numbers keep counting into the next file, a squeezed blank run can span
// two files, and a `\r` held at a chunk end still meets its `\n`.

import { NEWLINE } from "../../exec/bytes.js";

export interface RenderOptions {
  readonly number: "none" | "all" | "nonblank";
  readonly squeeze: boolean;
  readonly showEnds: boolean;
  readonly showTabs: boolean;
  readonly showNonprinting: boolean;
}

const TAB = 0x09;
const CARRIAGE_RETURN = 0x0d;
const CARET = 0x5e;
const DOLLAR = 0x24;
const DELETE = 0x7f;

export class CatRenderer {
  #atLineStart = true;
  #blankRun = 0;
  #line = 0;
  #heldCarriageReturn = false;
  #out = new Uint8Array(0);
  #length = 0;

  constructor(private readonly options: RenderOptions) {}

  push(chunk: Uint8Array): Uint8Array {
    this.#reset(chunk.length * 4 + 64);
    for (const byte of chunk) this.#byte(byte);
    return this.#take();
  }

  finish(): Uint8Array {
    this.#reset(1);
    if (this.#heldCarriageReturn) this.#emit(CARRIAGE_RETURN);
    this.#heldCarriageReturn = false;
    return this.#take();
  }

  #byte(byte: number): void {
    const options = this.options;
    if (this.#heldCarriageReturn) {
      this.#heldCarriageReturn = false;
      if (byte === NEWLINE) {
        this.#emit(CARET, 0x4d);
        this.#endLine();
        return;
      }
      this.#emit(CARRIAGE_RETURN);
    }
    if (this.#atLineStart) {
      if (byte === NEWLINE) {
        this.#blankRun++;
        if (options.squeeze && this.#blankRun > 1) return;
        if (options.number === "all") this.#number();
        this.#endLine();
        return;
      }
      this.#blankRun = 0;
      if (options.number !== "none") this.#number();
      this.#atLineStart = false;
    }
    if (byte === NEWLINE) {
      this.#endLine();
      return;
    }
    if (byte === CARRIAGE_RETURN && options.showEnds && !options.showNonprinting) {
      // cat -E shows a CRLF ending as `^M$` even without -v.
      this.#heldCarriageReturn = true;
      return;
    }
    if (byte === TAB) {
      if (options.showTabs) this.#emit(CARET, 0x49);
      else this.#emit(TAB);
      return;
    }
    if (!options.showNonprinting) {
      this.#emit(byte);
      return;
    }
    let low = byte;
    if (low >= 0x80) {
      this.#emit(0x4d, 0x2d);
      low -= 0x80;
    }
    if (low < 0x20) this.#emit(CARET, low + 0x40);
    else if (low === DELETE) this.#emit(CARET, 0x3f);
    else this.#emit(low);
  }

  #endLine(): void {
    if (this.options.showEnds) this.#emit(DOLLAR);
    this.#emit(NEWLINE);
    this.#atLineStart = true;
  }

  #number(): void {
    this.#line++;
    const label = `${String(this.#line).padStart(6)}\t`;
    for (let index = 0; index < label.length; index++) this.#emit(label.charCodeAt(index));
  }

  #reset(capacity: number): void {
    this.#out = new Uint8Array(capacity);
    this.#length = 0;
  }

  #emit(first: number, second?: number): void {
    if (this.#length + 2 > this.#out.length) {
      const grown = new Uint8Array(this.#out.length * 2 + 2);
      grown.set(this.#out.subarray(0, this.#length));
      this.#out = grown;
    }
    this.#out[this.#length++] = first;
    if (second !== undefined) this.#out[this.#length++] = second;
  }

  #take(): Uint8Array {
    const out = this.#out.subarray(0, this.#length);
    this.#out = new Uint8Array(0);
    this.#length = 0;
    return out;
  }
}
