import type { PlannedCommand } from "../plan/types.js";
import { type ByteStream, line } from "./bytes.js";
import type { CommandContext, CommandResult } from "./context.js";
import type { PipelineEnvironment } from "./execution-types.js";
import type { HeldChunk, OutputDestination, ResolvedRedirections } from "./routing-types.js";
import { diagnosticsFor } from "./stage-output.js";

export function commandContext(
  planned: PlannedCommand,
  redirections: ResolvedRedirections,
  lastStage: boolean,
  mayExitRun: boolean,
  argv: readonly string[],
  stdin: ByteStream | null,
  limitHint: number | null,
  env: PipelineEnvironment,
  routedDiagnostics: Map<OutputDestination, HeldChunk[]>,
): CommandContext {
  const output = commandOutput(redirections, lastStage, env);
  const diagnostic = (bytes: Uint8Array): void => {
    if (bytes.length === 0 || redirections.stderr.kind === "drop") return;
    if (redirections.stderr.kind === "diagnostic") {
      env.errors.writeBytes(bytes);
    } else {
      diagnosticsFor(routedDiagnostics, redirections.stderr).push({
        bytes,
        release: env.fs.retained.retain(bytes.length, "routed diagnostic"),
      });
    }
  };
  const context: CommandContext = {
    fs: env.fs,
    cwd: env.cwd,
    argv,
    stdin,
    env: env.inputs?.env,
    currentStatus: env.currentStatus,
    mayExitRun,
    limitHint,
    output,
    diagnostic,
    warn: (message: string) => {
      if (redirections.stderr.kind === "drop") return;
      const bytes = line(`${planned.name}: ${message}`);
      diagnostic(bytes);
    },
    chdir: env.chdir,
    invoke: async (name: string, subArgv: readonly string[]): Promise<CommandResult | null> => {
      const command = env.commands.get(name);
      if (command === undefined) return null;
      // No stdin and no demand hint: the sub-invocation's arguments already
      // carry everything it is meant to see.
      return command({
        ...context,
        argv: subArgv,
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
  env: PipelineEnvironment,
): CommandContext["output"] {
  const destination =
    redirections.stdout.kind === "output"
      ? lastStage
        ? "terminal"
        : "pipeline"
      : redirections.stdout.kind === "diagnostic"
        ? "terminal"
        : "redirect";
  const maxStdoutBytes = destinationLimit(redirections.stdout, lastStage, env);
  const maxStderrBytes = destinationLimit(redirections.stderr, lastStage, env);
  const discardStderr = redirections.stderr.kind === "drop";
  const maxCombinedOutputBytes =
    redirections.stdout === redirections.stderr
      ? Math.max(maxStdoutBytes, maxStderrBytes)
      : safeSum(maxStdoutBytes, maxStderrBytes);
  return {
    destination,
    maxStdoutBytes,
    maxStderrBytes,
    maxCombinedOutputBytes,
    discardStderr,
  };
}

function destinationLimit(
  destination: OutputDestination,
  lastStage: boolean,
  env: PipelineEnvironment,
): number {
  if (destination.kind === "drop") return 0;
  const available =
    destination.kind === "diagnostic"
      ? env.errors.remaining
      : destination.kind === "output" && lastStage
        ? env.out.remaining
        : Number.MAX_SAFE_INTEGER;
  return Math.min(available, env.fs.retained.available);
}

function safeSum(left: number, right: number): number {
  return Math.min(Number.MAX_SAFE_INTEGER, left + right);
}
