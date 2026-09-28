// Process-environment commands: env, date, sleep, mktemp, sha256sum, base64.

import type { Command } from "../../exec/context.js";

export const systemCommands: ReadonlyMap<string, Command> = new Map();
