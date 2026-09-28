// The admitted `diff` options, and GNU's switch string: the option words as
// spelled on the command line, which a directory comparison repeats in each
// `diff … A/f B/f` header.

import { type FlagSpec, parseFlags, UsageError } from "../flags.js";

/** Options GNU diff has and this one does not: whitespace, exclusion, symlinks, other formats. */
const REFUSED: ReadonlySet<string> = new Set([
  "-w",
  "-b",
  "-B",
  "-i",
  "-c",
  "-y",
  "-e",
  "-a",
  "-x",
  "--exclude",
  "-X",
  "--exclude-from",
  "-P",
  "--unidirectional-new-file",
  "--no-dereference",
  "--from-file",
  "--to-file",
]);

const SPEC: FlagSpec = {
  boolean: new Set([
    "-u",
    "-q",
    "--brief",
    "-s",
    "--report-identical-files",
    "-r",
    "--recursive",
    "-N",
    "--new-file",
    ...REFUSED,
  ]),
  valued: new Set(["-U", "--unified"]),
};

export interface DiffOptions {
  /** Unified context lines, or null for the normal format. */
  readonly contextLines: number | null;
  readonly brief: boolean;
  readonly reportIdentical: boolean;
  readonly recursive: boolean;
  /** `-N`: an entry absent on one side compares as empty. */
  readonly newFile: boolean;
  /** Leading space included, so a header is `diff${switches} A B`. */
  readonly switches: string;
  readonly operands: readonly string[];
}

/** The options, or the message for a usage failure. Refusals throw `UsageError`. */
export function parseOptions(argv: readonly string[]): DiffOptions | string {
  const parsed = parseFlags(argv, SPEC);
  const refused = parsed.flags.find((flag) => REFUSED.has(flag.name));
  if (refused !== undefined) {
    throw new UsageError(`${refused.name} is not supported; supported: -u, -U N, -q, -s, -r, -N`);
  }
  let contextLines: number | null = null;
  let brief = false;
  let reportIdentical = false;
  let recursive = false;
  let newFile = false;
  for (const flag of parsed.flags) {
    switch (flag.name) {
      case "-u":
        contextLines = 3;
        break;
      case "-U":
      case "--unified": {
        const value = flag.value ?? "";
        if (!/^[0-9]+$/.test(value)) return `invalid context length '${value}'`;
        contextLines = Number(value);
        break;
      }
      case "-q":
      case "--brief":
        brief = true;
        break;
      case "-r":
      case "--recursive":
        recursive = true;
        break;
      case "-N":
      case "--new-file":
        newFile = true;
        break;
      default:
        reportIdentical = true;
    }
  }
  return {
    contextLines,
    brief,
    reportIdentical,
    recursive,
    newFile,
    switches: switchString(argv),
    operands: parsed.operands,
  };
}

/**
 * GNU permutes options ahead of operands and prints every option word, `--`
 * and separated values included, each shell-quoted when it needs to be.
 */
function switchString(argv: readonly string[]): string {
  const words: string[] = [];
  for (let index = 0; index < argv.length; index++) {
    const arg = argv[index];
    if (arg === undefined || !arg.startsWith("-") || arg === "-") continue;
    words.push(arg);
    if (arg === "--") break;
    if (takesSeparateValue(arg)) {
      const value = argv[index + 1];
      if (value !== undefined) words.push(value);
      index++;
    }
  }
  return words.map((word) => ` ${shellQuote(word)}`).join("");
}

function takesSeparateValue(arg: string): boolean {
  if (arg.startsWith("--")) return !arg.includes("=") && SPEC.valued.has(arg);
  for (let cursor = 1; cursor < arg.length; cursor++) {
    if (SPEC.valued.has(`-${arg.charAt(cursor)}`)) return cursor === arg.length - 1;
  }
  return false;
}

/** gnulib's shell quoting style: bare when every byte is safe, else single-quoted. */
function shellQuote(word: string): string {
  if (/^[A-Za-z0-9_%+,./:@-]+$/.test(word)) return word;
  return `'${word.replaceAll("'", "'\\''")}'`;
}
