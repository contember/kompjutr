// `jq`: a bounded subset of the jq language over one retained JSON input.

import type { Command } from "../../exec/context.js";

export const jqCommands: ReadonlyMap<string, Command> = new Map();
