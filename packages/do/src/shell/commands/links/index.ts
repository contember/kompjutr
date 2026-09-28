// Link and metadata commands: ln, chmod, rmdir, readlink, realpath.

import type { Command } from "../../exec/context.js";

export const linkCommands: ReadonlyMap<string, Command> = new Map();
