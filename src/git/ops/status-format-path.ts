import { utf8 } from "../common/bytes.js";
import { GitError } from "../common/errors.js";
import type { ResolvedStatusFormatOptions } from "./status-format-types.js";

export function formatPath(
  path: string,
  options: ResolvedStatusFormatOptions,
  quoteEdgeSpaces: boolean,
  quoteRenameSeparator = false,
): string {
  if (options.zeroTerminate) return path;
  return options.quotePath
    ? quoteUtf8Bytes(path, quoteEdgeSpaces, quoteRenameSeparator)
    : quoteUnicodePath(path, quoteEdgeSpaces, quoteRenameSeparator);
}

function quoteUtf8Bytes(
  path: string,
  quoteEdgeSpaces: boolean,
  quoteRenameSeparator: boolean,
): string {
  let quoted =
    (quoteEdgeSpaces && edgeSpace(path)) || (quoteRenameSeparator && path.includes(" -> "));
  let output = "";
  for (const byte of utf8.encode(path)) {
    const escaped = escapeAscii(byte);
    if (escaped !== null) {
      quoted = true;
      output += escaped;
    } else if (byte >= 0x80) {
      quoted = true;
      output += octal(byte);
    } else {
      output += String.fromCharCode(byte);
    }
  }
  return quoted ? `"${output}"` : output;
}

function quoteUnicodePath(
  path: string,
  quoteEdgeSpaces: boolean,
  quoteRenameSeparator: boolean,
): string {
  let quoted =
    (quoteEdgeSpaces && edgeSpace(path)) || (quoteRenameSeparator && path.includes(" -> "));
  let output = "";
  for (const character of path) {
    const code = character.codePointAt(0);
    if (code === undefined) throw new GitError("ECORRUPT", "status path contains no code point");
    const escaped = code < 0x80 ? escapeAscii(code) : null;
    if (escaped !== null) {
      quoted = true;
      output += escaped;
    } else {
      output += character;
    }
  }
  return quoted ? `"${output}"` : output;
}

export function escapeAscii(byte: number): string | null {
  if (byte === 0x07) return "\\a";
  if (byte === 0x08) return "\\b";
  if (byte === 0x09) return "\\t";
  if (byte === 0x0a) return "\\n";
  if (byte === 0x0b) return "\\v";
  if (byte === 0x0c) return "\\f";
  if (byte === 0x0d) return "\\r";
  if (byte === 0x22) return '\\"';
  if (byte === 0x5c) return "\\\\";
  if (byte < 0x20 || byte === 0x7f) return octal(byte);
  return null;
}

function octal(byte: number): string {
  return `\\${byte.toString(8).padStart(3, "0")}`;
}

export function edgeSpace(path: string): boolean {
  return path.startsWith(" ") || path.endsWith(" ");
}

/** Porcelain v2 spells "unmodified" as a dot where v1 uses a space. */
export function v2Code(code: string): string {
  return code === " " ? "." : code;
}

export function joinRecords(records: string[], zeroTerminate: boolean): string {
  if (records.length === 0) return "";
  const terminator = zeroTerminate ? "\0" : "\n";
  return `${records.join(terminator)}${terminator}`;
}
