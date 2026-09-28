// Line and column filters: cut, tr, nl, rev, comm, seq.

import type { Command } from "../../exec/context.js";
import { comm } from "./comm.js";
import { cut } from "./cut.js";
import { nl } from "./nl.js";
import { rev } from "./rev.js";
import { seq } from "./seq.js";
import { tr } from "./tr.js";

export const columnCommands: ReadonlyMap<string, Command> = new Map([
  ["comm", comm],
  ["cut", cut],
  ["nl", nl],
  ["rev", rev],
  ["seq", seq],
  ["tr", tr],
]);
