import type { SqlDatabase } from "../../sqlite/db.js";

export type {
  CompatWriteFilesEntry,
  CompatWriteFilesOptions,
  NodeDirent,
  NodeStats,
  ReadFilesEntry,
  WalkEntry,
  WalkOptions,
} from "./node.js";
export { NodeFsCompat } from "./node.js";

// Kept so the agent runtime's adapter compiles unchanged. A path lookup is
// already one indexed read, so there is no scope to open or invalidate.
export const withReadScope = <T>(_db: SqlDatabase, work: () => Promise<T>): Promise<T> => work();

/** Quote one argument for `/bin/sh -c`. */
export function shellQuote(argument: string): string {
  if (argument.length > 0 && /^[A-Za-z0-9_\-+=:,./@%]+$/.test(argument)) return argument;
  return `'${argument.replace(/'/g, "'\\''")}'`;
}
