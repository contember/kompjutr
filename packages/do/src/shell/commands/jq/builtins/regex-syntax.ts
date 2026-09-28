// Oniguruma pattern syntax (ONIG_SYNTAX_PERL_NT) parsed to a tree for the
// linear-time matcher in regex-vm.ts. A character class or escape becomes a
// JavaScript `u`-mode fragment that tests exactly one code point, so JS RegExp
// never runs a whole pattern and cannot backtrack. Malformed patterns fail
// with Oniguruma's message; constructs a finite automaton cannot express
// (backreferences, lookaround, atomic and possessive forms) are refused.

import { JqRefusal } from "../errors.js";

const WORD = "\\p{L}\\p{M}\\p{Nd}\\p{Pc}";
const JS_SYNTAX = new Set("^$\\.*+?()[]{}|/");
const CLASS_SYNTAX = new Set("^$\\.*+?()[]{}|/-");
const POSIX = new Map([
  ["alpha", "\\p{Alphabetic}"],
  ["digit", "\\p{Nd}"],
  ["alnum", "\\p{Alphabetic}\\p{Nd}"],
  ["upper", "\\p{Uppercase}"],
  ["lower", "\\p{Lowercase}"],
  ["space", "\\p{White_Space}"],
  ["xdigit", "0-9A-Fa-f"],
  ["word", WORD],
]);
const KNOWN_POSIX = new Set(["punct", "cntrl", "graph", "print", "blank", "ascii"]);
const MAX_REPEAT = 100_000;
const MAX_DEPTH = 1024;

export const WORD_CLASS = `[${WORD}]`;

export type Assertion = "start" | "end" | "end-newline" | "word" | "not-word";

export type RegexNode =
  | { readonly kind: "char"; readonly source: string }
  | { readonly kind: "any"; readonly newline: boolean }
  | { readonly kind: "assert"; readonly assertion: Assertion }
  | { readonly kind: "concat"; readonly items: readonly RegexNode[] }
  | { readonly kind: "alt"; readonly items: readonly RegexNode[] }
  | {
      readonly kind: "repeat";
      readonly node: RegexNode;
      readonly min: number;
      readonly max: number | null;
      readonly lazy: boolean;
    }
  | { readonly kind: "group"; readonly index: number; readonly node: RegexNode };

export interface RegexFlags {
  ignoreCase: boolean;
  extended: boolean;
  dotAll: boolean;
}

export interface ParsedRegex {
  readonly root: RegexNode;
  readonly names: ReadonlyArray<string | null>;
  readonly ignoreCase: boolean;
}

export class RegexFailure extends Error {}

export function parseRegex(pattern: string, flags: RegexFlags): ParsedRegex {
  const leading = /^\(\?([ix]+)\)/.exec(pattern);
  let at = 0;
  const options = { ...flags };
  if (leading !== null) {
    if (leading[1]?.includes("i")) options.ignoreCase = true;
    if (leading[1]?.includes("x")) options.extended = true;
    at = leading[0].length;
  }
  const parser = new RegexParser(pattern, options, at);
  return { root: parser.parse(), names: parser.names, ignoreCase: options.ignoreCase };
}

class RegexParser {
  readonly names: Array<string | null> = [];
  #depth = 0;

  constructor(
    private readonly pattern: string,
    private readonly options: RegexFlags,
    private at: number,
  ) {}

  parse(): RegexNode {
    const root = this.#alternation();
    if (this.at < this.pattern.length) throw new RegexFailure("unmatched close parenthesis");
    return root;
  }

  #skipExtended(): void {
    if (!this.options.extended) return;
    for (;;) {
      const char = this.pattern.charAt(this.at);
      if (char !== "" && /\s/.test(char)) this.at++;
      else if (char === "#") {
        const newline = this.pattern.indexOf("\n", this.at);
        this.at = newline === -1 ? this.pattern.length : newline + 1;
      } else return;
    }
  }

  #peek(): string {
    this.#skipExtended();
    return this.pattern.charAt(this.at);
  }

  #alternation(): RegexNode {
    const items = [this.#concatenation()];
    while (this.#peek() === "|") {
      this.at++;
      items.push(this.#concatenation());
    }
    return items.length === 1
      ? (items[0] ?? { kind: "concat", items: [] })
      : { kind: "alt", items };
  }

  #concatenation(): RegexNode {
    const items: RegexNode[] = [];
    for (;;) {
      const char = this.#peek();
      if (char === "" || char === "|" || char === ")") break;
      if (char === "(" && this.pattern.startsWith("(?#", this.at)) {
        const close = this.pattern.indexOf(")", this.at);
        if (close === -1) throw new RegexFailure("end pattern in group");
        this.at = close + 1;
        continue;
      }
      if ("*+?".includes(char))
        throw new RegexFailure("target of repeat operator is not specified");
      if (char === "{" && this.#interval() !== null) {
        throw new RegexFailure("target of repeat operator is not specified");
      }
      items.push(this.#quantified(this.#atom()));
    }
    return items.length === 1
      ? (items[0] ?? { kind: "concat", items: [] })
      : { kind: "concat", items };
  }

  #interval(): { min: number; max: number | null; length: number } | null {
    const interval = /^\{(\d+)(,(\d*))?\}/.exec(this.pattern.slice(this.at));
    if (interval === null) return null;
    const min = Number(interval[1]);
    const max = interval[2] === undefined ? min : interval[3] === "" ? null : Number(interval[3]);
    if (min > MAX_REPEAT || (max !== null && max > MAX_REPEAT)) {
      throw new RegexFailure("too big number for repeat range");
    }
    if (max !== null && max < min)
      throw new RegexFailure("upper is smaller than lower in repeat range");
    return { min, max, length: interval[0].length };
  }

  #quantified(atom: RegexNode): RegexNode {
    let node = atom;
    for (;;) {
      const char = this.#peek();
      let min: number;
      let max: number | null;
      if (char === "*" || char === "+" || char === "?") {
        this.at++;
        min = char === "+" ? 1 : 0;
        max = char === "?" ? 1 : null;
      } else if (char === "{") {
        const interval = this.#interval();
        if (interval === null) return node;
        this.at += interval.length;
        min = interval.min;
        max = interval.max;
      } else return node;
      if (node.kind === "assert") throw new RegexFailure("target of repeat operator is invalid");
      let lazy = false;
      const next = this.pattern.charAt(this.at);
      if (next === "?") {
        lazy = true;
        this.at++;
      } else if (next === "+")
        throw new JqRefusal("possessive regex quantifiers are not supported");
      node = { kind: "repeat", node, min, max, lazy };
    }
  }

  #atom(): RegexNode {
    const char = this.pattern.charAt(this.at);
    switch (char) {
      case "\\":
        this.at++;
        return this.#escape();
      case "[":
        this.at++;
        return { kind: "char", source: this.#characterClass() };
      case "(":
        return this.#group();
      case ".":
        this.at++;
        return { kind: "any", newline: this.options.dotAll };
      case "^":
        this.at++;
        return { kind: "assert", assertion: "start" };
      case "$":
        this.at++;
        return { kind: "assert", assertion: "end-newline" };
      default: {
        const literal = String.fromCodePoint(this.pattern.codePointAt(this.at) ?? 0);
        this.at += literal.length;
        return literalNode(literal);
      }
    }
  }

  #group(): RegexNode {
    const rest = this.pattern.slice(this.at);
    this.#depth++;
    if (this.#depth > MAX_DEPTH) throw new RegexFailure("parse depth limit over");
    let index = -1;
    if (!rest.startsWith("(?")) {
      this.at++;
      this.names.push(null);
      index = this.names.length;
    } else {
      const named = /^\(\?(?:<([^>=!]*)>|'([^']*)')/.exec(rest);
      if (named !== null) {
        const name = named[1] ?? named[2] ?? "";
        if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) {
          throw new RegexFailure(`invalid group name <${name}>`);
        }
        this.names.push(name);
        index = this.names.length;
        this.at += named[0].length;
      } else if (rest.startsWith("(?:")) this.at += 3;
      else if (/^\(\?(?:=|!|<=|<!)/.test(rest))
        throw new JqRefusal("regex lookaround is not supported");
      else throw new JqRefusal(`regex group ${rest.slice(0, 3)} is not supported`);
    }
    const node = this.#alternation();
    if (this.pattern.charAt(this.at) !== ")")
      throw new RegexFailure("end pattern with unmatched parenthesis");
    this.at++;
    this.#depth--;
    return index === -1 ? node : { kind: "group", index, node };
  }

  #escape(): RegexNode {
    const char = this.pattern.charAt(this.at);
    switch (char) {
      case "b":
        this.at++;
        return { kind: "assert", assertion: "word" };
      case "B":
        this.at++;
        return { kind: "assert", assertion: "not-word" };
      case "A":
        this.at++;
        return { kind: "assert", assertion: "start" };
      case "z":
        this.at++;
        return { kind: "assert", assertion: "end" };
      case "Z":
        this.at++;
        return { kind: "assert", assertion: "end-newline" };
      default:
        return { kind: "char", source: this.#escapeSource(false) };
    }
  }

  /** An escape inside or outside a class, after its backslash, as a class fragment. */
  #escapeSource(inClass: boolean): string {
    const pattern = this.pattern;
    if (this.at >= pattern.length) throw new RegexFailure("end pattern at escape");
    const char = pattern.charAt(this.at);
    this.at++;
    switch (char) {
      case "d":
        return "\\p{Nd}";
      case "D":
        return "\\P{Nd}";
      case "w":
        return inClass ? WORD : WORD_CLASS;
      case "W":
        if (inClass) throw new JqRefusal("\\W inside a regex character class is not supported");
        return `[^${WORD}]`;
      case "s":
        return "\\p{White_Space}";
      case "S":
        return "\\P{White_Space}";
      case "b":
        if (inClass) return "\\x08";
        break;
      case "n":
      case "t":
      case "r":
      case "f":
      case "v":
        return `\\${char}`;
      case "a":
        return "\\x07";
      case "e":
        return "\\x1b";
      case "x":
        return this.#hex();
      case "p":
      case "P":
        return this.#property(char);
      case "k":
        throw new JqRefusal("regex backreferences are not supported");
      default:
        if (/[1-9]/.test(char) && !inClass)
          throw new JqRefusal("regex backreferences are not supported");
        if (/[A-Za-z0-9]/.test(char)) break;
        return (inClass ? CLASS_SYNTAX : JS_SYNTAX).has(char) ? `\\${char}` : char;
    }
    throw new JqRefusal(`regex escape \\${char} is not supported`);
  }

  #hex(): string {
    const pattern = this.pattern.slice(this.at);
    const braced = /^\{([0-9A-Fa-f]{1,8})\}/.exec(pattern);
    if (braced !== null) {
      this.at += braced[0].length;
      return `\\u{${braced[1]}}`;
    }
    const short = /^[0-9A-Fa-f]{1,2}/.exec(pattern);
    if (short === null) throw new JqRefusal("regex escape \\x without hex digits is not supported");
    this.at += short[0].length;
    return `\\x${short[0].padStart(2, "0")}`;
  }

  #property(char: string): string {
    const body = /^\{(\^?)([A-Za-z_][A-Za-z0-9_=]*)\}/.exec(this.pattern.slice(this.at));
    if (body === null) {
      throw new JqRefusal(`regex escape \\${char} without a property name is not supported`);
    }
    this.at += body[0].length;
    const negated = (char === "P") !== (body[1] === "^");
    return `\\${negated ? "P" : "p"}{${body[2]}}`;
  }

  #characterClass(): string {
    const pattern = this.pattern;
    let out = "[";
    if (pattern.charAt(this.at) === "^") {
      out += "^";
      this.at++;
    }
    let first = true;
    for (;;) {
      if (this.at >= pattern.length) throw new RegexFailure("premature end of char-class");
      const char = pattern.charAt(this.at);
      if (char === "]" && !first) {
        this.at++;
        return `${out}]`;
      }
      first = false;
      if (char === "]") {
        out += "\\]";
        this.at++;
      } else if (char === "[") out += this.#posix();
      else if (char === "\\") {
        this.at++;
        out += this.#escapeSource(true);
      } else if (char === "&" && pattern.charAt(this.at + 1) === "&") {
        throw new JqRefusal("regex character class intersection (&&) is not supported");
      } else if (this.options.extended && /\s/.test(char)) {
        throw new JqRefusal(
          "whitespace inside a regex character class with the x flag is not supported",
        );
      } else {
        const literal = String.fromCodePoint(pattern.codePointAt(this.at) ?? 0);
        this.at += literal.length;
        out += literal;
      }
    }
  }

  #posix(): string {
    const bracket = /^\[:(\^?)([A-Za-z]*):\]/.exec(this.pattern.slice(this.at));
    if (bracket === null) throw new JqRefusal("nested regex character classes are not supported");
    const name = bracket[2] ?? "";
    const translated = POSIX.get(name);
    if (translated === undefined) {
      if (KNOWN_POSIX.has(name)) throw new JqRefusal(`POSIX bracket [:${name}:] is not supported`);
      throw new RegexFailure("invalid POSIX bracket type");
    }
    if (bracket[1] === "^") throw new JqRefusal("negated POSIX brackets are not supported");
    this.at += bracket[0].length;
    return translated;
  }
}

function literalNode(literal: string): RegexNode {
  return { kind: "char", source: JS_SYNTAX.has(literal) ? `\\${literal}` : literal };
}
