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
import { line } from "./bytes.js";
import {
  BoundedFs,
  type Command,
  DEFAULT_LIMITS,
  type Limits,
  ShellLimitError,
} from "./context.js";
import { prepareRunInput, type RunInputOwner } from "./input.js";
import { runPipeline } from "./pipeline.js";
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
  let cwd = normalize(options.cwd);
  let exitCode = 0;
  let previousConnector: "&&" | "||" | ";" | null = null;
  let runInput: RunInputOwner | null = null;
  let commandTruncated = false;

  try {
    try {
      runInput = prepareRunInput(options.stdin, options.env, fs);
      for (const step of plan.steps) {
        const selected =
          previousConnector === null ||
          previousConnector === ";" ||
          (previousConnector === "&&" ? exitCode === 0 : exitCode !== 0);
        if (selected) {
          const outcome = await runPipeline(step.pipeline, {
            fs,
            cwd,
            commands: options.commands,
            out,
            errors,
            inputs: runInput,
            currentStatus: exitCode,
            chdir: (path: string) => {
              cwd = path;
            },
          });
          exitCode = outcome.exitCode;
          commandTruncated ||= outcome.truncated;
          if (outcome.terminateRun) break;
        }
        previousConnector = step.connector;
      }
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
      cwd,
      truncated: commandTruncated || out.truncated || errors.truncated,
      operations: fs.operations,
      peakRetainedBytes: fs.retained.peak,
    };
  } finally {
    runInput?.close();
  }
}
