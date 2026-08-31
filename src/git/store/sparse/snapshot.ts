import type { SqlDatabase } from "../../../db/db.js";
import { isOid } from "../../common/bytes.js";
import { CorruptError, hasErrorCode } from "../../common/errors.js";
import { comparePaths } from "../../common/streams.js";
import type {
  CommitTreeSnapshotDirectory,
  CommitTreeSnapshotRequest,
  CommitTreeSnapshotResult,
  CommitTreeSnapshotSource,
  SelectedPathRequest,
  SparseWorkspaceDirty,
} from "../contracts.js";
import { validStoredIndexPath } from "./index-rows.js";
import { readSelectedIndex, validateSelectedPathRequest } from "./selection.js";
import {
  CURSOR_RETAINED_BYTES,
  encoder,
  inputError,
  MAX_DEPTH,
  MAX_PATHS,
  MAX_SNAPSHOT_DIRECTORIES,
  OID_RETAINED_BYTES,
  parseRelativePath,
  ROW_RETAINED_BYTES,
  releaseSnapshot,
  reserveSnapshot,
  SELECTED_INDEX_RETAINED_BYTES,
  SNAPSHOT_ARRAY_RETAINED_BYTES,
  SNAPSHOT_ARRAY_SLOT_BYTES,
  SNAPSHOT_DIRECTORY_RETAINED_BYTES,
  SNAPSHOT_ENTRY_RETAINED_BYTES,
  SNAPSHOT_MAP_ENTRY_BYTES,
  SNAPSHOT_MAP_RETAINED_BYTES,
  SNAPSHOT_MIN_DIRTY_ROW_RETAINED_BYTES,
  SNAPSHOT_REQUEST_RETAINED_BYTES,
  SNAPSHOT_SOURCE_RETAINED_BYTES,
  SNAPSHOT_TREE_PART_JSON_CHARS,
  SNAPSHOT_TREE_RESOLUTION_RETAINED_BYTES,
  type SnapshotRetainedBudget,
  type SourceBudget,
  SPARSE_WORKSPACE_STATE_BYTES,
  type TreeCursor,
  type TreeResolution,
  type ValidatedTreeSource,
  validateRoot,
} from "./shared.js";
import { numberField, treeDepth } from "./tree-resolution.js";

function snapshotSelectedRequestBytes(
  dirty: readonly SparseWorkspaceDirty[],
  retainedLimit: number,
): number | null {
  let retainedBytes = SNAPSHOT_REQUEST_RETAINED_BYTES + SNAPSHOT_ARRAY_RETAINED_BYTES * 2;
  let jsonChars = 2;
  for (let index = 0; index < dirty.length; index++) {
    const path = dirty[index]?.path;
    if (path === undefined) throw new CorruptError("commit tree snapshot lost a dirty path");
    const parsed = parseRelativePath(path);
    const part = JSON.stringify({ p: path, r: 0 });
    const separator = index === 0 ? 0 : 1;
    const records =
      ROW_RETAINED_BYTES * 2 + SNAPSHOT_ARRAY_SLOT_BYTES * 2 + path.length * 4 + parsed.bytes;
    if (records > retainedLimit - retainedBytes) return null;
    retainedBytes += records;
    jsonChars += part.length + separator;
    if (jsonChars * 2 > retainedLimit - retainedBytes) return null;
  }
  return retainedBytes + jsonChars * 2;
}

interface ValidatedSnapshotRequest {
  request: CommitTreeSnapshotRequest;
  retainedLimit: number;
  retainedBytes: number;
}

function validateSnapshotRequest(input: unknown): ValidatedSnapshotRequest | null {
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
  const retainedLimit = SPARSE_WORKSPACE_STATE_BYTES;
  const retainedBytes =
    SNAPSHOT_REQUEST_RETAINED_BYTES + root.length * 4 + (baselineTreeOid === null ? 0 : 160);
  if (retainedBytes > retainedLimit) return null;
  return {
    request: {
      repoId,
      checkoutId,
      root,
      baselineTreeOid,
    },
    retainedLimit,
    retainedBytes,
  };
}

const SNAPSHOT_DIRTY_SQL = `WITH state AS (
  SELECT checkout.id AS checkout_id, checkout.repo_id, checkout.root,
         typeof(checkout.repo_id) AS repo_type, typeof(checkout.root) AS root_type,
         length(CAST(checkout.root AS BLOB)) AS root_bytes,
         tracker.baseline_tree_oid, typeof(tracker.baseline_tree_oid) AS baseline_type,
         length(CAST(tracker.baseline_tree_oid AS BLOB)) AS baseline_bytes,
         tracker.format, typeof(tracker.format) AS format_type,
         tracker.complete, typeof(tracker.complete) AS complete_type
    FROM git_checkouts checkout
    LEFT JOIN git_index_state tracker ON tracker.checkout_id = checkout.id
   WHERE checkout.id = ?
), dirty AS MATERIALIZED (
  SELECT path, flags FROM git_index_dirty WHERE checkout_id = ?
   ORDER BY path COLLATE BINARY LIMIT ?
)
SELECT 0 AS kind, state.*,
       NULL AS path, 'null' AS path_type, NULL AS path_bytes,
       NULL AS flags, 'null' AS flags_type
  FROM (SELECT 1) LEFT JOIN state ON 1 = 1
UNION ALL
SELECT 1, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL,
       dirty.path, typeof(dirty.path), length(CAST(dirty.path AS BLOB)),
       dirty.flags, typeof(dirty.flags)
  FROM dirty
ORDER BY kind, path COLLATE BINARY`;

function readSnapshotDirty(
  db: SqlDatabase,
  validated: ValidatedSnapshotRequest,
  budget: SnapshotRetainedBudget,
): { available: boolean; dirty: SparseWorkspaceDirty[] } {
  if (!reserveSnapshot(budget, SNAPSHOT_ARRAY_RETAINED_BYTES)) {
    return { available: false, dirty: [] };
  }
  const dirty: SparseWorkspaceDirty[] = [];
  const remaining = budget.limit - budget.used;
  const capacityRows = Math.floor(remaining / SNAPSHOT_MIN_DIRTY_ROW_RETAINED_BYTES);
  let metadata = false;
  let available = true;
  let previous: string | null = null;
  for (const row of db.iterate(
    SNAPSHOT_DIRTY_SQL,
    validated.request.checkoutId,
    validated.request.checkoutId,
    capacityRows + 1,
  )) {
    if (row.kind === 0) {
      if (metadata) throw new CorruptError("commit tree snapshot duplicated tracker state");
      metadata = true;
      if (row.checkout_id === null) return { available: false, dirty: [] };
      const rootBytes = numberField(row.root_bytes);
      if (
        row.checkout_id !== validated.request.checkoutId ||
        row.repo_type !== "integer" ||
        row.repo_id !== validated.request.repoId ||
        row.root_type !== "text" ||
        row.root !== validated.request.root ||
        rootBytes === null ||
        rootBytes < 1
      ) {
        throw new CorruptError("commit tree snapshot checkout is malformed");
      }
      if (row.complete === null) return { available: false, dirty: [] };
      if (row.complete_type !== "integer" || row.format_type !== "integer") {
        throw new CorruptError("commit tree snapshot tracker state is malformed");
      }
      if (row.complete !== 0 && row.complete !== 1) {
        throw new CorruptError("commit tree snapshot tracker completion is invalid");
      }
      if (row.complete === 0) return { available: false, dirty: [] };
      const baselineBytes = numberField(row.baseline_bytes);
      if (
        row.format !== 1 ||
        (row.baseline_type !== "null" && row.baseline_type !== "text") ||
        (row.baseline_tree_oid !== null &&
          (typeof row.baseline_tree_oid !== "string" ||
            baselineBytes !== 40 ||
            !isOid(row.baseline_tree_oid)))
      ) {
        throw new CorruptError("commit tree snapshot tracker baseline is malformed");
      }
      if (row.baseline_tree_oid !== validated.request.baselineTreeOid) available = false;
      continue;
    }
    if (row.kind !== 1 || !metadata) {
      throw new CorruptError("commit tree snapshot dirty rows are unordered");
    }
    const pathBytes = numberField(row.path_bytes);
    const flags = numberField(row.flags);
    if (
      row.path_type !== "text" ||
      typeof row.path !== "string" ||
      pathBytes === null ||
      pathBytes < 1 ||
      !validStoredIndexPath(row.path, pathBytes) ||
      row.flags_type !== "integer" ||
      flags === null ||
      (flags !== 1 && flags !== 2 && flags !== 3) ||
      (previous !== null && comparePaths(previous, row.path) >= 0)
    ) {
      throw new CorruptError("commit tree snapshot dirty row is malformed");
    }
    if (dirty.length === capacityRows) return { available: false, dirty: [] };
    previous = row.path;
    const bytes = ROW_RETAINED_BYTES + SNAPSHOT_ARRAY_SLOT_BYTES + row.path.length * 4 + pathBytes;
    if (!reserveSnapshot(budget, bytes)) {
      return { available: false, dirty: [] };
    }
    dirty.push({ path: row.path, flags });
  }
  if (!metadata) throw new CorruptError("commit tree snapshot lost tracker state");
  return { available, dirty };
}

function snapshotDirectoryPaths(
  dirty: readonly SparseWorkspaceDirty[],
  budget: SnapshotRetainedBudget,
): string[] | null {
  if (
    !reserveSnapshot(
      budget,
      SNAPSHOT_MAP_RETAINED_BYTES + SNAPSHOT_MAP_ENTRY_BYTES + SNAPSHOT_DIRECTORY_RETAINED_BYTES,
    )
  ) {
    return null;
  }
  const paths = new Set<string>([""]);
  for (const entry of dirty) {
    let slash = entry.path.indexOf("/");
    while (slash >= 0) {
      const retained =
        SNAPSHOT_MAP_ENTRY_BYTES +
        SNAPSHOT_DIRECTORY_RETAINED_BYTES +
        slash * 4 +
        utf8PrefixLength(entry.path, slash);
      if (!reserveSnapshot(budget, retained)) return null;
      const directory = entry.path.slice(0, slash);
      if (paths.has(directory)) {
        releaseSnapshot(budget, retained);
      } else {
        if (paths.size === MAX_SNAPSHOT_DIRECTORIES) return null;
        paths.add(directory);
      }
      slash = entry.path.indexOf("/", slash + 1);
    }
  }
  if (
    !reserveSnapshot(budget, SNAPSHOT_ARRAY_RETAINED_BYTES + paths.size * SNAPSHOT_ARRAY_SLOT_BYTES)
  ) {
    return null;
  }
  return [...paths].sort(comparePaths);
}

function utf8PrefixLength(value: string, end: number): number {
  let bytes = 0;
  for (let index = 0; index < end; index++) {
    const unit = value.charCodeAt(index);
    if (unit < 0x80) bytes++;
    else if (unit < 0x800) bytes += 2;
    else if (unit >= 0xd800 && unit <= 0xdbff) {
      bytes += 4;
      index++;
    } else bytes += 3;
  }
  return bytes;
}

interface SnapshotTreeDepthReservation {
  requestBytes: number;
  resolutionBytes: number;
}

function reserveSnapshotTreeDepth(
  retained: SnapshotRetainedBudget,
  cursors: readonly TreeCursor[],
): SnapshotTreeDepthReservation | null {
  if (cursors.length > MAX_PATHS) return null;
  let jsonChars = 2;
  for (const cursor of cursors) {
    const partChars = SNAPSHOT_TREE_PART_JSON_CHARS + cursor.segment.length * 6;
    if (!Number.isSafeInteger(partChars)) {
      return null;
    }
    jsonChars += partChars + (jsonChars === 2 ? 0 : 1);
  }
  const requestBytes =
    SNAPSHOT_ARRAY_RETAINED_BYTES + cursors.length * SNAPSHOT_ARRAY_SLOT_BYTES + jsonChars * 6;
  const resolutionBytes =
    SNAPSHOT_MAP_RETAINED_BYTES + cursors.length * SNAPSHOT_TREE_RESOLUTION_RETAINED_BYTES;
  if (
    !Number.isSafeInteger(requestBytes) ||
    !Number.isSafeInteger(resolutionBytes) ||
    requestBytes > retained.limit - resolutionBytes ||
    !reserveSnapshot(retained, requestBytes + resolutionBytes)
  ) {
    return null;
  }
  return { requestBytes, resolutionBytes };
}

function snapshotTreeDepth(
  db: SqlDatabase,
  repoId: number,
  cursors: TreeCursor[],
  sources: Map<string, ValidatedTreeSource>,
  budget: SourceBudget,
  retained: SnapshotRetainedBudget,
  retainSource: (treeOid: string) => boolean,
): {
  available: boolean;
  resolutions: Map<string, TreeResolution>;
  resolutionBytes: number;
} {
  const allocation = reserveSnapshotTreeDepth(retained, cursors);
  if (allocation === null) {
    return { available: false, resolutions: new Map(), resolutionBytes: 0 };
  }
  const result = treeDepth(
    db,
    repoId,
    cursors,
    sources,
    budget,
    retained.used - allocation.requestBytes,
    retained.limit,
    retainSource,
  );
  releaseSnapshot(retained, allocation.requestBytes);
  return { ...result, resolutionBytes: allocation.resolutionBytes };
}

function resolveSnapshotDirectoryOids(
  db: SqlDatabase,
  request: CommitTreeSnapshotRequest,
  paths: readonly string[],
  retained: SnapshotRetainedBudget,
): {
  available: boolean;
  oids: Array<string | null>;
  sources: Map<string, ValidatedTreeSource>;
} {
  if (
    !reserveSnapshot(
      retained,
      SNAPSHOT_ARRAY_RETAINED_BYTES +
        paths.length * SNAPSHOT_ARRAY_SLOT_BYTES +
        SNAPSHOT_MAP_RETAINED_BYTES,
    )
  ) {
    return { available: false, oids: [], sources: new Map() };
  }
  const oids: Array<string | null> = paths.map(() => null);
  const sources = new Map<string, ValidatedTreeSource>();
  if (request.baselineTreeOid === null) return { available: true, oids, sources };
  const retainSource = (treeOid: string): boolean =>
    reserveSnapshot(
      retained,
      SNAPSHOT_MAP_ENTRY_BYTES + SNAPSHOT_SOURCE_RETAINED_BYTES + treeOid.length * 4,
    );
  const sourcePresent = db.scalar<unknown>(
    `SELECT EXISTS (
       SELECT 1 FROM git_tree_effective WHERE repo_id = ? AND tree_oid = ?
     )`,
    request.repoId,
    request.baselineTreeOid,
  );
  if (sourcePresent !== 0 && sourcePresent !== 1) {
    throw new CorruptError("commit tree source presence is malformed");
  }
  if (sourcePresent === 0) return { available: false, oids, sources };
  oids[0] = request.baselineTreeOid;
  const budget: SourceBudget = {
    entries: 0,
    bytes: 0,
    limit: Math.max(0, retained.limit - retained.used),
  };
  const rootCursorBytes =
    SNAPSHOT_ARRAY_RETAINED_BYTES + SNAPSHOT_ARRAY_SLOT_BYTES + snapshotCursorRetainedBytes(1, 1);
  if (!reserveSnapshot(retained, rootCursorBytes)) {
    return { available: false, oids, sources };
  }
  const rootCursors: TreeCursor[] = [
    {
      ordinal: 0,
      side: "b",
      treeOid: request.baselineTreeOid,
      segment: "/",
      final: true,
      validated: false,
      ancestry: [request.baselineTreeOid],
    },
  ];
  const rootValidation = snapshotTreeDepth(
    db,
    request.repoId,
    rootCursors,
    sources,
    budget,
    retained,
    retainSource,
  );
  releaseSnapshot(retained, rootValidation.resolutionBytes);
  releaseSnapshot(retained, rootCursorBytes);
  if (!rootValidation.available) return { available: false, oids, sources };

  if (!reserveSnapshot(retained, SNAPSHOT_ARRAY_RETAINED_BYTES)) {
    return { available: false, oids, sources };
  }
  let cursors: TreeCursor[] = [];
  let cursorRetainedBytes = SNAPSHOT_ARRAY_RETAINED_BYTES;
  for (let ordinal = 1; ordinal < paths.length; ordinal++) {
    const path = paths[ordinal];
    if (path === undefined) continue;
    const bounds = pathSegmentBounds(path, 0);
    if (bounds === null) throw new CorruptError("commit tree directory path is malformed");
    const cursorBytes =
      SNAPSHOT_ARRAY_SLOT_BYTES + snapshotCursorRetainedBytes(bounds.end - bounds.start, 1);
    if (!reserveSnapshot(retained, cursorBytes)) {
      return { available: false, oids, sources };
    }
    cursorRetainedBytes += cursorBytes;
    const first = path.slice(bounds.start, bounds.end);
    cursors.push({
      ordinal: ordinal - 1,
      side: "b",
      treeOid: request.baselineTreeOid,
      segment: first,
      final: bounds.final,
      validated: true,
      ancestry: [request.baselineTreeOid],
    });
  }
  for (let depth = 0; cursors.length > 0; depth++) {
    if (depth >= MAX_DEPTH) return { available: false, oids, sources };
    for (const cursor of cursors) cursor.validated = sources.has(cursor.treeOid);
    const resolved = snapshotTreeDepth(
      db,
      request.repoId,
      cursors,
      sources,
      budget,
      retained,
      retainSource,
    );
    if (!resolved.available) {
      releaseSnapshot(retained, resolved.resolutionBytes);
      return { available: false, oids, sources };
    }
    if (!reserveSnapshot(retained, SNAPSHOT_ARRAY_RETAINED_BYTES)) {
      return { available: false, oids, sources };
    }
    const next: TreeCursor[] = [];
    let nextRetainedBytes = SNAPSHOT_ARRAY_RETAINED_BYTES;
    for (const cursor of cursors) {
      const directoryOrdinal = cursor.ordinal + 1;
      const resolution = resolved.resolutions.get(`b:${cursor.ordinal}`);
      if (resolution === undefined)
        throw new CorruptError("commit tree directory lookup is incomplete");
      if (cursor.final) {
        oids[directoryOrdinal] = resolution.treeOid;
        continue;
      }
      if (resolution.treeOid === null) continue;
      const path = paths[directoryOrdinal];
      if (path === undefined) {
        throw new CorruptError("commit tree directory path is malformed");
      }
      const bounds = pathSegmentBounds(path, depth + 1);
      if (bounds === null) throw new CorruptError("commit tree directory path is malformed");
      const cursorBytes =
        SNAPSHOT_ARRAY_SLOT_BYTES +
        snapshotCursorRetainedBytes(bounds.end - bounds.start, cursor.ancestry.length + 1);
      if (!reserveSnapshot(retained, cursorBytes)) {
        return { available: false, oids, sources };
      }
      nextRetainedBytes += cursorBytes;
      const segment = path.slice(bounds.start, bounds.end);
      next.push({
        ordinal: cursor.ordinal,
        side: "b",
        treeOid: resolution.treeOid,
        segment,
        final: bounds.final,
        validated: sources.has(resolution.treeOid),
        ancestry: [...cursor.ancestry, resolution.treeOid],
      });
    }
    releaseSnapshot(retained, cursorRetainedBytes);
    releaseSnapshot(retained, resolved.resolutionBytes);
    cursors = next;
    cursorRetainedBytes = nextRetainedBytes;
  }
  releaseSnapshot(retained, cursorRetainedBytes);
  if (!reserveSnapshot(retained, SNAPSHOT_ARRAY_RETAINED_BYTES)) {
    return { available: false, oids, sources };
  }
  const unvalidated: string[] = [];
  let unvalidatedRetainedBytes = SNAPSHOT_ARRAY_RETAINED_BYTES;
  for (const oid of oids) {
    if (oid === null || sources.has(oid) || unvalidated.includes(oid)) continue;
    const bytes = SNAPSHOT_ARRAY_SLOT_BYTES + OID_RETAINED_BYTES;
    if (!reserveSnapshot(retained, bytes)) return { available: false, oids, sources };
    unvalidatedRetainedBytes += bytes;
    unvalidated.push(oid);
  }
  if (unvalidated.length > 0) {
    let validationCursorBytes = SNAPSHOT_ARRAY_RETAINED_BYTES;
    for (const oid of unvalidated) {
      validationCursorBytes +=
        SNAPSHOT_ARRAY_SLOT_BYTES + snapshotCursorRetainedBytes(1, 1) + oid.length * 4;
    }
    if (!reserveSnapshot(retained, validationCursorBytes)) {
      return { available: false, oids, sources };
    }
    const validation = snapshotTreeDepth(
      db,
      request.repoId,
      unvalidated.map((oid, ordinal) => ({
        ordinal,
        side: "b",
        treeOid: oid,
        segment: "/",
        final: true,
        validated: false,
        ancestry: [oid],
      })),
      sources,
      budget,
      retained,
      retainSource,
    );
    releaseSnapshot(retained, validationCursorBytes);
    releaseSnapshot(retained, validation.resolutionBytes);
    if (!validation.available) return { available: false, oids, sources };
  }
  releaseSnapshot(retained, unvalidatedRetainedBytes);
  return { available: true, oids, sources };
}

function snapshotCursorRetainedBytes(segmentLength: number, ancestryLength: number): number {
  return CURSOR_RETAINED_BYTES + segmentLength * 4 + ancestryLength * OID_RETAINED_BYTES;
}

function pathSegmentBounds(
  path: string,
  wanted: number,
): { start: number; end: number; final: boolean } | null {
  let segment = 0;
  let start = 0;
  for (let index = 0; index <= path.length; index++) {
    if (index !== path.length && path.charCodeAt(index) !== 0x2f) continue;
    if (segment === wanted) return { start, end: index, final: index === path.length };
    segment++;
    start = index + 1;
  }
  return null;
}

const SNAPSHOT_ENTRIES_SQL = `WITH
wanted(ordinal, path, tree_oid, source_key, storage, source_id) AS MATERIALIZED (
  SELECT CAST(json_extract(value, '$.i') AS INTEGER), json_extract(value, '$.p'),
         json_extract(value, '$.t'), CAST(json_extract(value, '$.k') AS INTEGER),
         json_extract(value, '$.s'),
         CAST(json_extract(value, '$.x') AS INTEGER)
    FROM json_each(?)
), selected AS MATERIALIZED (
  SELECT wanted.*, source.repo_id, source.tree_oid AS source_tree_oid,
         source.source_key AS selected_source_key, source.storage AS source_storage,
         source.source_id AS selected_source_id, source.complete,
         effective.source_key AS effective_source_key
    FROM wanted
    LEFT JOIN git_tree_sources source ON source.source_key = wanted.source_key
    LEFT JOIN git_tree_effective effective
      ON effective.repo_id = source.repo_id AND effective.tree_oid = source.tree_oid
     AND effective.source_key = source.source_key
)
SELECT selected.ordinal AS wanted_ordinal, selected.path AS directory_path,
       selected.tree_oid AS wanted_tree_oid, selected.source_key AS wanted_source_key,
       selected.storage AS wanted_storage, selected.source_id AS wanted_source_id,
       selected.repo_id AS selected_repo_id, selected.source_tree_oid,
       selected.selected_source_key, selected.source_storage, selected.selected_source_id,
       selected.complete AS source_complete, selected.effective_source_key,
       entry.ordinal, entry.mode, entry.name, entry.oid
  FROM selected
  LEFT JOIN (
    SELECT source_key, ordinal, mode, CAST(name_bytes AS TEXT) AS name, oid
      FROM git_tree_entries
  ) entry ON entry.source_key = selected.source_key
 ORDER BY selected.ordinal, entry.ordinal`;

function readSnapshotDirectories(
  db: SqlDatabase,
  request: CommitTreeSnapshotRequest,
  paths: readonly string[],
  oids: readonly (string | null)[],
  sources: Map<string, ValidatedTreeSource>,
  retained: SnapshotRetainedBudget,
): { available: boolean; directories: CommitTreeSnapshotDirectory[] } {
  const directoryBytes =
    SNAPSHOT_ARRAY_RETAINED_BYTES +
    paths.length *
      (SNAPSHOT_ARRAY_SLOT_BYTES +
        SNAPSHOT_DIRECTORY_RETAINED_BYTES +
        SNAPSHOT_ARRAY_RETAINED_BYTES);
  if (!reserveSnapshot(retained, directoryBytes)) {
    return { available: false, directories: [] };
  }
  const directories: CommitTreeSnapshotDirectory[] = paths.map((path, ordinal) => ({
    path,
    oid: oids[ordinal] ?? null,
    entries: [],
  }));
  if (!reserveSnapshot(retained, SNAPSHOT_ARRAY_RETAINED_BYTES + SNAPSHOT_MAP_RETAINED_BYTES)) {
    return { available: false, directories: [] };
  }
  const parts: string[] = [];
  const expectedCounts = new Map<number, number>();
  let requestJsonChars = 2;
  let requestJsonBytes = 2;
  for (let ordinal = 0; ordinal < paths.length; ordinal++) {
    const oid = oids[ordinal];
    if (oid === null || oid === undefined) continue;
    const source = sources.get(oid);
    if (source === undefined)
      throw new CorruptError("commit tree snapshot source is unauthenticated");
    const part = JSON.stringify({
      i: ordinal,
      p: paths[ordinal],
      t: oid,
      k: source.sourceKey,
      s: source.storage,
      x: source.sourceId,
    });
    const partBytes = SNAPSHOT_ARRAY_SLOT_BYTES + part.length * 2 + SNAPSHOT_MAP_ENTRY_BYTES;
    if (!reserveSnapshot(retained, partBytes)) {
      return { available: false, directories: [] };
    }
    const separator = parts.length === 0 ? 0 : 1;
    requestJsonChars += part.length + separator;
    requestJsonBytes += encoder.encode(part).length + separator;
    if (!Number.isSafeInteger(requestJsonBytes)) {
      return { available: false, directories: [] };
    }
    parts.push(part);
    expectedCounts.set(ordinal, source.entryCount);
  }
  if (parts.length === 0) return { available: true, directories };
  if (!reserveSnapshot(retained, requestJsonChars * 2)) {
    return { available: false, directories: [] };
  }
  const json = `[${parts.join(",")}]`;
  if (
    !reserveSnapshot(
      retained,
      SNAPSHOT_MAP_RETAINED_BYTES + expectedCounts.size * SNAPSHOT_MAP_ENTRY_BYTES,
    )
  ) {
    return { available: false, directories: [] };
  }
  const seen = new Map<number, number>();
  for (const row of db.iterate(SNAPSHOT_ENTRIES_SQL, json)) {
    const ordinal = numberField(row.wanted_ordinal);
    const sourceId = numberField(row.wanted_source_id);
    const sourceKey = numberField(row.wanted_source_key);
    const expectedOid = ordinal === null ? undefined : oids[ordinal];
    const expectedPath = ordinal === null ? undefined : paths[ordinal];
    const source = typeof expectedOid === "string" ? sources.get(expectedOid) : undefined;
    if (
      ordinal === null ||
      expectedPath === undefined ||
      typeof expectedOid !== "string" ||
      source === undefined ||
      row.directory_path !== expectedPath ||
      row.wanted_tree_oid !== expectedOid ||
      sourceKey !== source.sourceKey ||
      row.wanted_storage !== source.storage ||
      sourceId !== source.sourceId ||
      row.selected_repo_id !== request.repoId ||
      row.source_tree_oid !== expectedOid ||
      numberField(row.selected_source_key) !== source.sourceKey ||
      row.source_storage !== source.storage ||
      numberField(row.selected_source_id) !== source.sourceId ||
      row.source_complete !== 1 ||
      numberField(row.effective_source_key) !== source.sourceKey
    ) {
      throw new CorruptError("commit tree snapshot entry source is malformed");
    }
    if (row.ordinal === null) {
      if (source.entryCount !== 0 || (seen.get(ordinal) ?? 0) !== 0) {
        throw new CorruptError("commit tree snapshot lost source entries");
      }
      seen.set(ordinal, 0);
      continue;
    }
    const entryOrdinal = numberField(row.ordinal);
    if (
      entryOrdinal === null ||
      entryOrdinal !== (seen.get(ordinal) ?? 0) ||
      typeof row.mode !== "string" ||
      !["40000", "040000", "100644", "100755", "120000", "160000"].includes(row.mode) ||
      typeof row.name !== "string" ||
      row.name === "" ||
      row.name.includes("/") ||
      row.name.includes("\0") ||
      typeof row.oid !== "string" ||
      !isOid(row.oid)
    ) {
      throw new CorruptError("commit tree snapshot entry is malformed");
    }
    seen.set(ordinal, entryOrdinal + 1);
    const bytes =
      SNAPSHOT_ARRAY_SLOT_BYTES +
      SNAPSHOT_ENTRY_RETAINED_BYTES +
      row.name.length * 4 +
      row.oid.length * 4;
    if (!reserveSnapshot(retained, bytes)) {
      return { available: false, directories: [] };
    }
    directories[ordinal]?.entries.push({ mode: row.mode, name: row.name, oid: row.oid });
  }
  for (const [ordinal, expected] of expectedCounts) {
    if ((seen.get(ordinal) ?? -1) !== expected) {
      throw new CorruptError("commit tree snapshot entry cardinality is inconsistent");
    }
  }
  return { available: true, directories };
}

function snapshotCommitTreeNative(
  db: SqlDatabase,
  request: CommitTreeSnapshotRequest,
): CommitTreeSnapshotResult {
  const validated = validateSnapshotRequest(request);
  if (validated === null) return { available: false };
  const retained: SnapshotRetainedBudget = {
    limit: validated.retainedLimit,
    used: validated.retainedBytes,
    peak: validated.retainedBytes,
  };
  const dirty = readSnapshotDirty(db, validated, retained);
  if (!dirty.available) return { available: false };
  if (dirty.dirty.length === 0) {
    const rootPathsBytes = SNAPSHOT_ARRAY_RETAINED_BYTES + SNAPSHOT_ARRAY_SLOT_BYTES;
    if (!reserveSnapshot(retained, rootPathsBytes)) return { available: false };
    const rootPaths = [""];
    const authenticated = resolveSnapshotDirectoryOids(db, validated.request, rootPaths, retained);
    if (!authenticated.available) return { available: false };
    return {
      available: true,
      baselineTreeOid: validated.request.baselineTreeOid,
      dirty: [],
      index: [],
      directories: [],
    };
  }
  if (dirty.dirty.length > MAX_PATHS) return { available: false };
  const selectedRequestBytes = snapshotSelectedRequestBytes(dirty.dirty, retained.limit);
  if (selectedRequestBytes === null || !reserveSnapshot(retained, selectedRequestBytes)) {
    return { available: false };
  }
  const selectedRequest: SelectedPathRequest = {
    repoId: validated.request.repoId,
    checkoutId: validated.request.checkoutId,
    root: validated.request.root,
    specs: dirty.dirty.map((entry) => ({ path: entry.path, recursive: false })),
  };
  const selectedValidated = validateSelectedPathRequest(selectedRequest);
  if (selectedValidated === null) return { available: false };
  if (!reserveSnapshot(retained, SNAPSHOT_ARRAY_RETAINED_BYTES)) {
    return { available: false };
  }
  const index = readSelectedIndex(db, selectedValidated, retained.limit - retained.used, true, () =>
    reserveSnapshot(retained, SELECTED_INDEX_RETAINED_BYTES),
  );
  if (!index.available) return { available: false };
  const paths = snapshotDirectoryPaths(dirty.dirty, retained);
  if (paths === null) return { available: false };
  const resolved = resolveSnapshotDirectoryOids(db, validated.request, paths, retained);
  if (!resolved.available) return { available: false };
  const directories = readSnapshotDirectories(
    db,
    validated.request,
    paths,
    resolved.oids,
    resolved.sources,
    retained,
  );
  if (!directories.available) return { available: false };
  return {
    available: true,
    baselineTreeOid: validated.request.baselineTreeOid,
    dirty: dirty.dirty,
    index: index.rows,
    directories: directories.directories,
  };
}

/** Use the native seam without widening the public commit-tree source interface. */
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
  return {
    snapshot: (request) => snapshotCommitTreeNative(db, request),
  };
}
