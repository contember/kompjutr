// Pattern dialects.
//
// The engine is JS `RegExp`, which is neither POSIX BRE/ERE nor Rust's
// `regex`. Anything that maps mechanically is translated; anything that does
// not is rejected by name. Silently running a pattern that means something
// else is the failure mode this exists to prevent — a `grep '\(a\)'` that
// matched a literal paren would return plausible, wrong output.

export class PatternError extends Error {
  readonly construct: string;

  constructor(construct: string, message: string) {
    super(message);
    this.name = "PatternError";
    this.construct = construct;
  }
}

export type Dialect = "bre" | "ere" | "fixed";

export interface PatternOptions {
  readonly dialect: Dialect;
  readonly ignoreCase: boolean;
  /** `-w`: the match must be bounded by non-word characters. */
  readonly wholeWord: boolean;
  /** `-x`: the match must be the whole line. */
  readonly wholeLine: boolean;
}

/** POSIX classes JS has no syntax for. */
const POSIX_CLASSES: ReadonlyMap<string, string> = new Map([
  ["alpha", "A-Za-z"],
  ["digit", "0-9"],
  ["alnum", "A-Za-z0-9"],
  ["upper", "A-Z"],
  ["lower", "a-z"],
  ["space", " \\t\\n\\r\\f\\v"],
  ["blank", " \\t"],
  ["punct", "!-/:-@\\[-`{-~"],
  ["xdigit", "0-9A-Fa-f"],
  ["word", "A-Za-z0-9_"],
  ["cntrl", "\\x00-\\x1f\\x7f"],
  ["print", "\\x20-\\x7e"],
  ["graph", "\\x21-\\x7e"],
]);

export function compilePattern(pattern: string, options: PatternOptions): RegExp {
  let source =
    options.dialect === "fixed"
      ? escapeLiteral(pattern)
      : options.dialect === "bre"
        ? translateBre(pattern)
        : translateEre(pattern);

  if (options.wholeLine) source = `^(?:${source})$`;
  else if (options.wholeWord) source = `(?<![A-Za-z0-9_])(?:${source})(?![A-Za-z0-9_])`;

  try {
    return new RegExp(source, options.ignoreCase ? "giu" : "gu");
  } catch {
    // The `u` flag rejects some escapes GNU accepts; retry without it before
    // giving up, so a pattern like `\d` in a byte-oriented search still runs.
    try {
      return new RegExp(source, options.ignoreCase ? "gi" : "g");
    } catch (error) {
      throw new PatternError("pattern", `invalid pattern: ${String(error)}`);
    }
  }
}

function escapeLiteral(value: string): string {
  return value.replace(/[\\^$.|?*+()[\]{}]/g, (match) => `\\${match}`);
}

/**
 * ERE to JS. The grammars agree almost everywhere; the gaps are POSIX
 * character classes, which JS has no syntax for, and the two lookaround
 * forms Rust's `regex` does not have and rg users therefore cannot mean.
 */
function translateEre(pattern: string): string {
  reject(pattern);
  return expandPosixClasses(pattern);
}

/**
 * BRE to JS. In BRE the operators are backslashed and the bare characters
 * are literal — exactly inverted from JS — so `\(` becomes `(` and `(`
 * becomes `\(`. GNU's `\|`, `\+` and `\?` extensions are honoured because
 * the corpus uses `\|` heavily.
 */
function translateBre(pattern: string): string {
  reject(pattern);
  let out = "";
  let index = 0;
  while (index < pattern.length) {
    const char = pattern.charAt(index);

    if (char === "\\") {
      const next = pattern.charAt(index + 1);
      if (next === "") throw new PatternError("escape", "trailing backslash in pattern");
      // Backslashed operators become bare JS operators.
      if ("(){}|+?".includes(next)) {
        out += next;
        index += 2;
        continue;
      }
      out += `\\${next}`;
      index += 2;
      continue;
    }

    if (char === "[") {
      const scan = readClass(pattern, index);
      out += expandPosixClasses(scan.text);
      index = scan.end;
      continue;
    }

    // Bare operators are literal in BRE.
    if ("(){}|+?".includes(char)) {
      out += `\\${char}`;
      index++;
      continue;
    }

    // `*` at the start of the pattern or right after `(` or `|` is literal.
    if (char === "*" && (out === "" || out.endsWith("(") || out.endsWith("|"))) {
      out += "\\*";
      index++;
      continue;
    }

    // `^` only anchors at the start, `$` only at the end.
    if (char === "^" && out !== "") {
      out += "\\^";
      index++;
      continue;
    }
    if (char === "$" && index !== pattern.length - 1) {
      out += "\\$";
      index++;
      continue;
    }

    out += char;
    index++;
  }
  return out;
}

/** Constructs neither POSIX grep nor Rust's regex has. */
function reject(pattern: string): void {
  if (/\(\?[=!<]/.test(pattern)) {
    throw new PatternError(
      "lookaround",
      "lookaround is not supported: neither POSIX grep nor ripgrep has it",
    );
  }
  if (/(^|[^\\])\\[1-9]/.test(pattern)) {
    throw new PatternError(
      "backreference",
      "backreferences are not supported: ripgrep's engine has none",
    );
  }
}

function expandPosixClasses(pattern: string): string {
  return pattern.replace(/\[:([a-z]+):\]/g, (_match, name: string) => {
    const expansion = POSIX_CLASSES.get(name);
    if (expansion === undefined) {
      throw new PatternError("character class", `unknown character class [:${name}:]`);
    }
    return expansion;
  });
}

/** The text of a `[...]` class, brackets included. */
function readClass(pattern: string, open: number): { text: string; end: number } {
  let index = open + 1;
  if (pattern.charAt(index) === "^") index++;
  if (pattern.charAt(index) === "]") index++;
  while (index < pattern.length) {
    if (pattern.startsWith("[:", index)) {
      const close = pattern.indexOf(":]", index);
      if (close !== -1) {
        index = close + 2;
        continue;
      }
    }
    if (pattern.charAt(index) === "]") {
      return { text: pattern.slice(open, index + 1), end: index + 1 };
    }
    index++;
  }
  // An unclosed `[` is a literal bracket, as in grep.
  return { text: "\\[", end: open + 1 };
}

/**
 * The pattern as a plain substring, or null when it is a real expression.
 *
 * A search whose pattern is literal can be answered by a SQL predicate over
 * the stored bytes instead of by reading every candidate file into the
 * isolate — which covers most of what agents search for (`grep -r TODO`,
 * `rg NEEDLE`). The check is deliberately conservative: a pattern that
 * *might* be an expression is reported as one, because the cost of being
 * wrong here is a wrong answer rather than a slow one.
 */
export function literalNeedle(pattern: string, dialect: Dialect): string | null {
  if (pattern === "") return null;
  if (dialect === "fixed") return pattern;
  // BRE leaves `+ ? ( ) { } |` literal until they are backslashed, and the
  // backslash is already in the set, so the two dialects differ only in how
  // much they reject.
  const metacharacters = dialect === "bre" ? /[\\.*[\]^$]/ : /[\\.*+?[\](){}|^$]/;
  return metacharacters.test(pattern) ? null : pattern;
}
