// awk tokens, reserved words, and escape processing shared by the scanner
// and the command line (`-v`, `-F`, and operand assignments process escapes too).

export type TokenKind =
  | "newline"
  | ";"
  | "fake;"
  | "{"
  | "}"
  | "("
  | ")"
  | "["
  | "]"
  | ","
  | "?"
  | ":"
  | "||"
  | "&&"
  | "!"
  | "~"
  | "!~"
  | "="
  | "+="
  | "-="
  | "*="
  | "/="
  | "%="
  | "^="
  | "=="
  | "!="
  | "<"
  | "<="
  | ">"
  | ">="
  | "+"
  | "-"
  | "*"
  | "/"
  | "%"
  | "^"
  | "++"
  | "--"
  | "$"
  | "redirect"
  | "|"
  | "number"
  | "string"
  | "regex"
  | "name"
  | "funcname"
  | "builtin"
  | "field"
  | "keyword"
  | "eof";

export interface Token {
  readonly kind: TokenKind;
  /** How mawk names the token in `syntax error at or near …`. */
  readonly text: string;
  readonly line: number;
  /** Number value, string or regex text, or the name. */
  readonly number: number;
  readonly value: string;
  /** Open parentheses and braces once this token is scanned, for `missing ) near …`. */
  readonly parens: number;
  readonly braces: number;
}

export const KEYWORDS: ReadonlySet<string> = new Set([
  "BEGIN",
  "END",
  "break",
  "continue",
  "delete",
  "do",
  "else",
  "exit",
  "for",
  "function",
  "getline",
  "gsub",
  "if",
  "in",
  "length",
  "match",
  "next",
  "nextfile",
  "print",
  "printf",
  "return",
  "split",
  "sub",
  "while",
]);

export const BUILTINS: ReadonlySet<string> = new Set([
  "index",
  "substr",
  "sprintf",
  "sin",
  "cos",
  "atan2",
  "exp",
  "log",
  "int",
  "sqrt",
  "rand",
  "srand",
  "close",
  "system",
  "toupper",
  "tolower",
  "fflush",
  "systime",
  "mktime",
  "strftime",
]);

/** Tokens after which `/` divides; after anything else it opens a regex. */

/** Escape processing for string literals and command-line values. */
export function processEscapes(text: string): string {
  if (!text.includes("\\")) return text;
  let out = "";
  let index = 0;
  while (index < text.length) {
    const char = text.charAt(index);
    if (char !== "\\") {
      out += char;
      index++;
      continue;
    }
    const next = text.charAt(index + 1);
    const simple = "ntfbrav".indexOf(next);
    if (simple !== -1) {
      out += "\n\t\f\b\r\x07\v".charAt(simple);
      index += 2;
    } else if (next === "\\" || next === '"') {
      out += next;
      index += 2;
    } else if (next >= "0" && next <= "7") {
      let value = 0;
      let cursor = index + 1;
      while (cursor < index + 4 && text.charAt(cursor) >= "0" && text.charAt(cursor) <= "7") {
        value = value * 8 + text.charCodeAt(cursor) - 0x30;
        cursor++;
      }
      out += String.fromCharCode(value & 0xff);
      index = cursor;
    } else if (next === "x" && /^[0-9A-Fa-f]/.test(text.charAt(index + 2))) {
      const digits = /^[0-9A-Fa-f]{1,2}/.exec(text.slice(index + 2))?.[0] ?? "";
      out += String.fromCharCode(Number.parseInt(digits, 16));
      index += 2 + digits.length;
    } else if (next === "") {
      out += "\\";
      index++;
    } else {
      out += `\\${next}`;
      index += 2;
    }
  }
  return out;
}
