// jq's input side (jq_util_input_* in src/util.c). Files are read in fgets
// chunks — up to 4095 bytes, ending at a newline — and one parser runs across
// all of them, so a value may span files. The line counter counts chunks that
// hold a newline; with the file name it is the position jq prints in
// `jq: error (at file:N)`, so the chunking is reproduced exactly.

import type { ByteStream } from "../../exec/bytes.js";
import type { CommandContext } from "../../exec/context.js";
import { resolve } from "../../exec/execute.js";
import { streamFile } from "../read.js";
import { JsonParser } from "./json-parse.js";
import { deepSize } from "./runtime.js";
import type { JqValue } from "./value.js";

const CHUNK = 4095;
const NEWLINE = 0x0a;
const EMPTY = new Uint8Array(0);
const DECODER = new TextDecoder();

export type InputStep =
  | { readonly kind: "value"; readonly value: JqValue; readonly release: () => void }
  | { readonly kind: "error"; readonly message: string }
  | { readonly kind: "end" };

interface Provider {
  readonly operand: string;
  readonly failure: string | null;
  readonly stream: ByteStream | null;
  pending: Uint8Array;
  done: boolean;
  release: (() => void) | null;
}

type Pull = { readonly bytes: Uint8Array; readonly last: boolean } | null;

export class InputReader {
  failures = 0;
  filename: JqValue = null;
  line = 0;
  readonly #parser = new JsonParser();
  readonly #operands: readonly string[];
  readonly #providers: Provider[] = [];
  #current = -1;
  #held: Array<() => void> = [];
  #slurped: JqValue[] | null;
  #rawSlurp: Uint8Array[] | null;
  #rawLine: Uint8Array[] | null = null;
  #finished = false;

  constructor(
    private readonly context: CommandContext,
    operands: readonly string[],
    private readonly raw: boolean,
    slurp: boolean,
  ) {
    this.#operands = operands.length === 0 ? ["-"] : operands;
    this.#slurped = slurp && !raw ? [] : null;
    this.#rawSlurp = slurp && raw ? [] : null;
  }

  /** "file:line", or "<unknown>" before any input was opened. */
  get position(): string {
    return typeof this.filename === "string" ? `${this.filename}:${this.line}` : "<unknown>";
  }

  async next(): Promise<InputStep> {
    for (;;) {
      const step = this.poll();
      if (step !== undefined) return step;
      await this.#fill(this.#provider(Math.max(this.#current, 0)));
    }
  }

  /** Reads every remaining byte now, so that `poll` never waits (for `input`). */
  async preload(): Promise<void> {
    for (let index = Math.max(this.#current, 0); index < this.#operands.length; index++) {
      const provider = this.#provider(index);
      while (!provider.done) await this.#fill(provider);
    }
  }

  /** One step of jq_util_input_next_input; undefined means bytes must be pulled first. */
  poll(): InputStep | undefined {
    if (this.#finished) return { kind: "end" };
    for (;;) {
      if (this.raw) {
        const pulled = this.#pull();
        if (pulled === null) return undefined;
        const line = this.#rawChunk(pulled.bytes);
        if (line !== null) return line;
        if (pulled.last) return this.#finish();
        continue;
      }
      if (this.#parser.remaining === 0) {
        const pulled = this.#pull();
        if (pulled === null) return undefined;
        this.#hold(pulled.bytes.length);
        this.#parser.feed(pulled.bytes, pulled.last);
      }
      const step = this.#parser.next();
      if (step.kind === "error") return step;
      if (step.kind === "end") return this.#finish();
      if (step.kind === "value") {
        if (this.#slurped === null) return this.#value(step.value);
        this.#slurped.push(step.value);
      }
    }
  }

  #hold(bytes: number): void {
    this.#held.push(this.context.fs.retained.retain(bytes, "jq input"));
  }

  #handOver(): () => void {
    const held = this.#held;
    this.#held = [];
    return () => {
      for (const release of held) release();
    };
  }

  /** Hands a parsed value over, reserving an estimate of its parsed size instead of its bytes. */
  #value(value: JqValue): InputStep {
    this.#handOver()();
    const release = this.context.fs.retained.retain(deepSize(value), "jq input value");
    return { kind: "value", value, release };
  }

  #finish(): InputStep {
    this.#finished = true;
    if (this.#slurped !== null) return this.#value(this.#slurped);
    if (this.#rawSlurp !== null) {
      return this.#value(DECODER.decode(join(this.#rawSlurp)));
    }
    if (this.#rawLine !== null) {
      return this.#value(DECODER.decode(join(this.#rawLine)));
    }
    this.#handOver()();
    return { kind: "end" };
  }

  #rawChunk(bytes: Uint8Array): InputStep | null {
    if (bytes.length === 0) return null;
    this.#hold(bytes.length * 2);
    if (this.#rawSlurp !== null) {
      this.#rawSlurp.push(bytes.slice());
      return null;
    }
    const parts = this.#rawLine ?? [];
    if (bytes[bytes.length - 1] !== NEWLINE) {
      parts.push(bytes.slice());
      this.#rawLine = parts;
      return null;
    }
    parts.push(bytes.subarray(0, bytes.length - 1));
    this.#rawLine = null;
    return this.#value(DECODER.decode(join(parts)));
  }

  /** jq_util_input_read_more: one fgets chunk, moving to the next file at EOF. */
  #pull(): Pull {
    for (;;) {
      const provider = this.#current >= 0 ? this.#providers[this.#current] : undefined;
      if (provider !== undefined && provider.failure === null) {
        const chunk = takeChunk(provider);
        if (chunk !== null) {
          if (chunk.includes(NEWLINE)) this.line++;
          return { bytes: chunk, last: false };
        }
        if (!provider.done) return null;
      }
      if (this.#current + 1 >= this.#operands.length) {
        if (provider !== undefined) this.#current = this.#operands.length;
        return { bytes: EMPTY, last: true };
      }
      this.#open(this.#provider(++this.#current));
    }
  }

  #open(provider: Provider): void {
    this.line = 0;
    this.filename = provider.operand === "-" ? "<stdin>" : provider.operand;
    if (provider.failure === null) return;
    this.context.diagnostic(new TextEncoder().encode(provider.failure));
    this.failures++;
  }

  #provider(index: number): Provider {
    const existing = this.#providers[index];
    if (existing !== undefined) return existing;
    const operand = this.#operands[index] ?? "-";
    let stream: ByteStream | null = null;
    let failure: string | null = null;
    if (operand === "-") stream = this.context.stdin;
    else {
      const path = resolve(this.context.cwd, operand);
      const stat = this.context.fs.statTarget(path);
      if (stat === null)
        failure = `jq: error: Could not open file ${operand}: No such file or directory\n`;
      else if (stat.type === "dir") failure = "jq: error: Is a directory\n";
      else stream = streamFile(this.context, path, stat.size, "jq input file");
    }
    const provider: Provider = {
      operand,
      failure,
      stream,
      pending: EMPTY,
      done: stream === null,
      release: null,
    };
    this.#providers[index] = provider;
    return provider;
  }

  async #fill(provider: Provider): Promise<void> {
    if (provider.done || provider.stream === null) {
      provider.done = true;
      return;
    }
    const step = await provider.stream.next();
    if (step.done === true) {
      provider.done = true;
      return;
    }
    const joined = join([provider.pending, step.value]);
    provider.release?.();
    provider.release = this.context.fs.retained.retain(joined.length, "jq input buffer");
    provider.pending = joined;
  }
}

/** The next fgets chunk of a provider, or null when more bytes are needed. */
function takeChunk(provider: Provider): Uint8Array | null {
  const pending = provider.pending;
  const window = Math.min(pending.length, CHUNK);
  const newline = pending.subarray(0, window).indexOf(NEWLINE);
  let size: number;
  if (newline !== -1) size = newline + 1;
  else if (pending.length >= CHUNK || (provider.done && pending.length > 0)) size = window;
  else return null;
  const chunk = pending.subarray(0, size);
  provider.pending = pending.subarray(size);
  if (provider.pending.length === 0) {
    provider.release?.();
    provider.release = null;
  }
  return chunk;
}

function join(parts: readonly Uint8Array[]): Uint8Array {
  if (parts.length === 1) return parts[0] ?? EMPTY;
  let total = 0;
  for (const part of parts) total += part.length;
  const out = new Uint8Array(total);
  let offset = 0;
  for (const part of parts) {
    out.set(part, offset);
    offset += part.length;
  }
  return out;
}
