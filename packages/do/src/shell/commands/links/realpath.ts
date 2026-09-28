// `realpath` as uutils 0.2.2 behaves: every operand is attempted, and each
// failure is reported and turns the status to 1.

import { encode } from "../../exec/bytes.js";
import {
  type Command,
  type CommandContext,
  type CommandResult,
  result,
} from "../../exec/context.js";
import { isFilesystemError } from "../../exec/redirections.js";
import {
  canonicalize,
  canonicalizeLexically,
  type Existence,
  relativeTo,
  unresolved,
  within,
} from "./canonical.js";
import {
  ClapError,
  has,
  lastOf,
  missingRequired,
  type OptionSpec,
  parseOptions,
} from "./options.js";
import { HeldOutput, kindMessage } from "./output.js";

const SPEC: OptionSpec = {
  usage: "Usage: realpath [OPTION]... FILE...",
  short: new Map([
    ["e", "canonicalize-existing"],
    ["m", "canonicalize-missing"],
    ["s", "strip"],
    ["z", "zero"],
    ["q", "quiet"],
    ["L", "logical"],
    ["P", "physical"],
  ]),
  long: new Map([
    ["canonicalize-existing", false],
    ["canonicalize-missing", false],
    ["strip", false],
    ["no-symlinks", false],
    ["zero", false],
    ["quiet", false],
    ["logical", false],
    ["physical", false],
    ["relative-to", true],
    ["relative-base", true],
  ]),
  refused: new Set(["logical", "physical"]),
};

interface Resolution {
  readonly lexical: boolean;
  readonly existence: Existence;
}

type Attempt = { readonly ok: true; readonly path: string } | { readonly ok: false };

export const realpath: Command = (context) => {
  try {
    return run(context);
  } catch (error) {
    if (!(error instanceof ClapError)) throw error;
    context.diagnostic(encode(error.text));
    return result((function* () {})(), 1);
  }
};

function run(context: CommandContext): CommandResult {
  const parsed = parseOptions(context.argv, SPEC);
  if (parsed.operands.length === 0) throw missingRequired("<files>...", SPEC);
  if (parsed.operands.includes("")) {
    throw new ClapError("error: error: invalid value for one of the arguments\n\n");
  }

  const mode = lastOf(parsed, ["canonicalize-existing", "canonicalize-missing"]);
  const resolution: Resolution = {
    lexical: has(parsed, "strip", "no-symlinks"),
    existence:
      mode === "canonicalize-existing"
        ? "existing"
        : mode === "canonicalize-missing"
          ? "missing"
          : "normal",
  };
  const quiet = has(parsed, "quiet");
  const terminator = has(parsed, "zero") ? "\0" : "\n";

  const attempt = (operand: string, silent: boolean): Attempt => {
    const path = unresolved(context.cwd, operand);
    try {
      return {
        ok: true,
        path: resolution.lexical
          ? canonicalizeLexically(context.fs, path, resolution.existence)
          : canonicalize(context.fs, path, resolution.existence),
      };
    } catch (error) {
      if (!isFilesystemError(error)) throw error;
      if (!silent) context.warn(`${operand}: ${kindMessage(error)}`);
      return { ok: false };
    }
  };

  let relativeDirectory: string | null = null;
  let relativeBase: string | null = null;
  const directoryOperand = parsed.values.get("relative-to");
  if (directoryOperand !== undefined) {
    const directory = attempt(directoryOperand, false);
    if (!directory.ok) return result((function* () {})(), 1);
    relativeDirectory = directory.path;
  }
  const baseOperand = parsed.values.get("relative-base");
  if (baseOperand !== undefined) {
    const base = attempt(baseOperand, false);
    if (!base.ok) return result((function* () {})(), 1);
    relativeBase = base.path;
  }
  // GNU and uutils print absolute names when the directory escapes the base.
  if (relativeBase !== null && relativeDirectory !== null) {
    if (!within(relativeDirectory, relativeBase)) {
      relativeDirectory = null;
      relativeBase = null;
    }
  }

  const output = new HeldOutput(context);
  let status = 0;
  for (const operand of parsed.operands) {
    const resolved = attempt(operand, quiet);
    if (!resolved.ok) {
      // uutils' --quiet silences a failed operand's status as well as its message.
      if (!quiet) status = 1;
      continue;
    }
    output.write(`${display(resolved.path, relativeDirectory, relativeBase)}${terminator}`);
  }
  return output.result(status);
}

function display(path: string, directory: string | null, base: string | null): string {
  if (base !== null && !within(path, base)) return path;
  const from = directory ?? base;
  return from === null ? path : relativeTo(from, path);
}
