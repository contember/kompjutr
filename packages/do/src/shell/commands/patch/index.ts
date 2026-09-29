// `patch`: apply a unified diff and publish each file atomically.

import type { Command } from "../../exec/context.js";
import { patch } from "./patch.js";

export const patchCommands: ReadonlyMap<string, Command> = new Map([["patch", patch]]);
