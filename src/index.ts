// kompjutr — a SQLite-native filesystem and git backend for Cloudflare Workers.
//
// The filesystem and git database share one Durable Object SQLite database.

export {
  Database,
  type DurableObjectStorageLike,
  type SQLCursorLike,
  type SQLStorageLike,
  type SqlDatabase,
} from "./db/db.js";
export { NodeFsCompat } from "./fs/compat/node.js";
export { createFilesystem } from "./fs/filesystem.js";
export { FS_SCHEMA_VERSION, initializeFsSchema } from "./fs/schema.js";
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
} from "./fs/types.js";
export * from "./git/index.js";
export {
  type Async,
  type AsyncFilesystem,
  type ExitStatus,
  type ProcessEvent,
  type ProcessExecOptions,
  type ProcessHandle,
  type ProcessHost,
  type ProcessResult,
  type RpcHost,
  Workspace,
  type WorkspaceOptions,
} from "./runtime/index.js";
