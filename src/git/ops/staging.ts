// Stable facade for staging, reset, removal, and ls-files operations.

export {
  type AddLiteralPathsResult,
  type AddOptions,
  add,
  addLiteralPaths,
} from "./staging-add.js";
export {
  type LsFilesWorktreeOptions,
  lsFiles,
  lsFilesWithWorktree,
  MAX_LS_FILES_EXCLUDE_ROOTS,
} from "./staging-ls-files.js";
export { type ResetOptions, reset } from "./staging-reset.js";
export { type RmOptions, rm } from "./staging-rm.js";
