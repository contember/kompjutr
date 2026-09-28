// chmod's argv as the host chmod accepts it, with a twist: a cluster holding a
// mode character (`-w`, `-rwx`, `-x`) is a mode, not options, and every such
// argument joins the mode with a comma. Options may follow operands.

import { UsageError } from "../flags.js";

export type Verbosity = "normal" | "changes" | "high";

export interface ChmodArgs {
  readonly recursive: boolean;
  readonly verbosity: Verbosity;
  /** A mode assembled from `-mode` arguments, which also asks for umask surprises. */
  readonly optionMode: string | null;
  readonly operands: readonly string[];
}

/** A usage failure: the message, then the `--help` hint, status 1. */
export class ChmodUsage extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ChmodUsage";
  }
}

const MODE_CHARS = new Set("rwxXstugoa,+-=01234567");
const FLAGS: ReadonlyMap<string, string> = new Map([
  ["R", "recursive"],
  ["c", "changes"],
  ["v", "verbose"],
  ["f", "silent"],
  ["h", "no-dereference"],
  ["H", "-H"],
  ["L", "-L"],
  ["P", "-P"],
]);
const LONG = [
  "recursive",
  "changes",
  "verbose",
  "silent",
  "quiet",
  "reference",
  "preserve-root",
  "no-preserve-root",
  "dereference",
  "no-dereference",
  "help",
  "version",
];
const ADMITTED = new Set(["recursive", "changes", "verbose"]);

export function parseChmodArgs(argv: readonly string[]): ChmodArgs {
  let recursive = false;
  let verbosity: Verbosity = "normal";
  const modes: string[] = [];
  const operands: string[] = [];

  const apply = (name: string, spelling: string): void => {
    if (!ADMITTED.has(name)) throw new UsageError(`${spelling} is not supported`);
    if (name === "recursive") recursive = true;
    else verbosity = name === "changes" ? "changes" : "high";
  };

  const clusterIsMode = (arg: string): boolean => {
    for (const char of arg.slice(1)) {
      if (MODE_CHARS.has(char)) return true;
      const name = FLAGS.get(char);
      if (name === undefined) throw new ChmodUsage(`invalid option -- '${char}'`);
      apply(name, `-${char}`);
    }
    return false;
  };

  for (let index = 0; index < argv.length; index++) {
    const arg = argv[index];
    if (arg === undefined) continue;
    if (arg === "--") {
      operands.push(...argv.slice(index + 1));
      break;
    }
    if (arg.startsWith("--")) {
      const spelled = arg.slice(2).split("=")[0] ?? "";
      const exact = LONG.includes(spelled) ? spelled : undefined;
      const candidates = LONG.filter((name) => name.startsWith(spelled));
      const name = exact ?? (candidates.length === 1 ? candidates[0] : undefined);
      if (name === undefined || spelled === "") {
        if (candidates.length > 1 && spelled !== "") {
          throw new UsageError(`option '${arg}' is ambiguous`);
        }
        throw new ChmodUsage(`unrecognized option '${arg}'`);
      }
      if (arg.includes("=")) throw new UsageError(`--${name} is not supported`);
      apply(name, `--${name}`);
      continue;
    }
    if (arg.startsWith("-") && arg.length > 1) {
      if (clusterIsMode(arg)) modes.push(arg);
      continue;
    }
    operands.push(arg);
  }

  return {
    recursive,
    verbosity,
    optionMode: modes.length === 0 ? null : modes.join(","),
    operands,
  };
}
