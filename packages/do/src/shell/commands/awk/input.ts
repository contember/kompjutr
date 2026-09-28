// The main input: ARGV operands read in order, re-read as the program changes them, split
// into records by RS. A record is found in the buffered text and returned;
// only when none is there yet is another chunk pulled, so input streams and
// only the unfinished record is retained.

import type { ByteStream } from "../../exec/bytes.js";
import type { RetainedBudget } from "../../exec/context.js";
import { bytesToText } from "./bytes.js";
import { AwkRuntimeError } from "./errors.js";
import { BUILTINS, KEYWORDS, processEscapes } from "./parse/tokens.js";
import type { Regex } from "./regex/regex.js";
import type { Runtime } from "./runtime.js";
import { byteLength, maybeNumber, toNumber, toText, type Value } from "./values.js";

type Separator =
  | { readonly kind: "char"; readonly char: string }
  | { readonly kind: "regex"; readonly regex: Regex; readonly paragraph: boolean };

function separatorOf(runtime: Runtime): Separator {
  const text = toText(runtime.special("RS"), runtime);
  if (text.length === 1) return { kind: "char", char: text };
  if (text.length === 0) return { kind: "regex", regex: runtime.regex("\n\n+"), paragraph: true };
  return { kind: "regex", regex: runtime.regex(text), paragraph: false };
}

class RecordSource {
  #buffer = "";
  #offset = 0;
  /** Bytes of this file before the buffer, which decides whether `^` can match. */
  #consumed = 0;
  #ended = false;
  #started = false;
  #release: () => void = () => {};

  constructor(
    private readonly stream: ByteStream,
    private readonly budget: RetainedBudget,
  ) {}

  async read(runtime: Runtime): Promise<string | null> {
    const separator = separatorOf(runtime);
    if (!this.#started) {
      this.#started = true;
      if (separator.kind === "regex" && separator.paragraph) await this.#skipLeadingNewlines();
    }
    for (;;) {
      const found = this.#find(separator);
      if (found !== null) {
        const record = this.#buffer.slice(this.#offset, found.start);
        this.#offset = found.end;
        return record;
      }
      if (!this.#ended) {
        await this.#fill();
        continue;
      }
      if (this.#offset >= this.#buffer.length) return null;
      let record = this.#buffer.slice(this.#offset);
      this.#offset = this.#buffer.length;
      if (separator.kind === "regex" && separator.paragraph && record.endsWith("\n")) {
        record = record.slice(0, -1);
      }
      return record;
    }
  }

  async close(): Promise<void> {
    this.#release();
    this.#release = () => {};
    this.#buffer = "";
    await this.stream.return?.();
  }

  async #skipLeadingNewlines(): Promise<void> {
    for (;;) {
      while (this.#offset < this.#buffer.length && this.#buffer.charAt(this.#offset) === "\n") {
        this.#offset++;
      }
      if (this.#offset < this.#buffer.length || this.#ended) return;
      await this.#fill();
    }
  }

  #find(separator: Separator): { start: number; end: number } | null {
    if (separator.kind === "char") {
      const at = this.#buffer.indexOf(separator.char, this.#offset);
      return at === -1 ? null : { start: at, end: at + 1 };
    }
    let position = this.#offset;
    while (position < this.#buffer.length) {
      const atStart = this.#consumed === 0 && position === 0;
      const { match, hitEnd } = separator.regex.search(
        this.#buffer,
        position,
        atStart,
        this.#ended,
      );
      if (hitEnd || match === null) return null;
      if (match.end > match.start) return match;
      position = match.start + 1;
    }
    return null;
  }

  async #fill(): Promise<void> {
    const next = await this.stream.next();
    if (next.done === true) {
      this.#ended = true;
      return;
    }
    const kept = this.#buffer.slice(this.#offset);
    this.#consumed += this.#offset;
    this.#release();
    this.#release = () => {};
    const release = this.budget.retain(kept.length + next.value.length, "awk input record");
    this.#buffer = kept + bytesToText(next.value);
    this.#offset = 0;
    this.#release = release;
  }
}

export interface InputSources {
  /** Open a named operand; throws the diagnostic mawk gives when it cannot. */
  open(name: string): ByteStream;
  readonly stdin: ByteStream | null;
}

export class MainInput {
  #index = 1;
  #source: RecordSource | null = null;
  #openedAny = false;
  /** How many inputs have been opened, so a caller can tell when a new one starts. */
  files = 0;

  constructor(
    private readonly runtime: Runtime,
    private readonly sources: InputSources,
  ) {}

  async next(): Promise<string | null> {
    for (;;) {
      if (this.#source === null && !this.#openNext()) return null;
      const source = this.#source;
      if (source === null) return null;
      const record = await source.read(this.runtime);
      if (record !== null) return record;
      await this.skipFile();
    }
  }

  async skipFile(): Promise<void> {
    const source = this.#source;
    this.#source = null;
    await source?.close();
  }

  #openNext(): boolean {
    const runtime = this.runtime;
    const argv = runtime.globalArray("ARGV");
    while (this.#index < toNumber(runtime.special("ARGC"))) {
      const entry = argv.find({ kind: "integer", value: this.#index }, false);
      this.#index++;
      if (entry === null) continue;
      const operand = toText(entry.value, runtime);
      if (operand === "") continue;
      if (this.#assign(operand)) continue;
      const stream = operand === "-" ? this.#stdin() : this.sources.open(operand);
      this.#start(stream, entry.value);
      return true;
    }
    if (this.#openedAny) return false;
    this.#start(this.#stdin(), "-");
    return true;
  }

  #stdin(): ByteStream {
    const stdin = this.sources.stdin;
    return stdin ?? (function* (): ByteStream {})();
  }

  #start(stream: ByteStream, name: Value): void {
    this.#openedAny = true;
    this.files++;
    this.runtime.setSpecial("FILENAME", name);
    this.runtime.setSpecial("FNR", 0);
    this.#source = new RecordSource(stream, this.runtime.budget);
  }

  /** A `name=value` operand is an assignment, applied when it is reached. */
  #assign(operand: string): boolean {
    return assignFromCommandLine(this.runtime, operand);
  }
}

const ASSIGNMENT = /^([A-Za-z_][A-Za-z0-9_]*)=/;

export function isAssignment(operand: string): boolean {
  return ASSIGNMENT.test(operand);
}

/** Apply `name=value` with escapes processed; false when the operand is not one. */
export function assignFromCommandLine(runtime: Runtime, operand: string): boolean {
  const match = ASSIGNMENT.exec(operand);
  const name = match?.[1];
  if (match === null || name === undefined) return false;
  const value = maybeNumber(processEscapes(operand.slice(match[0].length)));
  const special = runtime.specialName(name);
  if (special !== null) {
    runtime.setSpecial(special, value);
    return true;
  }
  const index = runtime.program.globals.findIndex((global) => global.name === name);
  const clash =
    KEYWORDS.has(name) ||
    BUILTINS.has(name) ||
    runtime.program.functions.has(name) ||
    runtime.arrays[index] != null;
  if (clash)
    throw new AwkRuntimeError(`cannot command line assign to ${name}\n\ttype clash or keyword`);
  if (index === -1) return true;
  runtime.memory.adjust(byteLength(value) - byteLength(runtime.globals[index] ?? null));
  runtime.globals[index] = value;
  return true;
}
