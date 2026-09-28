// jv_dump: jq's serializer. Output is produced into a shared writer and the
// generator yields whenever enough text is pending, so a large result streams
// instead of being built whole.

import { comparePaths } from "../../../fs/path.js";
import { formatNumber, isArray, isNumber, type JqObject, type JqValue } from "./value.js";

export interface DumpOptions {
  readonly pretty: boolean;
  readonly indent: number;
  readonly tab: boolean;
  readonly sortKeys: boolean;
  readonly ascii: boolean;
}

export const COMPACT: DumpOptions = {
  pretty: false,
  indent: 0,
  tab: false,
  sortKeys: false,
  ascii: false,
};

const MAX_PRINT_DEPTH = 256;
const FLUSH_AT = 64 * 1024;

export class Writer {
  #parts: string[] = [];
  #size = 0;

  get size(): number {
    return this.#size;
  }

  write(text: string): void {
    this.#parts.push(text);
    this.#size += text.length;
  }

  take(): string {
    const text = this.#parts.join("");
    this.#parts = [];
    this.#size = 0;
    return text;
  }
}

/** Serializes into `writer`, yielding whenever a flush is due. */
export function* dumpInto(
  writer: Writer,
  value: JqValue,
  options: DumpOptions,
  depth = 0,
): Generator<void, void, undefined> {
  if (writer.size >= FLUSH_AT) yield;
  if (depth > MAX_PRINT_DEPTH) {
    writer.write("<skipped: too deep>");
    return;
  }
  if (value === null) writer.write("null");
  else if (typeof value === "boolean") writer.write(value ? "true" : "false");
  else if (typeof value === "string") writer.write(quote(value, options.ascii));
  else if (isNumber(value)) writer.write(formatNumber(value));
  else if (isArray(value)) {
    if (value.length === 0) {
      writer.write("[]");
      return;
    }
    writer.write("[");
    for (let index = 0; index < value.length; index++) {
      if (index > 0) writer.write(",");
      if (options.pretty) writer.write(`\n${indentation(depth + 1, options)}`);
      yield* dumpInto(writer, value[index] ?? null, options, depth + 1);
    }
    if (options.pretty) writer.write(`\n${indentation(depth, options)}`);
    writer.write("]");
  } else yield* dumpObject(writer, value, options, depth);
}

function* dumpObject(
  writer: Writer,
  value: JqObject,
  options: DumpOptions,
  depth: number,
): Generator<void, void, undefined> {
  if (value.size === 0) {
    writer.write("{}");
    return;
  }
  writer.write("{");
  const keys = options.sortKeys ? sortedKeys(value) : value.keys();
  let first = true;
  for (const key of keys) {
    if (!first) writer.write(",");
    first = false;
    if (options.pretty) writer.write(`\n${indentation(depth + 1, options)}`);
    writer.write(quote(key, options.ascii));
    writer.write(options.pretty ? ": " : ":");
    yield* dumpInto(writer, value.get(key) ?? null, options, depth + 1);
  }
  if (options.pretty) writer.write(`\n${indentation(depth, options)}`);
  writer.write("}");
}

function indentation(level: number, options: DumpOptions): string {
  return options.tab ? "\t".repeat(level) : " ".repeat(level * options.indent);
}

export function sortedKeys(value: JqObject): string[] {
  return [...value.keys()].sort(comparePaths);
}

/** The whole serialization as one string (tojson, tostring, messages). */
export function dumpString(value: JqValue, options: DumpOptions = COMPACT): string {
  const writer = new Writer();
  const run = dumpInto(writer, value, options);
  let parts = "";
  for (let step = run.next(); step.done !== true; step = run.next()) parts += writer.take();
  return parts + writer.take();
}

function needsEscape(text: string, ascii: boolean): boolean {
  for (let index = 0; index < text.length; index++) {
    const code = text.charCodeAt(index);
    if (code < 0x20 || code === 0x22 || code === 0x5c || code === 0x7f || (ascii && code > 0x7e)) {
      return true;
    }
  }
  return false;
}

export function quote(text: string, ascii: boolean): string {
  if (!needsEscape(text, ascii)) return `"${text}"`;
  let out = '"';
  for (const char of text) {
    const code = char.codePointAt(0) ?? 0;
    if (code >= 0x20 && code <= 0x7e) {
      out += code === 0x22 || code === 0x5c ? `\\${char}` : char;
    } else if (code < 0x20 || code === 0x7f) {
      out += CONTROL.get(code) ?? unicodeEscape(code);
    } else out += ascii ? unicodeEscape(code) : char;
  }
  return `${out}"`;
}

const CONTROL = new Map([
  [0x08, "\\b"],
  [0x09, "\\t"],
  [0x0a, "\\n"],
  [0x0c, "\\f"],
  [0x0d, "\\r"],
]);

function unicodeEscape(code: number): string {
  if (code <= 0xffff) return `\\u${code.toString(16).padStart(4, "0")}`;
  const offset = code - 0x10000;
  const high = 0xd800 | (offset >> 10);
  const low = 0xdc00 | (offset & 0x3ff);
  return `\\u${high.toString(16)}\\u${low.toString(16)}`;
}

/**
 * jv_dump_string_trunc: the compact dump cut to `bufsize - 1` bytes, ending in
 * "..." at a character boundary when it did not fit.
 */
export function truncatedDump(value: JqValue, bufsize = 15): string {
  const text = dumpString(value);
  let bytes = 0;
  let cut = -1;
  let index = 0;
  for (const char of text) {
    const width = byteWidth(char);
    if (cut === -1 && bytes + width > bufsize - 4) cut = index;
    bytes += width;
    index += char.length;
    if (bytes > bufsize - 1) return `${text.slice(0, cut)}...`;
  }
  return text;
}

function byteWidth(char: string): number {
  const code = char.codePointAt(0) ?? 0;
  return code < 0x80 ? 1 : code < 0x800 ? 2 : code < 0x10000 ? 3 : 4;
}
