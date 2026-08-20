export type {
  CompatWriteFilesEntry,
  CompatWriteFilesOptions,
  NodeDirent,
  NodeStats,
  ReadFilesEntry,
  WalkEntry,
  WalkOptions,
} from "./compat/node.js";
export { NodeFsCompat } from "./compat/node.js";
export { createFilesystem } from "./filesystem.js";
export { subtreeSuccessor } from "./path.js";
export { FS_SCHEMA_VERSION, initializeFsSchema } from "./schema.js";
export type {
  Dirent,
  EntryType,
  Filesystem,
  FilesystemOptions,
  ReadBatch,
  RealPath,
  RemoveOptions,
  ScanEntry,
  ScanOptions,
  Stat,
  WriteEntry,
  WriteOptions,
} from "./types.js";
