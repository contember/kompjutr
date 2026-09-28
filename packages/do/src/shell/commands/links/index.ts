// Link and metadata commands: ln, chmod, rmdir, readlink, realpath.

import type { Command } from "../../exec/context.js";
import { chmod } from "./chmod.js";
import { ln } from "./ln.js";
import { readlink } from "./readlink.js";
import { realpath } from "./realpath.js";
import { rmdir } from "./rmdir.js";

export const linkCommands: ReadonlyMap<string, Command> = new Map([
  ["ln", ln],
  ["chmod", chmod],
  ["rmdir", rmdir],
  ["readlink", readlink],
  ["realpath", realpath],
]);
