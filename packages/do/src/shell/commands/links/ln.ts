// `ln` as uutils 0.2.2 behaves, quirks included: a failed symlink reports
// only the error kind (`ln: Already exists`), `-n` matters only with `-f`,
// and `-f` refuses to replace a link with the file it already names.
//
// A hard link to a symbolic link is refused: link(2) would name the link
// itself, and the store can give a second name only to a regular file.

import { dirname } from "../../../fs/path.js";
import type { Stat } from "../../../fs/types.js";
import { encode } from "../../exec/bytes.js";
import {
  type Command,
  type CommandContext,
  type CommandResult,
  result,
} from "../../exec/context.js";
import { resolve } from "../../exec/execute.js";
import { isFilesystemError } from "../../exec/redirections.js";
import { UsageError } from "../flags.js";
import { canonicalize, relativeTo, unresolved } from "./canonical.js";
import { ClapError, has, missingRequired, type OptionSpec, parseOptions } from "./options.js";
import { HeldOutput, kindMessage, quote } from "./output.js";

const SPEC: OptionSpec = {
  usage:
    "Usage: ln [OPTION]... [-T] TARGET LINK_NAME\n" +
    "       ln [OPTION]... TARGET\n" +
    "       ln [OPTION]... TARGET... DIRECTORY\n" +
    "       ln [OPTION]... -t DIRECTORY TARGET...",
  short: new Map([
    ["s", "symbolic"],
    ["f", "force"],
    ["n", "no-dereference"],
    ["T", "no-target-directory"],
    ["v", "verbose"],
    ["r", "relative"],
    ["b", "backup"],
    ["S", "suffix"],
    ["t", "target-directory"],
    ["i", "interactive"],
    ["L", "logical"],
    ["P", "physical"],
  ]),
  long: new Map([
    ["symbolic", false],
    ["force", false],
    ["no-dereference", false],
    ["no-target-directory", false],
    ["verbose", false],
    ["relative", false],
    ["backup", false],
    ["suffix", true],
    ["target-directory", true],
    ["interactive", false],
    ["logical", false],
    ["physical", false],
  ]),
  refused: new Set(["backup", "suffix", "target-directory", "interactive", "logical", "physical"]),
};

interface Settings {
  readonly symbolic: boolean;
  readonly force: boolean;
  readonly noDereference: boolean;
  readonly verbose: boolean;
  readonly relative: boolean;
}

export const ln: Command = (context) => {
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
  const operands = parsed.operands;
  if (operands.length === 0) throw missingRequired("<files>...", SPEC);
  const settings: Settings = {
    symbolic: has(parsed, "symbolic"),
    force: has(parsed, "force"),
    noDereference: has(parsed, "no-dereference"),
    verbose: has(parsed, "verbose"),
    relative: has(parsed, "relative"),
  };
  if (settings.relative && !settings.symbolic) throw missingRequired("--symbolic", SPEC);

  const output = new HeldOutput(context);
  const [first, second] = operands;
  if (has(parsed, "no-target-directory")) {
    if (operands.length === 1) {
      context.warn(`missing destination file operand after ${quote(first ?? "")}`);
      return output.result(1);
    }
    if (operands.length > 2) {
      context.warn(`extra operand ${operands[2] ?? ""}`);
      context.diagnostic(encode("Try 'ln --help' for more information.\n"));
      return output.result(1);
    }
    return output.result(linkOne(context, output, settings, first ?? "", second ?? "") ? 0 : 1);
  }

  if (operands.length === 1) {
    return output.result(linkInto(context, output, settings, operands, ".") ? 0 : 1);
  }
  const last = operands[operands.length - 1] ?? "";
  if (operands.length > 2 || isDirectory(context, last)) {
    const sources = operands.slice(0, -1);
    return output.result(linkInto(context, output, settings, sources, last) ? 0 : 1);
  }
  return output.result(linkOne(context, output, settings, first ?? "", last) ? 0 : 1);
}

function linkInto(
  context: CommandContext,
  output: HeldOutput,
  settings: Settings,
  sources: readonly string[],
  directory: string,
): boolean {
  if (!isDirectory(context, directory)) {
    context.warn(`target ${quote(directory)} is not a directory`);
    return false;
  }
  let succeeded = true;
  for (const source of sources) {
    let destination: string;
    if (settings.noDereference && settings.force) {
      // uutils replaces a symlinked target directory itself rather than linking inside it.
      const path = resolve(context.cwd, directory);
      if (context.fs.stat(path)?.type === "symlink") context.fs.removeFiles([path]);
      destination = directory;
    } else {
      destination = joinName(directory, source);
    }
    if (!linkOne(context, output, settings, source, destination)) succeeded = false;
  }
  return succeeded;
}

function linkOne(
  context: CommandContext,
  output: HeldOutput,
  settings: Settings,
  source: string,
  destination: string,
): boolean {
  const target = settings.relative ? relativeTarget(context, source, destination) : source;
  const report = (message: string): boolean => {
    context.warn(
      settings.symbolic
        ? message
        : `failed to create hard link ${quote(source)} => ${quote(destination)}: ${message}`,
    );
    return false;
  };
  // An empty name is no path to symlink(2) or link(2); resolve() would read it as cwd.
  if (destination === "" || (!settings.symbolic && source === "") || target === "") {
    return report("No such file or directory");
  }

  const path = resolve(context.cwd, destination);
  try {
    const existing = context.fs.stat(path);
    if (existing !== null && settings.force) {
      if (existing.type !== "symlink" && sameFile(context, source, path)) {
        context.warn(`${quote(source)} and ${quote(destination)} are the same file`);
        return false;
      }
      // A directory survives, as remove_file(2) leaves it, and creation then fails.
      if (existing.type !== "dir") context.fs.removeFiles([path]);
    }

    if (settings.symbolic) {
      context.fs.symlink(target, path);
    } else {
      const sourcePath = resolve(context.cwd, source);
      if (context.fs.stat(sourcePath)?.type === "symlink") {
        throw new UsageError("hard links to symbolic links are not supported");
      }
      context.fs.link(sourcePath, path);
    }
  } catch (error) {
    if (!isFilesystemError(error)) throw error;
    return report(kindMessage(error));
  }

  if (settings.verbose) output.write(`${quote(destination)} -> ${quote(target)}\n`);
  return true;
}

/** `-r`: the target spelled from the link's directory, both sides fully resolved. */
function relativeTarget(context: CommandContext, source: string, destination: string): string {
  const from = canonicalize(
    context.fs,
    dirname(unresolved(context.cwd, destination.replace(/\/+$/, ""))),
    "missing",
  );
  const to = canonicalize(context.fs, unresolved(context.cwd, source), "missing");
  return relativeTo(from, to);
}

/** Rust's `dir.join(file_name(source))`, spelled as uutils prints it. */
function joinName(directory: string, source: string): string {
  const trimmed = source.replace(/\/+$/, "");
  const name = trimmed.slice(trimmed.lastIndexOf("/") + 1);
  const leaf = name === "" || name === "." || name === ".." ? source : name;
  if (leaf.startsWith("/")) return leaf;
  return directory.endsWith("/") ? `${directory}${leaf}` : `${directory}/${leaf}`;
}

function isDirectory(context: CommandContext, operand: string): boolean {
  if (operand === "") return false;
  return targetOf(context, resolve(context.cwd, operand))?.type === "dir";
}

function sameFile(context: CommandContext, source: string, destination: string): boolean {
  const left = targetOf(context, resolve(context.cwd, source));
  const right = targetOf(context, destination);
  return left !== null && right !== null && left.ino === right.ino;
}

function targetOf(context: CommandContext, path: string): Stat | null {
  try {
    return context.fs.statTarget(path);
  } catch (error) {
    if (isFilesystemError(error)) return null;
    throw error;
  }
}
