// Oniguruma pattern syntax (ONIG_SYNTAX_PERL_NT) rewritten as a JavaScript
// `u`-mode source. Errors Oniguruma reports for malformed patterns come out
// as RegexFailure with its message; constructs whose meaning JavaScript cannot
// reproduce are refused.

import { JqRefusal } from "../errors.js";

const WORD = "\\p{L}\\p{M}\\p{Nd}\\p{Pc}";
const WORD_CLASS = `[${WORD}]`;
const START = "(?<![\\s\\S])";
const END = "(?![\\s\\S])";
const END_OR_FINAL_NEWLINE = "(?=\\n?(?![\\s\\S]))";
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

export interface RegexOptions {
  readonly global: boolean;
  readonly ignoreCase: boolean;
  readonly extended: boolean;
  readonly dotAll: boolean;
  readonly notEmpty: boolean;
}

export class RegexFailure extends Error {}

export interface Translation {
  readonly source: string;
  readonly names: ReadonlyArray<string | null>;
  readonly emptyAlternatives: boolean;
}

export class Translator {
  #at = 0;
  #out = "";
  #names: Array<string | null> = [];
  #depth = 0;
  #quantifiable = false;
  #quantified = false;
  #emptyAlternatives = false;

  constructor(
    private readonly pattern: string,
    private readonly options: RegexOptions,
  ) {}

  run(): Translation {
    const pattern = this.pattern;
    while (this.#at < pattern.length) {
      const char = pattern.charAt(this.#at);
      if (this.options.extended && /\s/.test(char)) {
        this.#at++;
        continue;
      }
      if (this.options.extended && char === "#") {
        const newline = pattern.indexOf("\n", this.#at);
        this.#at = newline === -1 ? pattern.length : newline + 1;
        continue;
      }
      this.#token(char);
    }
    if (this.#depth > 0) throw new RegexFailure("end pattern with unmatched parenthesis");
    return { source: this.#out, names: this.#names, emptyAlternatives: this.#emptyAlternatives };
  }

  #atom(source: string, quantifiable = true): void {
    this.#out += source;
    this.#quantifiable = quantifiable;
    this.#quantified = false;
  }

  #token(char: string): void {
    const pattern = this.pattern;
    switch (char) {
      case "\\":
        this.#at++;
        this.#atom(...this.#escape(false));
        return;
      case "[":
        this.#at++;
        this.#atom(this.#characterClass());
        return;
      case "(":
        this.#group();
        return;
      case ")":
        if (this.#depth === 0) throw new RegexFailure("unmatched close parenthesis");
        this.#depth--;
        this.#at++;
        this.#atom(")");
        return;
      case "|":
        this.#at++;
        this.#emptyAlternatives = true;
        this.#atom("|", false);
        return;
      case "*":
      case "+":
      case "?":
        this.#at++;
        this.#quantifier(char);
        return;
      case "{": {
        const interval = /^\{(\d+)(,(\d*))?\}/.exec(pattern.slice(this.#at));
        if (interval === null) {
          this.#at++;
          this.#atom("\\{");
          return;
        }
        const lower = Number(interval[1]);
        const upper = interval[3] === undefined || interval[3] === "" ? null : Number(interval[3]);
        if (upper !== null && upper < lower && interval[2] !== undefined) {
          throw new RegexFailure("upper is smaller than lower in repeat range");
        }
        this.#at += interval[0].length;
        this.#quantifier(interval[0]);
        return;
      }
      case "}":
      case "]":
        this.#at++;
        this.#atom(`\\${char}`);
        return;
      case ".":
        this.#at++;
        this.#atom(this.options.dotAll ? "[\\s\\S]" : "[^\\n]");
        return;
      case "^":
        this.#at++;
        this.#atom(START, false);
        return;
      case "$":
        this.#at++;
        this.#atom(END_OR_FINAL_NEWLINE, false);
        return;
      default: {
        const point = pattern.codePointAt(this.#at) ?? 0;
        const literal = String.fromCodePoint(point);
        this.#at += literal.length;
        this.#atom(literal);
      }
    }
  }

  #quantifier(text: string): void {
    if (!this.#quantifiable) {
      if (this.#quantified) throw new JqRefusal("repeated regex quantifiers are not supported");
      throw new RegexFailure("target of repeat operator is not specified");
    }
    let out = text;
    const next = this.pattern.charAt(this.#at);
    if (next === "?") {
      out += "?";
      this.#at++;
      this.#emptyAlternatives = true;
    } else if (next === "+") {
      throw new JqRefusal("possessive regex quantifiers are not supported");
    }
    this.#out += out;
    this.#quantifiable = false;
    this.#quantified = true;
  }

  #group(): void {
    const rest = this.pattern.slice(this.#at);
    this.#at++;
    if (!rest.startsWith("(?")) {
      this.#names.push(null);
      this.#open("(");
      return;
    }
    const named = /^\(\?(?:<([^>=!]*)>|'([^']*)')/.exec(rest);
    if (named !== null) {
      const name = named[1] ?? named[2] ?? "";
      if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name))
        throw new RegexFailure(`invalid group name <${name}>`);
      this.#names.push(name);
      this.#at += named[0].length - 1;
      this.#open(`(?<${name}>`);
      return;
    }
    const plainGroup = /^\(\?(?::|=|!|<=|<!)/.exec(rest);
    if (plainGroup !== null) {
      this.#at += plainGroup[0].length - 1;
      this.#open(plainGroup[0]);
      return;
    }
    if (rest.startsWith("(?#")) {
      const close = this.pattern.indexOf(")", this.#at);
      if (close === -1) throw new RegexFailure("end pattern in group");
      this.#at = close + 1;
      return;
    }
    throw new JqRefusal(`regex group ${rest.slice(0, 3)} is not supported`);
  }

  #open(source: string): void {
    this.#depth++;
    this.#out += source;
    this.#quantifiable = false;
    this.#quantified = false;
  }

  /** An escape after its backslash: [translation, quantifiable]. */
  #escape(inClass: boolean): [string, boolean] {
    const pattern = this.pattern;
    if (this.#at >= pattern.length) throw new RegexFailure("end pattern at escape");
    const char = pattern.charAt(this.#at);
    this.#at++;
    switch (char) {
      case "d":
        return ["\\p{Nd}", true];
      case "D":
        return ["\\P{Nd}", true];
      case "w":
        return [inClass ? WORD : WORD_CLASS, true];
      case "W":
        if (inClass) throw new JqRefusal("\\W inside a regex character class is not supported");
        return [`[^${WORD}]`, true];
      case "s":
        return ["\\p{White_Space}", true];
      case "S":
        return ["\\P{White_Space}", true];
      case "b":
        if (inClass) return ["\\x08", true];
        return [
          `(?:(?<=${WORD_CLASS})(?!${WORD_CLASS})|(?<!${WORD_CLASS})(?=${WORD_CLASS}))`,
          false,
        ];
      case "B":
        if (inClass) break;
        return [
          `(?:(?<=${WORD_CLASS})(?=${WORD_CLASS})|(?<!${WORD_CLASS})(?!${WORD_CLASS}))`,
          false,
        ];
      case "A":
        if (inClass) break;
        return [START, false];
      case "z":
        if (inClass) break;
        return [END, false];
      case "Z":
        if (inClass) break;
        return [END_OR_FINAL_NEWLINE, false];
      case "n":
      case "t":
      case "r":
      case "f":
      case "v":
        return [`\\${char}`, true];
      case "a":
        return ["\\x07", true];
      case "e":
        return ["\\x1b", true];
      case "x":
        return [this.#hex(), true];
      case "p":
      case "P":
        return [this.#property(char), true];
      case "k":
        if (inClass) break;
        return [this.#backreference(), true];
      default:
        if (/[1-9]/.test(char) && !inClass && !/[0-9]/.test(pattern.charAt(this.#at))) {
          return [`\\${char}`, true];
        }
        if (/[A-Za-z0-9]/.test(char)) break;
        return [(inClass ? CLASS_SYNTAX : JS_SYNTAX).has(char) ? `\\${char}` : char, true];
    }
    throw new JqRefusal(`regex escape \\${char} is not supported`);
  }

  #hex(): string {
    const pattern = this.pattern.slice(this.#at);
    const braced = /^\{([0-9A-Fa-f]{1,8})\}/.exec(pattern);
    if (braced !== null) {
      this.#at += braced[0].length;
      return `\\u{${braced[1]}}`;
    }
    const short = /^[0-9A-Fa-f]{1,2}/.exec(pattern);
    if (short === null) throw new JqRefusal("regex escape \\x without hex digits is not supported");
    this.#at += short[0].length;
    return `\\x${short[0].padStart(2, "0")}`;
  }

  #property(char: string): string {
    const body = /^\{(\^?)([A-Za-z_][A-Za-z0-9_=]*)\}/.exec(this.pattern.slice(this.#at));
    if (body === null)
      throw new JqRefusal(`regex escape \\${char} without a property name is not supported`);
    this.#at += body[0].length;
    const negated = (char === "P") !== (body[1] === "^");
    return `\\${negated ? "P" : "p"}{${body[2]}}`;
  }

  #backreference(): string {
    const body = /^(?:<([A-Za-z_][A-Za-z0-9_]*)>|'([A-Za-z_][A-Za-z0-9_]*)')/.exec(
      this.pattern.slice(this.#at),
    );
    if (body === null) throw new JqRefusal("this \\k backreference form is not supported");
    this.#at += body[0].length;
    return `\\k<${body[1] ?? body[2]}>`;
  }

  #characterClass(): string {
    const pattern = this.pattern;
    let out = "[";
    if (pattern.charAt(this.#at) === "^") {
      out += "^";
      this.#at++;
    }
    let first = true;
    for (;;) {
      if (this.#at >= pattern.length) throw new RegexFailure("premature end of char-class");
      const char = pattern.charAt(this.#at);
      if (char === "]" && !first) {
        this.#at++;
        return `${out}]`;
      }
      first = false;
      if (char === "]") {
        out += "\\]";
        this.#at++;
      } else if (char === "[") out += this.#posix();
      else if (char === "\\") {
        this.#at++;
        out += this.#escape(true)[0];
      } else if (char === "&" && pattern.charAt(this.#at + 1) === "&") {
        throw new JqRefusal("regex character class intersection (&&) is not supported");
      } else if (this.options.extended && /\s/.test(char)) {
        throw new JqRefusal(
          "whitespace inside a regex character class with the x flag is not supported",
        );
      } else {
        const literal = String.fromCodePoint(pattern.codePointAt(this.#at) ?? 0);
        this.#at += literal.length;
        out += literal;
      }
    }
  }

  #posix(): string {
    const bracket = /^\[:(\^?)([A-Za-z]*):\]/.exec(this.pattern.slice(this.#at));
    if (bracket === null) throw new JqRefusal("nested regex character classes are not supported");
    const name = bracket[2] ?? "";
    const translated = POSIX.get(name);
    if (translated === undefined) {
      if (KNOWN_POSIX.has(name)) throw new JqRefusal(`POSIX bracket [:${name}:] is not supported`);
      throw new RegexFailure("invalid POSIX bracket type");
    }
    if (bracket[1] === "^") throw new JqRefusal("negated POSIX brackets are not supported");
    this.#at += bracket[0].length;
    return translated;
  }
}
