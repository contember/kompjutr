// `patch`: apply a unified diff and publish each file atomically.

import type { Command } from "../../exec/context.js";

export const patchCommands: ReadonlyMap<string, Command> = new Map();
