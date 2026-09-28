// `readlink` as uutils 0.2.2 behaves: the first operand that fails ends the
// run with status 1, silently unless `-v`.

import { filesystemError } from "../../../fs/errors.js";
import { encode } from "../../exec/bytes.js";
import {
  type Command,
  type CommandContext,
  type CommandResult,
  result,
} from "../../exec/context.js";
import { isFilesystemError } from "../../exec/redirections.js";
import { canonicalize, type Existence, unresolved } from "./canonical.js";
import { ClapError, lastOf, type OptionSpec, parseOptions } from "./options.js";
import { HeldOutput, kindMessage } from "./output.js";

const SPEC: OptionSpec = {
  usage: "Usage: readlink [OPTION]... [FILE]...",
  short: new Map([
    ["f", "canonicalize"],
    ["e", "canonicalize-existing"],
    ["m", "canonicalize-missing"],
    ["n", "no-newline"],
    ["q", "quiet"],
    ["s", "silent"],
    ["v", "verbose"],
    ["z", "zero"],
  ]),
  long: new Map([
    ["canonicalize", false],
    ["canonicalize-existing", false],
    ["canonicalize-missing", false],
    ["no-newline", false],
    ["quiet", false],
    ["silent", false],
    ["verbose", false],
    ["zero", false],
  ]),
  refused: new Set(),
};

const MODES = ["canonicalize", "canonicalize-existing", "canonicalize-missing"] as const;
const EXISTENCE: Readonly<Record<(typeof MODES)[number], Existence>> = {
  canonicalize: "normal",
  "canonicalize-existing": "existing",
  "canonicalize-missing": "missing",
};

export const readlink: Command = (context) => {
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
  const mode = lastOf(parsed, MODES);
  const verbose = parsed.flags.includes("verbose");
  const operands = parsed.operands;
  if (operands.length === 0) {
    context.warn("missing operand");
    context.diagnostic(encode("Try 'readlink --help' for more information.\n"));
    return result((function* () {})(), 1);
  }

  let terminator = parsed.flags.includes("zero") ? "\0" : "\n";
  if (parsed.flags.includes("no-newline")) {
    if (operands.length === 1) terminator = "";
    else context.warn("ignoring --no-newline with multiple arguments");
  }

  const output = new HeldOutput(context);
  for (const operand of operands) {
    const path = unresolved(context.cwd, operand);
    try {
      const shown =
        mode === null
          ? readTarget(context, operand, path)
          : canonicalize(context.fs, path, EXISTENCE[mode]);
      output.write(`${shown}${terminator}`);
    } catch (error) {
      if (!isFilesystemError(error)) throw error;
      if (verbose) context.warn(`${operand}: ${kindMessage(missingReason(context, path, error))}`);
      return output.result(1);
    }
  }
  return output.result(0);
}

function readTarget(context: CommandContext, operand: string, path: string): string {
  // An empty name is no path at all to readlink(2), not the working directory.
  if (operand === "") throw filesystemError("ENOENT", "no such file or directory", operand);
  return context.fs.readlink(path);
}

/** The store reports a path through a regular file as missing; Linux says ENOTDIR. */
function missingReason(
  context: CommandContext,
  path: string,
  error: Error & { readonly code: string },
): Error & { readonly code: string } {
  if (error.code !== "ENOENT") return error;
  try {
    context.fs.realpath(path);
  } catch (resolution) {
    if (isFilesystemError(resolution) && resolution.code === "ENOTDIR") return resolution;
  }
  return error;
}
