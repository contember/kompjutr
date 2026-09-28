// Running a plan.
//
// Pull-based on purpose: a stage only advances when the stage after it asks
// for more, so a `head -20` that stops asking stops the search behind it,
// which stops the discovery pages behind that. R1's limit pushdown is not
// implemented here as a rewrite — it falls out of the laziness, and the
// planner's `limitHint` only sizes the first page.

import { normalize } from "../../fs/path.js";
import type { Filesystem } from "../../fs/types.js";
import { ShellSyntaxError } from "../parse/ast.js";
import type { Plan } from "../plan/types.js";
import { LoopBudget } from "./arguments.js";
import { line } from "./bytes.js";
import type { Frame, Outcome, Runtime, Segments } from "./compound/frame.js";
import { runCompound, runList } from "./compound/run.js";
import { ShellState } from "./compound/state.js";
import { runSubstitution } from "./compound/substitution.js";
import {
  BoundedFs,
  type Command,
  DEFAULT_LIMITS,
  type Limits,
  ShellLimitError,
} from "./context.js";
import { prepareRunInput, type RunInputOwner } from "./input.js";
import { Sink } from "./sink.js";

export { resolve } from "./arguments.js";
export { RunInputOwner } from "./input.js";

export interface ExecOptions {
  readonly fs: Filesystem;
  readonly cwd: string;
  readonly commands: ReadonlyMap<string, Command>;
  readonly limits?: Limits;
  readonly stdin?: Uint8Array | string;
  readonly env?: Readonly<Record<string, string>>;
  /** Milliseconds since the epoch. Defaults to `Date.now`. */
  readonly now?: () => number;
}

export interface ExecResult {
  readonly stdout: Uint8Array;
  readonly stderr: Uint8Array;
  readonly exitCode: number;
  /** The working directory after the run — `cd` is a builtin. */
  readonly cwd: string;
  /** True when `maxOutputBytes` stopped stdout or stderr early. */
  readonly truncated: boolean;
  readonly operations: number;
  /** Peak shell-owned intermediate bytes, excluding public stdout and stderr. */
  readonly peakRetainedBytes: number;
}

export async function execute(plan: Plan, options: ExecOptions): Promise<ExecResult> {
  const limits = options.limits ?? DEFAULT_LIMITS;
  const fs = new BoundedFs(options.fs, limits);
  const out = new Sink(limits.maxOutputBytes);
  const errors = new Sink(limits.maxOutputBytes);
  const runtime: Runtime = {
    fs,
    commands: options.commands,
    loops: new LoopBudget(),
    now: options.now ?? Date.now,
    truncated: false,
    compound: (stage, frame) => runCompound(stage, frame, runtime),
    substitute: (body, frame, io) => runSubstitution(body, frame, io, runtime),
  };
  let shell: ShellState | null = null;
  let exitCode = 0;
  let runInput: RunInputOwner | null = null;

  try {
    try {
      runInput = prepareRunInput(options.stdin, options.env, fs);
      shell = ShellState.initial(normalize(options.cwd), runInput?.env, fs.retained);
      const frame: Frame = {
        shell,
        io: {
          stdin: runInput,
          stderr: {
            writeBytes: (bytes) => errors.writeBytes(bytes),
            write: (stream) => errors.write(stream),
            limit: () => Math.min(errors.remaining, fs.retained.available),
            discards: false,
          },
          stdoutLimit: () => Math.min(out.remaining, fs.retained.available),
        },
        loops: 0,
        errexitIgnored: false,
      };
      exitCode = (await writeSegments(runList(plan, frame, runtime), out)).status;
    } catch (error) {
      if (error instanceof ShellLimitError || error instanceof ShellSyntaxError) {
        errors.writeBytes(line(`kompjutr: ${error.message}`));
        exitCode = 2;
      } else {
        throw error;
      }
    }

    return {
      stdout: out.bytes(),
      stderr: errors.bytes(),
      exitCode,
      cwd: shell?.cwd ?? normalize(options.cwd),
      truncated: runtime.truncated || out.truncated || errors.truncated,
      operations: fs.operations,
      peakRetainedBytes: fs.retained.peak,
    };
  } finally {
    try {
      shell?.release();
    } finally {
      runInput?.close();
    }
  }
}

/** Each pipeline's output reaches the sink in turn; a truncated sink stops only that pipeline. */
async function writeSegments(segments: Segments, out: Sink): Promise<Outcome> {
  let finished = false;
  try {
    for (;;) {
      const next = await segments.next();
      if (next.done === true) {
        finished = true;
        return next.value;
      }
      await out.write(next.value);
    }
  } finally {
    if (!finished) await segments.return({ status: 2, flow: null });
  }
}
