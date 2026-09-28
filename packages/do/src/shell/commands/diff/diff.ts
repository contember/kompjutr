// `diff` between two files, a file and stdin, or two directories, in GNU's
// normal or unified format. A file pair is read whole and held against the
// retained budget while its edit script is computed, in linear space; a
// directory pair streams one entry at a time (see tree.ts). Exit status is 0
// when equal, 1 when different, and 2 on trouble.

import { basename } from "../../../fs/path.js";
import { type ByteStream, concat, empty } from "../../exec/bytes.js";
import {
  type Command,
  type CommandContext,
  type CommandResult,
  deferred,
  result,
} from "../../exec/context.js";
import { resolve } from "../../exec/execute.js";
import { UsageError } from "../flags.js";
import { type DiffOptions, parseOptions } from "./options.js";
import type { Comparison, Side } from "./pair.js";
import { absent, childName, compareSides, present } from "./tree.js";

export const diff: Command = async (context) => {
  let options: DiffOptions | string;
  try {
    options = parseOptions(context.argv);
  } catch (error) {
    if (error instanceof UsageError) return trouble(context, [error.message]);
    throw error;
  }
  if (typeof options === "string") return usageTrouble(context, options);
  const [left, right, extra] = options.operands;
  if (left === undefined) return usageTrouble(context, "missing operand after 'diff'");
  if (right === undefined) return usageTrouble(context, `missing operand after '${left}'`);
  if (extra !== undefined) return usageTrouble(context, `extra operand '${extra}'`);

  const releases: Array<() => void> = [];
  const release = (): void => {
    for (const done of releases.splice(0)) done();
  };
  try {
    const sides = await operands(context, options, left, right, releases);
    if (!("a" in sides)) {
      release();
      return trouble(context, sides);
    }
    const comparison: Comparison = { context, options, status: 0 };
    return deferred((setStatus) => stream(comparison, sides, release, setStatus));
  } catch (error) {
    release();
    throw error;
  }
};

function* stream(
  comparison: Comparison,
  sides: { readonly a: Side; readonly b: Side },
  release: () => void,
  setStatus: (code: number) => void,
): ByteStream {
  try {
    yield* compareSides(comparison, sides.a, sides.b, null);
  } finally {
    release();
    setStatus(comparison.status);
  }
}

/**
 * The two top-level sides, or the diagnostics for why there are none. A
 * directory against a file compares the file of the same name inside it, as
 * GNU does; under `-N` a missing operand is empty when the other exists.
 */
async function operands(
  context: CommandContext,
  options: DiffOptions,
  left: string,
  right: string,
  releases: Array<() => void>,
): Promise<{ a: Side; b: Side } | string[]> {
  let a = await operand(context, left, releases);
  let b = await operand(context, right, releases);
  if (a === null && b === null) {
    return [`${left}: No such file or directory`, `${right}: No such file or directory`];
  }
  if (a === null) {
    if (!options.newFile) return [`${left}: No such file or directory`];
    a = absent(left, "");
  }
  if (b === null) {
    if (!options.newFile) return [`${right}: No such file or directory`];
    b = absent(right, "");
  }
  if (a.kind === "dir" && b.kind === "file") {
    const found = inside(context, a, b);
    if (typeof found === "string") return [found];
    a = found;
  } else if (b.kind === "dir" && a.kind === "file") {
    const found = inside(context, b, a);
    if (typeof found === "string") return [found];
    b = found;
  }
  return { a, b };
}

async function operand(
  context: CommandContext,
  name: string,
  releases: Array<() => void>,
): Promise<Side | null> {
  if (name === "-") {
    const chunks: Uint8Array[] = [];
    for await (const chunk of context.stdin ?? empty()) {
      releases.push(context.fs.retained.retain(chunk.length, "diff input"));
      chunks.push(chunk.slice());
    }
    const bytes = concat(chunks);
    return {
      name,
      path: "",
      kind: "file",
      size: bytes.length,
      mtime: context.now(),
      ino: null,
      contentId: null,
      bytes,
    };
  }
  const path = resolve(context.cwd, name);
  const stat = context.fs.statTarget(path);
  return stat === null ? null : present(name, path, stat);
}

/** The entry of `directory` named like `file`, or the diagnostic for why there is none. */
function inside(context: CommandContext, directory: Side, file: Side): Side | string {
  if (file.bytes !== null) return "cannot compare '-' to a directory";
  const name = childName(directory.name, basename(file.path));
  const path = resolve(context.cwd, name);
  const stat = context.fs.statTarget(path);
  return stat === null ? `${name}: No such file or directory` : present(name, path, stat);
}

function usageTrouble(context: CommandContext, message: string): CommandResult {
  context.warn(message);
  context.warn("Try 'diff --help' for more information.");
  return result(empty(), 2);
}

function trouble(context: CommandContext, messages: readonly string[]): CommandResult {
  for (const message of messages) context.warn(message);
  return result(empty(), 2);
}
