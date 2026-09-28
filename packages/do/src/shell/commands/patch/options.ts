// GNU patch's command line, parsed the way glibc getopt_long parses it:
// options and operands may interleave, long options take unique prefixes,
// and each option acts in order, so `-d` changes directory before a later
// numeric error is reported. Options GNU has and this patch does not are
// refused by name instead of being ignored.

import type { CommandContext } from "../../exec/context.js";
import { resolve } from "../../exec/execute.js";
import { PatchFatal, PatchUsage } from "./messages.js";
import { quote } from "./names.js";

export interface PatchOptions {
  /** Leading components to strip; -1 strips all but the basename. */
  readonly strip: number;
  readonly reverse: boolean;
  readonly dryRun: boolean;
  /** `-N`: skip patches that look reversed or already applied. */
  readonly forward: boolean;
  readonly silent: boolean;
  readonly force: boolean;
  readonly batch: boolean;
  readonly removeEmpty: boolean;
  readonly backupIfMismatch: boolean;
  readonly maxFuzz: number;
  readonly rejectFile: string | null;
  /** The patch file; null or `-` reads stdin. */
  readonly patchFile: string | null;
  /** An explicit file to patch, which every patch in the input then targets. */
  readonly target: string | null;
  /** The working directory after `-d`. */
  readonly cwd: string;
}

interface Spec {
  readonly short: string;
  readonly argument: boolean;
}

const LONG: ReadonlyArray<readonly [string, Spec]> = [
  ["backup", { short: "b", argument: false }],
  ["prefix", { short: "B", argument: true }],
  ["context", { short: "c", argument: false }],
  ["directory", { short: "d", argument: true }],
  ["ifdef", { short: "D", argument: true }],
  ["ed", { short: "e", argument: false }],
  ["remove-empty-files", { short: "E", argument: false }],
  ["force", { short: "f", argument: false }],
  ["fuzz", { short: "F", argument: true }],
  ["get", { short: "g", argument: true }],
  ["input", { short: "i", argument: true }],
  ["ignore-whitespace", { short: "l", argument: false }],
  ["normal", { short: "n", argument: false }],
  ["forward", { short: "N", argument: false }],
  ["output", { short: "o", argument: true }],
  ["strip", { short: "p", argument: true }],
  ["reject-file", { short: "r", argument: true }],
  ["reverse", { short: "R", argument: false }],
  ["quiet", { short: "s", argument: false }],
  ["silent", { short: "s", argument: false }],
  ["batch", { short: "t", argument: false }],
  ["set-time", { short: "T", argument: false }],
  ["unified", { short: "u", argument: false }],
  ["version", { short: "v", argument: false }],
  ["version-control", { short: "V", argument: true }],
  ["debug", { short: "x", argument: true }],
  ["basename-prefix", { short: "Y", argument: true }],
  ["suffix", { short: "z", argument: true }],
  ["set-utc", { short: "Z", argument: false }],
  ["dry-run", { short: "dry-run", argument: false }],
  ["verbose", { short: "verbose", argument: false }],
  ["binary", { short: "binary", argument: false }],
  ["help", { short: "help", argument: false }],
  ["backup-if-mismatch", { short: "backup-if-mismatch", argument: false }],
  ["no-backup-if-mismatch", { short: "no-backup-if-mismatch", argument: false }],
  ["posix", { short: "posix", argument: false }],
  ["quoting-style", { short: "quoting-style", argument: true }],
  ["reject-format", { short: "reject-format", argument: true }],
  ["read-only", { short: "read-only", argument: true }],
  ["follow-symlinks", { short: "follow-symlinks", argument: false }],
];

const SHORT_WITH_ARGUMENT = new Set("BdDFgiopVxYzr".split(""));
const SHORT_WITHOUT_ARGUMENT = new Set("bceEflnNRstTuvZ".split(""));

/** Every option this patch implements, keyed as `short` in the tables above. */
const ADMITTED = new Set([
  "p",
  "R",
  "dry-run",
  "N",
  "s",
  "d",
  "f",
  "t",
  "E",
  "no-backup-if-mismatch",
  "F",
  "r",
  "i",
]);

const SUPPORTED =
  "-pN, -R, --dry-run, -N, -s, -d DIR, -f, -t, -E, --no-backup-if-mismatch, -F N, -r FILE, -i FILE";

type Mutable = { -readonly [K in keyof PatchOptions]: PatchOptions[K] };

export function parseOptions(context: CommandContext, argv: readonly string[]): PatchOptions {
  const options: Mutable = {
    strip: -1,
    reverse: false,
    dryRun: false,
    forward: false,
    silent: false,
    force: false,
    batch: false,
    removeEmpty: false,
    backupIfMismatch: true,
    maxFuzz: 2,
    rejectFile: null,
    patchFile: null,
    target: null,
    cwd: context.cwd,
  };
  const operands: string[] = [];
  let index = 0;
  const take = (display: string, long: boolean): string => {
    const value = argv[index + 1];
    if (value === undefined) {
      throw new PatchUsage(
        long
          ? `option '${display}' requires an argument`
          : `option requires an argument -- '${display}'`,
      );
    }
    index++;
    return value;
  };

  for (; index < argv.length; index++) {
    const arg = argv[index];
    if (arg === undefined) continue;
    if (arg === "--") {
      operands.push(...argv.slice(index + 1));
      break;
    }
    if (arg.startsWith("--")) {
      const equals = arg.indexOf("=");
      const written = equals === -1 ? arg.slice(2) : arg.slice(2, equals);
      const [name, spec] = longOption(written, arg);
      let value: string | null = null;
      if (spec.argument) value = equals === -1 ? take(`--${name}`, true) : arg.slice(equals + 1);
      else if (equals !== -1) throw new PatchUsage(`option '--${name}' doesn't allow an argument`);
      act(context, options, spec.short, `--${name}`, value);
      continue;
    }
    if (arg.startsWith("-") && arg.length > 1) {
      for (let cursor = 1; cursor < arg.length; cursor++) {
        const letter = arg.charAt(cursor);
        if (SHORT_WITH_ARGUMENT.has(letter)) {
          const inline = arg.slice(cursor + 1);
          act(context, options, letter, `-${letter}`, inline === "" ? take(letter, false) : inline);
          break;
        }
        if (!SHORT_WITHOUT_ARGUMENT.has(letter))
          throw new PatchUsage(`invalid option -- '${letter}'`);
        act(context, options, letter, `-${letter}`, null);
      }
      continue;
    }
    operands.push(arg);
  }

  const [target, patchFile, extra] = operands;
  if (extra !== undefined) throw new PatchUsage(`${quote(extra)}: extra operand`);
  if (target !== undefined) options.target = target;
  if (patchFile !== undefined) options.patchFile = patchFile;
  return options;
}

function longOption(written: string, arg: string): readonly [string, Spec] {
  const exact = LONG.find(([name]) => name === written);
  if (exact !== undefined) return exact;
  const candidates = LONG.filter(([name]) => name.startsWith(written));
  const first = candidates[0];
  if (first === undefined) throw new PatchUsage(`unrecognized option '${arg}'`);
  const same = candidates.every(
    ([, spec]) => spec.short === first[1].short && spec.argument === first[1].argument,
  );
  if (!same) {
    const names = candidates.map(([name]) => ` '--${name}'`).join("");
    throw new PatchUsage(`option '--${written}' is ambiguous; possibilities:${names}`);
  }
  return first;
}

function act(
  context: CommandContext,
  options: Mutable,
  key: string,
  display: string,
  value: string | null,
): void {
  if (!ADMITTED.has(key)) {
    throw new PatchUsage(`option '${display}' is not supported; supported: ${SUPPORTED}`, false);
  }
  switch (key) {
    case "p":
      options.strip = numeric(value, "strip count");
      return;
    case "F":
      options.maxFuzz = numeric(value, "fuzz factor");
      return;
    case "R":
      options.reverse = true;
      return;
    case "dry-run":
      options.dryRun = true;
      return;
    case "N":
      options.forward = true;
      return;
    case "s":
      options.silent = true;
      return;
    case "f":
      options.force = true;
      return;
    case "t":
      options.batch = true;
      return;
    case "E":
      options.removeEmpty = true;
      return;
    case "no-backup-if-mismatch":
      options.backupIfMismatch = false;
      return;
    case "r":
      options.rejectFile = value;
      return;
    case "i":
      options.patchFile = value;
      return;
    case "d":
      options.cwd = directory(context, options.cwd, value ?? "");
      return;
  }
}

/** GNU's `numeric_string`: an optional sign, then digits; negatives refused. */
function numeric(value: string | null, label: string): number {
  const text = value ?? "";
  const match = /^([+-]?)([0-9]+)$/.exec(text);
  if (match === null) throw new PatchFatal(`${label} ${quote(text)} is not a number`);
  const digits = match[2] ?? "";
  if (match[1] === "-" && /[1-9]/.test(digits)) {
    throw new PatchFatal(`${label} ${quote(text)} is negative`);
  }
  return Math.min(Number(digits), Number.MAX_SAFE_INTEGER);
}

function directory(context: CommandContext, cwd: string, operand: string): string {
  const path = resolve(cwd, operand);
  const stat = context.fs.statTarget(path);
  if (stat?.type === "dir") return path;
  const reason = stat === null ? "No such file or directory" : "Not a directory";
  throw new PatchFatal(`Can't change to directory ${quote(operand)} : ${reason}`);
}
