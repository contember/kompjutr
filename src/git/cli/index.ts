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

export async function runGitCli(
  input: GitCliInput,
  handlers: GitCliHandlers,
  options?: GitCliRunOptions,
): Promise<GitCliResult> {
  const resolved = Object.freeze(resolveGitCliRunOptions(options));
  const parsed = parseGitCliInput(input, resolved.logLimitHint, { options: resolved });
  if (!parsed.ok) return boundedGitCliResult(parsed.result, resolved);
  return boundedGitCliResult(await dispatch(parsed.invocation, handlers, resolved), resolved);
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
  const reads = createGitCliReadHandlers(context);
  const writes = createGitCliWriteHandlers(context);
  return createGitCliRunner({
    ...reads,
    ...writes,
    branch(invocation, options) {
      const handler =
        invocation.command.action === "show-current" || invocation.command.action === "list"
          ? reads.branch
          : writes.branch;
      return requireHandler(handler, "branch")(invocation, options);
    },
  });
}

async function dispatch(
  invocation: GitCliInvocation,
  handlers: GitCliHandlers,
  options: ResolvedGitCliRunOptions,
): Promise<GitCliResult> {
  const command = invocation.command;
  if (command.kind === "status") {
    return await requireHandler(handlers.status, command.kind)(
      specificInvocation(invocation, command),
      options,
    );
  }
  if (command.kind === "rev-parse") {
    return await requireHandler(handlers.revParse, command.kind)(
      specificInvocation(invocation, command),
      options,
    );
  }
  if (command.kind === "branch") {
    return await requireHandler(handlers.branch, command.kind)(
      specificInvocation(invocation, command),
      options,
    );
  }
  if (command.kind === "ls-files") {
    return await requireHandler(handlers.lsFiles, command.kind)(
      specificInvocation(invocation, command),
      options,
    );
  }
  if (command.kind === "diff") {
    return await requireHandler(handlers.diff, command.kind)(
      specificInvocation(invocation, command),
      options,
    );
  }
  if (command.kind === "log") {
    return await requireHandler(handlers.log, command.kind)(
      specificInvocation(invocation, command),
      options,
    );
  }
  if (command.kind === "rev-list") {
    return await requireHandler(handlers.revList, command.kind)(
      specificInvocation(invocation, command),
      options,
    );
  }
  if (command.kind === "symbolic-ref") {
    return await requireHandler(handlers.symbolicRef, command.kind)(
      specificInvocation(invocation, command),
      options,
    );
  }
  if (command.kind === "add") {
    return await requireHandler(handlers.add, command.kind)(
      specificInvocation(invocation, command),
      options,
    );
  }
  if (command.kind === "commit") {
    return await requireHandler(handlers.commit, command.kind)(
      specificInvocation(invocation, command),
      options,
    );
  }
  if (command.kind === "reset") {
    return await requireHandler(handlers.reset, command.kind)(
      specificInvocation(invocation, command),
      options,
    );
  }
  if (command.kind === "checkout") {
    return await requireHandler(handlers.checkout, command.kind)(
      specificInvocation(invocation, command),
      options,
    );
  }
  if (command.kind === "switch") {
    return await requireHandler(handlers.switch, command.kind)(
      specificInvocation(invocation, command),
      options,
    );
  }
  if (command.kind === "restore") {
    return await requireHandler(handlers.restore, command.kind)(
      specificInvocation(invocation, command),
      options,
    );
  }
  if (command.kind === "rebase") {
    return await requireHandler(handlers.rebase, command.kind)(
      specificInvocation(invocation, command),
      options,
    );
  }
  return await requireHandler(handlers.merge, command.kind)(
    specificInvocation(invocation, command),
    options,
  );
}

function requireHandler<Command extends ParsedGitCliCommand>(
  handler:
    | ((
        invocation: GitCliInvocation<Command>,
        options: ResolvedGitCliRunOptions,
      ) => GitCliResult | Promise<GitCliResult>)
    | undefined,
  command: string,
): (
  invocation: GitCliInvocation<Command>,
  options: ResolvedGitCliRunOptions,
) => GitCliResult | Promise<GitCliResult> {
  if (handler === undefined) throw new Error(`missing git CLI handler for ${command}`);
  return handler;
}

function specificInvocation<Command extends ParsedGitCliCommand>(
  invocation: GitCliInvocation,
  command: Command,
): GitCliInvocation<Command> {
  return { command, cwd: invocation.cwd, env: invocation.env };
}
