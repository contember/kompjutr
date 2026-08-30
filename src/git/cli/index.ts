import type { GitContext } from "../../core/context.js";
import { MemoryCoordinator, type MemoryReservation } from "../../memory.js";
import { parseGitCliInput } from "./parse.js";
import { createGitCliReadHandlers } from "./read.js";
import { boundedGitCliResult, resolveGitCliRunOptions } from "./result.js";
import type {
  GitCliHandlers,
  GitCliInput,
  GitCliInvocation,
  GitCliResult,
  GitCliRunner,
  GitCliRunOptions,
  ParsedGitCliCommand,
  ResolvedGitCliRunOptions,
} from "./types.js";
import { createGitCliWriteHandlers } from "./write.js";

export * from "./parse.js";
export * from "./result.js";
export * from "./types.js";

export function runGitCli(
  input: GitCliInput,
  handlers: GitCliHandlers,
  options?: GitCliRunOptions,
  memory = new MemoryCoordinator(),
): GitCliResult {
  const reservation = memory.reserve();
  const optionsMemory = reservation.scope();
  const parserMemory = reservation.scope();
  try {
    const resolved = Object.freeze(resolveGitCliRunOptions(options));
    optionsMemory.set("other", 64);
    const parsed = parseGitCliInput(input, resolved.logLimitHint, parserMemory, {
      options: resolved,
      reservation,
    });
    if (!parsed.ok) return boundedGitCliResult(parsed.result, resolved, reservation);
    return boundedGitCliResult(
      dispatch(parsed.invocation, handlers, resolved, reservation),
      resolved,
      reservation,
    );
  } finally {
    reservation.dispose();
  }
}

export function createGitCliRunner(
  handlers: GitCliHandlers,
  memory = new MemoryCoordinator(),
): GitCliRunner {
  return {
    runCli(input, options) {
      return runGitCli(input, handlers, options, memory);
    },
  };
}

/** Bind the complete argv dispatcher to one Git context. */
export function createContextGitCliRunner(context: GitContext): GitCliRunner {
  return createGitCliRunner({
    ...createGitCliReadHandlers(context),
    ...createGitCliWriteHandlers(context),
  });
}

function dispatch(
  invocation: GitCliInvocation,
  handlers: GitCliHandlers,
  options: ResolvedGitCliRunOptions,
  reservation: MemoryReservation,
): GitCliResult {
  const command = invocation.command;
  if (command.kind === "status") {
    return requireHandler(handlers.status, command.kind)(
      specificInvocation(invocation, command),
      options,
      reservation,
    );
  }
  if (command.kind === "diff") {
    return requireHandler(handlers.diff, command.kind)(
      specificInvocation(invocation, command),
      options,
      reservation,
    );
  }
  if (command.kind === "log") {
    return requireHandler(handlers.log, command.kind)(
      specificInvocation(invocation, command),
      options,
      reservation,
    );
  }
  if (command.kind === "rev-list") {
    return requireHandler(handlers.revList, command.kind)(
      specificInvocation(invocation, command),
      options,
      reservation,
    );
  }
  if (command.kind === "symbolic-ref") {
    return requireHandler(handlers.symbolicRef, command.kind)(
      specificInvocation(invocation, command),
      options,
      reservation,
    );
  }
  if (command.kind === "add") {
    return requireHandler(handlers.add, command.kind)(
      specificInvocation(invocation, command),
      options,
      reservation,
    );
  }
  if (command.kind === "commit") {
    return requireHandler(handlers.commit, command.kind)(
      specificInvocation(invocation, command),
      options,
      reservation,
    );
  }
  return requireHandler(handlers.rebase, command.kind)(
    specificInvocation(invocation, command),
    options,
    reservation,
  );
}

function requireHandler<Command extends ParsedGitCliCommand>(
  handler:
    | ((
        invocation: GitCliInvocation<Command>,
        options: ResolvedGitCliRunOptions,
        reservation: MemoryReservation,
      ) => GitCliResult)
    | undefined,
  command: string,
): (
  invocation: GitCliInvocation<Command>,
  options: ResolvedGitCliRunOptions,
  reservation: MemoryReservation,
) => GitCliResult {
  if (handler === undefined) throw new Error(`missing git CLI handler for ${command}`);
  return handler;
}

function specificInvocation<Command extends ParsedGitCliCommand>(
  invocation: GitCliInvocation,
  command: Command,
): GitCliInvocation<Command> {
  return { command, cwd: invocation.cwd, env: invocation.env };
}
