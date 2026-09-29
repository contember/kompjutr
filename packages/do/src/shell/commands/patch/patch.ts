// The `patch` command: read the whole diff under the retained budget, then
// apply its patches one at a time.
//
// The work runs before stdout is returned, so it does not depend on stdout's
// reader: `patch | true` and `patch | head` patch every file. A GNU fatal
// error publishes what was queued, as GNU does before it exits; a failure of
// this runtime (a limit, the store) discards it and propagates.

import { drainBounded, empty, owned } from "../../exec/bytes.js";
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
  const report = new Report(context.fs.retained, options.silent);
  let status: number;
  try {
    status = runPatches(context, options, root, held.bytes, report);
  } catch (error) {
    report.handOver().release();
    throw error;
  } finally {
    held.release();
  }
  const output = report.handOver();
  return result(owned(chunks(output.chunks), output.release), status);
};

function* chunks(list: readonly Uint8Array[]): Generator<Uint8Array, void, undefined> {
  yield* list;
}

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

/** Apply every patch in the input; returns the exit status. */
function runPatches(
  context: CommandContext,
  options: PatchOptions,
  root: string,
  bytes: Uint8Array,
  report: Report,
): number {
  const budget = context.fs.retained;
  const index = lineStarts(bytes, budget, "patch input lines");
  const workspace = new Workspace(context.fs, root);
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
    }
    if (!found && bytes.length > 0) {
      throw new PatchFatalError("Only garbage was found in the patch input.");
    }
    publishOrDiscard(workspace);
    return session.status;
  } catch (error) {
    if (!(error instanceof PatchFatalError || error instanceof PatchRefusal)) {
      discardQuietly(workspace);
      throw error;
    }
    context.warn(error instanceof PatchFatalError ? `**** ${error.message}` : error.message);
    publishOrDiscard(workspace);
    return 2;
  } finally {
    index.release();
  }
}

/** Publish the queue; if that fails, remove the staging and let the failure propagate. */
function publishOrDiscard(workspace: Workspace): void {
  try {
    workspace.publish();
  } catch (error) {
    discardQuietly(workspace);
    throw error;
  }
}

// The run is already failing; a failure to clean up must not replace its error.
function discardQuietly(workspace: Workspace): void {
  try {
    workspace.discard();
  } catch {}
}
