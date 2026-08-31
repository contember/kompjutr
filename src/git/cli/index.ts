import type { GitContext } from "../ops/context.js";
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
): GitCliResult {
  const resolved = Object.freeze(resolveGitCliRunOptions(options));
  const parsed = parseGitCliInput(input, resolved.logLimitHint, { options: resolved });
  if (!parsed.ok) return boundedGitCliResult(parsed.result, resolved);
  return boundedGitCliResult(dispatch(parsed.invocation, handlers, resolved), resolved);
}

export function createGitCliRunner(handlers: GitCliHandlers): GitCliRunner {
  return {
    runCli(input, options) {
      return runGitCli(input, handlers, options);
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
): GitCliResult {
  const command = invocation.command;
  if (command.kind === "status") {
    return requireHandler(handlers.status, command.kind)(
      specificInvocation(invocation, command),
      options,
    );
  }
  if (command.kind === "diff") {
    return requireHandler(handlers.diff, command.kind)(
      specificInvocation(invocation, command),
      options,
    );
  }
  if (command.kind === "log") {
    return requireHandler(handlers.log, command.kind)(
      specificInvocation(invocation, command),
      options,
    );
  }
  if (command.kind === "rev-list") {
    return requireHandler(handlers.revList, command.kind)(
      specificInvocation(invocation, command),
      options,
    );
  }
  if (command.kind === "symbolic-ref") {
    return requireHandler(handlers.symbolicRef, command.kind)(
      specificInvocation(invocation, command),
      options,
    );
  }
  if (command.kind === "add") {
    return requireHandler(handlers.add, command.kind)(
      specificInvocation(invocation, command),
      options,
    );
  }
  if (command.kind === "commit") {
    return requireHandler(handlers.commit, command.kind)(
      specificInvocation(invocation, command),
      options,
    );
  }
  return requireHandler(handlers.rebase, command.kind)(
    specificInvocation(invocation, command),
    options,
  );
}

function requireHandler<Command extends ParsedGitCliCommand>(
  handler:
    | ((invocation: GitCliInvocation<Command>, options: ResolvedGitCliRunOptions) => GitCliResult)
    | undefined,
  command: string,
): (invocation: GitCliInvocation<Command>, options: ResolvedGitCliRunOptions) => GitCliResult {
  if (handler === undefined) throw new Error(`missing git CLI handler for ${command}`);
  return handler;
}

function specificInvocation<Command extends ParsedGitCliCommand>(
  invocation: GitCliInvocation,
  command: Command,
): GitCliInvocation<Command> {
  return { command, cwd: invocation.cwd, env: invocation.env };
}
