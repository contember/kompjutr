// tree(1)'s `-P`/`-I` wildcard dialect and its C-locale name printing. Both
// work on UTF-8 bytes, as tree does: `?` consumes one byte, and a non-ASCII
// byte prints as an octal escape.

import { encode } from "../../exec/bytes.js";

const SLASH = 0x2f;
const STAR = 0x2a;
const BACKSLASH = 0x5c;

/** Matches a name against one `-P`/`-I` argument; `|` separates alternatives. */
export function matchesPattern(name: string, pattern: string, isDirectory: boolean): boolean {
  return alternatives(encode(name), encode(pattern), isDirectory);
}

// tree splits at the first `|` unless it is the pattern's first or last byte.
function alternatives(name: Uint8Array, pattern: Uint8Array, isDirectory: boolean): boolean {
  const bar = pattern.indexOf(0x7c);
  if (bar > 0 && bar < pattern.length - 1) {
    return (
      match(name, 0, pattern.subarray(0, bar), 0, isDirectory) === 1 ||
      alternatives(name, pattern.subarray(bar + 1), isDirectory)
    );
  }
  return match(name, 0, pattern, 0, isDirectory) === 1;
}

/** tree's `patmatch`: 1 on a match, 0 on a mismatch, -1 on a malformed class. */
function match(
  name: Uint8Array,
  nameStart: number,
  pattern: Uint8Array,
  patternStart: number,
  isDirectory: boolean,
): number {
  let at = nameStart;
  let p = patternStart;
  let matched = 1;
  while (p < pattern.length && matched === 1) {
    const token = pattern[p];
    const current = name[at] ?? 0;
    if (token === 0x5b) {
      p++;
      let hit = 0;
      let onMatch = 1;
      if (pattern[p] === 0x5e) {
        p++;
        onMatch = 0;
        hit = 1;
      }
      while (pattern[p] !== 0x5d) {
        if (pattern[p] === BACKSLASH) p++;
        const low = pattern[p];
        if (low === undefined) return -1;
        if (pattern[p + 1] === 0x2d) {
          p += 2;
          if (pattern[p] === BACKSLASH) p++;
          const high = pattern[p];
          if (current >= low && high !== undefined && current <= high) hit = onMatch;
          if (high === undefined) p--;
        } else if (current === low) {
          hit = onMatch;
        }
        p++;
      }
      matched = hit;
      at++;
    } else if (token === STAR) {
      p++;
      if (p >= pattern.length) return name.indexOf(SLASH, at) === -1 ? 1 : 0;
      if (pattern[p] === STAR) {
        p++;
        if (pattern[p] === SLASH) p++;
      }
      for (let from = at; from <= name.length; from++) {
        const result = match(name, from, pattern, p, isDirectory);
        if (result !== 0) return result;
      }
      return 0;
    } else if (token === 0x3f) {
      if (at >= name.length) return 0;
      at++;
    } else if (token === SLASH) {
      if (p === pattern.length - 1 && at >= name.length) return isDirectory ? 1 : 0;
      matched = current === SLASH && at < name.length ? 1 : 0;
      at++;
    } else {
      if (token === BACKSLASH && p + 1 < pattern.length) p++;
      matched = at < name.length && current === pattern[p] ? 1 : 0;
      at++;
    }
    p++;
  }
  if (matched !== 1) return matched;
  return at >= name.length ? 1 : 0;
}

const CONTROL_LETTERS = "abtnvfr";

/** A name as tree prints it under the C locale. */
export function printable(text: string): string {
  let out = "";
  for (const byte of encode(text)) {
    if (byte >= 7 && byte <= 13) out += `\\${CONTROL_LETTERS.charAt(byte - 7)}`;
    else if (byte === BACKSLASH) out += "\\\\";
    else if (byte === 0x20) out += "\\ ";
    else if (byte > 0x20 && byte < 0x7f) out += String.fromCharCode(byte);
    else out += `\\${byte.toString(8).padStart(3, "0")}`;
  }
  return out;
}
