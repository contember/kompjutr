import { utf8 } from "../../common/bytes.js";
import { GitError } from "../../common/errors.js";
import type { DiffFormatOptions } from "./diff-types.js";

/** Format one already-bounded repository path for a Git patch header. */
export function diffHeaderPath(
  path: string,
  prefix: "" | "a/" | "b/",
  options: DiffFormatOptions,
): string {
  if (options.quotePaths !== true) return `${prefix}${path}`;
  const quoteNonAscii = options.quoteNonAscii ?? true;
  if (typeof quoteNonAscii !== "boolean") {
    throw new GitError("EINVAL", "diff quoteNonAscii must be a boolean");
  }
  validateDiffPath(path);
  return quoteNonAscii ? quoteDiffUtf8(`${prefix}${path}`) : quoteDiffUnicode(`${prefix}${path}`);
}

function validateDiffPath(path: string): void {
  for (let index = 0; index < path.length; index++) {
    const code = path.charCodeAt(index);
    if (code === 0) throw new GitError("EINVAL", "diff path must not contain NUL");
    if (code >= 0xd800 && code <= 0xdbff) {
      const low = path.charCodeAt(index + 1);
      if (low < 0xdc00 || low > 0xdfff) {
        throw new GitError("EINVAL", "diff path must be well-formed UTF-16");
      }
      index++;
    } else if (code >= 0xdc00 && code <= 0xdfff) {
      throw new GitError("EINVAL", "diff path must be well-formed UTF-16");
    }
  }
}

function quoteDiffUtf8(path: string): string {
  let quoted = false;
  let output = "";
  for (const byte of utf8.encode(path)) {
    const escaped = escapeDiffByte(byte);
    if (escaped !== null) {
      quoted = true;
      output += escaped;
    } else if (byte >= 0x80) {
      quoted = true;
      output += octalByte(byte);
    } else {
      output += String.fromCharCode(byte);
    }
  }
  return quoted ? `"${output}"` : output;
}

function quoteDiffUnicode(path: string): string {
  let quoted = false;
  let output = "";
  for (const character of path) {
    const code = character.codePointAt(0);
    if (code === undefined) throw new GitError("ECORRUPT", "diff path contains no code point");
    const escaped = code < 0x80 ? escapeDiffByte(code) : null;
    if (escaped === null) output += character;
    else {
      quoted = true;
      output += escaped;
    }
  }
  return quoted ? `"${output}"` : output;
}

function escapeDiffByte(byte: number): string | null {
  if (byte === 0x07) return "\\a";
  if (byte === 0x08) return "\\b";
  if (byte === 0x09) return "\\t";
  if (byte === 0x0a) return "\\n";
  if (byte === 0x0b) return "\\v";
  if (byte === 0x0c) return "\\f";
  if (byte === 0x0d) return "\\r";
  if (byte === 0x22) return '\\"';
  if (byte === 0x5c) return "\\\\";
  if (byte < 0x20 || byte === 0x7f) return octalByte(byte);
  return null;
}

function octalByte(byte: number): string {
  return `\\${byte.toString(8).padStart(3, "0")}`;
}
