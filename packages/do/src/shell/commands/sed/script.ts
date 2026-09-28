// sed scripts: commands separated by `;` or newlines, each with an optional
// address or `a,b` range and `!`. Commands are `s`, `p`, `d`, `q`, `=`, the
// one-line `a`, `i`, `c`, and `{ }` blocks. The hold space, labels, branches,
// and file commands are refused by name. Diagnostics follow GNU's `-e expression #N, char M:`.

import { compilePattern, PatternError } from "../search/regex.js";

export type Address =
  | { readonly kind: "line"; readonly line: number }
  /** `+N` as a range end: the N lines after the start. */
  | { readonly kind: "relative"; readonly count: number }
  | { readonly kind: "last" }
  | { readonly kind: "regex"; readonly pattern: RegExp };

export type Action =
  | {
      readonly kind: "s";
      readonly pattern: RegExp;
      readonly replacement: readonly ReplacementPart[];
      /** `g` replaces this occurrence and every later one. */
      readonly global: boolean;
      /** The first occurrence to replace, from a numeric flag; 1 by default. */
      readonly occurrence: number;
      readonly print: boolean;
    }
  | { readonly kind: "p" }
  | { readonly kind: "d" }
  | { readonly kind: "=" }
  | { readonly kind: "q"; readonly status: number }
  | { readonly kind: "a" | "i" | "c"; readonly text: string }
  | { readonly kind: "block"; readonly commands: readonly SedCommand[] };

export type ReplacementPart =
  | { readonly kind: "text"; readonly value: string }
  | { readonly kind: "group"; readonly index: number };

export interface SedCommand {
  readonly from: Address | null;
  readonly to: Address | null;
  readonly negated: boolean;
  readonly action: Action;
}

export class SedScriptError extends Error {}

const HOLD = "the hold space is not supported";
const BRANCHES = "branches and labels are not supported";
const FILES = "file commands are not supported";

const REFUSED: ReadonlyMap<string, string> = new Map([
  ["h", HOLD],
  ["H", HOLD],
  ["g", HOLD],
  ["G", HOLD],
  ["x", HOLD],
  ["b", BRANCHES],
  ["t", BRANCHES],
  ["T", BRANCHES],
  [":", BRANCHES],
  ["r", FILES],
  ["R", FILES],
  ["w", FILES],
  ["W", FILES],
  ...["n", "N", "D", "P", "y", "l", "e", "F", "z"].map((letter): [string, string] => [
    letter,
    `\`${letter}' is not supported`,
  ]),
]);

export function parseScripts(scripts: readonly string[], extended: boolean): SedCommand[] {
  const commands: SedCommand[] = [];
  for (const [index, script] of scripts.entries()) {
    commands.push(...new ScriptParser(script, index + 1, extended).parse());
  }
  return commands;
}

class ScriptParser {
  #at = 0;

  constructor(
    private readonly source: string,
    private readonly expression: number,
    private readonly extended: boolean,
  ) {}

  parse(): SedCommand[] {
    const commands = this.#sequence(false);
    if (this.#at < this.source.length) this.#fail("unexpected `}'", this.#at + 1);
    return commands;
  }

  /** Commands up to the end of the script, or through the `}` closing a block. */
  #sequence(inBlock: boolean): SedCommand[] {
    const commands: SedCommand[] = [];
    for (;;) {
      this.#skip(" \t\n;");
      if (this.#peek() === "}") {
        if (!inBlock) return commands;
        this.#at++;
        return commands;
      }
      if (this.#at >= this.source.length) {
        if (inBlock) this.#fail("unmatched `{'", 0);
        return commands;
      }
      commands.push(this.#command());
      this.#skip(" \t");
      const next = this.#peek();
      if (next !== "" && next !== ";" && next !== "\n" && next !== "}") {
        this.#fail(`extra characters after command`);
      }
    }
  }

  #command(): SedCommand {
    const from = this.#address();
    let to: Address | null = null;
    if (from !== null && this.#peek() === ",") {
      this.#at++;
      this.#skip(" \t");
      to = this.#rangeEnd();
    }
    this.#skip(" \t");
    let negated = false;
    while (this.#peek() === "!") {
      negated = true;
      this.#at++;
      this.#skip(" \t");
    }
    const letter = this.#take();
    if (letter === "") this.#fail("missing command");
    // Line 0 only starts a range whose end is a regex, which may match line 1.
    if (from?.kind === "line" && from.line === 0 && to?.kind !== "regex") {
      this.#fail("invalid usage of line address 0");
    }
    return { from, to, negated, action: this.#action(letter) };
  }

  #rangeEnd(): Address {
    if (this.#peek() === "+") {
      this.#at++;
      const digits = /^[0-9]+/.exec(this.source.slice(this.#at))?.[0] ?? "";
      if (digits === "") this.#fail("unexpected `,'");
      this.#at += digits.length;
      return { kind: "relative", count: Number(digits) };
    }
    const to = this.#address();
    if (to === null) this.#fail("unexpected `,'");
    return to;
  }

  #address(): Address | null {
    const char = this.#peek();
    if (/[0-9]/.test(char)) {
      const digits = /^[0-9]+/.exec(this.source.slice(this.#at))?.[0] ?? "";
      this.#at += digits.length;
      return { kind: "line", line: Number(digits) };
    }
    if (char === "$") {
      this.#at++;
      return { kind: "last" };
    }
    if (char === "/" || char === "\\") {
      if (char === "\\") this.#at++;
      const delimiter = this.#take();
      const body = this.#delimited(delimiter, "unterminated address regex");
      const ignoreCase = this.#peek() === "I";
      if (ignoreCase) this.#at++;
      return { kind: "regex", pattern: this.#regex(body, ignoreCase) };
    }
    return null;
  }

  #action(letter: string): Action {
    switch (letter) {
      case "s":
        return this.#substitute();
      case "p":
        return { kind: "p" };
      case "d":
        return { kind: "d" };
      case "=":
        return { kind: "=" };
      case "q": {
        this.#skip(" \t");
        const digits = /^[0-9]*/.exec(this.source.slice(this.#at))?.[0] ?? "";
        this.#at += digits.length;
        return { kind: "q", status: digits === "" ? 0 : Number(digits) };
      }
      case "a":
      case "i":
      case "c":
        return { kind: letter, text: this.#text() };
      case "{":
        return { kind: "block", commands: this.#sequence(true) };
      default: {
        const refused = REFUSED.get(letter);
        if (refused !== undefined) this.#fail(refused);
        this.#fail(`unknown command: \`${letter}'`, this.#at);
      }
    }
  }

  #substitute(): Action {
    const delimiter = this.#take();
    if (delimiter === "" || delimiter === "\n" || delimiter === "\\") {
      this.#fail("unterminated `s' command");
    }
    const pattern = this.#delimited(delimiter, "unterminated `s' command");
    const replacement = this.#delimited(delimiter, "unterminated `s' command", true);
    let global = false;
    let print = false;
    let ignoreCase = false;
    let occurrence = 1;
    for (;;) {
      const flag = this.#peek();
      const digits = /^[0-9]+/.exec(this.source.slice(this.#at))?.[0];
      if (digits !== undefined) {
        occurrence = Number(digits);
        if (occurrence === 0)
          this.#fail("number option to `s' command may not be zero", this.#at + 1);
        this.#at += digits.length;
        continue;
      }
      if (flag === "g") global = true;
      else if (flag === "p") print = true;
      else if (flag === "i" || flag === "I") ignoreCase = true;
      else if (flag === "" || " \t;\n}".includes(flag)) break;
      else this.#fail("unknown option to `s'", this.#at + 1);
      this.#at++;
    }
    return {
      kind: "s",
      pattern: this.#regex(pattern, ignoreCase),
      replacement: replacementParts(replacement),
      global,
      occurrence,
      print,
    };
  }

  /** GNU's one-line form: `a text`, with leading blanks and one `\` skipped. */
  #text(): string {
    this.#skip(" \t");
    if (this.#peek() === "\\") {
      this.#at++;
      if (this.#peek() === "\n") this.#at++;
    }
    const end = this.source.indexOf("\n", this.#at);
    const text = this.source.slice(this.#at, end === -1 ? this.source.length : end);
    this.#at = end === -1 ? this.source.length : end;
    return text;
  }

  /** Text up to an unescaped delimiter; `\<delimiter>` stands for the delimiter. */
  #delimited(delimiter: string, unterminated: string, keepEscapes = false): string {
    let text = "";
    for (;;) {
      const char = this.#take();
      if (char === "" || char === "\n") this.#fail(unterminated);
      if (char === delimiter) return text;
      if (char === "\\") {
        const next = this.#take();
        if (next === "") this.#fail(unterminated);
        text += next === delimiter && !keepEscapes ? next : `\\${next}`;
        continue;
      }
      text += char;
    }
  }

  #regex(body: string, ignoreCase: boolean): RegExp {
    if (body === "") this.#fail("no previous regular expression");
    try {
      const compiled = compilePattern(body, {
        dialect: this.extended ? "ere" : "bre",
        ignoreCase,
        wholeWord: false,
        wholeLine: false,
      });
      return new RegExp(compiled.source, compiled.flags.replace("g", ""));
    } catch (error) {
      if (error instanceof PatternError) this.#fail(error.message);
      throw error;
    }
  }

  #skip(characters: string): void {
    while (this.#at < this.source.length && characters.includes(this.source.charAt(this.#at))) {
      this.#at++;
    }
  }

  #peek(): string {
    return this.source.charAt(this.#at);
  }

  #take(): string {
    const char = this.source.charAt(this.#at);
    if (char !== "") this.#at++;
    return char;
  }

  #fail(message: string, at = this.#at): never {
    throw new SedScriptError(`-e expression #${this.expression}, char ${at}: ${message}`);
  }
}

/** `&` is the match, `\1`–`\9` groups, `\n` and `\t` controls, `\x` the character. */
function replacementParts(source: string): ReplacementPart[] {
  const parts: ReplacementPart[] = [];
  let text = "";
  const flush = (): void => {
    if (text !== "") parts.push({ kind: "text", value: text });
    text = "";
  };
  for (let index = 0; index < source.length; index++) {
    const char = source.charAt(index);
    if (char === "&") {
      flush();
      parts.push({ kind: "group", index: 0 });
      continue;
    }
    if (char !== "\\" || index + 1 >= source.length) {
      text += char;
      continue;
    }
    const next = source.charAt(++index);
    if (/[0-9]/.test(next)) {
      flush();
      parts.push({ kind: "group", index: Number(next) });
    } else if (next === "n") {
      text += "\n";
    } else if (next === "t") {
      text += "\t";
    } else {
      text += next;
    }
  }
  flush();
  return parts;
}
