// C-coded string builtins. jq works on UTF-8 bytes and counts code points;
// JavaScript strings hold the same text, so offsets are converted where jq
// reports them.

import { JqError, typeError } from "../errors.js";
import { splitString } from "../operators.js";
import { arrayBytes, stringBytes, toInt } from "../paths.js";
import {
  codePointLength,
  codePoints,
  isArray,
  isNumber,
  type JqValue,
  numberValue,
} from "../value.js";
import { type Natives, unary, withArgs } from "./native.js";

export function registerStrings(natives: Natives): void {
  natives.set(
    "startswith/1",
    withArgs((value, [prefix]) => {
      if (typeof value !== "string" || typeof prefix !== "string") {
        throw new JqError("startswith() requires string inputs");
      }
      return value.startsWith(prefix);
    }),
  );
  natives.set(
    "endswith/1",
    withArgs((value, [suffix]) => {
      if (typeof value !== "string" || typeof suffix !== "string") {
        throw new JqError("endswith() requires string inputs");
      }
      return value.endsWith(suffix);
    }),
  );
  natives.set(
    "split/1",
    withArgs((value, [separator], runtime) => {
      if (typeof value !== "string" || typeof separator !== "string") {
        throw new JqError("split input and separator must be strings");
      }
      return splitString(value, separator, runtime.charge);
    }),
  );
  natives.set(
    "explode/0",
    unary((value, runtime) => {
      if (typeof value !== "string") throw new JqError("explode input must be a string");
      runtime.charge(arrayBytes(value.length));
      return codePoints(value);
    }),
  );
  natives.set(
    "implode/0",
    unary((value, runtime) => {
      const text = implode(value);
      runtime.charge(stringBytes(text));
      return text;
    }),
  );
  natives.set(
    "_strindices/1",
    withArgs((value, [needle]) => {
      if (typeof value !== "string" || typeof needle !== "string") return [];
      return indices(value, needle);
    }),
  );
  natives.set(
    "trim/0",
    unary((value) => trim(value, true, true)),
  );
  natives.set(
    "ltrim/0",
    unary((value) => trim(value, true, false)),
  );
  natives.set(
    "rtrim/0",
    unary((value) => trim(value, false, true)),
  );
}

function implode(value: JqValue): string {
  if (!isArray(value)) throw new JqError("implode input must be an array");
  let out = "";
  for (const item of value) {
    if (!isNumber(item) || Number.isNaN(numberValue(item))) {
      throw typeError(item, "can't be imploded, unicode codepoint needs to be numeric");
    }
    let code = toInt(numberValue(item));
    if (code < 0 || code > 0x10ffff || (code >= 0xd800 && code <= 0xdfff)) code = 0xfffd;
    out += String.fromCodePoint(code);
  }
  return out;
}

/** jv_string_indexes: every (overlapping) match, as code point offsets. */
function indices(text: string, needle: string): JqValue[] {
  const found: JqValue[] = [];
  if (needle === "") return found;
  let counted = 0;
  let points = 0;
  for (let at = text.indexOf(needle); at !== -1; at = text.indexOf(needle, at + 1)) {
    points += codePointLength(text.slice(counted, at));
    counted = at;
    found.push(points);
  }
  return found;
}

function isWhitespace(code: number): boolean {
  return (
    (code >= 0x09 && code <= 0x0d) ||
    code === 0x20 ||
    code === 0x85 ||
    code === 0xa0 ||
    code === 0x1680 ||
    (code >= 0x2000 && code <= 0x200a) ||
    code === 0x2028 ||
    code === 0x2029 ||
    code === 0x202f ||
    code === 0x205f ||
    code === 0x3000
  );
}

function trim(value: JqValue, left: boolean, right: boolean): JqValue {
  if (typeof value !== "string") throw new JqError("trim input must be a string");
  let start = 0;
  let end = value.length;
  if (left) while (start < end && isWhitespace(value.charCodeAt(start))) start++;
  if (right) while (end > start && isWhitespace(value.charCodeAt(end - 1))) end--;
  return value.slice(start, end);
}
