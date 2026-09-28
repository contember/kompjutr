// `patch`: apply a unified diff and publish each file atomically. The diff
// is held whole against the retained budget, because GNU patch reads it
// twice: once to find each header and again to apply what follows it.

import { drainBounded, empty, owned } from "../../exec/bytes.js";
import {
  type Command,
  type CommandContext,
  type CommandResult,
  result,
} from "../../exec/context.js";
import { resolve } from "../../exec/execute.js";
import { PatchFatal, PatchUsage, Transcript } from "./messages.js";
import { quote } from "./names.js";
import { type PatchOptions, parseOptions } from "./options.js";
import { Publisher } from "./publish.js";
import { applyAll } from "./run.js";
import { Session } from "./session.js";
import { PatchSource } from "./source.js";

const patch: Command = async (context) => {
  let options: PatchOptions;
  try {
    options = parseOptions(context, context.argv);
  } catch (error) {
    if (error instanceof PatchUsage) {
      context.warn(error.message);
      if (error.tryHelp) context.warn("Try 'patch --help' for more information.");
      return result(empty(), 2);
    }
    if (error instanceof PatchFatal) {
      context.diagnostic(error.diagnostic());
      return result(empty(), 2);
    }
    throw error;
  }

  const transcript = new Transcript(context.fs.retained);
  let input: { readonly bytes: Uint8Array; release(): void } | null = null;
  let status: number;
  const publisher = new Publisher(context.fs, options.cwd);
  try {
    input = await readPatch(context, options);
    const source = new PatchSource(input.bytes, (text) => transcript.say(text));
    status = applyAll(context, new Session(options, publisher, transcript), source);
  } catch (error) {
    if (!(error instanceof PatchFatal)) {
      transcript.release();
      throw error;
    }
    context.diagnostic(error.diagnostic());
    publisher.flush();
    status = 2;
  } finally {
    input?.release();
  }
  return stdout(transcript, status);
};

function stdout(transcript: Transcript, status: number): CommandResult {
  const chunks = transcript.chunks;
  const stream = (function* () {
    yield* chunks;
  })();
  return result(
    owned(stream, () => transcript.release()),
    status,
  );
}

async function readPatch(
  context: CommandContext,
  options: PatchOptions,
): Promise<{ readonly bytes: Uint8Array; release(): void }> {
  const file = options.patchFile;
  if (file === null || file === "" || file === "-") {
    return drainBounded(context.stdin ?? empty(), context.fs.retained, "patch input");
  }
  const path = resolve(options.cwd, file);
  const stat = context.fs.statTarget(path);
  if (stat === null) {
    throw new PatchFatal(`Can't open patch file ${quote(file)} : No such file or directory`);
  }
  if (stat.type === "dir") throw new PatchFatal("read error : Is a directory");
  const release = context.fs.retained.retain(stat.size, "patch input");
  try {
    return { bytes: context.fs.readFile(path), release };
  } catch (error) {
    release();
    throw error;
  }
}

export const patchCommands: ReadonlyMap<string, Command> = new Map([["patch", patch]]);
