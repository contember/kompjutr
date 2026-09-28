// The `grep` surface. Defaults are GNU grep's: not recursive, dotfiles
// searched, BRE unless `-E`. See docs/archive/plans/shell.md §5.1 for the six ways
// this differs from `rg`, which shares the engine below it.

import { type Command, fail } from "../../exec/context.js";
import { resolve } from "../../exec/execute.js";
import { count, parseFlags, UsageError } from "../flags.js";
import { compilePatternSet, type Dialect, literalNeedle, PatternError } from "./regex.js";
import { type SearchRequest, type SearchRoot, search } from "./search.js";
import { onlyMatchingFor, quietly } from "./search-output.js";
import { searchStream } from "./search-stream.js";

const SPEC = {
  boolean: new Set([
    "-o",
    "--only-matching",
    "-q",
    "--quiet",
    "--silent",
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
    let onlyMatching = false;
    let quiet = false;
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
        case "-o":
        case "--only-matching":
          onlyMatching = true;
          break;
        case "-q":
        case "--quiet":
        case "--silent":
          quiet = true;
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

    const roots: SearchRoot[] = operands.map((operand) => ({
      path: resolve(context.cwd, operand),
      operand,
    }));
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
    // `-q` only needs to know that one line was selected.
    const searchMode: SearchRequest["mode"] = quiet ? "files" : mode;
    const shared = {
      invert,
      mode: searchMode,
      lineNumbers,
      before,
      after,
      onlyMatching: onlyMatching ? onlyMatchingFor(compiled, "grep") : null,
    };

    // `-r` with no file searches the working directory, as GNU grep does even
    // when stdin is a pipe. Otherwise a pipe stage searches its input, not the
    // filesystem — R3. No path is resolved and no query is issued.
    if (operands.length === 0 && recursive) {
      roots.push({ path: context.cwd, operand: "" });
    } else if (operands.length === 0) {
      if (context.stdin === null) {
        return fail(context, "no input; give a file or pipe something in", 2);
      }
      const piped = searchStream(
        context.stdin,
        {
          ...shared,
          pattern: compiled,
          withFilename: withFilename ?? false,
          name: null,
        },
        context.fs.retained,
      );
      return quiet ? quietly(piped.stdout, piped.status, piped.matched) : piped;
    }

    const request: SearchRequest = {
      ...shared,
      pattern: compiled,
      literal,
      roots,
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
    if (quiet) return quietly(outcome.stream, outcome.status, outcome.matched);
    return { stdout: outcome.stream, status: outcome.status, truncated: () => false };
  } catch (error) {
    if (error instanceof UsageError || error instanceof PatternError) {
      return fail(context, error.message, 2);
    }
    throw error;
  }
};
