// `patch` argv, parsed the way GNU patch's getopt_long does: options and
// operands may interleave, a long option may be abbreviated to any unique
// prefix, and each option takes effect as it is read, so `-p x` fails before
// a later unknown option is noticed. Options GNU knows but this command does
// not implement are refused by name rather than ignored.

export const SUPPORTED =
  "-pN, -R, --dry-run, -N, -s, -d DIR, -f, -t, -E, --no-backup-if-mismatch, -F N, -r FILE, -i FILE";

export interface PatchOptions {
  /** Components to strip; null strips every directory, as GNU does without `-p`. */
  readonly strip: number | null;
  readonly reverse: boolean;
  readonly dryRun: boolean;
  readonly forward: boolean;
  readonly silent: boolean;
  readonly directory: string | null;
  /** How questions without a terminal are answered: `force` (-f), `batch` (-t), or neither. */
  readonly answers: "ask" | "batch" | "force";
  readonly removeEmpty: boolean;
  readonly backupIfMismatch: boolean;
  readonly maxFuzz: number;
  /** `-r FILE`; `-` discards rejects. */
  readonly rejectFile: string | null;
  readonly input: string | null;
  readonly original: string | null;
}

/** A command-line failure, printed as GNU prints it, with status 2. */
export class PatchUsageError extends Error {
  constructor(
    readonly lines: readonly string[],
    readonly tryHelp: boolean,
  ) {
    super(lines.join("\n"));
    this.name = "PatchUsageError";
  }
}

type Argument = "none" | "required";

interface OptionSpec {
  readonly long: string;
  readonly short: string | null;
  readonly argument: Argument;
  readonly supported: boolean;
}

function option(
  long: string,
  short: string | null,
  argument: Argument,
  supported = false,
): OptionSpec {
  return { long, short, argument, supported };
}

// Listed in the order GNU patch names them when an abbreviation is ambiguous.
const LONG_OPTIONS: readonly OptionSpec[] = [
  option("backup", "b", "none"),
  option("batch", "t", "none", true),
  option("basename-prefix", "Y", "required"),
  option("binary", null, "none"),
  option("backup-if-mismatch", null, "none"),
  option("context", "c", "none"),
  option("directory", "d", "required", true),
  option("debug", "x", "required"),
  option("dry-run", null, "none", true),
  option("ed", "e", "none"),
  option("force", "f", "none", true),
  option("fuzz", "F", "required", true),
  option("forward", "N", "none", true),
  option("follow-symlinks", null, "none"),
  option("get", "g", "required"),
  option("help", null, "none"),
  option("ifdef", "D", "required"),
  option("input", "i", "required", true),
  option("ignore-whitespace", "l", "none"),
  option("normal", "n", "none"),
  option("no-backup-if-mismatch", null, "none", true),
  option("output", "o", "required"),
  option("prefix", "B", "required"),
  option("posix", null, "none"),
  option("quiet", "s", "none", true),
  option("quoting-style", null, "required"),
  option("remove-empty-files", "E", "none", true),
  option("reject-file", "r", "required", true),
  option("reverse", "R", "none", true),
  option("reject-format", null, "required"),
  option("read-only", null, "required"),
  option("strip", "p", "required", true),
  option("silent", "s", "none", true),
  option("set-time", "T", "none"),
  option("suffix", "z", "required"),
  option("set-utc", "Z", "none"),
  option("unified", "u", "none"),
  option("version", "v", "none"),
  option("version-control", "V", "required"),
  option("verbose", null, "none"),
];

const SHORT_OPTIONS: ReadonlyMap<string, OptionSpec> = shortOptions();

function shortOptions(): Map<string, OptionSpec> {
  const options = new Map<string, OptionSpec>();
  for (const spec of LONG_OPTIONS) {
    if (spec.short !== null && !options.has(spec.short)) options.set(spec.short, spec);
  }
  // GNU accepts an undocumented `-m`; it is refused by name like the rest.
  options.set("m", option("m", "m", "none"));
  return options;
}

export function parsePatchArguments(argv: readonly string[]): PatchOptions {
  const state = new OptionState();
  const operands: string[] = [];
  for (let index = 0; index < argv.length; index++) {
    const arg = argv[index] ?? "";
    const next = (): string | undefined => {
      const value = argv[index + 1];
      if (value !== undefined) index++;
      return value;
    };
    if (arg === "--") {
      operands.push(...argv.slice(index + 1));
      break;
    }
    if (arg.startsWith("--")) {
      readLong(arg.slice(2), next, state);
      continue;
    }
    if (arg.startsWith("-") && arg.length > 1) {
      readShortCluster(arg, next, state);
      continue;
    }
    operands.push(arg);
  }
  const extra = operands[2];
  if (extra !== undefined) throw new PatchUsageError([`${extra}: extra operand`], true);
  return state.finish(operands[0] ?? null, operands[1] ?? null);
}

function readLong(body: string, next: () => string | undefined, state: OptionState): void {
  const equals = body.indexOf("=");
  const name = equals === -1 ? body : body.slice(0, equals);
  const exact = LONG_OPTIONS.find((spec) => spec.long === name);
  const candidates = exact === undefined ? LONG_OPTIONS.filter((s) => s.long.startsWith(name)) : [];
  const spec = exact ?? (candidates.length === 1 ? candidates[0] : undefined);
  if (spec === undefined) {
    if (candidates.length > 1) {
      const names = candidates.map((candidate) => `'--${candidate.long}'`).join(" ");
      throw new PatchUsageError([`option '--${body}' is ambiguous; possibilities: ${names}`], true);
    }
    throw new PatchUsageError([`unrecognized option '--${body}'`], true);
  }
  if (spec.argument === "none" && equals !== -1) {
    throw new PatchUsageError([`option '--${spec.long}' doesn't allow an argument`], true);
  }
  if (!spec.supported) refuse(`--${spec.long}`);
  let value: string | null = null;
  if (spec.argument === "required") {
    value = equals === -1 ? (next() ?? null) : body.slice(equals + 1);
    if (value === null) {
      throw new PatchUsageError([`option '--${spec.long}' requires an argument`], true);
    }
  }
  state.apply(spec, value);
}

function readShortCluster(arg: string, next: () => string | undefined, state: OptionState): void {
  for (let cursor = 1; cursor < arg.length; cursor++) {
    const letter = arg.charAt(cursor);
    const spec = SHORT_OPTIONS.get(letter);
    if (spec === undefined) throw new PatchUsageError([`invalid option -- '${letter}'`], true);
    if (spec.argument === "none") {
      if (!spec.supported) refuse(`-${letter}`);
      state.apply(spec, null);
      continue;
    }
    const inline = arg.slice(cursor + 1);
    const value = inline === "" ? next() : inline;
    if (value === undefined) {
      throw new PatchUsageError([`option requires an argument -- '${letter}'`], true);
    }
    if (!spec.supported) refuse(`-${letter}`);
    state.apply(spec, value);
    return;
  }
}

function refuse(name: string): never {
  throw new PatchUsageError([`option '${name}' is not supported; supported: ${SUPPORTED}`], false);
}

/** GNU reads counts as decimal integers; a larger value saturates. */
function count(value: string, what: string): number {
  if (/^-[0-9]+$/.test(value))
    throw new PatchUsageError([`**** ${what} ${value} is negative`], false);
  if (!/^\+?[0-9]+$/.test(value)) {
    throw new PatchUsageError([`**** ${what} ${value} is not a number`], false);
  }
  return Math.min(Number(value), Number.MAX_SAFE_INTEGER);
}

class OptionState {
  strip: number | null = null;
  reverse = false;
  dryRun = false;
  forward = false;
  silent = false;
  directory: string | null = null;
  answers: "ask" | "batch" | "force" = "ask";
  removeEmpty = false;
  backupIfMismatch = true;
  maxFuzz = 2;
  rejectFile: string | null = null;
  input: string | null = null;

  apply(spec: OptionSpec, value: string | null): void {
    switch (spec.long) {
      case "strip":
        this.strip = count(value ?? "", "strip count");
        return;
      case "fuzz":
        this.maxFuzz = count(value ?? "", "fuzz factor");
        return;
      case "reverse":
        this.reverse = true;
        return;
      case "dry-run":
        this.dryRun = true;
        return;
      case "forward":
        this.forward = true;
        return;
      case "quiet":
      case "silent":
        this.silent = true;
        return;
      case "directory":
        this.directory = value;
        return;
      case "batch":
        this.answers = "batch";
        return;
      case "force":
        this.answers = "force";
        return;
      case "remove-empty-files":
        this.removeEmpty = true;
        return;
      case "no-backup-if-mismatch":
        this.backupIfMismatch = false;
        return;
      case "reject-file":
        this.rejectFile = value;
        return;
      case "input":
        this.input = value;
        return;
      default:
        refuse(`--${spec.long}`);
    }
  }

  finish(original: string | null, patchFile: string | null): PatchOptions {
    return {
      strip: this.strip,
      reverse: this.reverse,
      dryRun: this.dryRun,
      forward: this.forward,
      silent: this.silent,
      directory: this.directory,
      answers: this.answers,
      removeEmpty: this.removeEmpty,
      backupIfMismatch: this.backupIfMismatch,
      maxFuzz: this.maxFuzz,
      rejectFile: this.rejectFile,
      input: this.input ?? patchFile,
      original,
    };
  }
}
