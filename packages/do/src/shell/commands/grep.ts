// The `grep` surface. Defaults are GNU grep's: not recursive, dotfiles
// searched, BRE unless `-E`. See docs/archive/plans/shell.md §5.1 for the six ways
// this differs from `rg`, which shares the engine below it.

import { type Command, fail } from "../exec/context.js";
import { resolve } from "../exec/execute.js";
import { count, parseFlags, UsageError } from "./flags.js";
import { compilePatternSet, type Dialect, literalNeedle, PatternError } from "./regex.js";
import { type SearchRequest, search } from "./search.js";
import { searchStream } from "./search-stream.js";

const SPEC = {
  boolean: new Set([
    "-r",
    "-R",
    "-i",
    "-n",
    "-l",
    "-L",
    "-v",
    "-E",
    "-F",
    "-c",
    "-w",
    "-x",
    "-h",
    "-H",
    "-s",
    "--recursive",
    "--ignore-case",
    "--line-number",
    "--files-with-matches",
    "--files-without-match",
    "--invert-match",
    "--extended-regexp",
    "--fixed-strings",
    "--count",
    "--word-regexp",
    "--line-regexp",
    "--no-filename",
    "--with-filename",
  ]),
  valued: new Set(["-A", "-B", "-C", "-e", "-m", "--include", "--exclude", "--regexp"]),
};

export const grep: Command = (context) => {
  try {
    const parsed = parseFlags(context.argv, SPEC);

    let recursive = false;
    let ignoreCase = false;
    let lineNumbers = false;
    let invert = false;
    let dialect: Dialect = "bre";
    let mode: SearchRequest["mode"] = "content";
    let wholeWord = false;
    let wholeLine = false;
    let withFilename: boolean | null = null;
    /** `-s`: an unreadable path stops being a diagnostic, but still fails. */
    let suppressErrors = false;
    let before = 0;
    let after = 0;
    const include: string[] = [];
    const exclude: string[] = [];
    const patterns: string[] = [];

    for (const flag of parsed.flags) {
      switch (flag.name) {
        case "-r":
        case "-R":
        case "--recursive":
          recursive = true;
          break;
        case "-i":
        case "--ignore-case":
          ignoreCase = true;
          break;
        case "-n":
        case "--line-number":
          lineNumbers = true;
          break;
        case "-l":
        case "--files-with-matches":
          mode = "files";
          break;
        case "-L":
        case "--files-without-match":
          mode = "files-without-match";
          break;
        case "-v":
        case "--invert-match":
          invert = true;
          break;
        case "-E":
        case "--extended-regexp":
          dialect = "ere";
          break;
        case "-F":
        case "--fixed-strings":
          dialect = "fixed";
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
        case "-h":
        case "--no-filename":
          withFilename = false;
          break;
        case "-H":
        case "--with-filename":
          withFilename = true;
          break;
        case "-s":
          suppressErrors = true;
          break;
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
          if (flag.value !== null) patterns.push(flag.value);
          break;
        case "--include":
          if (flag.value !== null) include.push(flag.value);
          break;
        case "--exclude":
          if (flag.value !== null) exclude.push(flag.value);
          break;
        case "-m":
          throw new UsageError("-m is not supported; pipe through `head` instead");
        default:
          throw new UsageError(`unrecognized option '${flag.name}'`);
      }
    }

    let operands = parsed.operands;
    if (patterns.length === 0) {
      const [first, ...rest] = operands;
      if (first === undefined) throw new UsageError("usage: grep [OPTION]... PATTERN [FILE]...");
      patterns.push(first);
      operands = rest;
    }

    const compiled = compilePatternSet(patterns, { dialect, ignoreCase, wholeWord, wholeLine });
    // The SQL content predicate only answers a case-sensitive, positive
    // substring search: `instr` has no case folding and cannot prove the
    // absence an inverted search asks about.
    const onlyPattern = patterns.length === 1 ? patterns[0] : undefined;
    const needle =
      ignoreCase || invert || onlyPattern === undefined
        ? null
        : literalNeedle(onlyPattern, dialect);
    const literal = needle === null ? null : new TextEncoder().encode(needle);
    const shared = { invert, mode, lineNumbers, before, after };

    // A pipe stage searches its input, not the filesystem — R3. No path is
    // resolved and no query is issued.
    if (operands.length === 0) {
      if (context.stdin === null) {
        return fail(context, "no input; give a file or pipe something in", 2);
      }
      return searchStream(
        context.stdin,
        {
          ...shared,
          pattern: compiled,
          withFilename: withFilename ?? false,
          name: null,
        },
        context.fs.retained,
      );
    }

    const request: SearchRequest = {
      ...shared,
      pattern: compiled,
      literal,
      roots: operands.map((operand) => resolve(context.cwd, operand)),
      recursive,
      include,
      exclude,
      skipHidden: false,
      withFilename,
      walkedBinaries: "report",
      // GNU prints `path:0` for every file it searched.
      zeroCounts: true,
      warn: (message: string) => {
        if (!suppressErrors) context.warn(message);
      },
      // GNU grep 3.x reports a binary file on *stderr*, which is the right
      // stream for it: the line is a notice about the data, not the data.
      reportBinary: (path: string) => {
        context.warn(`${path}: binary file matches`);
        return null;
      },
    };

    const outcome = search(context.fs, request);
    return { stdout: outcome.stream, status: outcome.status, truncated: () => false };
  } catch (error) {
    if (error instanceof UsageError || error instanceof PatternError) {
      return fail(context, error.message, 2);
    }
    throw error;
  }
};
