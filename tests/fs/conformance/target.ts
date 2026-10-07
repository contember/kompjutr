// The filesystem the ported cases run against. `mounted.test.ts` replaces
// this module to run the same cases through a mounted view.
export { createFilesystemOps } from "../../../packages/do/src/fs/ops.js";

/** Where a case's path is stored, for the cases that query rows directly. */
export function storedPath(path: string): string {
  return path;
}
