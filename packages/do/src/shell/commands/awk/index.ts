// `awk`: a POSIX awk subset without unbounded loops.

import type { Command } from "../../exec/context.js";

export const awkCommands: ReadonlyMap<string, Command> = new Map();
