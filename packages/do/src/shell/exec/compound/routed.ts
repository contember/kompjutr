// A compound command whose output is routed: a pipeline stage, or one that
// carries redirections. Its body runs lazily inside the stdout it returns,
// so the stage is routed exactly like a simple command's output — files,
// `2>&1`, pipes — and a consumer that stops pulling stops the body.

import type { PlannedCompound } from "../../plan/types.js";
import type { CommandContext, CommandResult } from "../context.js";
import type { Frame, Outcome, Runtime, Segments, ShellIO, StdinCursor } from "./frame.js";

export interface CompoundRun {
  readonly result: CommandResult;
  /** Null until the body has finished; a consumer that stopped early leaves it null. */
  outcome(): Outcome | null;
}

const CANCELLED: Outcome = { status: 0, flow: null };

/**
 * `context` is the compound's own: its diagnostics follow the compound's
 * redirections, which makes it the body's stderr. `limits` are the live
 * terminal bounds of the compound's stdout and stderr destinations.
 */
export function runRoutedCompound(
  stage: PlannedCompound,
  context: CommandContext,
  limits: { stdout(): number; stderr(): number },
  frame: Frame,
  stdin: StdinCursor | null,
  runtime: Runtime,
): CompoundRun {
  const io: ShellIO = {
    stdin,
    stderr: {
      writeBytes: (bytes) => context.diagnostic(bytes),
      write: async (stream) => {
        for await (const chunk of stream) context.diagnostic(chunk);
      },
      limit: limits.stderr,
      discards: context.output.discardStderr,
    },
    stdoutLimit: limits.stdout,
  };
  let outcome: Outcome | null = null;
  const body = (async function* (): AsyncGenerator<Uint8Array, void, undefined> {
    outcome = yield* flatten(runtime.compound(stage, { ...frame, io }));
  })();
  return {
    result: {
      stdout: new CompoundOutput(body),
      status: () => outcome?.status ?? 0,
      truncated: () => false,
    },
    outcome: () => outcome,
  };
}

/**
 * A body closed before anything pulled it still runs up to its first output,
 * as a Bash stage runs until a write meets the closed pipe: `(exit 3) | true`
 * keeps its status for `pipefail`, and the body stops at its first write.
 */
class CompoundOutput implements AsyncIterableIterator<Uint8Array, void, undefined> {
  #started = false;

  constructor(private readonly body: AsyncGenerator<Uint8Array, void, undefined>) {}

  [Symbol.asyncIterator](): AsyncIterableIterator<Uint8Array, void, undefined> {
    return this;
  }

  next(..._args: [] | [undefined]): Promise<IteratorResult<Uint8Array, void>> {
    this.#started = true;
    return this.body.next();
  }

  async return(_value?: undefined): Promise<IteratorResult<Uint8Array, void>> {
    if (!this.#started) {
      this.#started = true;
      const first = await this.body.next();
      if (first.done === true) return first;
    }
    return this.body.return(undefined);
  }

  async throw(error: unknown): Promise<IteratorResult<Uint8Array, void>> {
    return this.body.throw(error);
  }
}

/** The segments' bytes in order; closing the result closes the body where it stands. */
async function* flatten(segments: Segments): AsyncGenerator<Uint8Array, Outcome, undefined> {
  let finished = false;
  try {
    for (;;) {
      const next = await segments.next();
      if (next.done === true) {
        finished = true;
        return next.value;
      }
      yield* next.value;
    }
  } finally {
    if (!finished) await segments.return(CANCELLED);
  }
}
