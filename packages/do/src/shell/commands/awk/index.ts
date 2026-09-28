// `awk`: a POSIX awk subset without unbounded loops, matching mawk 1.3.4.
// `mawk` is the same command; each names itself in its diagnostics and ARGV[0].

import type { Command } from "../../exec/context.js";
import { awkCommand } from "./command.js";

export const awkCommands: ReadonlyMap<string, Command> = new Map([
  ["awk", awkCommand("awk")],
  ["mawk", awkCommand("mawk")],
]);
