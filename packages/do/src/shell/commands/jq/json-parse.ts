// jv_parse: jq's incremental JSON text parser, byte for byte. Its messages,
// line, and column are part of jq's observable output, so the state machine
// follows jq's rather than JSON.parse: a value is complete at its closing
// token, a top-level number only when a delimiter follows, and a literal is
// judged when the next structural byte or EOF arrives.

import { type JqValue, parseLiteral } from "./value.js";

export type ParseStep =
  | { readonly kind: "value"; readonly value: JqValue }
  | { readonly kind: "error"; readonly message: string }
  | { readonly kind: "more" }
  | { readonly kind: "end" };

type Entry =
  | { readonly kind: "array"; readonly items: JqValue[] }
  | { readonly kind: "object"; readonly map: Map<string, JqValue> }
  | { readonly kind: "key"; readonly key: string };

const MAX_DEPTH = 10_000;
const BOM = [0xef, 0xbb, 0xbf];
const EMPTY = new Uint8Array(0);
const DECODER = new TextDecoder();
const QUOTE = 0x22;
const BACKSLASH = 0x5c;

type Mode = "normal" | "string" | "escape";

export class JsonParser {
  line = 1;
  column = 0;
  #buffer: Uint8Array = EMPTY;
  #position = 0;
  #final = false;
  #eof = false;
  #bom = 0;
  #stack: Entry[] = [];
  #next: { value: JqValue } | null = null;
  #output: { value: JqValue } | null = null;
  #token: number[] = [];
  #string: Uint8Array[] = [];
  #mode: Mode = "normal";

  /** jv_parser_set_buf: the previous buffer must be consumed first. */
  feed(chunk: Uint8Array, final: boolean): void {
    let start = 0;
    while (start < chunk.length && this.#bom < BOM.length) {
      if (chunk[start] === BOM[this.#bom]) {
        start++;
        this.#bom++;
      } else this.#bom = this.#bom === 0 ? BOM.length : 0xff;
    }
    this.#buffer = start === 0 ? chunk : chunk.subarray(start);
    this.#position = 0;
    this.#final = final;
  }

  get remaining(): number {
    return this.#buffer.length - this.#position;
  }

  next(): ParseStep {
    if (this.#eof) return { kind: "end" };
    if (this.#bom === 0xff) return { kind: "error", message: "Malformed BOM" };
    const buffer = this.#buffer;
    while (this.#position < buffer.length) {
      const byte = buffer[this.#position++] ?? 0;
      let outcome: string | null;
      if (this.#mode !== "normal" && byte !== 0x0a && byte !== QUOTE && byte !== BACKSLASH) {
        this.column++;
        outcome = this.#stringRun(buffer);
      } else outcome = this.#scan(byte);
      if (outcome === OK) {
        const output = this.#output;
        this.#output = null;
        if (output !== null) return { kind: "value", value: output.value };
      } else if (outcome !== null) {
        const message = `${outcome} at line ${this.line}, column ${this.column}`;
        this.#reset();
        this.#buffer = EMPTY;
        this.#position = 0;
        return { kind: "error", message };
      }
    }
    if (!this.#final) return { kind: "more" };
    return this.#finish();
  }

  /** Consumes a run of ordinary string bytes; the first was already counted. */
  #stringRun(buffer: Uint8Array): null {
    const start = this.#position - 1;
    let end = this.#position;
    while (end < buffer.length) {
      const byte = buffer[end] ?? 0;
      if (byte === 0x0a || byte === QUOTE || byte === BACKSLASH) break;
      end++;
    }
    this.column += end - this.#position;
    this.#string.push(buffer.subarray(start, end));
    this.#position = end;
    if (this.#mode === "escape") this.#mode = "string";
    return null;
  }

  #finish(): ParseStep {
    this.#eof = true;
    if (this.#mode !== "normal") {
      return this.#fail(`Unfinished string at EOF at line ${this.line}, column ${this.column}`);
    }
    const literal = this.#checkLiteral();
    if (literal !== null) {
      return this.#fail(`${literal} at EOF at line ${this.line}, column ${this.column}`);
    }
    if (this.#stack.length > 0) {
      return this.#fail(`Unfinished JSON term at EOF at line ${this.line}, column ${this.column}`);
    }
    const next = this.#next;
    this.#next = null;
    return next === null ? { kind: "end" } : { kind: "value", value: next.value };
  }

  #fail(message: string): ParseStep {
    this.#reset();
    return { kind: "error", message };
  }

  #reset(): void {
    this.#stack = [];
    this.#next = null;
    this.#token = [];
    this.#string = [];
    this.#mode = "normal";
  }

  #scan(byte: number): string | null {
    this.column++;
    if (byte === 0x0a) {
      this.line++;
      this.column = 0;
    }
    if (this.#mode === "normal") {
      let answer: string | null = null;
      const structural = STRUCTURE.has(byte);
      const literal = !structural && byte !== QUOTE && !WHITESPACE.has(byte);
      if (!literal) {
        const failed = this.#checkLiteral();
        if (failed !== null) return failed;
        if (this.#done()) answer = OK;
      }
      if (literal) this.#token.push(byte);
      else if (byte === QUOTE) this.#mode = "string";
      else if (structural) {
        const failed = this.#structure(byte);
        if (failed !== null) return failed;
      }
      if (this.#done()) answer = OK;
      return answer;
    }
    if (byte === QUOTE && this.#mode === "string") {
      const failed = this.#foundString();
      if (failed !== null) return failed;
      this.#mode = "normal";
      return this.#done() ? OK : null;
    }
    this.#string.push(Uint8Array.of(byte));
    this.#mode = byte === BACKSLASH && this.#mode === "string" ? "escape" : "string";
    return null;
  }

  /** parse_check_done: a complete top-level value moves to the output slot. */
  #done(): boolean {
    if (this.#stack.length !== 0 || this.#next === null) return false;
    this.#output = this.#next;
    this.#next = null;
    return true;
  }

  #value(value: JqValue): string | null {
    if (this.#next !== null) return "Expected separator between values";
    this.#next = { value };
    return null;
  }

  #checkLiteral(): string | null {
    const token = this.#token;
    if (token.length === 0) return null;
    const text = DECODER.decode(Uint8Array.from(token));
    let pattern: string | null = null;
    let value: JqValue = null;
    const first = text.charAt(0);
    if (first === "t") {
      pattern = "true";
      value = true;
    } else if (first === "f") {
      pattern = "false";
      value = false;
    } else if (first === "'") return "Invalid string literal; expected \", but got '";
    else if (first === "n" && text.charAt(1) === "u") pattern = "null";
    if (pattern !== null) {
      if (text !== pattern) return "Invalid literal";
    } else {
      const number = parseLiteral(text);
      if (number === null) return "Invalid numeric literal";
      value = number;
    }
    const failed = this.#value(value);
    if (failed !== null) return failed;
    this.#token = [];
    return null;
  }

  #structure(byte: number): string | null {
    const stack = this.#stack;
    const top = stack[stack.length - 1];
    switch (byte) {
      case 0x5b:
      case 0x7b:
        if (stack.length >= MAX_DEPTH) return "Exceeds depth limit for parsing";
        if (this.#next !== null) return "Expected separator between values";
        stack.push(
          byte === 0x5b ? { kind: "array", items: [] } : { kind: "object", map: new Map() },
        );
        return null;
      case 0x3a: {
        const next = this.#next;
        if (next === null) return "Expected string key before ':'";
        if (top?.kind !== "object") return "':' not as part of an object";
        if (typeof next.value !== "string") return "Object keys must be strings";
        stack.push({ kind: "key", key: next.value });
        this.#next = null;
        return null;
      }
      case 0x2c: {
        const next = this.#next;
        if (next === null) return "Expected value before ','";
        if (top === undefined) return "',' not as part of an object or array";
        if (top.kind === "array") top.items.push(next.value);
        else if (top.kind === "key") {
          stack.pop();
          const object = stack[stack.length - 1];
          if (object?.kind === "object") object.map.set(top.key, next.value);
        } else return "Objects must consist of key:value pairs";
        this.#next = null;
        return null;
      }
      case 0x5d: {
        if (top?.kind !== "array") return "Unmatched ']'";
        const next = this.#next;
        if (next !== null) top.items.push(next.value);
        else if (top.items.length !== 0) return "Expected another array element";
        stack.pop();
        this.#next = { value: top.items };
        return null;
      }
      default: {
        if (top === undefined) return "Unmatched '}'";
        const next = this.#next;
        if (next !== null) {
          if (top.kind !== "key") return "Objects must consist of key:value pairs";
          stack.pop();
          const object = stack[stack.length - 1];
          if (object?.kind === "object") object.map.set(top.key, next.value);
        } else {
          if (top.kind !== "object") return "Unmatched '}'";
          if (top.map.size !== 0) return "Expected another key-value pair";
        }
        const object = stack.pop();
        this.#next = object?.kind === "object" ? { value: object.map } : null;
        return null;
      }
    }
  }

  #foundString(): string | null {
    const raw = concatBytes(this.#string);
    this.#string = [];
    const decoded = decodeEscapes(raw);
    return typeof decoded === "string" ? this.#value(decoded) : decoded.error;
  }
}

const OK = "output produced";
const WHITESPACE = new Set([0x20, 0x09, 0x0d, 0x0a]);
const STRUCTURE = new Set([0x5b, 0x2c, 0x5d, 0x7b, 0x3a, 0x7d]);

function concatBytes(parts: readonly Uint8Array[]): Uint8Array {
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

const SIMPLE_ESCAPES = new Map([
  [0x5c, 0x5c],
  [0x22, 0x22],
  [0x2f, 0x2f],
  [0x62, 0x08],
  [0x66, 0x0c],
  [0x74, 0x09],
  [0x6e, 0x0a],
  [0x72, 0x0d],
]);

/** found_string: resolve escapes, reject raw control bytes, decode UTF-8. */
export function decodeEscapes(raw: Uint8Array): string | { readonly error: string } {
  if (raw.indexOf(BACKSLASH) === -1) {
    for (const byte of raw) {
      if (byte < 0x20) return { error: CONTROL_MESSAGE };
    }
    return DECODER.decode(raw);
  }
  const out: number[] = [];
  let index = 0;
  while (index < raw.length) {
    const byte = raw[index++] ?? 0;
    if (byte !== BACKSLASH) {
      if (byte < 0x20) return { error: CONTROL_MESSAGE };
      out.push(byte);
      continue;
    }
    if (index >= raw.length) return { error: "Expected escape character at end of string" };
    const escaped = raw[index++] ?? 0;
    const simple = SIMPLE_ESCAPES.get(escaped);
    if (simple !== undefined) {
      out.push(simple);
      continue;
    }
    if (escaped !== 0x75) return { error: "Invalid escape" };
    if (index + 4 > raw.length) return { error: "Invalid \\uXXXX escape" };
    let codepoint = unhex4(raw, index);
    if (codepoint < 0) return { error: "Invalid characters in \\uXXXX escape" };
    index += 4;
    if (codepoint >= 0xd800 && codepoint <= 0xdbff) {
      if (index + 6 > raw.length || raw[index] !== BACKSLASH || raw[index + 1] !== 0x75) {
        return { error: SURROGATE_MESSAGE };
      }
      const low = unhex4(raw, index + 2);
      if (!(low >= 0xdc00 && low <= 0xdfff)) return { error: SURROGATE_MESSAGE };
      index += 6;
      codepoint = 0x10000 + (((codepoint - 0xd800) << 10) | (low - 0xdc00));
    }
    if (codepoint >= 0xdc00 && codepoint <= 0xdfff) codepoint = 0xfffd;
    encodeCodePoint(codepoint, out);
  }
  return DECODER.decode(Uint8Array.from(out));
}

const CONTROL_MESSAGE =
  "Invalid string: control characters from U+0000 through U+001F must be escaped";
const SURROGATE_MESSAGE = "Invalid \\uXXXX\\uXXXX surrogate pair escape";

function unhex4(raw: Uint8Array, at: number): number {
  let value = 0;
  for (let offset = 0; offset < 4; offset++) {
    const byte = raw[at + offset] ?? 0;
    let digit: number;
    if (byte >= 0x30 && byte <= 0x39) digit = byte - 0x30;
    else if (byte >= 0x41 && byte <= 0x46) digit = byte - 0x37;
    else if (byte >= 0x61 && byte <= 0x66) digit = byte - 0x57;
    else return -1;
    value = (value << 4) | digit;
  }
  return value;
}

function encodeCodePoint(codepoint: number, out: number[]): void {
  if (codepoint < 0x80) out.push(codepoint);
  else if (codepoint < 0x800) out.push(0xc0 | (codepoint >> 6), 0x80 | (codepoint & 0x3f));
  else if (codepoint < 0x10000) {
    out.push(0xe0 | (codepoint >> 12), 0x80 | ((codepoint >> 6) & 0x3f), 0x80 | (codepoint & 0x3f));
  } else {
    out.push(
      0xf0 | (codepoint >> 18),
      0x80 | ((codepoint >> 12) & 0x3f),
      0x80 | ((codepoint >> 6) & 0x3f),
      0x80 | (codepoint & 0x3f),
    );
  }
}

/** jv_parse_sized: exactly one JSON text, with jq's `(while parsing '…')` suffix. */
export function parseJsonText(
  text: string,
):
  | { readonly kind: "value"; readonly value: JqValue }
  | { readonly kind: "error"; readonly message: string } {
  const parser = new JsonParser();
  parser.feed(new TextEncoder().encode(text), true);
  const first = parser.next();
  let message: string;
  if (first.kind === "value") {
    const second = parser.next();
    if (second.kind === "end") return first;
    message = second.kind === "error" ? second.message : "Unexpected extra JSON values";
  } else if (first.kind === "error") message = first.message;
  else message = "Expected JSON value";
  return { kind: "error", message: `${message} (while parsing '${text}')` };
}
