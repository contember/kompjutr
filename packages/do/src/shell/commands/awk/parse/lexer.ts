// The awk program scanner.
//
// awk's grammar leans on the scanner: a newline is a token but `{`, `,`, `;`,
// `&&`, and `||` swallow the ones after them; `/` is a regex unless the token
// before it can end an operand; `>` and `|` inside `print` are redirections;
// and a statement right before `}` gets a supplied semicolon. The whole
// program is scanned up front, which the parser's lookahead relies on.

import { AwkSyntaxError } from "../errors.js";
import { BUILTINS, KEYWORDS, processEscapes, type Token, type TokenKind } from "./tokens.js";

const ENDS_OPERAND: ReadonlySet<TokenKind> = new Set([
  "number",
  "string",
  ")",
  "name",
  "regex",
  "]",
  "field",
]);

const isDigit = (char: string): boolean => char >= "0" && char <= "9";
const isNameStart = (char: string): boolean =>
  (char >= "a" && char <= "z") || (char >= "A" && char <= "Z") || char === "_";
const isSpace = (char: string): boolean =>
  char === " " || char === "\t" || char === "\f" || char === "\r" || char === "\v";

/** The scanner sees a trailing newline, so a last pattern without an action is terminated. */
export function scan(source: string): Token[] {
  return new Scanner(`${source}\n`).run();
}

class Scanner {
  readonly tokens: Token[] = [];
  index = 0;
  line = 1;
  parens = 0;
  braces = 0;
  printing = false;
  readonly functions = new Set<string>();
  readonly variables = new Set<string>();
  /** `if`, `for`, `while`, or `function` saw no `(` yet; its `)` swallows newlines. */
  awaitingParen = false;
  readonly closers: number[] = [];

  constructor(private readonly source: string) {}

  run(): Token[] {
    this.skipBlankLines();
    for (;;) {
      const token = this.next();
      this.tokens.push(token);
      if (token.kind === "eof") return this.tokens;
    }
  }

  private get previous(): TokenKind | null {
    return this.tokens[this.tokens.length - 1]?.kind ?? null;
  }

  private token(kind: TokenKind, text: string, value = "", number = 0, line = this.line): Token {
    if (kind === "newline" || kind === ";" || kind === "fake;" || kind === "}") {
      this.printing = false;
    }
    return { kind, text, line, number, value, parens: this.parens, braces: this.braces };
  }

  /** Skip blanks, comments, newlines, and escaped newlines. */
  private skipBlankLines(): void {
    for (;;) {
      const char = this.source.charAt(this.index);
      if (isSpace(char)) this.index++;
      else if (char === "\n") {
        this.index++;
        this.line++;
      } else if (char === "#") this.skipComment();
      else if (char === "\\" && this.escapedNewline()) continue;
      else return;
    }
  }

  private skipComment(): void {
    while (this.index < this.source.length && this.source.charAt(this.index) !== "\n") this.index++;
  }

  private escapedNewline(): boolean {
    let cursor = this.index + 1;
    while (isSpace(this.source.charAt(cursor))) cursor++;
    if (this.source.charAt(cursor) !== "\n") return false;
    this.index = cursor + 1;
    this.line++;
    return true;
  }

  private unexpected(char: string): never {
    const code = char.charCodeAt(0);
    const shown =
      code > 0x20 && code < 0x7f ? `'${char}'` : `0x${code.toString(16).padStart(2, "0")}`;
    throw new AwkSyntaxError(null, `${this.line}: unexpected character ${shown}`);
  }

  private next(): Token {
    for (;;) {
      const char = this.source.charAt(this.index);
      if (char === "") return this.token("eof", "end of file");
      if (isSpace(char)) {
        this.index++;
        continue;
      }
      if (char === "#") {
        this.skipComment();
        continue;
      }
      if (char === "\\") {
        if (this.escapedNewline()) continue;
        this.index++;
        this.unexpected("\\");
      }
      break;
    }
    const line = this.line;
    const char = this.source.charAt(this.index);
    const after = this.source.charAt(this.index + 1);
    this.index++;
    switch (char) {
      case "\n": {
        const token = this.token("newline", "end of line", "", 0, line);
        this.line++;
        this.skipBlankLines();
        return token;
      }
      case ";":
        this.skipBlankLines();
        return this.token(";", ";");
      case "{":
        this.braces++;
        this.skipBlankLines();
        return this.token("{", "{", "", 0, line);
      case "}":
        return this.closeBrace(line);
      case ",":
        this.skipBlankLines();
        return this.token(",", ",", "", 0, line);
      case "(":
        if (this.awaitingParen) {
          this.awaitingParen = false;
          this.closers.push(this.parens);
        }
        this.parens++;
        return this.token("(", "(");
      case ")": {
        if (--this.parens < 0) throw new AwkSyntaxError(line, "extra ')'");
        const token = this.token(")", ")");
        if (this.closers[this.closers.length - 1] === this.parens) {
          this.closers.pop();
          this.skipBlankLines();
        }
        return token;
      }
      case "[":
        return this.token("[", "[");
      case "]":
        return this.token("]", "]");
      case "?":
        return this.token("?", "?");
      case ":":
        return this.token(":", ":");
      case "~":
        return this.token("~", "~");
      case "+":
      case "-":
        if (after === char) {
          this.index++;
          return this.token(char === "+" ? "++" : "--", `${char}${char}`);
        }
        if (after === "=") {
          this.index++;
          return this.token(char === "+" ? "+=" : "-=", `${char}=`);
        }
        return this.token(char === "+" ? "+" : "-", char);
      case "*":
      case "%":
      case "^":
        if (after === "=") {
          this.index++;
          return this.token(char === "*" ? "*=" : char === "%" ? "%=" : "^=", `${char}=`);
        }
        return this.token(char === "*" ? "*" : char === "%" ? "%" : "^", char);
      case "=":
        if (after === "=") {
          this.index++;
          return this.token("==", "==");
        }
        return this.token("=", "=");
      case "!":
        if (after === "~" || after === "=") {
          this.index++;
          return after === "~" ? this.token("!~", "!~") : this.token("!=", "!=");
        }
        return this.token("!", "!");
      case "<":
        if (after === "=") {
          this.index++;
          return this.token("<=", "<=");
        }
        return this.token("<", "<");
      case ">":
        if (this.printing && this.parens === 0) {
          this.printing = false;
          if (after === ">") {
            this.index++;
            return this.token("redirect", ">>", ">>");
          }
          return this.token("redirect", ">", ">");
        }
        if (after === "=") {
          this.index++;
          return this.token(">=", ">=");
        }
        return this.token(">", ">");
      case "|":
        if (after === "|") {
          this.index++;
          this.skipBlankLines();
          return this.token("||", "||", "", 0, line);
        }
        if (this.printing && this.parens === 0) {
          this.printing = false;
          return this.token("redirect", "|", "|");
        }
        return this.token("|", "|");
      case "&":
        if (after === "&") {
          this.index++;
          this.skipBlankLines();
          return this.token("&&", "&&", "", 0, line);
        }
        return this.unexpected("&");
      case "/":
        return this.slash();
      case "$":
        return this.dollar();
      case '"':
        return this.string(line);
      default:
        break;
    }
    if (isDigit(char) || char === ".") return this.number(char);
    if (isNameStart(char)) return this.name(char);
    return this.unexpected(char);
  }

  private closeBrace(line: number): Token {
    const previous = this.previous;
    if (previous !== "newline" && previous !== ";" && previous !== "fake;" && previous !== "}") {
      // A statement right before `}` is terminated for it.
      this.index--;
      return this.token("fake;", "}", "", 0, line);
    }
    if (--this.braces < 0) throw new AwkSyntaxError(line, "extra '}'");
    if (this.braces === 0) {
      let cursor = this.index;
      while (isSpace(this.source.charAt(cursor))) cursor++;
      if (this.source.charAt(cursor) === ";") this.index = cursor + 1;
    }
    this.skipBlankLines();
    return this.token("}", "}", "", 0, line);
  }

  private slash(): Token {
    const previous = this.previous;
    if (previous !== null && ENDS_OPERAND.has(previous)) {
      if (this.source.charAt(this.index) === "=") {
        this.index++;
        return this.token("/=", "/=");
      }
      return this.token("/", "/");
    }
    return this.regex();
  }

  private regex(): Token {
    let text = "";
    let boxed = 0;
    let first = -1;
    for (;;) {
      const char = this.source.charAt(this.index);
      if (char === "\n" || char === "") {
        throw new AwkSyntaxError(this.line, `runaway regular expression /${text.slice(0, 10)} ...`);
      }
      this.index++;
      if (char === "\\") {
        const next = this.source.charAt(this.index);
        if (next === "/") {
          text += "/";
          this.index++;
        } else if (next === "\n") {
          this.index++;
          this.line++;
        } else if (next !== "") {
          text += `\\${next}`;
          this.index++;
        }
        continue;
      }
      if (char === "/" && boxed === 0) break;
      if (char === "[") {
        if (boxed === 0) {
          boxed = 1;
          first = text.length + 1;
        } else if (this.source.charAt(this.index) === ":") boxed++;
      } else if (char === "^" && text.length === first && text.charAt(first - 1) === "[") {
        first = text.length + 1;
      } else if (char === "]" && boxed > 0 && text.length !== first) {
        boxed--;
      }
      text += char;
    }
    return this.token("regex", `/${text}/`, text);
  }

  private dollar(): Token {
    let cursor = this.index;
    while (isSpace(this.source.charAt(cursor))) cursor++;
    const char = this.source.charAt(cursor);
    if (!isDigit(char) && char !== ".") return this.token("$", "$");
    this.index = cursor + 1;
    const number = this.decimal(char);
    if (number.value > 0 && !Number.isInteger(number.value)) {
      throw new AwkSyntaxError(this.line, `$${number.text} is invalid field index`);
    }
    return this.token("field", "$", "", Math.max(0, number.value));
  }

  private number(char: string): Token {
    const number = this.decimal(char);
    return this.token("number", number.text, "", number.value);
  }

  /** A decimal constant, with the first character already consumed. */
  private decimal(first: string): { value: number; text: string } {
    const rest = this.source.slice(this.index - 1);
    const match = /^(?:[0-9]+\.?[0-9]*|\.[0-9]+)(?:[eE][+-]?[0-9]+)?/.exec(rest);
    if (match === null) {
      if (first === ".") this.unexpected(".");
      return { value: 0, text: first };
    }
    this.index += match[0].length - 1;
    return { value: Number(match[0]), text: match[0] };
  }

  private string(line: number): Token {
    let raw = "";
    for (;;) {
      const char = this.source.charAt(this.index);
      if (char === "\n" || char === "") {
        throw new AwkSyntaxError(
          line,
          `runaway string constant "${processEscapes(raw).slice(0, 10)} ...`,
        );
      }
      this.index++;
      if (char === '"') break;
      if (char === "\\") {
        const next = this.source.charAt(this.index);
        if (next === "\n") {
          this.index++;
          this.line++;
          continue;
        }
        raw += `\\${next}`;
        this.index++;
        continue;
      }
      raw += char;
    }
    const value = processEscapes(raw);
    return this.token("string", value, value);
  }

  private name(first: string): Token {
    let name = first;
    while (/[A-Za-z0-9_]/.test(this.source.charAt(this.index))) {
      name += this.source.charAt(this.index);
      this.index++;
    }
    if (KEYWORDS.has(name)) {
      if (name === "print" || name === "printf") this.printing = true;
      if (name === "if" || name === "for" || name === "while" || name === "function") {
        this.awaitingParen = true;
      }
      if (name === "else" || name === "do") {
        const token = this.token("keyword", name, name);
        this.skipBlankLines();
        return token;
      }
      if (name === "function") {
        const match = /^[ \t]*([A-Za-z_][A-Za-z0-9_]*)/.exec(this.source.slice(this.index));
        if (match?.[1] !== undefined) this.functions.add(match[1]);
      }
      return this.token("keyword", name, name);
    }
    if (BUILTINS.has(name)) return this.token("builtin", name, name);
    // A new name directly before `(` is a function; a name already
    // used as a variable stays one, so `x (1)` concatenates.
    const called = this.source.charAt(this.index) === "(" && this.previous !== "$";
    if (this.functions.has(name) || (called && !this.variables.has(name))) {
      return this.token("funcname", name, name);
    }
    this.variables.add(name);
    return this.token("name", name, name);
  }
}
