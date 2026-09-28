// `jq`: a bounded subset of the jq 1.8 language, compared byte for byte
// against the installed jq.

import type { Command } from "../../exec/context.js";
import { jq } from "./cli.js";

export const jqCommands: ReadonlyMap<string, Command> = new Map([["jq", jq]]);
