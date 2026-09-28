// `rmdir` as uutils 0.2.2 behaves. `-v` announces each removal on stdout
// before attempting it; `-p` then removes each parent the operand spells,
// stopping at the first failure.

import { encode } from "../../exec/bytes.js";
import {
  type Command,
  type CommandContext,
  type CommandResult,
  result,
} from "../../exec/context.js";
import { strerror } from "../../exec/errno.js";
import { resolve } from "../../exec/execute.js";
import { isFilesystemError } from "../../exec/redirections.js";
import { unresolved } from "./canonical.js";
import { ClapError, has, missingRequired, type OptionSpec, parseOptions } from "./options.js";
import { HeldOutput, quote } from "./output.js";

const SPEC: OptionSpec = {
  usage: "Usage: rmdir [OPTION]... DIRECTORY...",
  short: new Map([
    ["p", "parents"],
    ["v", "verbose"],
  ]),
  long: new Map([
    ["parents", false],
    ["verbose", false],
    ["ignore-fail-on-non-empty", false],
  ]),
  refused: new Set(),
};

interface Settings {
  readonly parents: boolean;
  readonly verbose: boolean;
  readonly ignoreNonEmpty: boolean;
}

export const rmdir: Command = (context) => {
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
  if (parsed.operands.length === 0) throw missingRequired("<dirs>...", SPEC);
  const settings: Settings = {
    parents: has(parsed, "parents"),
    verbose: has(parsed, "verbose"),
    ignoreNonEmpty: has(parsed, "ignore-fail-on-non-empty"),
  };

  const output = new HeldOutput(context);
  let status = 0;
  for (const operand of parsed.operands) {
    let current: string | null = operand;
    while (current !== null) {
      const failure = removeOne(context, output, settings, current);
      if (failure !== null) {
        if (!(settings.ignoreNonEmpty && failure === "Directory not empty")) {
          context.warn(`failed to remove ${quote(current)}: ${failure}`);
          status = 1;
        }
        break;
      }
      current = settings.parents ? parentOf(current) : null;
    }
  }
  return output.result(status);
}

/** Remove one directory; the failure text, or null on success. */
function removeOne(
  context: CommandContext,
  output: HeldOutput,
  settings: Settings,
  operand: string,
): string | null {
  if (settings.verbose) output.write(`rmdir: removing directory, ${quote(operand)}\n`);
  const path = resolve(context.cwd, operand);
  try {
    // resolve() is lexical, so the kernel's answers for a final `.` or `..`
    // and for a slash-terminated symlink are decided here, before it.
    if (path === "/") return "Device or resource busy";
    const last = finalComponent(operand);
    if (last === "." || last === "..") {
      if (context.fs.statTarget(unresolved(context.cwd, operand)) === null) {
        return "No such file or directory";
      }
      return last === "." ? "Invalid argument" : "Directory not empty";
    }
    if (operand.endsWith("/") && context.fs.stat(path)?.type === "symlink") {
      return context.fs.statTarget(path)?.type === "dir"
        ? "Symbolic link not followed"
        : "Not a directory";
    }
    context.fs.rmdir(path);
    return null;
  } catch (error) {
    if (!isFilesystemError(error)) throw error;
    return strerror(error);
  }
}

function finalComponent(operand: string): string {
  const trimmed = operand.replace(/\/+$/, "");
  return trimmed.slice(trimmed.lastIndexOf("/") + 1);
}

/** Rust's `Path::parent` as the string it slices: null at the root or an empty rest. */
function parentOf(operand: string): string | null {
  const trimmed = operand.replace(/\/+$/, "");
  if (trimmed === "") return null;
  const slash = trimmed.lastIndexOf("/");
  if (slash === -1) return null;
  const parent = trimmed.slice(0, slash).replace(/\/+$/, "");
  return parent === "" ? "/" : parent;
}
