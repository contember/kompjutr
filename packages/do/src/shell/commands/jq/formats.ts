// `@name` formats (f_format in src/builtin.c). escape_string always maps NUL
// to `\0`, whichever table a format adds on top.

import { dumpString } from "./dump.js";
import { JqError, typeError } from "./errors.js";
import { type Charge, stringBytes } from "./paths.js";
import { formatNumber, isArray, isNumber, type JqValue, numberValue } from "./value.js";

export function formatValue(name: string, value: JqValue, charge: Charge): string {
  const text = format(name, value);
  charge(stringBytes(text));
  return text;
}

function format(name: string, value: JqValue): string {
  switch (name) {
    case "json":
      return dumpString(value);
    case "text":
      return toText(value);
    case "csv":
      return row(value, ",", '"', CSV, "cannot be csv-formatted, only array");
    case "tsv":
      return row(value, "\t", "", TSV, "cannot be tsv-formatted, only array");
    case "html":
      return escapeText(toText(value), HTML);
    case "uri":
      return uri(toText(value));
    case "urid":
      return uriDecode(toText(value));
    case "sh":
      return shell(value);
    case "base64":
      return base64Encode(new TextEncoder().encode(toText(value)));
    case "base64d":
      return base64Decode(toText(value));
    default:
      throw new JqError(`${name} is not a valid format`);
  }
}

export function toText(value: JqValue): string {
  return typeof value === "string" ? value : dumpString(value);
}

const CSV = new Map([['"', '""']]);
const TSV = new Map([
  ["\t", "\\t"],
  ["\r", "\\r"],
  ["\n", "\\n"],
  ["\\", "\\\\"],
]);
const HTML = new Map([
  ["&", "&amp;"],
  ["<", "&lt;"],
  [">", "&gt;"],
  ["'", "&apos;"],
  ['"', "&quot;"],
]);
const SHELL = new Map([["'", "'\\''"]]);

function escapeText(text: string, table: ReadonlyMap<string, string>): string {
  let out = "";
  for (const char of text) out += char === "\0" ? "\\0" : (table.get(char) ?? char);
  return out;
}

function row(
  value: JqValue,
  separator: string,
  quote: string,
  table: ReadonlyMap<string, string>,
  message: string,
): string {
  if (!isArray(value)) throw typeError(value, message);
  const cells: string[] = [];
  for (const cell of value) {
    if (cell === null) cells.push("");
    else if (typeof cell === "boolean") cells.push(cell ? "true" : "false");
    else if (isNumber(cell)) cells.push(Number.isNaN(numberValue(cell)) ? "" : formatNumber(cell));
    else if (typeof cell === "string") cells.push(`${quote}${escapeText(cell, table)}${quote}`);
    else throw typeError(cell, "is not valid in a csv row");
  }
  return cells.join(separator);
}

const UNRESERVED = /^[A-Za-z0-9\-_.~]$/;

function uri(text: string): string {
  let out = "";
  for (const byte of new TextEncoder().encode(text)) {
    const char = String.fromCharCode(byte);
    out +=
      byte < 128 && UNRESERVED.test(char)
        ? char
        : `%${byte.toString(16).toUpperCase().padStart(2, "0")}`;
  }
  return out;
}

/** jq's @urid: each %XX run forms one UTF-8 character, validated as a whole. */
function uriDecode(text: string): string {
  const bytes = new TextEncoder().encode(text);
  const out: number[] = [];
  const invalid = (): never => {
    throw typeError(text, "is not a valid uri encoding");
  };
  const hex = (at: number): number => {
    const digits = String.fromCharCode(bytes[at] ?? 0, bytes[at + 1] ?? 0);
    if (!/^[0-9A-Fa-f]{2}$/.test(digits)) invalid();
    return Number.parseInt(digits, 16);
  };
  for (let at = 0; at < bytes.length && bytes[at] !== 0; ) {
    if (bytes[at] !== 0x25) {
      out.push(bytes[at] ?? 0);
      at++;
      continue;
    }
    const sequence: number[] = [];
    for (let count = 0; ; count++) {
      const lead = sequence[0] ?? 0;
      const more = count === 0 || (count < 4 && (lead >> 7) & 1 && (lead >> (7 - count)) & 1);
      if (!more) break;
      if (bytes[at] !== 0x25) invalid();
      sequence.push(hex(at + 1));
      at += 3;
    }
    const decoded = new TextDecoder("utf-8", { fatal: true });
    try {
      decoded.decode(Uint8Array.from(sequence));
    } catch {
      invalid();
    }
    out.push(...sequence);
  }
  return new TextDecoder().decode(Uint8Array.from(out));
}

function shell(value: JqValue): string {
  const items = isArray(value) ? value : [value];
  const words: string[] = [];
  for (const item of items) {
    if (item === null || typeof item === "boolean" || isNumber(item)) words.push(dumpString(item));
    else if (typeof item === "string") words.push(`'${escapeText(item, SHELL)}'`);
    else throw typeError(item, "can not be escaped for shell");
  }
  return words.join(" ");
}

const ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";

function base64Encode(bytes: Uint8Array): string {
  let out = "";
  for (let index = 0; index < bytes.length; index += 3) {
    const available = Math.min(3, bytes.length - index);
    const code =
      ((bytes[index] ?? 0) << 16) | ((bytes[index + 1] ?? 0) << 8) | (bytes[index + 2] ?? 0);
    for (let digit = 0; digit < 4; digit++) {
      out += digit > available ? "=" : ALPHABET.charAt((code >> (18 - digit * 6)) & 0x3f);
    }
  }
  return out;
}

/** jq's decoder: stops at the first `=`, rejects anything off the alphabet. */
function base64Decode(text: string): string {
  const bytes: number[] = [];
  let code = 0;
  let pending = 0;
  for (const char of text) {
    if (char === "=") break;
    const digit = ALPHABET.indexOf(char);
    if (digit === -1 || char.length !== 1) throw typeError(text, "is not valid base64 data");
    code = (code << 6) | digit;
    pending++;
    if (pending === 4) {
      bytes.push((code >> 16) & 0xff, (code >> 8) & 0xff, code & 0xff);
      pending = 0;
      code = 0;
    }
  }
  if (pending === 3) bytes.push((code >> 10) & 0xff, (code >> 2) & 0xff);
  else if (pending === 2) bytes.push((code >> 4) & 0xff);
  else if (pending === 1) throw typeError(text, "trailing base64 byte found");
  return new TextDecoder().decode(Uint8Array.from(bytes));
}
