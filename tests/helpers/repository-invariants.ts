import { isOid } from "../../src/core/bytes.js";
import type { GitContext } from "../../src/core/context.js";
import { openRepository } from "../../src/core/context.js";
import { CorruptError, GitError } from "../../src/core/errors.js";
import type { Repository } from "../../src/core/repository.js";
import { createExactPathStateSource } from "../../src/fs/exact-path-states.js";
import { createFilesystem } from "../../src/fs/filesystem.js";
import type { Filesystem } from "../../src/fs/types.js";
import {
  initializeIndexTracker,
  iterateIndexTrackerDirty,
  readIndexTrackerState,
} from "../../src/sqlite/index-tracker.js";
import { readMaintenanceRunView } from "../../src/sqlite/maintenance/state.js";
import { requireRawRefTarget, requireRefName } from "../../src/sqlite/ref-validation.js";
import {
  MAX_REFLOG_RAW_TARGET_BYTES,
  MAX_REFLOG_REF_BYTES,
} from "../../src/sqlite/reflog-schema.js";
import { createSqliteSparseWorkspaceSource } from "../../src/sqlite/sparse-workspace.js";
import { SqliteGitDatabase, type StoreOptions } from "../../src/sqlite/store.js";
import { TREE_WALK_PATH_BYTES } from "../../src/sqlite/tree-walk.js";
import { TestDatabase } from "./db.js";
import type { TestWorkspace } from "./workspace.js";

const MAX_INVARIANT_ROWS = 100_000;
const MAX_INVARIANT_OBJECT_PAGE = 1_024;
const MAX_INVARIANT_SYMBOLIC_REFS = 40;
const MAX_INVARIANT_REF_PAYLOAD_BYTES = 32 * 1024 * 1024;
const MAX_INVARIANT_SINGLE_PAYLOAD_BYTES = 512 * 1024;
const INDEX_MODES = new Set([0o100644, 0o100755, 0o120000, 0o160000]);

export interface ReopenedTestRepository {
  readonly database: SqliteGitDatabase;
  readonly worktree: Filesystem;
  readonly context: GitContext;
  readonly repo: Repository;
}

/** Rebuild every database-backed handle over the same Durable Object storage. */
export function reopenTestRepository(
  workspace: TestWorkspace,
  root = "/",
  storeOptions: StoreOptions = {},
): ReopenedTestRepository {
  const db = new TestDatabase(workspace.storage);
  const worktree = createFilesystem(db, { now: workspace.context.now });
  const database = new SqliteGitDatabase(db, { ...storeOptions, now: workspace.context.now });
  initializeIndexTracker(db);
  const context: GitContext = {
    database,
    worktree,
    exactRootStates: createExactPathStateSource(db),
    sparseWorkspace: createSqliteSparseWorkspaceSource(db),
    now: workspace.context.now,
    timezoneOffset: workspace.context.timezoneOffset,
  };
  return { database, worktree, context, repo: openRepository(context, root) };
}

function requireIndexPath(value: unknown): string {
  if (typeof value !== "string" || value === "" || value.startsWith("/") || value.endsWith("/")) {
    throw new CorruptError("interleaving invariant index path is invalid");
  }
  let bytes = 0;
  for (let index = 0; index < value.length; index++) {
    const unit = value.charCodeAt(index);
    if (unit === 0) throw new CorruptError("interleaving invariant index path is invalid");
    if (unit >= 0xd800 && unit <= 0xdbff) {
      const low = value.charCodeAt(index + 1);
      if (low < 0xdc00 || low > 0xdfff) {
        throw new CorruptError("interleaving invariant index path is not canonical UTF-16");
      }
      index++;
      bytes += 4;
    } else if (unit >= 0xdc00 && unit <= 0xdfff) {
      throw new CorruptError("interleaving invariant index path is not canonical UTF-16");
    } else {
      bytes += unit < 0x80 ? 1 : unit < 0x800 ? 2 : 3;
    }
    if (bytes > TREE_WALK_PATH_BYTES) {
      throw new CorruptError("interleaving invariant index path exceeds its byte bound");
    }
  }
  for (const segment of value.split("/")) {
    if (segment === "" || segment === "." || segment === "..") {
      throw new CorruptError("interleaving invariant index path is invalid");
    }
  }
  return value;
}

function requireIndexInteger(value: unknown, label: string, maximum?: number): number {
  if (
    typeof value !== "number" ||
    !Number.isSafeInteger(value) ||
    value < 0 ||
    (maximum !== undefined && value > maximum)
  ) {
    throw new CorruptError(`interleaving invariant ${label} is invalid`);
  }
  return value;
}

function requireNullableIndexInteger(value: unknown, label: string): void {
  if (value !== null) requireIndexInteger(value, label);
}

function probeObjects(repo: Repository, page: string[]): void {
  if (page.length === 0) return;
  repo.store.objectInfo(page);
  page.length = 0;
}

function readObjectPayloads(repo: Repository, page: string[], budget: { bytes: number }): void {
  if (page.length === 0) return;
  const info = repo.store.objectInfo(page);
  let pageBytes = 0;
  for (const object of info) {
    if (object.size > MAX_INVARIANT_SINGLE_PAYLOAD_BYTES) {
      throw new GitError(
        "E2BIG",
        `interleaving invariant object ${object.oid} exceeds ${MAX_INVARIANT_SINGLE_PAYLOAD_BYTES} bytes`,
      );
    }
    if (object.size > MAX_INVARIANT_REF_PAYLOAD_BYTES - budget.bytes - pageBytes) {
      throw new GitError(
        "E2BIG",
        `interleaving invariant ref payloads exceed ${MAX_INVARIANT_REF_PAYLOAD_BYTES} bytes`,
      );
    }
    pageBytes += object.size;
  }

  let remaining = info.map((object) => object.oid);
  while (remaining.length > 0) {
    const batch = repo.readObjects(remaining, { budgetBytes: MAX_INVARIANT_SINGLE_PAYLOAD_BYTES });
    remaining = batch.remaining;
  }
  budget.bytes += pageBytes;
  page.length = 0;
}

function assertRefsReadable(repo: Repository, budget: { bytes: number }): void {
  let rows = 0;
  const objects: string[] = [];
  const symbolic: string[] = [];
  for (const row of repo.store.db.iterate(
    `SELECT CASE WHEN typeof(name) = 'text' AND length(CAST(name AS BLOB)) <= ?
                 THEN name END AS name,
            CASE WHEN typeof(target) = 'text' AND length(CAST(target AS BLOB)) <= ?
                 THEN target END AS target
       FROM git_refs WHERE repo_id = ? ORDER BY name`,
    MAX_REFLOG_REF_BYTES,
    MAX_REFLOG_RAW_TARGET_BYTES,
    repo.store.repoId,
  )) {
    rows++;
    if (rows > MAX_INVARIANT_ROWS) {
      throw new CorruptError(`interleaving invariant refs exceed ${MAX_INVARIANT_ROWS} rows`);
    }
    const name = requireRefName(row.name, "interleaving invariant ref name", "stored");
    const target = requireRawRefTarget(
      row.target,
      `interleaving invariant target of ${name}`,
      "stored",
    );
    if (isOid(target)) {
      objects.push(target);
      if (objects.length === MAX_INVARIANT_OBJECT_PAGE) {
        readObjectPayloads(repo, objects, budget);
      }
      continue;
    }
    symbolic.push(name);
    if (symbolic.length > MAX_INVARIANT_SYMBOLIC_REFS) {
      throw new CorruptError(
        `interleaving invariant symbolic refs exceed ${MAX_INVARIANT_SYMBOLIC_REFS} rows`,
      );
    }
  }
  for (const name of symbolic) {
    const oid = repo.resolveRef(name);
    if (oid === null) throw new CorruptError(`visible ref ${name} does not resolve`);
    objects.push(oid);
    if (objects.length === MAX_INVARIANT_OBJECT_PAGE) readObjectPayloads(repo, objects, budget);
  }
  readObjectPayloads(repo, objects, budget);
}

function assertIndexReadable(repo: Repository): void {
  let rows = 0;
  const objects: string[] = [];
  for (const row of repo.store.db.iterate(
    `SELECT CASE WHEN typeof(path) = 'text' AND length(CAST(path AS BLOB)) <= ?
                 THEN path END AS path,
            CASE WHEN typeof(stage) = 'integer' THEN stage END AS stage,
            CASE WHEN typeof(mode) = 'integer' THEN mode END AS mode,
            CASE WHEN typeof(oid) = 'text' AND length(CAST(oid AS BLOB)) = 40
                 THEN oid END AS oid,
            CASE WHEN size IS NULL THEN NULL
                 WHEN typeof(size) = 'integer' THEN size ELSE -1 END AS size,
            CASE WHEN mtime IS NULL THEN NULL
                 WHEN typeof(mtime) = 'integer' THEN mtime ELSE -1 END AS mtime,
            CASE WHEN ino IS NULL THEN NULL
                 WHEN typeof(ino) = 'integer' THEN ino ELSE -1 END AS ino,
            CASE WHEN rev IS NULL THEN NULL
                 WHEN typeof(rev) = 'integer' THEN rev ELSE -1 END AS rev
       FROM git_index WHERE checkout_id = ? ORDER BY path, stage`,
    TREE_WALK_PATH_BYTES,
    repo.checkout.checkoutId,
  )) {
    rows++;
    if (rows > MAX_INVARIANT_ROWS) {
      throw new CorruptError(`interleaving invariant index exceeds ${MAX_INVARIANT_ROWS} rows`);
    }
    requireIndexPath(row.path);
    requireIndexInteger(row.stage, "index stage", 3);
    const mode = requireIndexInteger(row.mode, "index mode");
    if (!INDEX_MODES.has(mode)) {
      throw new CorruptError("interleaving invariant index mode is invalid");
    }
    if (typeof row.oid !== "string" || !isOid(row.oid)) {
      throw new CorruptError("interleaving invariant index OID is invalid");
    }
    requireNullableIndexInteger(row.size, "index size");
    requireNullableIndexInteger(row.mtime, "index mtime");
    requireNullableIndexInteger(row.ino, "index inode");
    requireNullableIndexInteger(row.rev, "index revision");
    if (mode !== 0o160000) {
      objects.push(row.oid);
      if (objects.length === MAX_INVARIANT_OBJECT_PAGE) probeObjects(repo, objects);
    }
  }
  probeObjects(repo, objects);
}

/** Validate the bounded, static readability subset shared by interleaving tests. */
export function assertRepositoryReadable(repo: Repository): void {
  const refPayloadBudget = { bytes: 0 };
  const head = repo.head();
  if (head.oid !== null) readObjectPayloads(repo, [head.oid], refPayloadBudget);

  assertRefsReadable(repo, refPayloadBudget);
  assertIndexReadable(repo);

  repo.checkout.readOperationState();
  const tracker = readIndexTrackerState(repo.store.db, repo.checkout.checkoutId);
  if (tracker.available) {
    if (tracker.baselineTreeOid !== null) {
      const [info] = repo.store.objectInfo([tracker.baselineTreeOid]);
      if (info === undefined || info.size > MAX_INVARIANT_SINGLE_PAYLOAD_BYTES) {
        throw new GitError(
          "E2BIG",
          `interleaving invariant baseline exceeds ${MAX_INVARIANT_SINGLE_PAYLOAD_BYTES} bytes`,
        );
      }
      const baseline = repo.read(tracker.baselineTreeOid);
      if (baseline.type !== "tree") {
        throw new CorruptError("interleaving invariant index baseline is not a tree");
      }
    }
    for (const _row of iterateIndexTrackerDirty(repo.store.db, repo.checkout.checkoutId)) {
      // Iteration validates every retained dirty row.
    }
  }
  readMaintenanceRunView(repo.store.db, repo.store.repoId);
}
