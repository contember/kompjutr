// The repository registry and the per-repository store: objects, refs,
// config and the index, all as rows.

import pako from "pako";

import { concat, toHex } from "../core/bytes.js";
import { CorruptError, GitError } from "../core/errors.js";
import { ByteLru } from "../core/lru.js";
import { hashObject, type ObjectType, objectHeader, type RawObject } from "../core/objects.js";
import { Sha1 } from "../core/sha1.js";
import { deflate, InflateStream, inflate } from "../core/zlib.js";
import { blob, readBlob, type SqlDatabase } from "./db.js";
import { type PackCacheOptions, PackStore } from "./packs.js";
import {
  indexTreeSource,
  indexTreeSources,
  initializeGitSchema,
  TREE_QUEUE_ROW_FIXED_BYTES,
} from "./schema.js";

/** Bytes per `git_object_chunks` row. */
const OBJECT_CHUNK = 1024 * 1024;

/** Deflate output chunk, and one row, for a streamed write. Smaller than
 *  OBJECT_CHUNK so a streamed object's peak is a chunk, not a megabyte. */
const STREAM_CHUNK = 64 * 1024;

/** Compressed bytes fed to the inflater at a time when streaming a read. */
const INFLATE_FEED = 16 * 1024;

/** Compressed bytes gathered into one `substr()` payload, and the trigger
 *  that flushes a batch. Well under the 2 MB ceiling on a bound value. */
const OBJECT_PAYLOAD = 1024 * 1024;

/** Objects buffered before a batch flushes. The JSON arrays are bound
 *  values too, so the row count is capped as well as the byte count. */
const DEFAULT_OBJECT_FLUSH = 4096;

/** Oids per existence-probe statement, bounding the same JSON parameter. */
const OID_PROBE_PAGE = 4096;

/** Index rows per round trip. This is the memory bound of a scan. */
const DEFAULT_INDEX_PAGE = 512;

/** Index mutations buffered before a batch is applied. */
const DEFAULT_INDEX_FLUSH = 512;

const DEFAULT_OBJECT_CACHE_BYTES = 16 * 1024 * 1024;
const TREE_WALK_STATE_BYTES = 8 * 1024 * 1024;
const TREE_WALK_PATH_BYTES = 2_200;
const TREE_WALK_QUEUE_BYTES = 16 * 1024 * 1024;

export interface StoreOptions extends PackCacheOptions {
  /** Bytes of inflated objects held hot across reads. */
  objectCacheBytes?: number;
  now?: () => number;
}

export interface RepositoryRow {
  id: number;
  root: string;
  head: string;
}

export interface RefRow {
  name: string;
  target: string;
}

export interface IndexEntry {
  path: string;
  stage: number;
  /** Full git mode, e.g. 0o100644. */
  mode: number;
  oid: string;
  /** Working-tree facts recorded when the entry was written, for status. */
  size: number | null;
  mtime: number | null;
  ino: number | null;
}

export interface IndexScanOptions {
  /** Resume strictly after this (path, stage). */
  after?: { path: string; stage: number };
  /** Only the path equal to, or under, this repo-relative prefix. */
  prefix?: string;
  /** Rows per round trip. This is the memory bound of the scan. */
  pageSize?: number;
}

export interface IndexApplyOptions {
  /** Mutations buffered before a batch is written. */
  flushEvery?: number;
}

export interface ObjectBatchOptions {
  /** Compressed bytes buffered before a flush, and the cap on one payload. */
  payloadBytes?: number;
  /** Objects buffered before a flush. */
  flushEvery?: number;
}

/**
 * A bounded sink for loose object writes. `write` hashes and deflates, so
 * the oid it returns is final, but no row exists until `flush`: a staged
 * object is invisible to `read`, `has` and `readChunks` until then.
 */
export interface ObjectBatch {
  write(type: ObjectType, data: Uint8Array): string;
  /** Write whatever is staged. Called for you when `writeObjects` returns. */
  flush(): void;
}

export interface WalkTreeEntry {
  path: string;
  mode: string;
  oid: string;
}

export const WALK_TREE_SQL = `WITH RECURSIVE
  params(repo_id, root_oid, path_cap, state_cap, queue_cap, queue_fixed)
    AS (VALUES (?, ?, ?, ?, ?, ?)),
  source_valid(repo_id, tree_oid, storage, source_id, object_size,
               entry_count, base_cost) AS NOT MATERIALIZED (
    SELECT x.repo_id, x.tree_oid, x.storage, x.source_id, s.object_size,
           s.entry_count, s.base_cost
      FROM git_tree_effective x
      CROSS JOIN params p
      CROSS JOIN git_tree_sources s
     WHERE x.repo_id = p.repo_id
       AND length(x.tree_oid) = 40 AND x.tree_oid NOT GLOB '*[^0-9a-f]*'
       AND s.repo_id = x.repo_id AND s.tree_oid = x.tree_oid
       AND s.storage = x.storage AND s.source_id = x.source_id
       AND s.entry_count >= 0 AND s.object_size >= 0
       AND s.base_cost = s.object_size + (p.queue_fixed + 18) * s.entry_count
       AND (
         (x.storage = 'loose' AND x.source_id = 0 AND EXISTS (
           SELECT 1 FROM git_objects o
            WHERE o.repo_id = x.repo_id AND o.oid = x.tree_oid
              AND o.type = 'tree' AND o.size = s.object_size
         ))
         OR
         (x.storage = 'pack' AND EXISTS (
           SELECT 1
             FROM git_pack_objects o
             JOIN git_pack_meta m
               ON m.repo_id = o.repo_id AND m.pack_id = o.pack_id
              AND m.state = 'complete'
            WHERE o.repo_id = x.repo_id AND o.oid = x.tree_oid
              AND o.pack_id = x.source_id AND o.type = 'tree'
              AND o.size = s.object_size
         ))
       )
       AND NOT EXISTS (
         SELECT 1 FROM git_tree_entries e
          WHERE e.repo_id = s.repo_id AND e.tree_oid = s.tree_oid
            AND e.storage = s.storage AND e.source_id = s.source_id
            AND e.ordinal IN (-1, s.entry_count)
       )
       AND (
         (s.entry_count = 0 AND s.base_cost = 0)
         OR EXISTS (
           SELECT 1 FROM git_tree_entries e
            WHERE e.repo_id = s.repo_id AND e.tree_oid = s.tree_oid
              AND e.storage = s.storage AND e.source_id = s.source_id
              AND e.ordinal = s.entry_count - 1
              AND e.cumulative_base = s.base_cost
         )
       )
  ),
  walk(path, mode, oid, ancestry, sort_key, error, error_code,
       path_bytes, state_bytes, descend, reserved_bytes) AS (
    SELECT CASE
             WHEN length(e.name_bytes) <= p.path_cap
               AND length(CAST(e.name AS BLOB)) <= p.path_cap THEN e.name
             ELSE NULL
           END,
           CASE WHEN length(e.mode) <= 6 THEN e.mode ELSE NULL END,
           CASE WHEN length(e.oid) <= 40 THEN e.oid ELSE NULL END,
           '/' || p.root_oid || '/', printf('%08x', e.ordinal),
           CASE
             WHEN e.ordinal < 0 OR e.ordinal >= s.entry_count
               THEN 'tree entries do not match the parsed source marker'
             WHEN e.ordinal > 0 AND NOT EXISTS (
               SELECT 1 FROM git_tree_entries previous
                WHERE previous.repo_id = e.repo_id AND previous.tree_oid = e.tree_oid
                  AND previous.storage = e.storage AND previous.source_id = e.source_id
                  AND previous.ordinal = e.ordinal - 1
             ) THEN 'tree entries contain an ordinal gap'
             WHEN e.cumulative_base != p.queue_fixed + length(e.name_bytes)
                    + length(CAST(e.mode AS BLOB)) + length(CAST(e.oid AS BLOB))
                    + COALESCE((
                        SELECT previous.cumulative_base FROM git_tree_entries previous
                         WHERE previous.repo_id = e.repo_id
                           AND previous.tree_oid = e.tree_oid
                           AND previous.storage = e.storage
                           AND previous.source_id = e.source_id
                           AND previous.ordinal = e.ordinal - 1
                      ), 0)
               THEN 'tree queue metadata is inconsistent'
             WHEN length(e.name_bytes) > p.path_cap
               OR length(CAST(e.name AS BLOB)) > p.path_cap
               THEN 'tree path exceeds 2200 bytes'
             WHEN length(e.raw_entry) > p.path_cap + 64
               THEN 'tree entry integrity payload is too large'
             WHEN e.mode NOT IN ('40000', '040000', '100644', '100755', '120000', '160000')
               THEN 'tree entry has an invalid mode'
             WHEN length(e.name_bytes) = 0 OR instr(CAST(e.name_bytes AS TEXT), '/') != 0
               OR CAST(e.name_bytes AS TEXT) != e.name
               THEN 'tree entry has an invalid name'
             WHEN length(e.oid) != 40 OR e.oid GLOB '*[^0-9a-f]*'
               THEN 'tree entry has an invalid oid'
             WHEN length(e.raw_entry) != length(CAST(e.mode AS BLOB)) + length(e.name_bytes) + 22
               OR CAST(substr(e.raw_entry, 1, length(CAST(e.mode AS BLOB))) AS BLOB)
                    != CAST(e.mode AS BLOB)
               OR hex(substr(e.raw_entry, length(CAST(e.mode AS BLOB)) + 1, 1)) != '20'
               OR CAST(substr(
                    e.raw_entry, length(CAST(e.mode AS BLOB)) + 2, length(e.name_bytes)
                  ) AS BLOB) != e.name_bytes
               OR hex(substr(
                    e.raw_entry, length(CAST(e.mode AS BLOB)) + length(e.name_bytes) + 2, 1
                  )) != '00'
               OR lower(hex(substr(e.raw_entry, -20))) != e.oid
               THEN 'tree entry integrity check failed'
             WHEN length(e.name_bytes) + 41 + 8 > p.state_cap
               THEN 'tree traversal state exceeds 8 MiB'
             ELSE NULL
           END,
           CASE WHEN length(e.name_bytes) > p.path_cap
                  OR length(CAST(e.name AS BLOB)) > p.path_cap
                THEN 'E2BIG' ELSE 'ECORRUPT' END,
           length(e.name_bytes), length(e.name_bytes) + 41 + 8,
           CASE WHEN e.mode IN ('40000', '040000')
                  AND length(e.oid) = 40 AND e.oid NOT GLOB '*[^0-9a-f]*'
                  AND EXISTS (
                    SELECT 1 FROM source_valid child
                     WHERE child.repo_id = p.repo_id AND child.tree_oid = e.oid
                  )
             THEN CASE WHEN EXISTS (
               SELECT 1 FROM source_valid child
                WHERE child.repo_id = p.repo_id AND child.tree_oid = e.oid
                  AND s.base_cost - e.cumulative_base
                        + (s.entry_count - e.ordinal - 1) * 50
                        + child.base_cost
                        + child.entry_count * (length(e.name_bytes) + 49 + 51)
                      > p.queue_cap
             ) THEN 2 ELSE 1 END
             ELSE 0
           END,
           s.base_cost - e.cumulative_base
             + (s.entry_count - e.ordinal - 1) * 50
      FROM params p
      CROSS JOIN source_valid s
      CROSS JOIN git_tree_entries e
     WHERE s.repo_id = p.repo_id AND s.tree_oid = p.root_oid
       AND s.base_cost + s.entry_count * 50 <= p.queue_cap
       AND e.repo_id = s.repo_id AND e.tree_oid = s.tree_oid
       AND e.storage = s.storage AND e.source_id = s.source_id
    UNION ALL
    SELECT NULL, NULL, NULL, '/', '',
           'tree traversal queue exceeds 16 MiB', 'E2BIG', 0, 0, 0, 0
      FROM params p CROSS JOIN source_valid s
     WHERE s.repo_id = p.repo_id AND s.tree_oid = p.root_oid
       AND s.base_cost + s.entry_count * 50 > p.queue_cap
    UNION ALL
    SELECT NULL, NULL, NULL, '/', '',
           CASE WHEN length(p.root_oid) = 40 AND p.root_oid NOT GLOB '*[^0-9a-f]*'
                THEN 'tree source is invalid; reimport or reclone'
                ELSE 'tree oid is invalid'
           END,
           'ECORRUPT', 0, 0, 0, 0
      FROM params p
     WHERE NOT EXISTS (
       SELECT 1 FROM source_valid s
        WHERE s.repo_id = p.repo_id AND s.tree_oid = p.root_oid
     )
    UNION ALL
    SELECT CASE
             WHEN w.path_bytes + 1 + length(e.name_bytes) <= p.path_cap
               AND length(CAST(w.path AS BLOB)) + 1 + length(CAST(e.name AS BLOB))
                     <= p.path_cap
               THEN w.path || '/' || e.name
             ELSE NULL
           END,
           CASE WHEN length(e.mode) <= 6 THEN e.mode ELSE NULL END,
           CASE WHEN length(e.oid) <= 40 THEN e.oid ELSE NULL END,
           w.ancestry || w.oid || '/', w.sort_key || printf('%08x', e.ordinal),
           CASE
             WHEN e.ordinal < 0 OR e.ordinal >= s.entry_count
               THEN 'tree entries do not match the parsed source marker'
             WHEN e.ordinal > 0 AND NOT EXISTS (
               SELECT 1 FROM git_tree_entries previous
                WHERE previous.repo_id = e.repo_id AND previous.tree_oid = e.tree_oid
                  AND previous.storage = e.storage AND previous.source_id = e.source_id
                  AND previous.ordinal = e.ordinal - 1
             ) THEN 'tree entries contain an ordinal gap'
             WHEN e.cumulative_base != p.queue_fixed + length(e.name_bytes)
                    + length(CAST(e.mode AS BLOB)) + length(CAST(e.oid AS BLOB))
                    + COALESCE((
                        SELECT previous.cumulative_base FROM git_tree_entries previous
                         WHERE previous.repo_id = e.repo_id
                           AND previous.tree_oid = e.tree_oid
                           AND previous.storage = e.storage
                           AND previous.source_id = e.source_id
                           AND previous.ordinal = e.ordinal - 1
                      ), 0)
               THEN 'tree queue metadata is inconsistent'
             WHEN length(e.name_bytes) > p.path_cap
               OR length(CAST(e.name AS BLOB)) > p.path_cap
               THEN 'tree entry name exceeds the path limit'
             WHEN length(e.raw_entry) > p.path_cap + 64
               THEN 'tree entry integrity payload is too large'
             WHEN e.mode NOT IN ('40000', '040000', '100644', '100755', '120000', '160000')
               THEN 'tree entry has an invalid mode'
             WHEN length(e.name_bytes) = 0 OR instr(CAST(e.name_bytes AS TEXT), '/') != 0
               OR CAST(e.name_bytes AS TEXT) != e.name
               THEN 'tree entry has an invalid name'
             WHEN length(e.oid) != 40 OR e.oid GLOB '*[^0-9a-f]*'
               THEN 'tree entry has an invalid oid'
             WHEN length(e.raw_entry) != length(CAST(e.mode AS BLOB)) + length(e.name_bytes) + 22
               OR CAST(substr(e.raw_entry, 1, length(CAST(e.mode AS BLOB))) AS BLOB)
                    != CAST(e.mode AS BLOB)
               OR hex(substr(e.raw_entry, length(CAST(e.mode AS BLOB)) + 1, 1)) != '20'
               OR CAST(substr(
                    e.raw_entry, length(CAST(e.mode AS BLOB)) + 2, length(e.name_bytes)
                  ) AS BLOB) != e.name_bytes
               OR hex(substr(
                    e.raw_entry, length(CAST(e.mode AS BLOB)) + length(e.name_bytes) + 2, 1
                  )) != '00'
               OR lower(hex(substr(e.raw_entry, -20))) != e.oid
               THEN 'tree entry integrity check failed'
             WHEN w.path_bytes + 1 + length(e.name_bytes) > p.path_cap
               THEN 'tree path exceeds 2200 bytes'
             WHEN w.state_bytes + 1 + length(e.name_bytes) + 41 + 8 > p.state_cap
               THEN 'tree traversal state exceeds 8 MiB'
             ELSE NULL
           END,
           CASE WHEN w.path_bytes + 1 + length(e.name_bytes) > p.path_cap
                  OR length(CAST(w.path AS BLOB)) + 1 + length(CAST(e.name AS BLOB))
                       > p.path_cap
                THEN 'E2BIG' ELSE 'ECORRUPT' END,
           w.path_bytes + 1 + length(e.name_bytes),
           w.state_bytes + 1 + length(e.name_bytes) + 41 + 8,
           CASE WHEN e.mode IN ('40000', '040000')
                  AND length(e.oid) = 40 AND e.oid NOT GLOB '*[^0-9a-f]*'
                  AND EXISTS (
                    SELECT 1 FROM source_valid child
                     WHERE child.repo_id = p.repo_id AND child.tree_oid = e.oid
                  )
             THEN CASE WHEN EXISTS (
               SELECT 1 FROM source_valid child
                WHERE child.repo_id = p.repo_id AND child.tree_oid = e.oid
                  AND w.reserved_bytes + s.base_cost - e.cumulative_base
                        + (s.entry_count - e.ordinal - 1) * (w.state_bytes + 51)
                        + child.base_cost
                        + child.entry_count
                          * (w.state_bytes + 1 + length(e.name_bytes) + 49 + 51)
                      > p.queue_cap
             ) THEN 2 ELSE 1 END
             ELSE 0
           END,
           w.reserved_bytes + s.base_cost - e.cumulative_base
             + (s.entry_count - e.ordinal - 1) * (w.state_bytes + 51)
      FROM walk w
      CROSS JOIN params p
      CROSS JOIN source_valid s
      CROSS JOIN git_tree_entries e
     WHERE w.error IS NULL AND w.descend = 1
       AND instr(w.ancestry, '/' || w.oid || '/') = 0
       AND s.repo_id = p.repo_id AND s.tree_oid = w.oid
       AND e.repo_id = s.repo_id AND e.tree_oid = s.tree_oid
       AND e.storage = s.storage AND e.source_id = s.source_id
     ORDER BY 5
  )
SELECT path, mode, oid,
       CASE
         WHEN error IS NOT NULL THEN error
         WHEN mode IN ('40000', '040000') AND instr(ancestry, '/' || oid || '/') != 0
           THEN 'tree cycle at ' || oid
         WHEN mode IN ('40000', '040000') AND descend = 2
           THEN 'tree traversal queue exceeds 16 MiB'
         WHEN mode IN ('40000', '040000') AND descend = 0
           THEN 'tree ' || oid || ' has no valid v3 parsed source; reimport or reclone'
         ELSE NULL
       END AS error,
       CASE WHEN error_code = 'E2BIG' OR descend = 2 THEN 'E2BIG'
            ELSE 'ECORRUPT' END AS error_code
  FROM walk
 WHERE error IS NOT NULL
    OR mode NOT IN ('40000', '040000')
    OR instr(ancestry, '/' || oid || '/') != 0
    OR (mode IN ('40000', '040000') AND descend != 1)`;

/** One object staged in a batch, already hashed and deflated. */
interface StagedObject {
  oid: string;
  type: ObjectType;
  size: number;
  compressed: Uint8Array;
  treeData?: Uint8Array;
}

/** One `substr()` payload: the bytes, and the rows cut out of them. */
interface ChunkPayload {
  parts: Uint8Array[];
  length: number;
  rows: { o: string; q: number; a: number; n: number }[];
}

/** A bounded, ordered mutation sink over the index. */
export interface IndexSink {
  put(entry: IndexEntry): void;
  remove(path: string): void;
  /** Apply whatever is buffered. Called for you when `indexApply` returns. */
  flush(): void;
}

/** Normalise an absolute workspace path: no trailing slash, always leading. */
export function normalizeRoot(path: string): string {
  const trimmed = path.replace(/\/+$/, "");
  if (trimmed === "") return "/";
  return trimmed.startsWith("/") ? trimmed : `/${trimmed}`;
}

/** Every ancestor of `path`, nearest first, ending at "/". */
export function ancestors(path: string): string[] {
  const normalized = normalizeRoot(path);
  const out: string[] = [];
  let current = normalized;
  while (current !== "/") {
    out.push(current);
    const slash = current.lastIndexOf("/");
    current = slash <= 0 ? "/" : current.slice(0, slash);
  }
  out.push("/");
  return out;
}

/**
 * Owns the schema and the repository registry. One instance per
 * workspace database; `open()` hands out per-repository stores, cached so
 * their object and chunk caches survive across calls.
 */
export class SqliteGitDatabase {
  readonly #db: SqlDatabase;
  readonly #options: StoreOptions;
  readonly #stores = new Map<number, RepoStore>();

  constructor(db: SqlDatabase, options: StoreOptions = {}) {
    this.#db = db;
    this.#options = options;
    initializeGitSchema(db);
  }

  get db(): SqlDatabase {
    return this.#db;
  }

  /** The repository whose root is the nearest registered ancestor of `dir`. */
  find(dir: string): RepositoryRow | null {
    for (const candidate of ancestors(dir)) {
      const row = this.#db.one<RepositoryRow>(
        "SELECT id, root, head FROM git_repositories WHERE root = ?",
        candidate,
      );
      if (row !== undefined) return row;
    }
    return null;
  }

  at(root: string): RepositoryRow | null {
    return (
      this.#db.one<RepositoryRow>(
        "SELECT id, root, head FROM git_repositories WHERE root = ?",
        normalizeRoot(root),
      ) ?? null
    );
  }

  list(): RepositoryRow[] {
    return this.#db.all<RepositoryRow>("SELECT id, root, head FROM git_repositories ORDER BY root");
  }

  create(root: string, head: string): RepositoryRow {
    const normalized = normalizeRoot(root);
    return this.#db.transactionSync(() => {
      const nextId =
        (this.#db.scalar<number | null>("SELECT MAX(id) FROM git_repositories") ?? 0) + 1;
      this.#db.run(
        "INSERT INTO git_repositories (id, root, head) VALUES (?, ?, ?)",
        nextId,
        normalized,
        head,
      );
      return { id: nextId, root: normalized, head };
    });
  }

  open(repository: RepositoryRow): RepoStore {
    const existing = this.#stores.get(repository.id);
    if (existing !== undefined) return existing;
    // Destroying a repository evicts its store, so a reused id can never
    // hand back the previous repository's caches.
    const store = new RepoStore(this.#db, repository, this.#options, () =>
      this.#stores.delete(repository.id),
    );
    this.#stores.set(repository.id, store);
    return store;
  }
}

/** Objects, refs, config and index for one repository. */
export class RepoStore {
  readonly #db: SqlDatabase;
  readonly #repoId: number;
  readonly #root: string;
  readonly #objects: ByteLru<string, RawObject>;
  readonly #packs: PackStore;
  #hasLoose: boolean;
  readonly #onDestroy: (() => void) | undefined;

  constructor(
    db: SqlDatabase,
    repository: RepositoryRow,
    options: StoreOptions = {},
    onDestroy?: () => void,
  ) {
    this.#onDestroy = onDestroy;
    this.#db = db;
    this.#repoId = repository.id;
    this.#root = repository.root;
    this.#objects = new ByteLru(
      Math.min(options.objectCacheBytes ?? DEFAULT_OBJECT_CACHE_BYTES, DEFAULT_OBJECT_CACHE_BYTES),
      (object) => object.data.length,
    );
    this.#packs = new PackStore(
      db,
      repository.id,
      this.#objects,
      (oid) => this.#readLoose(oid),
      options,
    );
    this.#hasLoose =
      (this.#db.scalar<number>(
        "SELECT COUNT(*) FROM (SELECT 1 FROM git_objects WHERE repo_id = ? LIMIT 1)",
        this.#repoId,
      ) ?? 0) > 0;
  }

  get db(): SqlDatabase {
    return this.#db;
  }

  get repoId(): number {
    return this.#repoId;
  }

  get root(): string {
    return this.#root;
  }

  get packs(): PackStore {
    return this.#packs;
  }

  /** Bytes currently held by the two bounded caches. */
  cacheBytes(): { objects: number; chunks: number } {
    return { objects: this.#objects.bytes, chunks: this.#packs.cachedChunkBytes };
  }

  // -- objects --------------------------------------------------------

  has(oid: string): boolean {
    if (this.#hasLoose && this.#looseRow(oid) !== null) return true;
    return this.#packs.typeAndSize(oid) !== null;
  }

  /**
   * Which of `oids` this repository already holds, in one statement per
   * page. Both tables, deliberately: an `ON CONFLICT` on `git_objects`
   * alone cannot see a packed object, so after a clone an unchanged tree
   * would be re-written loose and shadow the packed copy.
   */
  hasAll(oids: Iterable<string>): Set<string> {
    const found = new Set<string>();
    let page: string[] = [];
    const probe = (): void => {
      if (page.length === 0) return;
      for (const row of this.#db.all<{ oid: string }>(
        `SELECT j.value AS oid FROM json_each(?) j
          WHERE EXISTS (SELECT 1 FROM git_objects o WHERE o.repo_id = ? AND o.oid = j.value)
             OR EXISTS (SELECT 1 FROM git_pack_objects p WHERE p.repo_id = ? AND p.oid = j.value)`,
        JSON.stringify(page),
        this.#repoId,
        this.#repoId,
      )) {
        found.add(row.oid);
      }
      page = [];
    };
    for (const oid of oids) {
      page.push(oid);
      if (page.length >= OID_PROBE_PAGE) probe();
    }
    probe();
    return found;
  }

  /** The oids this repository does not hold, in input order, deduplicated. */
  missing(oids: Iterable<string>): string[] {
    const wanted = [...new Set(oids)];
    const present = this.hasAll(wanted);
    return wanted.filter((oid) => !present.has(oid));
  }

  typeAndSize(oid: string): { type: ObjectType; size: number } | null {
    if (this.#hasLoose) {
      const row = this.#looseRow(oid);
      if (row !== null) return row;
    }
    return this.#packs.typeAndSize(oid);
  }

  read(oid: string): RawObject | null {
    const cached = this.#objects.get(`loose:${oid}`);
    if (cached !== undefined) return cached;
    return this.#readLoose(oid) ?? this.#packs.read(oid);
  }

  /** Stream every non-tree entry in raw Git DFS order with one SQL statement. */
  *walkTree(treeOid: string): Generator<WalkTreeEntry> {
    for (const row of this.#db.iterate(
      WALK_TREE_SQL,
      this.#repoId,
      treeOid,
      TREE_WALK_PATH_BYTES,
      TREE_WALK_STATE_BYTES,
      TREE_WALK_QUEUE_BYTES,
      TREE_QUEUE_ROW_FIXED_BYTES,
    )) {
      const error = row.error;
      if (typeof error === "string") {
        if (row.error_code === "E2BIG") throw new GitError("E2BIG", error);
        throw new CorruptError(error);
      }
      const path = row.path;
      const mode = row.mode;
      const oid = row.oid;
      if (typeof path !== "string" || typeof mode !== "string" || typeof oid !== "string") {
        throw new CorruptError("tree traversal yielded an invalid row");
      }
      yield { path, mode, oid };
    }
  }

  write(type: ObjectType, data: Uint8Array): string {
    const oid = hashObject(type, data);
    if (this.has(oid)) return oid;
    const compressed = deflate(data);
    this.#db.transactionSync(() => {
      this.#db.run(
        "INSERT OR REPLACE INTO git_objects (repo_id, oid, type, size) VALUES (?, ?, ?, ?)",
        this.#repoId,
        oid,
        type,
        data.length,
      );
      this.#db.run(
        "DELETE FROM git_object_chunks WHERE repo_id = ? AND oid = ?",
        this.#repoId,
        oid,
      );
      for (
        let seq = 0, offset = 0;
        offset < compressed.length || seq === 0;
        seq++, offset += OBJECT_CHUNK
      ) {
        this.#db.run(
          "INSERT INTO git_object_chunks (repo_id, oid, seq, data) VALUES (?, ?, ?, ?)",
          this.#repoId,
          oid,
          seq,
          blob(compressed.subarray(offset, offset + OBJECT_CHUNK)),
        );
      }
      if (type === "tree") {
        indexTreeSource(
          this.#db,
          {
            repoId: this.#repoId,
            treeOid: oid,
            storage: "loose",
            sourceId: 0,
            objectSize: data.length,
          },
          [data],
        );
      }
    });
    this.#hasLoose = true;
    this.#objects.set(`loose:${oid}`, { type, data });
    return oid;
  }

  /**
   * Write a loose object from a stream of chunks. `chunks` is a factory
   * because the content is read twice: once to hash it, which is how the oid
   * is known and how `has` can short-circuit before a single row is written,
   * and once to deflate and store it. Nothing larger than one chunk is ever
   * live, so the peak does not follow the object's size.
   */
  writeStream(type: ObjectType, size: number, chunks: () => Iterable<Uint8Array>): string {
    const hash = new Sha1().update(objectHeader(type, size));
    let hashed = 0;
    for (const chunk of chunks()) {
      hashed += chunk.length;
      hash.update(chunk);
    }
    if (hashed !== size) {
      throw new CorruptError(`streamed ${hashed} bytes for a ${type} declared as ${size}`);
    }
    const oid = toHex(hash.digest());
    if (this.has(oid)) return oid;

    const rows: Uint8Array[] = [];
    const deflate = new pako.Deflate({ chunkSize: STREAM_CHUNK });
    deflate.onData = (chunk) => {
      if (!(chunk instanceof Uint8Array))
        throw new CorruptError("deflate produced a non-binary chunk");
      rows.push(chunk);
    };

    this.#db.transactionSync(() => {
      this.#db.run(
        "INSERT OR REPLACE INTO git_objects (repo_id, oid, type, size) VALUES (?, ?, ?, ?)",
        this.#repoId,
        oid,
        type,
        size,
      );
      this.#db.run(
        "DELETE FROM git_object_chunks WHERE repo_id = ? AND oid = ?",
        this.#repoId,
        oid,
      );
      let seq = 0;
      const drain = (): void => {
        for (const row of rows) {
          this.#db.run(
            "INSERT INTO git_object_chunks (repo_id, oid, seq, data) VALUES (?, ?, ?, ?)",
            this.#repoId,
            oid,
            seq++,
            blob(row),
          );
        }
        rows.length = 0;
      };
      for (const chunk of chunks()) {
        deflate.push(chunk, false);
        if (deflate.err !== 0) throw new CorruptError(`deflate failed: ${deflate.msg}`);
        drain();
      }
      deflate.push(new Uint8Array(0), true);
      if (deflate.err !== 0) throw new CorruptError(`deflate failed: ${deflate.msg}`);
      drain();
      // An empty object still deserves one row, matching `write`.
      if (seq === 0) {
        this.#db.run(
          "INSERT INTO git_object_chunks (repo_id, oid, seq, data) VALUES (?, ?, ?, ?)",
          this.#repoId,
          oid,
          0,
          blob(new Uint8Array(0)),
        );
      }
      if (type === "tree") {
        indexTreeSource(
          this.#db,
          {
            repoId: this.#repoId,
            treeOid: oid,
            storage: "loose",
            sourceId: 0,
            objectSize: size,
          },
          chunks(),
        );
      }
    });
    this.#hasLoose = true;
    return oid;
  }

  /**
   * Open a batch of loose object writes. However many objects go in, a
   * flush costs one existence probe, one delete, one insert per payload
   * budget and one metadata insert — not five statements per object.
   *
   * The caller owns the lifecycle; `writeObjects` is the scoped form that
   * cannot forget the final flush.
   */
  writeBatch(options: ObjectBatchOptions = {}): ObjectBatch {
    const payloadBytes = options.payloadBytes ?? OBJECT_PAYLOAD;
    const flushEvery = options.flushEvery ?? DEFAULT_OBJECT_FLUSH;
    // Keyed by oid: a tree build re-emits identical subtrees, and one
    // (oid, seq) may appear at most once in a payload.
    const staged = new Map<string, StagedObject>();
    let bytes = 0;
    const flush = (): void => {
      if (staged.size === 0) return;
      this.#flushObjects([...staged.values()], payloadBytes);
      staged.clear();
      bytes = 0;
    };
    return {
      write: (type: ObjectType, data: Uint8Array): string => {
        const oid = hashObject(type, data);
        if (staged.has(oid)) return oid;
        const compressed = deflate(data);
        const object: StagedObject = { oid, type, size: data.length, compressed };
        if (type === "tree") object.treeData = data;
        staged.set(oid, object);
        bytes += compressed.length;
        // After staging, never before: an object's chunks and its metadata
        // row have to land in the same flush, whatever its size.
        if (bytes >= payloadBytes || staged.size >= flushEvery) flush();
        return oid;
      },
      flush,
    };
  }

  /** Run `body` with a batch, flushing what it staged when it returns. */
  writeObjects<T>(body: (batch: ObjectBatch) => T, options: ObjectBatchOptions = {}): T {
    const batch = this.writeBatch(options);
    const result = body(batch);
    batch.flush();
    return result;
  }

  #flushObjects(staged: StagedObject[], payloadBytes: number): void {
    const byOid = new Map(staged.map((object) => [object.oid, object]));
    const meta = JSON.stringify(
      staged.map((object) => ({ o: object.oid, t: object.type, s: object.size })),
    );
    this.#db.transactionSync(() => {
      const fresh: StagedObject[] = [];
      for (const row of this.#db.iterate(
        `INSERT INTO git_objects (repo_id, oid, type, size, stored)
         SELECT ?, json_extract(j.value, '$.o'), json_extract(j.value, '$.t'),
                json_extract(j.value, '$.s'), 'zlib'
           FROM json_each(?) j
          WHERE true
         ON CONFLICT(repo_id, oid) DO NOTHING
         RETURNING oid`,
        this.#repoId,
        meta,
      )) {
        if (typeof row.oid !== "string") {
          throw new CorruptError("object metadata insert returned an invalid oid");
        }
        const object = byOid.get(row.oid);
        if (object === undefined) {
          throw new CorruptError("object metadata insert returned an unknown oid");
        }
        fresh.push(object);
      }
      if (fresh.length === 0) return;

      const payloads: ChunkPayload[] = [{ parts: [], length: 0, rows: [] }];
      for (const object of fresh) {
        const compressed = object.compressed;
        for (
          let seq = 0, offset = 0;
          offset < compressed.length || seq === 0;
          seq++, offset += OBJECT_CHUNK
        ) {
          const part = compressed.subarray(offset, offset + OBJECT_CHUNK);
          let current = payloads[payloads.length - 1]!;
          if (current.length > 0 && current.length + part.length > payloadBytes) {
            current = { parts: [], length: 0, rows: [] };
            payloads.push(current);
          }
          // `a` is a 1-based byte offset: substr() counts bytes over a BLOB.
          current.rows.push({ o: object.oid, q: seq, a: current.length + 1, n: part.length });
          current.parts.push(part);
          current.length += part.length;
        }
      }

      const oids = JSON.stringify(fresh.map((object) => object.oid));
      // The transaction keeps metadata invisible until all chunks and parsed
      // tree rows are ready, while RETURNING replaces a separate probe.
      this.#db.run(
        "DELETE FROM git_object_chunks WHERE repo_id = ? AND oid IN (SELECT value FROM json_each(?))",
        this.#repoId,
        oids,
      );
      for (const payload of payloads) {
        this.#db.run(
          `INSERT INTO git_object_chunks (repo_id, oid, seq, data)
           SELECT ?, json_extract(j.value, '$.o'), json_extract(j.value, '$.q'),
                  substr(?, json_extract(j.value, '$.a'), json_extract(j.value, '$.n'))
             FROM json_each(?) j
            WHERE true
           ON CONFLICT(repo_id, oid, seq) DO UPDATE SET data = excluded.data`,
          this.#repoId,
          blob(concat(payload.parts)),
          JSON.stringify(payload.rows),
        );
      }
      indexTreeSources(
        this.#db,
        fresh.flatMap((object) => {
          if (object.type !== "tree" || object.treeData === undefined) return [];
          return [
            {
              repoId: this.#repoId,
              treeOid: object.oid,
              storage: "loose",
              sourceId: 0,
              objectSize: object.size,
              chunks: [object.treeData],
            },
          ];
        }),
      );
    });
    this.#hasLoose = true;
  }

  /**
   * Inflated object bytes, chunk by chunk. A loose object really streams: its
   * rows are read one at a time and inflated incrementally. A packed object
   * yields exactly one chunk holding the whole thing, because a delta cannot
   * be reconstructed without its full base in memory. Null when unknown.
   */
  readChunks(oid: string): Iterable<Uint8Array> | null {
    const cached = this.#objects.get(`loose:${oid}`);
    if (cached !== undefined) return [cached.data];
    if (this.#hasLoose && this.#looseRow(oid) !== null) return this.#looseChunks(oid);
    const packed = this.#packs.read(oid);
    return packed === null ? null : [packed.data];
  }

  *#looseChunks(oid: string): Generator<Uint8Array> {
    const ready: Uint8Array[] = [];
    const stream = new InflateStream((chunk) => ready.push(chunk));
    for (let seq = 0; ; seq++) {
      const row = this.#db.one<{ data: unknown }>(
        "SELECT data FROM git_object_chunks WHERE repo_id = ? AND oid = ? AND seq = ?",
        this.#repoId,
        oid,
        seq,
      );
      if (row === undefined) break;
      const compressed = readBlob(row.data);
      for (let offset = 0; offset < compressed.length; offset += INFLATE_FEED) {
        stream.push(compressed.subarray(offset, offset + INFLATE_FEED));
        for (const chunk of ready) yield chunk;
        ready.length = 0;
      }
      if (compressed.length === 0) {
        for (const chunk of ready) yield chunk;
        ready.length = 0;
      }
    }
    for (const chunk of ready) yield chunk;
  }

  /** Resolve an abbreviated oid. Null when unknown or ambiguous. */
  resolvePrefix(prefix: string): string | null {
    if (prefix.length === 40) return this.has(prefix) ? prefix : null;
    const found = new Set<string>();
    if (this.#hasLoose) {
      const upper = nextPrefix(prefix);
      for (const row of this.#db.all<{ oid: string }>(
        "SELECT oid FROM git_objects WHERE repo_id = ? AND oid >= ? AND oid < ? LIMIT 2",
        this.#repoId,
        prefix,
        upper,
      )) {
        found.add(row.oid);
      }
    }
    for (const oid of this.#packs.findPrefix(prefix, 2)) found.add(oid);
    return found.size === 1 ? [...found][0]! : null;
  }

  objectCount(): number {
    const loose =
      this.#db.scalar<number>("SELECT COUNT(*) FROM git_objects WHERE repo_id = ?", this.#repoId) ??
      0;
    return loose + this.#packs.count();
  }

  #looseRow(oid: string): { type: ObjectType; size: number } | null {
    return (
      this.#db.one<{ type: ObjectType; size: number }>(
        "SELECT type, size FROM git_objects WHERE repo_id = ? AND oid = ?",
        this.#repoId,
        oid,
      ) ?? null
    );
  }

  #readLoose(oid: string): RawObject | null {
    if (!this.#hasLoose) return null;
    const row = this.#looseRow(oid);
    if (row === null) return null;
    const chunks = this.#db.all<{ data: unknown }>(
      "SELECT data FROM git_object_chunks WHERE repo_id = ? AND oid = ? ORDER BY seq",
      this.#repoId,
      oid,
    );
    const object: RawObject = {
      type: row.type,
      data: inflate(concat(chunks.map((chunk) => readBlob(chunk.data)))),
    };
    this.#objects.set(`loose:${oid}`, object);
    return object;
  }

  // -- refs -----------------------------------------------------------

  /** Raw ref value: an oid, or "ref: <name>" for a symbolic ref. */
  getRef(name: string): string | null {
    if (name === "HEAD") return this.head();
    return (
      this.#db.scalar<string>(
        "SELECT target FROM git_refs WHERE repo_id = ? AND name = ?",
        this.#repoId,
        name,
      ) ?? null
    );
  }

  setRef(name: string, target: string): void {
    if (name === "HEAD") {
      this.setHead(target);
      return;
    }
    this.#db.run(
      "INSERT INTO git_refs (repo_id, name, target) VALUES (?, ?, ?) ON CONFLICT(repo_id, name) DO UPDATE SET target = excluded.target",
      this.#repoId,
      name,
      target,
    );
  }

  deleteRef(name: string): void {
    this.#db.run("DELETE FROM git_refs WHERE repo_id = ? AND name = ?", this.#repoId, name);
  }

  listRefs(prefix = ""): RefRow[] {
    if (prefix === "") {
      return this.#db.all<RefRow>(
        "SELECT name, target FROM git_refs WHERE repo_id = ? ORDER BY name",
        this.#repoId,
      );
    }
    return this.#db.all<RefRow>(
      "SELECT name, target FROM git_refs WHERE repo_id = ? AND name >= ? AND name < ? ORDER BY name",
      this.#repoId,
      prefix,
      nextPrefix(prefix),
    );
  }

  head(): string {
    return (
      this.#db.scalar<string>("SELECT head FROM git_repositories WHERE id = ?", this.#repoId) ??
      "ref: refs/heads/main"
    );
  }

  setHead(value: string): void {
    this.#db.run("UPDATE git_repositories SET head = ? WHERE id = ?", value, this.#repoId);
  }

  // -- config ---------------------------------------------------------

  configGetAll(path: string): string[] {
    return this.#db
      .all<{ value: string }>(
        "SELECT value FROM git_config WHERE repo_id = ? AND path = ? ORDER BY seq",
        this.#repoId,
        path,
      )
      .map((row) => row.value);
  }

  configGet(path: string): string | undefined {
    // git's `--get` reports the last value for a multi-valued key.
    const values = this.configGetAll(path);
    return values.length === 0 ? undefined : values[values.length - 1];
  }

  configSet(path: string, value: string): void {
    this.#db.transactionSync(() => {
      this.#db.run("DELETE FROM git_config WHERE repo_id = ? AND path = ?", this.#repoId, path);
      this.#db.run(
        "INSERT INTO git_config (repo_id, path, seq, value) VALUES (?, ?, 0, ?)",
        this.#repoId,
        path,
        value,
      );
    });
  }

  configAdd(path: string, value: string): void {
    this.#db.transactionSync(() => {
      const seq =
        (this.#db.scalar<number | null>(
          "SELECT MAX(seq) FROM git_config WHERE repo_id = ? AND path = ?",
          this.#repoId,
          path,
        ) ?? -1) + 1;
      this.#db.run(
        "INSERT INTO git_config (repo_id, path, seq, value) VALUES (?, ?, ?, ?)",
        this.#repoId,
        path,
        seq,
        value,
      );
    });
  }

  configUnset(path: string): void {
    this.#db.run("DELETE FROM git_config WHERE repo_id = ? AND path = ?", this.#repoId, path);
  }

  /** Distinct config paths under a dotted prefix, e.g. "remote.". */
  configPaths(prefix: string): string[] {
    return this.#db
      .all<{ path: string }>(
        "SELECT DISTINCT path FROM git_config WHERE repo_id = ? AND path >= ? AND path < ? ORDER BY path",
        this.#repoId,
        prefix,
        nextPrefix(prefix),
      )
      .map((row) => row.path);
  }

  // -- index ----------------------------------------------------------

  indexEntries(): IndexEntry[] {
    return this.#db.all<IndexEntry>(
      "SELECT path, stage, mode, oid, size, mtime, ino FROM git_index WHERE repo_id = ? ORDER BY path, stage",
      this.#repoId,
    );
  }

  indexGet(path: string, stage = 0): IndexEntry | null {
    return (
      this.#db.one<IndexEntry>(
        "SELECT path, stage, mode, oid, size, mtime, ino FROM git_index WHERE repo_id = ? AND path = ? AND stage = ?",
        this.#repoId,
        path,
        stage,
      ) ?? null
    );
  }

  indexPut(entry: IndexEntry): void {
    this.#db.run(
      `INSERT INTO git_index (repo_id, path, stage, mode, oid, size, mtime, ino)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(repo_id, path, stage) DO UPDATE SET
         mode = excluded.mode, oid = excluded.oid, size = excluded.size,
         mtime = excluded.mtime, ino = excluded.ino`,
      this.#repoId,
      entry.path,
      entry.stage,
      entry.mode,
      entry.oid,
      entry.size,
      entry.mtime,
      entry.ino,
    );
  }

  /** Remove every stage of `path`. */
  indexRemove(path: string): void {
    this.#db.run("DELETE FROM git_index WHERE repo_id = ? AND path = ?", this.#repoId, path);
  }

  indexClear(): void {
    this.#db.run("DELETE FROM git_index WHERE repo_id = ?", this.#repoId);
  }

  /**
   * Replace the whole index from a stream. Bounded by the flush size, not by
   * the length of `entries`, so a full reset never materialises the tree.
   */
  indexReplace(entries: Iterable<IndexEntry>, options: IndexApplyOptions = {}): void {
    const flushEvery = options.flushEvery ?? DEFAULT_INDEX_FLUSH;
    const pending: IndexEntry[] = [];
    const flush = (clear: boolean): void => {
      if (!clear && pending.length === 0) return;
      this.#db.transactionSync(() => {
        if (clear) this.indexClear();
        for (const entry of pending) this.indexPut(entry);
      });
      pending.length = 0;
    };
    let first = true;
    for (const entry of entries) {
      pending.push(entry);
      if (pending.length < flushEvery) continue;
      flush(first);
      first = false;
    }
    flush(first);
  }

  /**
   * Index rows in (path, stage) order, one bounded page at a time.
   *
   * Keyset paging must carry the stage: the key is (path, stage), so a page
   * boundary falling between stage 0 and stage 2 of one path would drop a row
   * if the cursor were the path alone.
   *
   * CONTRACT: a caller may mutate only paths at or behind the frontier it has
   * already been handed. Each page is a fresh query, so a row written ahead of
   * the frontier would be observed by this scan; a row written behind it would
   * not. `indexApply` is the shape that makes obeying this the easy path.
   */
  *indexScan(options: IndexScanOptions = {}): Generator<IndexEntry> {
    const pageSize = options.pageSize ?? DEFAULT_INDEX_PAGE;
    const prefix = options.prefix;
    let path = options.after?.path ?? "";
    let stage = options.after?.stage ?? -1;

    for (;;) {
      const page =
        prefix === undefined || prefix === ""
          ? this.#db.all<IndexEntry>(
              `SELECT path, stage, mode, oid, size, mtime, ino FROM git_index
               WHERE repo_id = ? AND (path > ? OR (path = ? AND stage > ?))
               ORDER BY path, stage LIMIT ?`,
              this.#repoId,
              path,
              path,
              stage,
              pageSize,
            )
          : this.#db.all<IndexEntry>(
              `SELECT path, stage, mode, oid, size, mtime, ino FROM git_index
               WHERE repo_id = ? AND (path > ? OR (path = ? AND stage > ?))
                 AND (path = ? OR (path >= ? AND path < ?))
               ORDER BY path, stage LIMIT ?`,
              this.#repoId,
              path,
              path,
              stage,
              prefix,
              `${prefix}/`,
              nextPrefix(`${prefix}/`),
              pageSize,
            );
      if (page.length === 0) return;
      for (const entry of page) yield entry;
      const last = page[page.length - 1]!;
      path = last.path;
      stage = last.stage;
      if (page.length < pageSize) return;
    }
  }

  /**
   * Run `body` with a bounded, ordered mutation sink. Mutations are buffered
   * and applied in batches of `flushEvery`, each batch one transaction, so a
   * staging pass over a large index never holds every change it made.
   */
  indexApply<T>(body: (sink: IndexSink) => T, options: IndexApplyOptions = {}): T {
    const flushEvery = options.flushEvery ?? DEFAULT_INDEX_FLUSH;
    // One ordered list, not a put list and a remove list: a caller that
    // removes a path and then re-puts it must get that order back.
    const pending: (IndexEntry | string)[] = [];
    const flush = (): void => {
      if (pending.length === 0) return;
      this.#db.transactionSync(() => {
        for (const item of pending) {
          if (typeof item === "string") this.indexRemove(item);
          else this.indexPut(item);
        }
      });
      pending.length = 0;
    };
    const record = (item: IndexEntry | string): void => {
      pending.push(item);
      if (pending.length >= flushEvery) flush();
    };
    const sink: IndexSink = { put: record, remove: record, flush };
    const result = body(sink);
    flush();
    return result;
  }

  /** True when any entry sits at a merge stage. */
  hasConflicts(): boolean {
    return (
      (this.#db.scalar<number>(
        "SELECT COUNT(*) FROM (SELECT 1 FROM git_index WHERE repo_id = ? AND stage > 0 LIMIT 1)",
        this.#repoId,
      ) ?? 0) > 0
    );
  }

  // -- shallow --------------------------------------------------------

  shallow(): Set<string> {
    return new Set(
      this.#db
        .all<{ oid: string }>("SELECT oid FROM git_shallow WHERE repo_id = ?", this.#repoId)
        .map((row) => row.oid),
    );
  }

  setShallow(add: Iterable<string>, remove: Iterable<string> = []): void {
    this.#db.transactionSync(() => {
      for (const oid of remove) {
        this.#db.run("DELETE FROM git_shallow WHERE repo_id = ? AND oid = ?", this.#repoId, oid);
      }
      for (const oid of add) {
        this.#db.run(
          "INSERT OR IGNORE INTO git_shallow (repo_id, oid) VALUES (?, ?)",
          this.#repoId,
          oid,
        );
      }
    });
  }

  // -- lifecycle ------------------------------------------------------

  /** Drop every row belonging to this repository. */
  destroy(): void {
    this.#db.transactionSync(() => {
      for (const table of [
        "git_refs",
        "git_config",
        "git_index",
        "git_shallow",
        "git_tree_effective",
        "git_tree_entries",
        "git_tree_sources",
        "git_objects",
        "git_object_chunks",
        "git_pack_meta",
        "git_pack_data",
        "git_pack_objects",
        "git_pack_pending",
      ]) {
        this.#db.run(`DELETE FROM ${table} WHERE repo_id = ?`, this.#repoId);
      }
      this.#db.run("DELETE FROM git_repositories WHERE id = ?", this.#repoId);
    });
    this.#objects.clear();
    this.#packs.clearCaches();
    this.#hasLoose = false;
    this.#onDestroy?.();
  }
}

/** The exclusive upper bound of a string prefix range. */
function nextPrefix(prefix: string): string {
  const last = prefix.charCodeAt(prefix.length - 1);
  return `${prefix.slice(0, -1)}${String.fromCharCode(last + 1)}`;
}
