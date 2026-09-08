import type { SqlDatabase } from "@kompjutr/sqlite";
import { isOid } from "../../common/bytes.js";
import { CorruptError, hasErrorCode } from "../../common/errors.js";
import { isCanonicalGitPath } from "../../common/paths.js";
import { int, nullable, oneOf, RowShape, text } from "../../common/rows.js";
import { comparePaths } from "../../common/streams.js";
import type {
  CommitTreeSnapshotDirectory,
  CommitTreeSnapshotRequest,
  CommitTreeSnapshotResult,
  CommitTreeSnapshotSource,
  SelectedPathRequest,
  SparseWorkspaceDirty,
} from "../../store/core/contracts.js";
import { bindSparseSource } from "../../store/sparse/receipt.js";
import { readSelectedIndex, validateSelectedPathRequest } from "./selection.js";
import {
  inputError,
  MAX_DEPTH,
  MAX_PATHS,
  type TreeCursor,
  type ValidatedTreeSource,
  validateRoot,
} from "./shared.js";
import { treeDepth } from "./tree-resolution.js";

const SNAPSHOT_DIRTY_SQL = `SELECT path, flags
  FROM git_index_dirty
 WHERE checkout_id = ?
 ORDER BY path COLLATE BINARY
 LIMIT ${MAX_PATHS + 1}`;
const SNAPSHOT_TRACKER_SCHEMA_SQL =
  "SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'git_index_state'";

const SNAPSHOT_STATE_ROW = new RowShape({
  checkout_id: int(1),
  repo_id: int(1),
  root: text(),
  baseline_tree_oid: nullable(text()),
  format: nullable(int(1)),
  complete: nullable(oneOf([0, 1])),
});

const SNAPSHOT_DIRTY_ROW = new RowShape({
  path: text().where(isCanonicalGitPath, "commit tree snapshot dirty path is malformed"),
  flags: oneOf([1, 2, 3]),
});

const SNAPSHOT_SOURCE_ROW = new RowShape({ source_key: int(1) });
const SNAPSHOT_SOURCE_SQL = `SELECT source.source_key
  FROM git_tree_effective effective
  JOIN git_tree_sources source
    ON source.source_key = effective.source_key
   AND source.repo_id = effective.repo_id
   AND source.tree_oid = effective.tree_oid
   AND source.complete = 1
 WHERE effective.repo_id = ? AND effective.tree_oid = ?`;

const SNAPSHOT_SOURCES_ROW = new RowShape({
  ordinal: int(0),
  oid: text(),
  source_key: nullable(int(1)),
});

const SNAPSHOT_ENTRY_ROW = new RowShape({
  wanted_ordinal: int(0),
  wanted_source_key: int(1),
  entry_ordinal: nullable(int(0)),
  mode: nullable(text()),
  name: nullable(text()),
  oid: nullable(text()),
});

function validateSnapshotRequest(input: unknown): CommitTreeSnapshotRequest {
  if (typeof input !== "object" || input === null || Array.isArray(input)) {
    throw inputError("commit tree snapshot request is invalid");
  }
  const repoId = Reflect.get(input, "repoId");
  const checkoutId = Reflect.get(input, "checkoutId");
  const root = Reflect.get(input, "root");
  const baselineTreeOid = Reflect.get(input, "baselineTreeOid");
  if (typeof repoId !== "number" || !Number.isSafeInteger(repoId) || repoId <= 0) {
    throw inputError("commit tree snapshot repository id is invalid");
  }
  if (typeof checkoutId !== "number" || !Number.isSafeInteger(checkoutId) || checkoutId <= 0) {
    throw inputError("commit tree snapshot checkout id is invalid");
  }
  if (typeof root !== "string") throw inputError("commit tree snapshot root is invalid");
  validateRoot(root);
  if (
    baselineTreeOid !== null &&
    (typeof baselineTreeOid !== "string" || !isOid(baselineTreeOid))
  ) {
    throw inputError("commit tree snapshot baseline is invalid");
  }
  return { repoId, checkoutId, root, baselineTreeOid };
}

function readSnapshotDirty(
  db: SqlDatabase,
  request: CommitTreeSnapshotRequest,
  retain: () => boolean,
): { available: boolean; dirty: SparseWorkspaceDirty[] } {
  if (db.scalar<unknown>(SNAPSHOT_TRACKER_SCHEMA_SQL) !== 1) {
    return { available: false, dirty: [] };
  }
  const rawState = db.one(
    `SELECT checkout.id AS checkout_id, checkout.repo_id, checkout.root,
            tracker.baseline_tree_oid, tracker.format, tracker.complete
       FROM git_checkouts checkout
       LEFT JOIN git_index_state tracker ON tracker.checkout_id = checkout.id
      WHERE checkout.id = ?`,
    request.checkoutId,
  );
  if (rawState === undefined) return { available: false, dirty: [] };
  const state = SNAPSHOT_STATE_ROW.decode(rawState);
  if (state.repo_id !== request.repoId) {
    throw inputError("commit tree snapshot checkout does not belong to the repository");
  }
  if (state.root !== request.root) {
    throw inputError("commit tree snapshot root does not match checkout");
  }
  if (state.format !== 1 || state.complete !== 1) return { available: false, dirty: [] };
  if (state.baseline_tree_oid !== null && !isOid(state.baseline_tree_oid)) {
    throw new CorruptError("commit tree snapshot tracker baseline is malformed");
  }
  if (state.baseline_tree_oid !== request.baselineTreeOid) {
    return { available: false, dirty: [] };
  }

  const dirty: SparseWorkspaceDirty[] = [];
  let previous: string | null = null;
  for (const raw of db.iterate(SNAPSHOT_DIRTY_SQL, request.checkoutId)) {
    const row = SNAPSHOT_DIRTY_ROW.decode(raw);
    if (previous !== null && comparePaths(previous, row.path) >= 0) {
      throw new CorruptError("commit tree snapshot dirty rows are unordered");
    }
    if (!retain()) return { available: false, dirty: [] };
    dirty.push(row);
    previous = row.path;
  }
  return { available: true, dirty };
}

function snapshotDirectoryPaths(
  dirty: readonly SparseWorkspaceDirty[],
  retain: () => boolean,
): string[] | null {
  if (!retain()) return null;
  const paths = new Set<string>([""]);
  for (const entry of dirty) {
    let slash = entry.path.indexOf("/");
    while (slash >= 0) {
      const directory = entry.path.slice(0, slash);
      if (!paths.has(directory)) {
        if (!retain()) return null;
        paths.add(directory);
      }
      slash = entry.path.indexOf("/", slash + 1);
    }
  }
  return [...paths].sort(comparePaths);
}

function resolveSnapshotDirectoryOids(
  db: SqlDatabase,
  request: CommitTreeSnapshotRequest,
  paths: readonly string[],
): {
  available: boolean;
  oids: Array<string | null>;
  sources: Map<string, ValidatedTreeSource>;
} {
  const oids: Array<string | null> = paths.map(() => null);
  const sources = new Map<string, ValidatedTreeSource>();
  if (request.baselineTreeOid === null) return { available: true, oids, sources };
  const rawSource = db.one(SNAPSHOT_SOURCE_SQL, request.repoId, request.baselineTreeOid);
  if (rawSource === undefined) return { available: false, oids, sources };
  const rootSource = SNAPSHOT_SOURCE_ROW.decode(rawSource);
  sources.set(request.baselineTreeOid, { sourceKey: rootSource.source_key });
  oids[0] = request.baselineTreeOid;

  let cursors: TreeCursor[] = [];
  for (let ordinal = 1; ordinal < paths.length; ordinal++) {
    const path = paths[ordinal];
    const segment = path?.split("/")[0];
    if (path === undefined || segment === undefined) {
      throw new CorruptError("commit tree directory path is malformed");
    }
    cursors.push({
      ordinal,
      side: "b",
      treeOid: request.baselineTreeOid,
      segment,
      final: !path.includes("/"),
      validated: true,
      ancestry: [request.baselineTreeOid],
    });
  }
  for (let depth = 0; cursors.length > 0; depth++) {
    if (depth >= MAX_DEPTH) return { available: false, oids, sources };
    const resolved = treeDepth(db, request.repoId, cursors, sources);
    if (!resolved.available) return { available: false, oids, sources };
    const next: TreeCursor[] = [];
    for (const cursor of cursors) {
      const resolution = resolved.resolutions.get(`b:${cursor.ordinal}`);
      if (resolution === undefined) {
        throw new CorruptError("commit tree directory lookup is incomplete");
      }
      if (cursor.final) {
        oids[cursor.ordinal] = resolution.treeOid;
        continue;
      }
      if (resolution.treeOid === null) continue;
      if (cursor.ancestry.includes(resolution.treeOid)) {
        throw new CorruptError(`commit tree snapshot cycle at ${resolution.treeOid}`);
      }
      const path = paths[cursor.ordinal];
      const segment = path?.split("/")[depth + 1];
      if (path === undefined || segment === undefined) {
        throw new CorruptError("commit tree directory path is malformed");
      }
      next.push({
        ordinal: cursor.ordinal,
        side: "b",
        treeOid: resolution.treeOid,
        segment,
        final: depth + 2 === path.split("/").length,
        validated: sources.has(resolution.treeOid),
        ancestry: [...cursor.ancestry, resolution.treeOid],
      });
    }
    cursors = next;
  }
  return { available: true, oids, sources };
}
function completeSnapshotSources(
  db: SqlDatabase,
  repoId: number,
  oids: readonly (string | null)[],
  sources: Map<string, ValidatedTreeSource>,
): boolean {
  const missing = [
    ...new Set(oids.filter((oid): oid is string => oid !== null && !sources.has(oid))),
  ];
  if (missing.length === 0) return true;
  const json = JSON.stringify(missing);
  let ordinal = 0;
  for (const raw of db.iterate(
    `WITH wanted(ordinal, oid) AS MATERIALIZED (
       SELECT CAST(key AS INTEGER), value FROM json_each(?)
     )
     SELECT wanted.ordinal, wanted.oid, source.source_key
       FROM wanted
       LEFT JOIN git_tree_effective effective
         ON effective.repo_id = ? AND effective.tree_oid = wanted.oid
       LEFT JOIN git_tree_sources source
         ON source.source_key = effective.source_key
        AND source.repo_id = effective.repo_id
        AND source.tree_oid = wanted.oid
        AND source.complete = 1
      ORDER BY wanted.ordinal`,
    json,
    repoId,
  )) {
    const row = SNAPSHOT_SOURCES_ROW.decode(raw);
    const oid = missing[ordinal];
    if (row.ordinal !== ordinal || oid === undefined || row.oid !== oid) {
      throw new CorruptError("commit tree snapshot source binding is malformed");
    }
    if (row.source_key === null) return false;
    sources.set(row.oid, { sourceKey: row.source_key });
    ordinal++;
  }
  if (ordinal !== missing.length) {
    throw new CorruptError("commit tree snapshot source lookup lost a requested tree");
  }
  return true;
}

const SNAPSHOT_ENTRIES_SQL = `WITH wanted(ordinal, source_key) AS MATERIALIZED (
  SELECT CAST(json_extract(value, '$.i') AS INTEGER),
         CAST(json_extract(value, '$.k') AS INTEGER)
    FROM json_each(?)
)
SELECT wanted.ordinal AS wanted_ordinal, wanted.source_key AS wanted_source_key,
       entry.ordinal AS entry_ordinal, entry.mode,
       CAST(entry.name_bytes AS TEXT) AS name, entry.oid
  FROM wanted
  LEFT JOIN git_tree_entries entry ON entry.source_key = wanted.source_key
 ORDER BY wanted.ordinal, entry.ordinal`;

function readSnapshotDirectories(
  db: SqlDatabase,
  paths: readonly string[],
  oids: readonly (string | null)[],
  sources: ReadonlyMap<string, ValidatedTreeSource>,
  retain: () => boolean,
): { available: boolean; directories: CommitTreeSnapshotDirectory[] } {
  const directories: CommitTreeSnapshotDirectory[] = paths.map((path, ordinal) => ({
    path,
    oid: oids[ordinal] ?? null,
    entries: [],
  }));
  const parts: string[] = [];
  for (let ordinal = 0; ordinal < paths.length; ordinal++) {
    const oid = oids[ordinal];
    if (oid === null || oid === undefined) continue;
    const source = sources.get(oid);
    if (source === undefined) throw new CorruptError("commit tree snapshot source is missing");
    parts.push(JSON.stringify({ i: ordinal, k: source.sourceKey }));
  }
  if (parts.length === 0) return { available: true, directories };

  const seen = new Map<number, number>();
  for (const raw of db.iterate(SNAPSHOT_ENTRIES_SQL, `[${parts.join(",")}]`)) {
    const row = SNAPSHOT_ENTRY_ROW.decode(raw);
    const expectedOid = oids[row.wanted_ordinal];
    const source = typeof expectedOid === "string" ? sources.get(expectedOid) : undefined;
    if (source === undefined || source.sourceKey !== row.wanted_source_key) {
      throw new CorruptError("commit tree snapshot entry binding is malformed");
    }
    if (row.entry_ordinal === null) {
      if (
        row.mode !== null ||
        row.name !== null ||
        row.oid !== null ||
        seen.has(row.wanted_ordinal)
      ) {
        throw new CorruptError("commit tree snapshot returned an incomplete entry");
      }
      seen.set(row.wanted_ordinal, 0);
      continue;
    }
    const expectedOrdinal = seen.get(row.wanted_ordinal) ?? 0;
    if (
      row.entry_ordinal !== expectedOrdinal ||
      row.mode === null ||
      !["40000", "040000", "100644", "100755", "120000", "160000"].includes(row.mode) ||
      row.name === null ||
      row.name === "" ||
      row.name.includes("/") ||
      row.name.includes("\0") ||
      row.oid === null ||
      !isOid(row.oid)
    ) {
      throw new CorruptError("commit tree snapshot entry is malformed");
    }
    if (!retain()) return { available: false, directories: [] };
    directories[row.wanted_ordinal]?.entries.push({ mode: row.mode, name: row.name, oid: row.oid });
    seen.set(row.wanted_ordinal, expectedOrdinal + 1);
  }
  return { available: true, directories };
}

function snapshotCommitTreeNative(
  db: SqlDatabase,
  input: CommitTreeSnapshotRequest,
): CommitTreeSnapshotResult {
  const request = validateSnapshotRequest(input);
  let materialized = 0;
  const retain = (): boolean => {
    if (materialized === MAX_PATHS) return false;
    materialized++;
    return true;
  };
  const dirty = readSnapshotDirty(db, request, retain);
  if (!dirty.available) return { available: false };
  if (dirty.dirty.length === 0) {
    if (request.baselineTreeOid !== null) {
      const source = db.one(SNAPSHOT_SOURCE_SQL, request.repoId, request.baselineTreeOid);
      if (source === undefined) return { available: false };
      SNAPSHOT_SOURCE_ROW.decode(source);
    }
    return {
      available: true,
      baselineTreeOid: request.baselineTreeOid,
      dirty: [],
      index: [],
      directories: [],
    };
  }

  const selectedRequest: SelectedPathRequest = {
    repoId: request.repoId,
    checkoutId: request.checkoutId,
    root: request.root,
    specs: dirty.dirty.map((entry) => ({ path: entry.path, recursive: false })),
  };
  const selectedValidated = validateSelectedPathRequest(selectedRequest);
  if (selectedValidated === null) return { available: false };
  const index = readSelectedIndex(db, selectedValidated, true, retain);
  if (!index.available) return { available: false };
  const paths = snapshotDirectoryPaths(dirty.dirty, retain);
  if (paths === null) return { available: false };
  const resolved = resolveSnapshotDirectoryOids(db, request, paths);
  if (!resolved.available) return { available: false };
  if (!completeSnapshotSources(db, request.repoId, resolved.oids, resolved.sources)) {
    return { available: false };
  }
  const directories = readSnapshotDirectories(db, paths, resolved.oids, resolved.sources, retain);
  if (!directories.available) return { available: false };
  return {
    available: true,
    baselineTreeOid: request.baselineTreeOid,
    dirty: dirty.dirty,
    index: index.rows,
    directories: directories.directories,
  };
}

export function snapshotCommitTreeOwned(
  source: CommitTreeSnapshotSource,
  request: CommitTreeSnapshotRequest,
): CommitTreeSnapshotResult {
  try {
    return source.snapshot(request);
  } catch (error) {
    if (hasErrorCode(error, "E2BIG")) return { available: false };
    throw error;
  }
}

export function createSqliteCommitTreeSnapshotSource(db: SqlDatabase): CommitTreeSnapshotSource {
  return bindSparseSource(db, "commit-tree", {
    snapshot: (request) => snapshotCommitTreeNative(db, request),
  });
}
