// Line and column filters: cut, tr, nl, rev, comm, seq.

import type { Command } from "../../exec/context.js";

export const columnCommands: ReadonlyMap<string, Command> = new Map();
