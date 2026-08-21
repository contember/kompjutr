// The whole git repository lives in these tables. There is no `.git`
// directory anywhere: HEAD, refs, config, the index, the object database
// and every received packfile are rows.
//
// Every table except the registry carries `repo_id`, so one workspace can
// hold several repositories side by side.

import { CorruptError } from "../core/errors.js";
import { parseTreeStream } from "../core/objects.js";
import { blob, type SqlDatabase } from "./db.js";

export const SCHEMA_VERSION = 5;
/** SQLite queue record, four integer fields, and bounded error fields. */
export const TREE_QUEUE_ROW_FIXED_BYTES = 64 + 4 * 8 + 96;

const COMMIT_TABLE = `CREATE TABLE IF NOT EXISTS git_commits (
  repo_id INTEGER NOT NULL,
  oid TEXT NOT NULL,
  parents TEXT NOT NULL,
  tree TEXT NOT NULL,
  author_name BLOB NOT NULL,
  author_email BLOB NOT NULL,
  author_time INTEGER NOT NULL,
  author_timezone INTEGER NOT NULL,
  committer_name BLOB NOT NULL,
  committer_email BLOB NOT NULL,
  committer_time INTEGER NOT NULL,
  committer_timezone INTEGER NOT NULL,
  message BLOB NOT NULL,
  gpgsig BLOB,
  object_size INTEGER NOT NULL,
  cache_bytes INTEGER NOT NULL,
  PRIMARY KEY (repo_id, oid)
) WITHOUT ROWID`;

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
     rev INTEGER,
     PRIMARY KEY (repo_id, path, stage)
   )`,

  // The working tree's opaque content ids mapped to blob oids. A file whose
  // `fs_nodes.content_id` is in here is unchanged: `status` and `add` answer
  // it from the scan statement, without reading the file or hashing it.
  //
  // The id is whatever the filesystem chose to record. Nothing here computes
  // one, and a missing row means "read the file", never "the file differs".
  `CREATE TABLE IF NOT EXISTS git_blob_ids (
     repo_id INTEGER NOT NULL,
     content_id BLOB NOT NULL,
     oid TEXT NOT NULL,
     PRIMARY KEY (repo_id, content_id)
   ) WITHOUT ROWID`,

  // Shallow boundary commits, the equivalent of .git/shallow. A history
  // walk stops dead at one of these.
  `CREATE TABLE IF NOT EXISTS git_shallow (
     repo_id INTEGER NOT NULL,
     oid TEXT NOT NULL,
     PRIMARY KEY (repo_id, oid)
   )`,

  // Loose objects: everything created locally, zlib-deflated and chunked.
  // A future repack folds them into a pack; nothing here depends on that.
  // `stored` names the encoding of the chunk bytes: 'zlib' or 'raw'.
  // Deflating an already-incompressible or tiny object costs more than it
  // saves, and the threshold is a client option.
  `CREATE TABLE IF NOT EXISTS git_objects (
     repo_id INTEGER NOT NULL,
     oid TEXT NOT NULL,
     type TEXT NOT NULL,
     size INTEGER NOT NULL,
     stored TEXT NOT NULL DEFAULT 'zlib',
     PRIMARY KEY (repo_id, oid)
   )`,

  // Full parsed commits for graph walks and reads. This remains a derived
  // cache: source metadata is validated before a row can be returned.
  COMMIT_TABLE,

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

  `CREATE TABLE IF NOT EXISTS git_tree_sources (
     repo_id INTEGER NOT NULL,
     tree_oid TEXT NOT NULL,
     storage TEXT NOT NULL CHECK (storage IN ('loose', 'pack')),
     source_id INTEGER NOT NULL,
     object_size INTEGER NOT NULL,
     entry_count INTEGER NOT NULL,
     base_cost INTEGER NOT NULL,
     PRIMARY KEY (repo_id, tree_oid, storage, source_id)
   ) WITHOUT ROWID`,

  `CREATE TABLE IF NOT EXISTS git_tree_entries (
     repo_id INTEGER NOT NULL,
     tree_oid TEXT NOT NULL,
     storage TEXT NOT NULL,
     source_id INTEGER NOT NULL,
     ordinal INTEGER NOT NULL,
     mode TEXT NOT NULL,
     name TEXT COLLATE BINARY NOT NULL,
     name_bytes BLOB NOT NULL,
     oid TEXT NOT NULL,
     raw_entry BLOB NOT NULL,
     cumulative_base INTEGER NOT NULL,
     PRIMARY KEY (repo_id, tree_oid, storage, source_id, ordinal),
     FOREIGN KEY (repo_id, tree_oid, storage, source_id)
       REFERENCES git_tree_sources (repo_id, tree_oid, storage, source_id)
       ON DELETE CASCADE DEFERRABLE INITIALLY DEFERRED
   ) WITHOUT ROWID`,

  // The source selected for traversal. A loose object always shadows its
  // packed copy, including while its parsed marker is missing or corrupt.
  `CREATE TABLE IF NOT EXISTS git_tree_effective (
     repo_id INTEGER NOT NULL,
     tree_oid TEXT NOT NULL,
     storage TEXT NOT NULL CHECK (storage IN ('loose', 'pack')),
     source_id INTEGER NOT NULL,
     PRIMARY KEY (repo_id, tree_oid)
   ) WITHOUT ROWID`,

  `CREATE TRIGGER IF NOT EXISTS git_tree_effective_loose_insert
   AFTER INSERT ON git_objects WHEN NEW.type = 'tree'
   BEGIN
     INSERT OR REPLACE INTO git_tree_effective
       (repo_id, tree_oid, storage, source_id)
     VALUES (NEW.repo_id, NEW.oid, 'loose', 0);
   END`,

  `CREATE TRIGGER IF NOT EXISTS git_tree_effective_loose_delete
   AFTER DELETE ON git_objects WHEN OLD.type = 'tree'
   BEGIN
     DELETE FROM git_tree_entries
      WHERE repo_id = OLD.repo_id AND tree_oid = OLD.oid
        AND storage = 'loose' AND source_id = 0;
     DELETE FROM git_tree_sources
      WHERE repo_id = OLD.repo_id AND tree_oid = OLD.oid
        AND storage = 'loose' AND source_id = 0;
     DELETE FROM git_tree_effective
      WHERE repo_id = OLD.repo_id AND tree_oid = OLD.oid AND storage = 'loose';
     INSERT OR REPLACE INTO git_tree_effective
       (repo_id, tree_oid, storage, source_id)
     SELECT o.repo_id, o.oid, 'pack', o.pack_id
       FROM git_pack_objects o
       JOIN git_pack_meta m
         ON m.repo_id = o.repo_id AND m.pack_id = o.pack_id AND m.state = 'complete'
      WHERE o.repo_id = OLD.repo_id AND o.oid = OLD.oid AND o.type = 'tree';
   END`,

  `CREATE TRIGGER IF NOT EXISTS git_tree_effective_pack_complete
   AFTER UPDATE OF state ON git_pack_meta
   WHEN NEW.state = 'complete' AND OLD.state != 'complete'
   BEGIN
     INSERT OR REPLACE INTO git_tree_effective
       (repo_id, tree_oid, storage, source_id)
     SELECT o.repo_id, o.oid, 'pack', o.pack_id
       FROM git_pack_objects o
      WHERE o.repo_id = NEW.repo_id AND o.pack_id = NEW.pack_id AND o.type = 'tree'
        AND NOT EXISTS (
          SELECT 1 FROM git_objects lo
           WHERE lo.repo_id = o.repo_id AND lo.oid = o.oid AND lo.type = 'tree'
        );
   END`,

  `CREATE TRIGGER IF NOT EXISTS git_tree_effective_pack_delete
   AFTER DELETE ON git_pack_meta WHEN OLD.state = 'complete'
   BEGIN
     DELETE FROM git_tree_effective
      WHERE repo_id = OLD.repo_id AND storage = 'pack' AND source_id = OLD.pack_id;
   END`,

  `CREATE TRIGGER IF NOT EXISTS git_tree_effective_pack_hide
   AFTER UPDATE OF state ON git_pack_meta
   WHEN OLD.state = 'complete' AND NEW.state != 'complete'
   BEGIN
     DELETE FROM git_tree_effective
      WHERE repo_id = OLD.repo_id AND storage = 'pack' AND source_id = OLD.pack_id;
   END`,
] as const;

// v1 -> v2 added `git_blob_ids`, `git_commits` and `git_objects.stored`.
// v3 added parsed tree tables. v4 replaces the incomplete, unused commit
// projection. v5 records the monotonic filesystem revision in index stat data.
function migrate(db: SqlDatabase, from: number): void {
  if (from < 2) {
    db.run("ALTER TABLE git_objects ADD COLUMN stored TEXT NOT NULL DEFAULT 'zlib'");
  }
  if (from < 4) {
    db.run("DROP TABLE git_commits");
    db.run(COMMIT_TABLE);
  }
  if (from < 5) {
    const hasRevision = db
      .all<{ name: string }>("PRAGMA table_info(git_index)")
      .some((column) => column.name === "rev");
    if (!hasRevision) db.run("ALTER TABLE git_index ADD COLUMN rev INTEGER");
  }
}

export function initializeGitSchema(db: SqlDatabase): void {
  db.transactionSync(() => {
    // git_meta first, so the recorded version is readable before the rest
    // of the CREATEs run and before it gets rewritten below.
    const [meta] = STATEMENTS;
    db.run(meta);
    const recorded = db.scalar<unknown>("SELECT value FROM git_meta WHERE key = 'schema_version'");
    if (recorded !== undefined && (typeof recorded !== "string" || !/^[1-9]\d*$/.test(recorded))) {
      throw new CorruptError("git schema has an invalid version");
    }
    const previous = recorded === undefined ? undefined : Number(recorded);
    if (previous !== undefined && !Number.isSafeInteger(previous)) {
      throw new CorruptError("git schema has an invalid version");
    }
    if (previous !== undefined && previous > SCHEMA_VERSION) {
      throw new CorruptError(
        `git schema version ${previous} is newer than supported version ${SCHEMA_VERSION}`,
      );
    }

    for (const statement of STATEMENTS) db.run(statement);

    // 0 means a fresh database: the CREATEs above already carry the current shape.
    if (previous !== undefined && previous < SCHEMA_VERSION) migrate(db, previous);

    db.run(
      "INSERT OR REPLACE INTO git_meta (key, value) VALUES ('schema_version', ?)",
      String(SCHEMA_VERSION),
    );
  });
}

export type TreeStorage = "loose" | "pack";

export interface TreeSource {
  repoId: number;
  treeOid: string;
  storage: TreeStorage;
  sourceId: number;
  objectSize: number;
}

interface PendingTreeEntry {
  repoId: number;
  treeOid: string;
  storage: TreeStorage;
  sourceId: number;
  ordinal: number;
  mode: string;
  nameBytes: Uint8Array;
  oid: string;
  rawEntry: Uint8Array;
  cumulativeBase: number;
}

export interface TreeSourceInput extends TreeSource {
  chunks: Iterable<Uint8Array>;
}

const TREE_INDEX_ROWS = 2048;
const TREE_INDEX_BYTES = 1024 * 1024;

/** Write exact parsed-tree sources. The caller owns the transaction. */
export function indexTreeSources(db: SqlDatabase, sources: Iterable<TreeSourceInput>): void {
  let rows: PendingTreeEntry[] = [];
  let bufferedBytes = 0;
  const markers: {
    p: number;
    t: string;
    s: TreeStorage;
    x: number;
    z: number;
    n: number;
    b: number;
  }[] = [];
  const flush = (): void => {
    if (rows.length === 0) return;
    const nameLength = rows.reduce((sum, row) => sum + row.nameBytes.length, 0);
    const rawLength = rows.reduce((sum, row) => sum + row.rawEntry.length, 0);
    const names = new Uint8Array(nameLength);
    const rawEntries = new Uint8Array(rawLength);
    let at = 0;
    let rawAt = 0;
    const json: {
      p: number;
      t: string;
      s: TreeStorage;
      x: number;
      q: number;
      m: string;
      o: string;
      a: number;
      l: number;
      r: number;
      z: number;
      c: number;
    }[] = [];
    for (const row of rows) {
      names.set(row.nameBytes, at);
      rawEntries.set(row.rawEntry, rawAt);
      json.push({
        p: row.repoId,
        t: row.treeOid,
        s: row.storage,
        x: row.sourceId,
        q: row.ordinal,
        m: row.mode,
        o: row.oid,
        a: at + 1,
        l: row.nameBytes.length,
        r: rawAt + 1,
        z: row.rawEntry.length,
        c: row.cumulativeBase,
      });
      at += row.nameBytes.length;
      rawAt += row.rawEntry.length;
    }
    db.run(
      `INSERT INTO git_tree_entries
         (repo_id, tree_oid, storage, source_id, ordinal, mode, name, name_bytes, oid,
          raw_entry, cumulative_base)
       SELECT json_extract(j.value, '$.p'), json_extract(j.value, '$.t'),
              json_extract(j.value, '$.s'), json_extract(j.value, '$.x'),
              json_extract(j.value, '$.q'), json_extract(j.value, '$.m'),
              CAST(substr(?, json_extract(j.value, '$.a'), json_extract(j.value, '$.l')) AS TEXT),
              substr(?, json_extract(j.value, '$.a'), json_extract(j.value, '$.l')),
              json_extract(j.value, '$.o'),
              substr(?, json_extract(j.value, '$.r'), json_extract(j.value, '$.z')),
              json_extract(j.value, '$.c')
         FROM json_each(?) j`,
      blob(names),
      blob(names),
      blob(rawEntries),
      JSON.stringify(json),
    );
    rows = [];
    bufferedBytes = 0;
  };

  for (const source of sources) {
    let count = 0;
    let observedSize = 0;
    let baseCost = 0;
    for (const parsed of parseTreeStream(source.chunks)) {
      const { entry, nameBytes, rawEntry } = parsed;
      if (!/^(?:0?40000|100644|100755|120000|160000)$/.test(entry.mode)) {
        throw new CorruptError(`invalid tree mode ${entry.mode}`);
      }
      if (entry.name === "" || entry.name.includes("/")) {
        throw new CorruptError("invalid tree entry name");
      }
      const entryBytes = entry.mode.length + nameBytes.length + 22;
      baseCost +=
        TREE_QUEUE_ROW_FIXED_BYTES + nameBytes.length + entry.mode.length + entry.oid.length;
      const bufferedEntry =
        nameBytes.length + rawEntry.length + source.treeOid.length + entry.oid.length + 192;
      if (
        rows.length > 0 &&
        (rows.length >= TREE_INDEX_ROWS || bufferedBytes + bufferedEntry > TREE_INDEX_BYTES)
      ) {
        flush();
      }
      if (bufferedEntry > TREE_INDEX_BYTES) {
        throw new CorruptError("tree entry exceeds the index buffer limit");
      }
      rows.push({
        repoId: source.repoId,
        treeOid: source.treeOid,
        storage: source.storage,
        sourceId: source.sourceId,
        ordinal: count,
        mode: entry.mode,
        nameBytes,
        oid: entry.oid,
        rawEntry,
        cumulativeBase: baseCost,
      });
      bufferedBytes += bufferedEntry;
      observedSize += entryBytes;
      count++;
    }
    if (observedSize !== source.objectSize) {
      throw new CorruptError(
        `tree ${source.treeOid} parsed ${observedSize} bytes, expected ${source.objectSize}`,
      );
    }
    markers.push({
      p: source.repoId,
      t: source.treeOid,
      s: source.storage,
      x: source.sourceId,
      z: source.objectSize,
      n: count,
      b: baseCost,
    });
  }
  flush();
  for (let at = 0; at < markers.length; at += TREE_INDEX_ROWS) {
    db.run(
      `INSERT INTO git_tree_sources
         (repo_id, tree_oid, storage, source_id, object_size, entry_count, base_cost)
       SELECT json_extract(value, '$.p'), json_extract(value, '$.t'),
              json_extract(value, '$.s'), json_extract(value, '$.x'),
              json_extract(value, '$.z'), json_extract(value, '$.n'),
              json_extract(value, '$.b')
         FROM json_each(?)`,
      JSON.stringify(markers.slice(at, at + TREE_INDEX_ROWS)),
    );
  }
}

/** Write one exact parsed-tree source. The caller owns the transaction. */
export function indexTreeSource(
  db: SqlDatabase,
  source: TreeSource,
  chunks: Iterable<Uint8Array>,
): void {
  indexTreeSources(db, [{ ...source, chunks }]);
}
