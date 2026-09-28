// The state a running awk program holds, and its retained-memory accounting.
//
// Variables and arrays grow with input (`{ a[NR] = $0 }`), so their bytes are
// reserved on the shell's retained budget as they grow: a program that would
// exhaust memory fails with the retained-memory limit instead. Output is
// buffered between flush points and reserved the same way.

import type { RetainedBudget } from "../../exec/context.js";
import { AwkArray, type Entry, type Subscript } from "./array.js";
import { textToBytes } from "./bytes.js";
import { AwkRuntimeError } from "./errors.js";
import { FieldState, type Splitter, splitText } from "./fields.js";
import { formatSingleNumber } from "./format/format.js";
import type { Program, SpecialName } from "./parse/ast.js";
import { Regex } from "./regex/regex.js";
import { RegexSyntaxError } from "./regex/regex-parse.js";
import { byteLength, type Formats, toNumber, toText, type Value } from "./values.js";

const BLOCK = 64 * 1024;
const REGEX_CACHE = 128;
/** Bytes charged per array element beyond its key and value. */
export const ELEMENT_OVERHEAD = 64;

/** Grows a reservation in blocks as usage rises; releases it all at the end. */
export class Reservation {
  #used = 0;
  #reserved = 0;
  #releases: Array<() => void> = [];

  constructor(
    private readonly budget: RetainedBudget,
    private readonly label: string,
  ) {}

  adjust(delta: number): void {
    this.#used += delta;
    if (this.#used <= this.#reserved) return;
    const needed = this.#used - this.#reserved;
    const block = Math.max(needed, Math.min(BLOCK, this.budget.available));
    this.#releases.push(this.budget.retain(block, this.label));
    this.#reserved += block;
  }

  release(): void {
    for (const release of this.#releases) release();
    this.#releases = [];
    this.#used = 0;
    this.#reserved = 0;
  }
}

export class Output {
  #chunks: string[] = [];
  #size = 0;
  readonly #reservation: Reservation;

  constructor(budget: RetainedBudget) {
    this.#reservation = new Reservation(budget, "awk output");
  }

  get size(): number {
    return this.#size;
  }

  write(text: string): void {
    if (text.length === 0) return;
    this.#reservation.adjust(text.length);
    this.#chunks.push(text);
    this.#size += text.length;
  }

  take(): Uint8Array {
    const bytes = textToBytes(this.#chunks.join(""));
    this.#chunks = [];
    this.#size = 0;
    this.#reservation.release();
    return bytes;
  }

  release(): void {
    this.#chunks = [];
    this.#size = 0;
    this.#reservation.release();
  }
}

export interface RuntimeInput {
  readonly program: Program;
  readonly budget: RetainedBudget;
  /** ARGV[0], then the operands after the program. */
  readonly argv: readonly Value[];
  readonly environ: ReadonlyArray<readonly [string, Value]>;
}

export class Runtime implements Formats {
  readonly program: Program;
  readonly budget: RetainedBudget;
  readonly globals: Value[];
  readonly arrays: Array<AwkArray | null>;
  readonly memory: Reservation;
  readonly output: Output;
  readonly fields: FieldState;
  readonly specials = new Map<SpecialName, Value>([
    ["NR", 0],
    ["FNR", 0],
    ["FS", " "],
    ["OFS", " "],
    ["ORS", "\n"],
    ["RS", "\n"],
    ["FILENAME", ""],
    ["SUBSEP", "\x1c"],
    ["RSTART", null],
    ["RLENGTH", null],
    ["CONVFMT", "%.6g"],
    ["OFMT", "%.6g"],
  ]);
  convfmt = "%.6g";
  ofmt = "%.6g";
  splitter: Splitter = { kind: "space" };
  readonly #regexes = new Map<string, Regex>();

  constructor(input: RuntimeInput) {
    this.program = input.program;
    this.budget = input.budget;
    this.memory = new Reservation(input.budget, "awk variables");
    this.output = new Output(input.budget);
    this.globals = input.program.globals.map(() => null);
    this.arrays = input.program.globals.map((global) => (global.array ? new AwkArray() : null));
    this.fields = new FieldState(
      (text) => splitText(text, this.splitter),
      (values) =>
        values.map((value) => toText(value, this)).join(toText(this.special("OFS"), this)),
      (value) => toText(value, this),
    );
    const argv = this.globalArray("ARGV");
    input.argv.forEach((value, index) => {
      this.storeElement(argv, { kind: "integer", value: index }, value);
    });
    this.specials.set("ARGC", input.argv.length);
    const environ = this.globalArray("ENVIRON");
    for (const [name, value] of input.environ) {
      this.storeElement(environ, { kind: "string", value: name }, value);
    }
  }

  newArray(): AwkArray {
    return new AwkArray();
  }

  globalArray(name: string): AwkArray {
    const index = this.program.globals.findIndex((global) => global.name === name);
    const array = this.arrays[index];
    if (array === undefined || array === null) throw new Error(`awk: ${name} is not an array`);
    return array;
  }

  storeElement(array: AwkArray, subscript: Subscript, value: Value): void {
    const entry = array.find(subscript, true);
    if (entry === null) return;
    this.setElement(array, entry, value);
  }

  /** Store into an entry, charging new entries and the size change. */
  setElement(array: AwkArray, entry: Entry, value: Value): void {
    this.charge(array, byteLength(value) - byteLength(entry.value));
    entry.value = value;
  }

  charge(array: AwkArray, delta: number): void {
    array.bytes += delta;
    this.memory.adjust(delta);
  }

  /** Account an element `find(…, true)` just created. */
  created(array: AwkArray, keyLength: number): void {
    this.charge(array, keyLength + ELEMENT_OVERHEAD + 8);
  }

  clearArray(array: AwkArray): void {
    this.charge(array, -array.bytes);
    array.clear();
  }

  specialName(name: string): SpecialName | null {
    if (name === "NF") return "NF";
    for (const special of this.specials.keys()) if (special === name) return special;
    return null;
  }

  special(name: SpecialName): Value {
    if (name === "NF") return this.fields.count;
    return this.specials.get(name) ?? null;
  }

  setSpecial(name: SpecialName, value: Value): void {
    switch (name) {
      case "NF": {
        const count = Math.trunc(toNumber(value));
        if (count < 0) throw new AwkRuntimeError(`NF set to negative value`);
        this.fields.setCount(count);
        return;
      }
      case "FS":
        this.splitter = this.splitterFor(value);
        break;
      case "CONVFMT":
        this.convfmt = toText(value, this);
        break;
      case "OFMT":
        this.ofmt = toText(value, this);
        break;
      default:
        break;
    }
    this.specials.set(name, value);
  }

  /** One blank splits on runs of blanks, one other character literally, anything longer as a regex. */
  splitterFor(value: Value): Splitter {
    const text = toText(value, this);
    if (text === " ") return { kind: "space" };
    if (text === "") return { kind: "empty" };
    if (text.length === 1) return { kind: "char", char: text };
    return { kind: "regex", regex: this.regex(text) };
  }

  regex(source: string): Regex {
    const cached = this.#regexes.get(source);
    if (cached !== undefined) {
      this.#regexes.delete(source);
      this.#regexes.set(source, cached);
      return cached;
    }
    let regex: Regex;
    try {
      regex = new Regex(source, (bytes) => this.budget.retain(bytes, "awk regular expression")());
    } catch (error) {
      // A pattern nested deeper than the stack is reported as too large, not a crash.
      const reason =
        error instanceof RegexSyntaxError
          ? error.message
          : error instanceof RangeError
            ? "resource exhaustion -- regular expression too large"
            : null;
      if (reason === null) throw error;
      throw new AwkRuntimeError(`regular expression compile failed (${reason})\n${source}`);
    }
    if (this.#regexes.size >= REGEX_CACHE) {
      const oldest = this.#regexes.keys().next().value;
      if (oldest !== undefined) this.#regexes.delete(oldest);
    }
    this.#regexes.set(source, regex);
    return regex;
  }

  /** Integral numbers key by their integer text; other numbers through CONVFMT; the rest by text. */
  subscript(value: Value): Subscript {
    if (typeof value === "number") {
      if (Number.isInteger(value) && value >= -(2 ** 63) && value <= 2 ** 63) {
        return { kind: "integer", value: value === 0 ? 0 : value };
      }
      return { kind: "string", value: formatSingleNumber(this.convfmt, value) };
    }
    return { kind: "string", value: toText(value, this) };
  }

  release(): void {
    this.memory.release();
    this.output.release();
  }
}
