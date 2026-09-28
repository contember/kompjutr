// jq's regex builtins (f_match in src/builtin.c) over the linear-time matcher
// in regex-vm.ts. Offsets and lengths are in code points. After an empty
// match jq resumes one byte later, so inside a multi-byte code point it finds
// further empty matches; that stepping is reproduced. Where Oniguruma gives up
// with "retry-limit-in-match over", this matcher returns the actual result.

import { JqError, JqRefusal, typeError } from "../errors.js";
import { arrayBytes, stringBytes } from "../paths.js";
import type { JqValue } from "../value.js";
import { type Natives, withArgs } from "./native.js";
import { parseRegex, RegexFailure } from "./regex-syntax.js";
import { compileProgram, Matcher, type Program } from "./regex-vm.js";

interface MatchOptions {
  global: boolean;
  ignoreCase: boolean;
  extended: boolean;
  dotAll: boolean;
  notEmpty: boolean;
}

export function registerRegex(natives: Natives): void {
  natives.set(
    "_match_impl/3",
    withArgs((input, [regex, modifiers, testMode], runtime) => {
      const result = matchAll(
        input,
        regex ?? null,
        modifiers ?? null,
        testMode === true,
        runtime.charge,
      );
      if (Array.isArray(result))
        runtime.charge(arrayBytes(result.length) + stringBytes(String(input)) * 2);
      return result;
    }),
  );
}

function parseOptions(modifiers: JqValue): MatchOptions {
  const options: MatchOptions = {
    global: false,
    ignoreCase: false,
    extended: false,
    dotAll: false,
    notEmpty: false,
  };
  if (modifiers === null) return options;
  if (typeof modifiers !== "string") throw typeError(modifiers, "is not a string");
  for (const flag of modifiers) {
    if (flag === "g") options.global = true;
    else if (flag === "i") options.ignoreCase = true;
    else if (flag === "x") options.extended = true;
    else if (flag === "m" || flag === "p") options.dotAll = true;
    else if (flag === "s") continue;
    else if (flag === "n") options.notEmpty = true;
    else if (flag === "l") throw new JqRefusal("the l (longest match) regex flag is not supported");
    else throw new JqError(`${modifiers} is not a valid modifier string`);
  }
  return options;
}

function matchAll(
  input: JqValue,
  regex: JqValue,
  modifiers: JqValue,
  test: boolean,
  charge: (bytes: number) => void,
): JqValue {
  if (typeof input !== "string") throw typeError(input, "cannot be matched, as it is not a string");
  if (typeof regex !== "string") throw typeError(regex, "is not a string");
  const options = parseOptions(modifiers);
  let parsed: ReturnType<typeof parseRegex>;
  let program: Program;
  try {
    parsed = parseRegex(regex, options);
    program = compileProgram(parsed.root, parsed.names.length, parsed.ignoreCase, charge);
  } catch (error) {
    if (error instanceof RegexFailure) throw new JqError(`Regex failure: ${error.message}`);
    throw error;
  }
  if (parsed.ignoreCase && (hasMultiCharFold(regex) || hasMultiCharFold(input))) {
    throw new JqRefusal(
      "case-insensitive matching of characters with multi-character case folds is not supported",
    );
  }
  const text = new CodePoints(input, charge);
  const matcher = new Matcher(program, text.points);
  const results: JqValue[] = [];
  let start = 0;
  // Byte positions left inside the code point before `start`, after an empty match.
  let inside = 0;
  for (;;) {
    let caps = inside > 0 ? matcher.matchInside(start, options.notEmpty) : null;
    const mid = caps !== null;
    if (caps === null) {
      inside = 0;
      caps = matcher.search(start, options.notEmpty);
    }
    if (caps === null) break;
    if (test) return true;
    results.push(describe(caps, parsed.names, text));
    if (!options.global) break;
    if (mid) {
      inside--;
      continue;
    }
    const matchStart = caps[0] ?? 0;
    const matchEnd = caps[1] ?? 0;
    if (matchEnd > matchStart) {
      start = matchEnd;
      continue;
    }
    if (matchStart >= text.points.length) break;
    inside = utf8Width(text.points[matchStart] ?? 0) - 1;
    start = matchStart + 1;
  }
  return test ? false : results;
}

function utf8Width(point: number): number {
  return point < 0x80 ? 1 : point < 0x800 ? 2 : point < 0x10000 ? 3 : 4;
}

/** Oniguruma folds ß to "ss"; per-character case folding does not. */
function hasMultiCharFold(text: string): boolean {
  for (const char of text) {
    if (char.charCodeAt(0) < 0x80) continue;
    if (char.toUpperCase().length !== char.length || char.toLowerCase().length !== char.length) {
      return true;
    }
  }
  return false;
}

class CodePoints {
  readonly points: number[] = [];
  readonly #offsets: number[] = [];

  constructor(
    private readonly text: string,
    charge: (bytes: number) => void,
  ) {
    charge(16 * text.length);
    let unit = 0;
    for (const char of text) {
      this.points.push(char.codePointAt(0) ?? 0);
      this.#offsets.push(unit);
      unit += char.length;
    }
    this.#offsets.push(unit);
  }

  slice(start: number, end: number): string {
    return this.text.slice(this.#offsets[start] ?? 0, this.#offsets[end] ?? this.text.length);
  }
}

function describe(
  caps: Int32Array,
  names: ReadonlyArray<string | null>,
  text: CodePoints,
): JqValue {
  const start = caps[0] ?? 0;
  const end = caps[1] ?? 0;
  const captures: JqValue[] = [];
  for (let group = 1; group <= names.length; group++) {
    const from = caps[group * 2] ?? -1;
    const to = caps[group * 2 + 1] ?? -1;
    const name = names[group - 1] ?? null;
    if (from === -1 || to === -1) {
      captures.push(
        entries([
          ["offset", -1],
          ["string", null],
          ["length", 0],
          ["name", name],
        ]),
      );
    } else if (start === end || from === to) {
      const at = start === end ? start : from;
      captures.push(
        entries([
          ["offset", at],
          ["string", ""],
          ["length", 0],
          ["name", name],
        ]),
      );
    } else {
      captures.push(
        entries([
          ["offset", from],
          ["length", to - from],
          ["string", text.slice(from, to)],
          ["name", name],
        ]),
      );
    }
  }
  return new Map<string, JqValue>([
    ["offset", start],
    ["length", end - start],
    ["string", text.slice(start, end)],
    ["captures", captures],
  ]);
}

function entries(pairs: ReadonlyArray<readonly [string, JqValue]>): JqValue {
  return new Map(pairs);
}
