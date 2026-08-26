// The command registry.
//
// `git` is deliberately absent. It is injected by the consumer as a
// registered command, exactly as `@cloudflare/computer` does it, because
// putting it here would make `src/shell/` depend on `src/git/` and break the
// one-way rule in docs/reference/architecture.md.

import { type Command, fail } from "../exec/context.js";
import { fileCommands } from "./files.js";
import { UsageError } from "./flags.js";
import { grep } from "./grep.js";
import { listCommands } from "./list.js";
import { readCommands } from "./read.js";
import { rg } from "./rg.js";
import { registerKnownCommands, textCommands } from "./text.js";
import { xargs } from "./xargs.js";

export function builtinCommands(): Map<string, Command> {
  const raw = new Map<string, Command>([
    ["grep", grep],
    ["rg", rg],
    ["xargs", xargs],
    ...readCommands,
    ...listCommands,
    ...fileCommands,
    ...textCommands,
  ]);
  const commands = new Map<string, Command>();
  for (const [name, command] of raw) commands.set(name, normalizeFailures(command));
  registerKnownCommands(commands.keys());
  return commands;
}

function normalizeFailures(command: Command): Command {
  return (context) => {
    let produced: ReturnType<Command>;
    try {
      produced = command(context);
    } catch (error) {
      const expected = expectedFailure(error);
      if (expected === null) throw error;
      return fail(context, expected.message, expected.status);
    }

    let failed: number | null = null;
    const stdout = (function* () {
      try {
        yield* produced.stdout;
      } catch (error) {
        const expected = expectedFailure(error);
        if (expected === null) throw error;
        context.warn(expected.message);
        failed = expected.status;
      }
    })();
    return { stdout, status: () => failed ?? produced.status() };
  };
}

function expectedFailure(error: unknown): { message: string; status: number } | null {
  if (error instanceof UsageError) return { message: error.message, status: 2 };
  if (
    error instanceof Error &&
    "code" in error &&
    typeof error.code === "string" &&
    error.code.startsWith("E")
  ) {
    return { message: error.message, status: 1 };
  }
  return null;
}

export { grep, rg, xargs };
