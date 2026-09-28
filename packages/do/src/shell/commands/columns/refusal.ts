// Diagnostics these tools print whole, and the forms the shell declines.
//
// A refusal is status 2 with a message naming what is unsupported: `--help`
// and `--version` print text owned by the installed binary, which the shell
// does not reproduce.

import { empty, encode } from "../../exec/bytes.js";
import type { CommandContext, CommandResult } from "../../exec/context.js";
import { type ClapParsed, has } from "./clap.js";

/** Exact diagnostic bytes and a status, before any output. */
export function failWith(context: CommandContext, text: string, status = 1): CommandResult {
  context.diagnostic(encode(text));
  return { stdout: empty(), status: () => status, truncated: () => false };
}

export function refuse(context: CommandContext, what: string): CommandResult {
  context.warn(`${what} is not supported`);
  return { stdout: empty(), status: () => 2, truncated: () => false };
}

export function refuseBuiltins(context: CommandContext, parsed: ClapParsed): CommandResult | null {
  if (has(parsed, "help")) return refuse(context, "--help");
  if (has(parsed, "version")) return refuse(context, "--version");
  return null;
}
