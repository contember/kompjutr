// Oniguruma (ONIG_SYNTAX_PERL_NT, UTF-8) patterns translated to JavaScript
// RegExp. A construct whose meaning would differ is refused, never
// approximated: possessive and atomic groups, inline options, \h, \K, \G,
// nested classes, intersections, and `n` together with a lazy quantifier or an
// alternation (Oniguruma retries for a non-empty match; JavaScript cannot).
// Unicode \d \w \s \b use Oniguruma's Unicode definitions.

import { JqError, JqRefusal, typeError } from "../errors.js";
import { arrayBytes, stringBytes } from "../paths.js";
import { codePointLength, type JqValue } from "../value.js";
import { type Natives, withArgs } from "./native.js";
import { RegexFailure, type RegexOptions, type Translation, Translator } from "./regex-syntax.js";

interface Compiled {
  readonly regex: RegExp;
  readonly names: ReadonlyArray<string | null>;
  readonly notEmpty: boolean;
}

export function registerRegex(natives: Natives): void {
  natives.set(
    "_match_impl/3",
    withArgs((input, [regex, modifiers, testMode], runtime) => {
      const result = matchAll(input, regex ?? null, modifiers ?? null, testMode === true);
      if (Array.isArray(result))
        runtime.charge(arrayBytes(result.length) + stringBytes(String(input)) * 2);
      return result;
    }),
  );
}

function parseOptions(modifiers: JqValue): RegexOptions {
  const options = {
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

function compile(pattern: string, options: RegexOptions): Compiled {
  let translated: Translation;
  try {
    translated = new Translator(pattern, options).run();
  } catch (error) {
    if (error instanceof RegexFailure) throw new JqError(`Regex failure: ${error.message}`);
    throw error;
  }
  if (options.notEmpty && translated.emptyAlternatives) {
    throw new JqRefusal(
      "the n regex flag with a lazy quantifier or an alternation is not supported",
    );
  }
  try {
    const flags = `dgu${options.ignoreCase ? "i" : ""}`;
    return {
      regex: new RegExp(translated.source, flags),
      names: translated.names,
      notEmpty: options.notEmpty,
    };
  } catch {
    throw new JqRefusal(`regular expression ${JSON.stringify(pattern)} is not supported`);
  }
}

function matchAll(input: JqValue, regex: JqValue, modifiers: JqValue, test: boolean): JqValue {
  if (typeof input !== "string") throw typeError(input, "cannot be matched, as it is not a string");
  if (typeof regex !== "string") throw typeError(regex, "is not a string");
  const options = parseOptions(modifiers);
  if (options.ignoreCase && (hasMultiCharFold(regex) || hasMultiCharFold(input))) {
    throw new JqRefusal(
      "case-insensitive matching of characters with multi-character case folds is not supported",
    );
  }
  const { regex: compiled, names, notEmpty } = compile(regex, options);
  const results: JqValue[] = [];
  const points = new CodePointIndex(input);
  let start = 0;
  do {
    compiled.lastIndex = start;
    const match = compiled.exec(input);
    if (match === null) break;
    const text = match[0];
    if (notEmpty && text === "") {
      start = match.index + unitWidth(input, match.index);
      if (start > input.length) break;
      continue;
    }
    if (test) return true;
    results.push(describe(match, names, points));
    start = text === "" ? match.index + unitWidth(input, match.index) : match.index + text.length;
  } while (options.global && start <= input.length);
  return test ? false : results;
}

/** Oniguruma folds ß to "ss"; JavaScript's simple case folding does not. */
function hasMultiCharFold(text: string): boolean {
  for (const char of text) {
    if (char.charCodeAt(0) < 0x80) continue;
    if (char.toUpperCase().length !== char.length || char.toLowerCase().length !== char.length)
      return true;
  }
  return false;
}

function unitWidth(text: string, at: number): number {
  const unit = text.charCodeAt(at);
  return unit >= 0xd800 && unit <= 0xdbff && at + 1 < text.length ? 2 : 1;
}

class CodePointIndex {
  #unit = 0;
  #point = 0;

  constructor(private readonly text: string) {}

  at(unit: number): number {
    if (unit < this.#unit) {
      this.#unit = 0;
      this.#point = 0;
    }
    this.#point += codePointLength(this.text.slice(this.#unit, unit));
    this.#unit = unit;
    return this.#point;
  }
}

function describe(
  match: RegExpExecArray,
  names: ReadonlyArray<string | null>,
  points: CodePointIndex,
): JqValue {
  const text = match[0];
  const offset = points.at(match.index);
  const indices = match.indices;
  const captures: JqValue[] = [];
  for (let group = 1; group < match.length; group++) {
    const captured = match[group];
    const name = names[group - 1] ?? null;
    const span = indices?.[group];
    if (captured === undefined || span === undefined) {
      captures.push(
        capture([
          ["offset", -1],
          ["string", null],
          ["length", 0],
          ["name", name],
        ]),
      );
    } else if (text === "" || captured === "") {
      const at = text === "" ? offset : points.at(span[0]);
      captures.push(
        capture([
          ["offset", at],
          ["string", ""],
          ["length", 0],
          ["name", name],
        ]),
      );
    } else {
      captures.push(
        capture([
          ["offset", points.at(span[0])],
          ["length", codePointLength(captured)],
          ["string", captured],
          ["name", name],
        ]),
      );
    }
  }
  return new Map<string, JqValue>([
    ["offset", offset],
    ["length", codePointLength(text)],
    ["string", text],
    ["captures", captures],
  ]);
}

function capture(entries: ReadonlyArray<readonly [string, JqValue]>): JqValue {
  return new Map(entries);
}
