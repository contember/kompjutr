// The whole git repository lives in these tables. There is no `.git`
// directory anywhere: HEAD, refs, config, the index, the object database
// and every received packfile are rows.
//
// Every table except the registry carries `repo_id`, so one workspace can
// hold several repositories side by side.

import type { SqlDatabase } from "./db.js";

export const SCHEMA_VERSION = 1;

const STATEMENTS = [
  `CREATE TABLE IF NOT EXISTS git_meta (
     key TEXT PRIMARY KEY,
     value TEXT NOT NULL
   )`,

  // Registry. `root` is the absolute working-tree root inside the
  // workspace; a repository is resolved for a cwd by finding the nearest
  // registered ancestor. `head` holds HEAD's raw value: either
  // "ref: refs/heads/<name>" or a 40-hex oid when detached.
  `CREATE TABLE IF NOT EXISTS git_repositories (
     id INTEGER PRIMARY KEY,
     root TEXT NOT NULL UNIQUE,
     head TEXT NOT NULL
   )`,

  `CREATE TABLE IF NOT EXISTS git_refs (
     repo_id INTEGER NOT NULL,
     name TEXT NOT NULL,
     target TEXT NOT NULL,
     PRIMARY KEY (repo_id, name)
   )`,

  // Dotted config path ("user.email", "remote.origin.url"). `seq` keeps
  // multi-valued keys ordered the way a config file would.
  `CREATE TABLE IF NOT EXISTS git_config (
     repo_id INTEGER NOT NULL,
     path TEXT NOT NULL,
     seq INTEGER NOT NULL,
     value TEXT NOT NULL,
     PRIMARY KEY (repo_id, path, seq)
   )`,

  // Git's logical index, not the .git/index binary format. The trailing
  // columns cache what the working tree looked like when the entry was
  // written, so an unchanged file does not have to be re-hashed.
  `CREATE TABLE IF NOT EXISTS git_index (
     repo_id INTEGER NOT NULL,
     path TEXT NOT NULL,
     stage INTEGER NOT NULL,
     mode INTEGER NOT NULL,
     oid TEXT NOT NULL,
     size INTEGER,
     mtime INTEGER,
     ino INTEGER,
     PRIMARY KEY (repo_id, path, stage)
   )`,

  // Shallow boundary commits, the equivalent of .git/shallow. A history
  // walk stops dead at one of these.
  `CREATE TABLE IF NOT EXISTS git_shallow (
     repo_id INTEGER NOT NULL,
     oid TEXT NOT NULL,
     PRIMARY KEY (repo_id, oid)
   )`,

  // Loose objects: everything created locally, zlib-deflated and chunked.
  // A future repack folds them into a pack; nothing here depends on that.
  `CREATE TABLE IF NOT EXISTS git_objects (
     repo_id INTEGER NOT NULL,
     oid TEXT NOT NULL,
     type TEXT NOT NULL,
     size INTEGER NOT NULL,
     PRIMARY KEY (repo_id, oid)
   )`,

  `CREATE TABLE IF NOT EXISTS git_object_chunks (
     repo_id INTEGER NOT NULL,
     oid TEXT NOT NULL,
     seq INTEGER NOT NULL,
     data BLOB NOT NULL,
     PRIMARY KEY (repo_id, oid, seq)
   )`,

  // Received packs are kept verbatim, still compressed. `state` is
  // 'pending' until the trailer has been verified and every entry
  // indexed; an interrupted fetch leaves a pending pack that the next
  // ingest reclaims.
  `CREATE TABLE IF NOT EXISTS git_pack_meta (
     repo_id INTEGER NOT NULL,
     pack_id INTEGER NOT NULL,
     size INTEGER NOT NULL,
     count INTEGER NOT NULL,
     state TEXT NOT NULL,
     created INTEGER NOT NULL,
     PRIMARY KEY (repo_id, pack_id)
   )`,

  `CREATE TABLE IF NOT EXISTS git_pack_data (
     repo_id INTEGER NOT NULL,
     pack_id INTEGER NOT NULL,
     seq INTEGER NOT NULL,
     data BLOB NOT NULL,
     PRIMARY KEY (repo_id, pack_id, seq)
   )`,

  `CREATE TABLE IF NOT EXISTS git_pack_objects (
     repo_id INTEGER NOT NULL,
     oid TEXT NOT NULL,
     pack_id INTEGER NOT NULL,
     offset INTEGER NOT NULL,
     data_off INTEGER NOT NULL,
     data_len INTEGER NOT NULL,
     type TEXT NOT NULL,
     size INTEGER NOT NULL,
     entry_size INTEGER NOT NULL,
     base_oid TEXT,
     PRIMARY KEY (repo_id, oid)
   )`,

  `CREATE INDEX IF NOT EXISTS git_pack_objects_loc
     ON git_pack_objects (repo_id, pack_id, offset)`,

  // Delta entries whose base had not been seen yet when the pack was
  // scanned. Drained before the pack is marked complete.
  `CREATE TABLE IF NOT EXISTS git_pack_pending (
     repo_id INTEGER NOT NULL,
     pack_id INTEGER NOT NULL,
     offset INTEGER NOT NULL,
     data_off INTEGER NOT NULL,
     data_len INTEGER NOT NULL,
     entry_size INTEGER NOT NULL,
     base_oid TEXT,
     base_offset INTEGER,
     PRIMARY KEY (repo_id, pack_id, offset)
   )`,
] as const;

export function initializeGitSchema(db: SqlDatabase): void {
  db.transactionSync(() => {
    for (const statement of STATEMENTS) db.run(statement);
    db.run(
      "INSERT OR REPLACE INTO git_meta (key, value) VALUES ('schema_version', ?)",
      String(SCHEMA_VERSION),
    );
  });
}
