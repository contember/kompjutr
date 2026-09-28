// mawk's regular expression dialect, parsed to a tree.
//
// This follows the dialect mawk accepts rather than POSIX: `^` and `$` are anchors
// wherever an operand may stand, a `)` without an open group is literal,
// `{n,m}` is an interval only when it is well formed, `\` escapes work inside
// brackets, and an empty alternative is an error. The tree is matched by the
// leftmost-longest engine in `regex.ts`; JS RegExp is leftmost-first, which
// gives different `match`, `sub`, and `split` results for alternations.

export type RegexNode =
  | { readonly kind: "set"; readonly set: Uint8Array }
  | { readonly kind: "bol" }
  | { readonly kind: "eol" }
  | { readonly kind: "empty" }
  | { readonly kind: "concat"; readonly items: readonly RegexNode[] }
  | { readonly kind: "alt"; readonly items: readonly RegexNode[] }
  | {
      readonly kind: "repeat";
      readonly node: RegexNode;
      readonly min: number;
      readonly max: number;
    };

/** mawk's diagnostic, shown as `regular expression compile failed (<reason>)`. */
export class RegexSyntaxError extends Error {}

const MISSING_OPERAND = "missing operand";
const MISSING_PAREN = "missing ')'";
const BAD_CLASS = "bad class -- [], [^] or [";
const BAD_INTERVAL = "bad interval expression";
const CARET_REPEAT = "syntax error ^* or ^+";

function charSet(code: number): Uint8Array {
  const set = new Uint8Array(256);
  set[code] = 1;
  return set;
}

function range(set: Uint8Array, from: number, to: number): void {
  for (let code = from; code <= to; code++) set[code] = 1;
}

const isDigit = (code: number): boolean => code >= 0x30 && code <= 0x39;
const isUpper = (code: number): boolean => code >= 0x41 && code <= 0x5a;
const isLower = (code: number): boolean => code >= 0x61 && code <= 0x7a;
const isAlpha = (code: number): boolean => isUpper(code) || isLower(code);
const isPrint = (code: number): boolean => code >= 0x20 && code <= 0x7e;

/** The C locale's ctype classes. */
const CLASSES: ReadonlyMap<string, (code: number) => boolean> = new Map([
  ["alnum", (code: number) => isAlpha(code) || isDigit(code)],
  ["alpha", isAlpha],
  ["blank", (code: number) => code === 0x20 || code === 0x09],
  ["cntrl", (code: number) => code < 0x20 || code === 0x7f],
  ["digit", isDigit],
  ["graph", (code: number) => code > 0x20 && code <= 0x7e],
  ["lower", isLower],
  ["print", isPrint],
  ["punct", (code: number) => code > 0x20 && code <= 0x7e && !isAlpha(code) && !isDigit(code)],
  ["space", (code: number) => code === 0x20 || (code >= 0x09 && code <= 0x0d)],
  ["upper", isUpper],
  [
    "xdigit",
    (code: number) =>
      isDigit(code) || (code >= 0x41 && code <= 0x46) || (code >= 0x61 && code <= 0x66),
  ],
]);

const isOctal = (char: string): boolean => char >= "0" && char <= "7";

function hexValue(char: string): number {
  const code = char.charCodeAt(0);
  if (isDigit(code)) return code - 0x30;
  if (code >= 0x41 && code <= 0x46) return code - 0x37;
  if (code >= 0x61 && code <= 0x66) return code - 0x57;
  return -1;
}

class Parser {
  index = 0;
  depth = 0;

  constructor(private readonly source: string) {}

  parse(): RegexNode {
    if (this.source.length === 0) return { kind: "empty" };
    const node = this.alternation();
    if (this.index < this.source.length) throw new RegexSyntaxError(MISSING_PAREN);
    return node;
  }

  private alternation(): RegexNode {
    const items = [this.concatenation()];
    while (this.source.charAt(this.index) === "|") {
      this.index++;
      items.push(this.concatenation());
    }
    return items.length === 1 && items[0] !== undefined ? items[0] : { kind: "alt", items };
  }

  private concatenation(): RegexNode {
    const items: RegexNode[] = [];
    for (;;) {
      const char = this.source.charAt(this.index);
      if (char === "" || char === "|") break;
      if (char === ")" && this.depth > 0) break;
      if (char === "*" || char === "+" || char === "?") throw new RegexSyntaxError(MISSING_OPERAND);
      if (char === "{" && this.intervalAt(this.index)) throw new RegexSyntaxError(MISSING_OPERAND);
      const atom = this.atom();
      items.push(this.postfix(atom));
    }
    if (items.length === 0) throw new RegexSyntaxError(MISSING_OPERAND);
    return items.length === 1 && items[0] !== undefined ? items[0] : { kind: "concat", items };
  }

  private postfix(atom: RegexNode): RegexNode {
    let node = atom;
    for (;;) {
      const char = this.source.charAt(this.index);
      if (char === "*" || char === "+") {
        if (atom.kind === "bol" && node === atom) throw new RegexSyntaxError(CARET_REPEAT);
        this.index++;
        node = { kind: "repeat", node, min: char === "+" ? 1 : 0, max: Infinity };
      } else if (char === "?") {
        this.index++;
        node = { kind: "repeat", node, min: 0, max: 1 };
      } else if (char === "{" && this.intervalAt(this.index)) {
        const { min, max } = this.interval();
        node = { kind: "repeat", node, min, max };
      } else {
        return node;
      }
    }
  }

  /** An interval is digits and at most one comma, then `}`; anything else is a literal `{`. */
  private intervalAt(open: number): boolean {
    let commas = 0;
    for (let index = open + 1; index < this.source.length; index++) {
      const char = this.source.charAt(index);
      if (char === "}") return true;
      if (char === ",") {
        if (++commas > 1) return false;
      } else if (!isDigit(char.charCodeAt(0))) return false;
    }
    return false;
  }

  private interval(): { min: number; max: number } {
    const close = this.source.indexOf("}", this.index);
    const body = this.source.slice(this.index + 1, close);
    this.index = close + 1;
    if (body === "") throw new RegexSyntaxError(BAD_INTERVAL);
    const comma = body.indexOf(",");
    if (comma === -1) {
      const count = Number(body);
      return { min: count, max: count };
    }
    const min = comma === 0 ? 0 : Number(body.slice(0, comma));
    const tail = body.slice(comma + 1);
    const max = tail === "" ? Infinity : Number(tail);
    if (max < min) throw new RegexSyntaxError(BAD_INTERVAL);
    return { min, max };
  }

  private atom(): RegexNode {
    const char = this.source.charAt(this.index);
    switch (char) {
      case "(": {
        this.index++;
        this.depth++;
        if (this.index >= this.source.length) throw new RegexSyntaxError(MISSING_PAREN);
        if (this.source.charAt(this.index) === ")") throw new RegexSyntaxError(MISSING_OPERAND);
        const inner = this.alternation();
        if (this.source.charAt(this.index) !== ")") throw new RegexSyntaxError(MISSING_PAREN);
        this.index++;
        this.depth--;
        return inner;
      }
      case "^":
        this.index++;
        return { kind: "bol" };
      case "$":
        this.index++;
        return { kind: "eol" };
      case ".": {
        this.index++;
        const set = new Uint8Array(256);
        set.fill(1);
        return { kind: "set", set };
      }
      case "[":
        return { kind: "set", set: this.bracket() };
      case "\\":
        this.index++;
        return { kind: "set", set: charSet(this.escape()) };
      default:
        this.index++;
        return { kind: "set", set: charSet(char.charCodeAt(0)) };
    }
  }

  /** One escape, entered just after the backslash. */
  private escape(): number {
    const char = this.source.charAt(this.index);
    const simple = "ntfbrav".indexOf(char);
    if (char === "") return 0x5c;
    if (simple !== -1) {
      this.index++;
      return [0x0a, 0x09, 0x0c, 0x08, 0x0d, 0x07, 0x0b][simple] ?? 0;
    }
    if (isOctal(char)) {
      let value = 0;
      let count = 0;
      while (count < 3 && isOctal(this.source.charAt(this.index))) {
        value = value * 8 + (this.source.charCodeAt(this.index) - 0x30);
        this.index++;
        count++;
      }
      return value & 0xff;
    }
    if (char === "x") {
      this.index++;
      const first = hexValue(this.source.charAt(this.index));
      if (first === -1) return 0x78;
      this.index++;
      const second = hexValue(this.source.charAt(this.index));
      if (second === -1) return first;
      this.index++;
      return first * 16 + second;
    }
    this.index++;
    return char.charCodeAt(0);
  }

  private classAt(index: number): ((code: number) => boolean) | null {
    if (!this.source.startsWith("[:", index)) return null;
    const close = this.source.indexOf(":]", index + 2);
    if (close === -1) return null;
    const test = CLASSES.get(this.source.slice(index + 2, close));
    if (test === undefined) throw new RegexSyntaxError(BAD_CLASS);
    return test;
  }

  private bracket(): Uint8Array {
    const open = this.index;
    let cursor = open + 1;
    if (this.source.charAt(cursor) === "^") cursor++;
    const first = this.source.charAt(cursor);
    if (first === "]" || (first === "[" && this.classAt(cursor) === null)) cursor++;
    let close = cursor;
    for (;;) {
      const char = this.source.charAt(close);
      if (char === "") throw new RegexSyntaxError(BAD_CLASS);
      if (char === "[" && this.classAt(close) !== null) {
        close = this.source.indexOf(":]", close) + 2;
        continue;
      }
      if (char === "]") break;
      close += char === "\\" ? 2 : 1;
    }

    const set = new Uint8Array(256);
    this.index = open + 1;
    const negate = this.source.charAt(this.index) === "^";
    if (negate) this.index++;
    let previous = -1;
    while (this.index < close) {
      const char = this.source.charAt(this.index);
      if (char === "\\") {
        this.index++;
        previous = this.escape();
        set[previous] = 1;
        continue;
      }
      if (char === "[") {
        const test = this.classAt(this.index);
        if (test !== null) {
          for (let code = 0; code < 256; code++) if (test(code)) set[code] = 1;
          this.index = this.source.indexOf(":]", this.index) + 2;
          continue;
        }
      }
      if (char === "-" && previous !== -1 && this.index + 1 < close) {
        const mark = this.index + 1;
        this.index = mark;
        let to: number;
        if (this.source.charAt(this.index) === "\\") {
          this.index++;
          to = this.escape();
        } else {
          to = this.source.charCodeAt(this.index);
          this.index++;
        }
        if (previous <= to) {
          range(set, previous, to);
          previous = -1;
        } else {
          this.index = mark;
          previous = 0x2d;
          set[0x2d] = 1;
        }
        continue;
      }
      previous = char.charCodeAt(0);
      set[previous] = 1;
      this.index++;
    }
    this.index = close + 1;
    if (negate) for (let code = 0; code < 256; code++) set[code] = set[code] === 1 ? 0 : 1;
    return set;
  }
}

export function parseRegex(source: string): RegexNode {
  return new Parser(source).parse();
}

/** The pattern as plain text when it has no operators, for a substring search. */
export function literalText(node: RegexNode): string | null {
  const items = node.kind === "concat" ? node.items : [node];
  let text = "";
  for (const item of items) {
    if (item.kind !== "set") return null;
    let only = -1;
    for (let code = 0; code < 256; code++) {
      if (item.set[code] !== 1) continue;
      if (only !== -1) return null;
      only = code;
    }
    if (only === -1) return null;
    text += String.fromCharCode(only);
  }
  return text;
}
