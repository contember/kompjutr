// The `rg` surface. Not an alias for `grep`: agents used both (98 and 130
// occurrences) and the defaults differ in six ways that change what comes
// back. Aliasing would be a lie that surfaces as wrong output.
//
// Differences from `grep`, per docs/plans/shell.md §5.1:
//   recursive by default · `-g` instead of `--include` · `-t <type>` ·
//   `-S` smart-case · dotfiles skipped unless `--hidden` · always ERE
//
// One deliberate divergence from real rg: no ignore-file handling. A
// kompjutr workspace is a checkout, not a build tree, so there is no
// `node_modules` to skip. Recorded as a non-goal, not a gap.
//
// tty-dependent defaults resolve to the piped form: no heading, and line
// numbers only with `-n`. There is no terminal here.

import { encode } from "../exec/bytes.js";
import { type Command, fail } from "../exec/context.js";
import { resolve } from "../exec/execute.js";
import { count, parseFlags, UsageError } from "./flags.js";
import { compilePattern, literalNeedle, PatternError } from "./regex.js";
import { type SearchRequest, search } from "./search.js";
import { searchStream } from "./search-stream.js";

/** `-t ts` and friends. Lowered to the same glob `-g` produces. */
const TYPES: ReadonlyMap<string, readonly string[]> = new Map([
  ["ts", ["*.ts", "*.tsx", "*.mts", "*.cts"]],
  ["js", ["*.js", "*.jsx", "*.mjs", "*.cjs"]],
  ["md", ["*.md", "*.markdown"]],
  ["json", ["*.json", "*.jsonc"]],
  ["css", ["*.css", "*.scss", "*.sass", "*.less"]],
  ["html", ["*.html", "*.htm"]],
  ["py", ["*.py", "*.pyi"]],
  ["go", ["*.go"]],
  ["rust", ["*.rs"]],
  ["sh", ["*.sh", "*.bash", "*.zsh"]],
  ["yaml", ["*.yaml", "*.yml"]],
  ["toml", ["*.toml"]],
  ["sql", ["*.sql"]],
]);

const SPEC = {
  boolean: new Set([
    "-i",
    "-S",
    "-s",
    "-n",
    "-N",
    "-l",
    "-v",
    "-F",
    "-c",
    "-w",
    "-x",
    "--hidden",
    "--no-filename",
    "--with-filename",
    "--no-heading",
    "--ignore-case",
    "--smart-case",
    "--case-sensitive",
    "--line-number",
    "--no-line-number",
    "--files-with-matches",
    "--invert-match",
    "--fixed-strings",
    "--count",
    "--word-regexp",
    "--line-regexp",
    "--no-ignore",
  ]),
  valued: new Set(["-A", "-B", "-C", "-e", "-g", "-t", "--glob", "--type", "--regexp"]),
};

export const rg: Command = (context) => {
  try {
    const parsed = parseFlags(context.argv, SPEC);

    let caseMode: "sensitive" | "insensitive" | "smart" = "sensitive";
    let lineNumbers = false;
    let invert = false;
    let fixed = false;
    let mode: SearchRequest["mode"] = "content";
    let wholeWord = false;
    let wholeLine = false;
    let withFilename: boolean | null = null;
    let skipHidden = true;
    let before = 0;
    let after = 0;
    const include: string[] = [];
    const exclude: string[] = [];
    let pattern: string | null = null;

    for (const flag of parsed.flags) {
      switch (flag.name) {
        case "-i":
        case "--ignore-case":
          caseMode = "insensitive";
          break;
        case "-S":
        case "--smart-case":
          caseMode = "smart";
          break;
        case "-s":
        case "--case-sensitive":
          caseMode = "sensitive";
          break;
        case "-n":
        case "--line-number":
          lineNumbers = true;
          break;
        case "-N":
        case "--no-line-number":
          lineNumbers = false;
          break;
        case "-l":
        case "--files-with-matches":
          mode = "files";
          break;
        case "-v":
        case "--invert-match":
          invert = true;
          break;
        case "-F":
        case "--fixed-strings":
          fixed = true;
          break;
        case "-c":
        case "--count":
          mode = "count";
          break;
        case "-w":
        case "--word-regexp":
          wholeWord = true;
          break;
        case "-x":
        case "--line-regexp":
          wholeLine = true;
          break;
        case "--hidden":
          skipHidden = false;
          break;
        case "--no-filename":
          withFilename = false;
          break;
        case "--with-filename":
          withFilename = true;
          break;
        case "--no-heading":
        case "--no-ignore":
          break; // Already the behaviour; accepted so scripts do not break.
        case "-A":
          after = count(flag.value ?? "", "-A");
          break;
        case "-B":
          before = count(flag.value ?? "", "-B");
          break;
        case "-C": {
          const both = count(flag.value ?? "", "-C");
          before = both;
          after = both;
          break;
        }
        case "-e":
        case "--regexp":
          pattern = flag.value;
          break;
        case "-g":
        case "--glob": {
          const value = flag.value ?? "";
          // rg's `!` prefix is an exclusion.
          if (value.startsWith("!")) exclude.push(value.slice(1));
          else include.push(value);
          break;
        }
        case "-t":
        case "--type": {
          const globs = TYPES.get(flag.value ?? "");
          if (globs === undefined) throw new UsageError(`unrecognized file type: ${flag.value}`);
          include.push(...globs);
          break;
        }
        default:
          throw new UsageError(`unrecognized option '${flag.name}'`);
      }
    }

    let operands = parsed.operands;
    if (pattern === null) {
      const [first, ...rest] = operands;
      if (first === undefined) throw new UsageError("usage: rg [OPTIONS] PATTERN [PATH...]");
      pattern = first;
      operands = rest;
    }

    // Smart case: insensitive unless the pattern carries an uppercase letter.
    const ignoreCase =
      caseMode === "insensitive" || (caseMode === "smart" && !/[A-Z]/.test(pattern));

    const compiled = compilePattern(pattern, {
      dialect: fixed ? "fixed" : "ere",
      ignoreCase,
      wholeWord,
      wholeLine,
    });
    // The SQL content predicate only answers a case-sensitive, positive
    // substring search: `instr` has no case folding and cannot prove the
    // absence an inverted search asks about.
    const needle = ignoreCase || invert ? null : literalNeedle(pattern, fixed ? "fixed" : "ere");
    const literal = needle === null ? null : new TextEncoder().encode(needle);
    const shared = { invert, mode, lineNumbers, before, after };

    if (operands.length === 0 && context.stdin !== null) {
      return searchStream(context.stdin, {
        ...shared,
        pattern: compiled,
        withFilename: withFilename ?? false,
        name: "<stdin>",
      });
    }

    // rg with no path searches the working directory, recursively.
    const roots =
      operands.length === 0 ? [context.cwd] : operands.map((o) => resolve(context.cwd, o));

    const outcome = search(context.fs, {
      ...shared,
      pattern: compiled,
      literal,
      roots,
      recursive: true,
      include,
      exclude,
      skipHidden,
      withFilename,
      // rg drops a binary file a walk turned up; a named one it searches.
      walkedBinaries: "skip",
      // rg lists only files that matched, where GNU prints `path:0` for all
      // of them. That is why `rg -c` keeps the SQL predicate and `grep -c`
      // cannot: the predicate returns matches, which is exactly rg's answer.
      zeroCounts: false,
      warn: (message: string) => {
        context.warn(message);
      },
      // rg puts its notice on stdout, with the offset of the byte that
      // decided it.
      reportBinary: (path: string, offset: number, withName: boolean) =>
        encode(
          `${withName ? `${path}: ` : ""}binary file matches (found "\\0" byte around offset ${offset})\n`,
        ),
    });
    return { stdout: outcome.stream, status: outcome.status };
  } catch (error) {
    if (error instanceof UsageError || error instanceof PatternError) {
      return fail(context, error.message, 2);
    }
    throw error;
  }
};
