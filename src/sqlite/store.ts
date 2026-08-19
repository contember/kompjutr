// The repository registry and the per-repository store: objects, refs,
// config and the index, all as rows.

import { concat } from "../core/bytes.js";
import { ByteLru } from "../core/lru.js";
import { hashObject, type ObjectType, type RawObject } from "../core/objects.js";
import { deflate, inflate } from "../core/zlib.js";
import { blob, readBlob, type SqlDatabase } from "./db.js";
import { type PackCacheOptions, PackStore } from "./packs.js";
import { initializeGitSchema } from "./schema.js";

/** Bytes per `git_object_chunks` row. */
const OBJECT_CHUNK = 1024 * 1024;

const DEFAULT_OBJECT_CACHE_BYTES = 16 * 1024 * 1024;

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
      const nextId = (this.#db.scalar<number | null>("SELECT MAX(id) FROM git_repositories") ?? 0) + 1;
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
      options.objectCacheBytes ?? DEFAULT_OBJECT_CACHE_BYTES,
      (object) => object.data.length,
    );
    this.#packs = new PackStore(db, repository.id, this.#objects, (oid) => this.#readLoose(oid), options);
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

  typeAndSize(oid: string): { type: ObjectType; size: number } | null {
    if (this.#hasLoose) {
      const row = this.#looseRow(oid);
      if (row !== null) return row;
    }
    return this.#packs.typeAndSize(oid);
  }

  read(oid: string): RawObject | null {
    const cached = this.#objects.get(oid);
    if (cached !== undefined) return cached;
    return this.#readLoose(oid) ?? this.#packs.read(oid);
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
      for (let seq = 0, offset = 0; offset < compressed.length || seq === 0; seq++, offset += OBJECT_CHUNK) {
        this.#db.run(
          "INSERT INTO git_object_chunks (repo_id, oid, seq, data) VALUES (?, ?, ?, ?)",
          this.#repoId,
          oid,
          seq,
          blob(compressed.subarray(offset, offset + OBJECT_CHUNK)),
        );
      }
    });
    this.#hasLoose = true;
    this.#objects.set(oid, { type, data });
    return oid;
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
    this.#objects.set(oid, object);
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

  indexReplace(entries: IndexEntry[]): void {
    this.#db.transactionSync(() => {
      this.indexClear();
      for (const entry of entries) this.indexPut(entry);
    });
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
