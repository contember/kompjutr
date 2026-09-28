// Tree summaries over paged listings: du, tree.

import type { Command } from "../../exec/context.js";
import { du } from "./du.js";
import { tree } from "./tree.js";

export const treeCommands: ReadonlyMap<string, Command> = new Map([
  ["du", du],
  ["tree", tree],
]);
