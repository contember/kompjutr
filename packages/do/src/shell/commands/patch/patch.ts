// The `patch` command: read the whole diff under the retained budget, then
// apply its patches one at a time, flushing progress after each.
//
// Work does not stop when stdout's consumer does: the remaining patches are
// still applied and their messages dropped, so `patch | head` patches every
// file. A GNU fatal error publishes what was queued, as GNU does before it
// exits; a failure of this runtime (a limit, the store) discards it.

import { type ByteStream, drainBounded, empty } from "../../exec/bytes.js";
import type { Command, CommandContext } from "../../exec/context.js";
import { result } from "../../exec/context.js";
import { resolve } from "../../exec/execute.js";
import { processPatch, type Session } from "./file-patch.js";
import { type PatchOptions, PatchUsageError, parsePatchArguments } from "./options.js";
import { PatchFatalError, PatchRefusal, Report } from "./report.js";
import { nextPatch } from "./scan.js";
import { lineStarts, PatchInput } from "./text.js";
import { Workspace } from "./workspace.js";

export const patch: Command = async (context) => {
  let options: PatchOptions;
  try {
    options = parsePatchArguments(context.argv);
  } catch (error) {
    if (!(error instanceof PatchUsageError)) throw error;
    for (const line of error.lines) context.warn(line);
    if (error.tryHelp) context.warn("Try 'patch --help' for more information.");
    return result(empty(), 2);
  }
  const fatal = (message: string) => {
    context.warn(`**** ${message}`);
    return result(empty(), 2);
  };

  let root = context.cwd;
  if (options.directory !== null) {
    root = resolve(context.cwd, options.directory);
    const stat = context.fs.statTarget(root);
    if (stat === null) {
      return fatal(`Can't change to directory ${options.directory} : No such file or directory`);
    }
    if (stat.type !== "dir") {
      return fatal(`Can't change to directory ${options.directory} : Not a directory`);
    }
  }

  const held = await readInput(context, options, root);
  if (typeof held === "string") return fatal(held);
  let status = 0;
  const stdout = run(context, options, root, held.bytes, held.release, (code) => {
    status = code;
  });
  return { stdout, status: () => status, truncated: () => false };
};

interface Held {
  readonly bytes: Uint8Array;
  release(): void;
}

async function readInput(
  context: CommandContext,
  options: PatchOptions,
  root: string,
): Promise<Held | string> {
  const budget = context.fs.retained;
  if (options.input !== null && options.input !== "-") {
    const path = resolve(root, options.input);
    const stat = context.fs.statTarget(path);
    if (stat === null) return `Can't open patch file ${options.input} : No such file or directory`;
    if (stat.type === "dir") return "read error : Is a directory";
    const release = budget.retain(stat.size, "patch input");
    try {
      return { bytes: context.fs.readFile(path), release };
    } catch (error) {
      release();
      throw error;
    }
  }
  if (context.stdin === null) return { bytes: new Uint8Array(), release: () => {} };
  return drainBounded(context.stdin, budget, "patch input");
}

function run(
  context: CommandContext,
  options: PatchOptions,
  root: string,
  bytes: Uint8Array,
  releaseInput: () => void,
  setStatus: (status: number) => void,
): ByteStream {
  const steps = patchSteps(context, options, root, bytes, setStatus);
  return (function* (): Generator<Uint8Array, void, undefined> {
    try {
      for (let next = steps.next(); next.done !== true; next = steps.next()) yield next.value;
    } finally {
      try {
        for (let next = steps.next(); next.done !== true; next = steps.next());
      } finally {
        releaseInput();
      }
    }
  })();
}

function* patchSteps(
  context: CommandContext,
  options: PatchOptions,
  root: string,
  bytes: Uint8Array,
  setStatus: (status: number) => void,
): Generator<Uint8Array, void, undefined> {
  const budget = context.fs.retained;
  const index = lineStarts(bytes, budget, "patch input lines");
  const workspace = new Workspace(context.fs, root);
  const report = new Report(budget, options.silent);
  const session: Session = {
    fs: context.fs,
    options,
    workspace,
    report,
    input: new PatchInput(bytes, index),
    operand:
      options.original === null
        ? null
        : { name: options.original, path: resolve(root, options.original) },
    status: 0,
    rejectFileStarted: false,
  };
  try {
    let at = 0;
    let found = false;
    for (;;) {
      const header = nextPatch(session.input, at, report);
      if (header === null) break;
      found = true;
      at = processPatch(session, header);
      yield* report.take();
    }
    if (!found && bytes.length > 0) {
      throw new PatchFatalError("Only garbage was found in the patch input.");
    }
    workspace.publish();
    yield* report.take();
    setStatus(session.status);
  } catch (error) {
    if (!(error instanceof PatchFatalError || error instanceof PatchRefusal)) {
      workspace.discard();
      throw error;
    }
    workspace.publish();
    yield* report.take();
    context.warn(error instanceof PatchFatalError ? `**** ${error.message}` : error.message);
    setStatus(2);
  } finally {
    report.take();
    index.release();
  }
}
