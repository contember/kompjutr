// The public surface: `kompjutr/shell`.
//
// A bash-shaped command surface over `Filesystem`, in which a command is a
// query rather than a tree walk. See docs/archive/plans/shell.md for what it does
// and, more usefully, for what it deliberately does not.

import type { Filesystem } from "../fs/types.js";
import { builtinCommands } from "./commands/index.js";
import { decode } from "./exec/bytes.js";
import { type Command, DEFAULT_LIMITS, type Limits } from "./exec/context.js";
import { type ExecResult, execute } from "./exec/execute.js";
import { ShellSyntaxError } from "./parse/ast.js";
import { parse } from "./parse/parser.js";
import { planScript } from "./plan/plan.js";
import { DEFAULT_CWD, initializeShellSchema, ShellSession } from "./session.js";

export interface ShellOptions {
  readonly fs: Filesystem;
  /** Identifies the persistent working directory. One row per session. */
  readonly sessionId?: string;
  /** Where a brand-new session starts. */
  readonly cwd?: string;
  /**
   * Commands layered on top of the built-ins. This is where a consumer
   * injects `git`; the shell never imports the git layer itself.
   */
  readonly commands?: ReadonlyMap<string, Command>;
  readonly limits?: Limits;
}

export interface ShellRunOptions {
  readonly stdin?: Uint8Array | string;
  readonly env?: Readonly<Record<string, string>>;
}

export interface RunResult {
  readonly stdout: string;
  readonly stderr: string;
  readonly exitCode: number;
  readonly cwd: string;
  /** True when the stdout or stderr ceiling stopped the result early. */
  readonly truncated: boolean;
  /** Filesystem operations the run cost. The metric that matters. */
  readonly operations: number;
  /** Peak shell-owned intermediate bytes, excluding public stdout and stderr. */
  readonly peakRetainedBytes: number;
}

export interface Shell {
  /** Run one command line. Text in, text out. */
  run(source: string, options?: ShellRunOptions): RunResult;
  /** Run one command line, keeping stdout as bytes. */
  exec(source: string, options?: ShellRunOptions): ExecResult;
  cwd(): string;
}

export function createShell(options: ShellOptions): Shell {
  const sessionId = options.sessionId ?? "default";
  initializeShellSchema(options.fs.db);
  const session = new ShellSession(options.fs.db, sessionId, options.cwd ?? DEFAULT_CWD);

  const commands = builtinCommands();
  if (options.commands !== undefined) {
    for (const [name, command] of options.commands) commands.set(name, command);
  }

  const exec = (source: string, runOptions?: ShellRunOptions): ExecResult => {
    const before = session.cwd();
    let plan: ReturnType<typeof planScript>;
    try {
      plan = planScript(parse(source));
    } catch (error) {
      if (error instanceof ShellSyntaxError) {
        const message = new TextEncoder().encode(`kompjutr: ${error.message}\n`);
        const maxOutputBytes = options.limits?.maxOutputBytes ?? DEFAULT_LIMITS.maxOutputBytes;
        const stderr = message.subarray(0, Math.max(0, maxOutputBytes));
        return {
          stdout: new Uint8Array(0),
          stderr,
          exitCode: 2,
          cwd: before,
          truncated: stderr.length < message.length,
          operations: 0,
          peakRetainedBytes: 0,
        };
      }
      throw error;
    }

    const outcome = execute(plan, {
      fs: options.fs,
      cwd: before,
      commands,
      limits: options.limits ?? DEFAULT_LIMITS,
      stdin: runOptions?.stdin,
      env: runOptions?.env,
    });
    if (outcome.cwd !== before) session.setCwd(outcome.cwd);
    return outcome;
  };

  return {
    exec,
    run: (source: string, runOptions?: ShellRunOptions): RunResult => {
      const outcome = exec(source, runOptions);
      return {
        stdout: decode(outcome.stdout),
        stderr: decode(outcome.stderr),
        exitCode: outcome.exitCode,
        cwd: outcome.cwd,
        truncated: outcome.truncated,
        operations: outcome.operations,
        peakRetainedBytes: outcome.peakRetainedBytes,
      };
    },
    cwd: () => session.cwd(),
  };
}

export type { CommandContext, CommandResult } from "./exec/context.js";
export type { Command, ExecResult, Limits };
export { DEFAULT_LIMITS, ShellSyntaxError };
