// The command registry.
//
// `git` is deliberately absent. It is injected by the consumer as a
// registered command, exactly as `@cloudflare/computer` does it, because
// putting it here would make `src/shell/` depend on `src/git/` and break the
// one-way rule in docs/reference/architecture.md.

import type { Command } from "../exec/context.js";
import { fileCommands } from "./files.js";
import { grep } from "./grep.js";
import { listCommands } from "./list.js";
import { readCommands } from "./read.js";
import { rg } from "./rg.js";
import { registerKnownCommands, textCommands } from "./text.js";
import { xargs } from "./xargs.js";

export function builtinCommands(): Map<string, Command> {
  const commands = new Map<string, Command>([
    ["grep", grep],
    ["rg", rg],
    ["xargs", xargs],
    ...readCommands,
    ...listCommands,
    ...fileCommands,
    ...textCommands,
  ]);
  registerKnownCommands(commands.keys());
  return commands;
}

export { grep, rg, xargs };
