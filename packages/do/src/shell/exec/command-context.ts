import { type ByteStream, line } from "./bytes.js";
import type { Frame, Runtime } from "./compound/frame.js";
import type { CommandContext, CommandResult, InvokeOptions } from "./context.js";
import type { HeldChunk, OutputDestination, ResolvedRedirections } from "./routing-types.js";
import { diagnosticsFor } from "./stage-output.js";

/** What a diagnostic names: a command, or a compound command's opening word. */
export interface StageLabel {
  readonly name: string;
  readonly line: number;
}

/**
 * Every pipeline stage is a shell of its own, so a direct `exit` may end it:
 * the run, a subshell, or just that stage of a multi-stage pipeline.
 */
export function commandContext(
  label: StageLabel,
  redirections: ResolvedRedirections,
  lastStage: boolean,
  argv: readonly string[],
  stdin: ByteStream | null,
  limitHint: number | null,
  frame: Frame,
  runtime: Runtime,
  routedDiagnostics: Map<OutputDestination, HeldChunk[]>,
): CommandContext {
  const output = commandOutput(redirections, lastStage, frame);
  const diagnostic = (bytes: Uint8Array): void => {
    if (bytes.length === 0 || redirections.stderr.kind === "drop") return;
    if (redirections.stderr.kind === "diagnostic") {
      frame.io.stderr.writeBytes(bytes);
    } else {
      diagnosticsFor(routedDiagnostics, redirections.stderr).push({
        bytes,
        release: runtime.fs.retained.retain(bytes.length, "routed diagnostic"),
      });
    }
  };
  const shell = frame.shell;
  const context: CommandContext = {
    fs: runtime.fs,
    cwd: shell.cwd,
    argv,
    stdin,
    env: shell.variables.exported(),
    currentStatus: shell.status,
    now: runtime.now,
    mayExitRun: true,
    line: label.line,
    limitHint,
    output,
    diagnostic,
    warn: (message: string) => {
      if (redirections.stderr.kind === "drop") return;
      const bytes = line(`${label.name}: ${message}`);
      diagnostic(bytes);
    },
    chdir: (path: string) => {
      shell.cwd = path;
    },
    invoke: async (
      name: string,
      subArgv: readonly string[],
      options?: InvokeOptions,
    ): Promise<CommandResult | null> => {
      const command = runtime.commands.get(name);
      if (command === undefined) return null;
      // No stdin and no demand hint: the sub-invocation's arguments already
      // carry everything it is meant to see.
      return command({
        ...context,
        argv: subArgv,
        env: options?.env ?? context.env,
        stdin: null,
        limitHint: null,
        mayExitRun: false,
      });
    },
  };
  return context;
}

function commandOutput(
  redirections: ResolvedRedirections,
  lastStage: boolean,
  frame: Frame,
): CommandContext["output"] {
  const maxStdoutBytes = destinationLimit(redirections.stdout, lastStage, frame);
  const maxStderrBytes = destinationLimit(redirections.stderr, lastStage, frame);
  const discardStderr =
    redirections.stderr.kind === "drop" ||
    (redirections.stderr.kind === "diagnostic" && frame.io.stderr.discards);
  const maxCombinedOutputBytes =
    redirections.stdout === redirections.stderr
      ? Math.max(maxStdoutBytes, maxStderrBytes)
      : safeSum(maxStdoutBytes, maxStderrBytes);
  return {
    maxStdoutBytes,
    maxStderrBytes,
    maxCombinedOutputBytes,
    discardStderr,
  };
}

// Only a terminal sink truncates. Pipe and redirect bytes are semantic input,
// so the retained budget fails the run instead of shortening them.
export function destinationLimit(
  destination: OutputDestination,
  lastStage: boolean,
  frame: Frame,
): number {
  if (destination.kind === "drop") return 0;
  if (destination.kind === "diagnostic") return frame.io.stderr.limit();
  if (destination.kind === "output" && lastStage) return frame.io.stdoutLimit();
  return Number.MAX_SAFE_INTEGER;
}

function safeSum(left: number, right: number): number {
  return Math.min(Number.MAX_SAFE_INTEGER, left + right);
}
