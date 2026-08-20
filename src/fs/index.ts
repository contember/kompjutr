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
  DiscoverFilesOptions,
  DiscoverFilesPage,
  EntryType,
  Filesystem,
  FilesystemOptions,
  HandleReadBatch,
  ReadBatch,
  RealPath,
  RegularFileHandle,
  RemoveOptions,
  ScanEntry,
  ScanOptions,
  Stat,
  WriteEntry,
  WriteOptions,
} from "./types.js";
