import { describe, expect, it, vi } from "vitest";
import { createFilesystem } from "../packages/do/src/fs/filesystem.js";
import { createInitialWorktreeWriter } from "../packages/do/src/fs/store/initial-write.js";
import type { Filesystem } from "../packages/do/src/fs/types.js";
import {
  initializeIndexTracker,
  readIndexTrackerState,
  resealIndexTracker,
} from "../packages/git/src/do-fs/indexes/index-tracker.js";
import type { GitContext } from "../packages/git/src/ops/core/context.js";
import { checkout } from "../packages/git/src/ops/refs/refs.js";
import { initRepository } from "../packages/git/src/ops/repository/init.js";
import type { Repository } from "../packages/git/src/ops/repository/repository.js";
import { add } from "../packages/git/src/ops/staging/staging.js";
import { status } from "../packages/git/src/ops/status/status-core.js";
import { SqliteGitDatabase } from "../packages/git/src/store/index.js";
import { TestDatabase } from "./helpers/db.js";
import { GitFixture } from "./helpers/git.js";
import { importFixture } from "./helpers/import.js";
import { SqliteTestStorage } from "./helpers/storage.js";

// One fixed clock for the writer and the filesystem: every later edit lands in
// the checkout's own timestamp tick, so only `rev` can tell it apart.
const NOW = 1_600_000_000_000;
const FILES = 2_000;
const LARGE_BYTES = 1024 * 1024 + 17;

interface StatRuntime {
  storage: SqliteTestStorage;
  db: TestDatabase;
  worktree: Filesystem;
  context: GitContext;
  repo: Repository;
}

function makeRuntime(tracker: boolean): StatRuntime {
  const now = (): number => NOW;
  const storage = new SqliteTestStorage();
  const db = new TestDatabase(storage);
  const worktree = createFilesystem(db, { now });
  const database = new SqliteGitDatabase(db, { now });
  if (tracker) initializeIndexTracker(db);
  const context: GitContext = {
    database,
    worktree,
    initialWorktree: createInitialWorktreeWriter(db, now, (candidate) => candidate === database),
    indexTracker: tracker
      ? {
          reseal: (checkoutId, baselineTreeOid, entries) =>
            resealIndexTracker(db, checkoutId, baselineTreeOid, entries),
          advanceBaseline: () => false,
        }
      : undefined,
    now,
    timezoneOffset: () => 0,
  };
  const repo = initRepository(context, { dir: "/repo" });
  return { storage, db, worktree, context, repo };
}

function buildFixture(): GitFixture {
  const fixture = new GitFixture().init("main");
  for (let index = 0; index < FILES; index++) {
    fixture.write(`dir-${index % 7}/file-${String(index).padStart(5, "0")}.txt`, `c-${index}\n`);
  }
  fixture.writeExecutable("bin/run.sh", "#!/bin/sh\necho hi\n");
  fixture.symlink("bin/run.sh", "run-link");
  fixture.write("large.bin", new Uint8Array(LARGE_BYTES).fill(7));
  fixture.commit("stat target");
  return fixture;
}

type IndexSnapshot = Map<string, string>;

function indexSnapshot(runtime: StatRuntime): IndexSnapshot {
  const rows = runtime.db.all<{ path: string; row: string }>(
    `SELECT path, json_array(stage, mode, oid, size, mtime, ino, rev) AS row
       FROM git_index WHERE checkout_id = ? ORDER BY path`,
    runtime.repo.checkout.checkoutId,
  );
  return new Map(rows.map((row) => [row.path, row.row]));
}

function changedRows(before: IndexSnapshot, after: IndexSnapshot): number {
  let changed = 0;
  for (const [path, row] of after) if (before.get(path) !== row) changed++;
  for (const path of before.keys()) if (!after.has(path)) changed++;
  return changed;
}

function dirtyRows(runtime: StatRuntime): number {
  return runtime.db.scalar<number>("SELECT count(*) FROM git_index_dirty") ?? -1;
}

interface AddCost {
  statements: number;
  filesHashed: number;
  indexRowsWritten: number;
}

/**
 * The first whole-tree add, through the full worktree scan rather than the tracker.
 * A symlink hashes from its scanned target without a read; any hashed path is
 * also an index write, so `indexRowsWritten` covers it.
 */
function measureFirstAdd(runtime: StatRuntime): AddCost {
  const worktree = runtime.worktree;
  const readFiles = vi.spyOn(worktree, "readFiles");
  const readRange = vi.spyOn(worktree, "readRange");
  const readFile = vi.spyOn(worktree, "readFile");
  const readlink = vi.spyOn(worktree, "readlink");
  const before = indexSnapshot(runtime);
  runtime.storage.resetCounters();
  add(runtime.repo, worktree, { paths: ["."] });
  const statements = runtime.storage.statementCount;
  const hashed = new Set<string>();
  for (const result of readFiles.mock.results) {
    if (result.type === "return") for (const path of result.value.files.keys()) hashed.add(path);
  }
  for (const [path] of readRange.mock.calls) hashed.add(path);
  for (const [path] of readFile.mock.calls) hashed.add(path);
  for (const [path] of readlink.mock.calls) hashed.add(path);
  vi.restoreAllMocks();
  return {
    statements,
    filesHashed: hashed.size,
    indexRowsWritten: changedRows(before, indexSnapshot(runtime)),
  };
}

describe("initial checkout stat data", () => {
  it("lets the first add trust every checked-out file without hashing or index writes", async () => {
    const fixture = buildFixture();
    const runtime = makeRuntime(false);
    try {
      await importFixture(fixture, runtime.repo.checkout);
      checkout(runtime.context, runtime.repo, runtime.worktree, { ref: "main" });

      for (const path of ["dir-0/file-00000.txt", "bin/run.sh", "run-link", "large.bin"]) {
        const stat = runtime.worktree.stat(`/repo/${path}`);
        expect(stat).not.toBeNull();
        expect(runtime.repo.checkout.indexGet(path)).toMatchObject({
          size: stat?.size,
          mtime: stat?.mtime,
          ino: stat?.ino,
          rev: stat?.rev,
        });
      }

      const cost = measureFirstAdd(runtime);
      expect({ filesHashed: cost.filesHashed, indexRowsWritten: cost.indexRowsWritten }).toEqual({
        filesHashed: 0,
        indexRowsWritten: 0,
      });
      expect(cost.statements).toBeLessThan(1_000);
    } finally {
      fixture.dispose();
    }
  });

  it("control: NULL stats without blob-id mappings make the same add hash and rewrite", async () => {
    const fixture = buildFixture();
    const runtime = makeRuntime(false);
    try {
      await importFixture(fixture, runtime.repo.checkout);
      checkout(runtime.context, runtime.repo, runtime.worktree, { ref: "main" });
      runtime.db.run("UPDATE git_index SET mtime = NULL, ino = NULL, rev = NULL");
      runtime.db.run("DELETE FROM git_blob_ids");

      const cost = measureFirstAdd(runtime);
      // Every regular file is read; the symlink hashes from its scanned target.
      expect({ filesHashed: cost.filesHashed, indexRowsWritten: cost.indexRowsWritten }).toEqual({
        filesHashed: FILES + 2,
        indexRowsWritten: FILES + 3,
      });
    } finally {
      fixture.dispose();
    }
  });

  it("still reports a same-size edit made in the checkout's timestamp tick through rev", async () => {
    const fixture = buildFixture();
    const runtime = makeRuntime(false);
    try {
      await importFixture(fixture, runtime.repo.checkout);
      checkout(runtime.context, runtime.repo, runtime.worktree, { ref: "main" });
      expect(status(runtime.repo, runtime.worktree)).toEqual([]);

      const path = "dir-3/file-00010.txt";
      const recorded = runtime.repo.checkout.indexGet(path);
      runtime.worktree.writeFile(`/repo/${path}`, new TextEncoder().encode("X-10\n"));
      const edited = runtime.worktree.stat(`/repo/${path}`);

      // Size, mtime and inode all still match the index row; only rev moved.
      expect(edited).toMatchObject({
        size: recorded?.size,
        mtime: recorded?.mtime,
        ino: recorded?.ino,
      });
      expect(edited?.rev).not.toBe(recorded?.rev);
      expect(status(runtime.repo, runtime.worktree)).toEqual([
        expect.objectContaining({ path, index: " ", worktree: "M" }),
      ]);
    } finally {
      fixture.dispose();
    }
  });

  it("does not flood a complete tracker when the first add finds nothing to refresh", async () => {
    const fixture = buildFixture();
    const runtime = makeRuntime(true);
    try {
      await importFixture(fixture, runtime.repo.checkout);
      checkout(runtime.context, runtime.repo, runtime.worktree, { ref: "main" });
      expect(readIndexTrackerState(runtime.db, runtime.repo.checkout.checkoutId)).toMatchObject({
        available: true,
      });
      expect(dirtyRows(runtime)).toBe(0);

      const cost = measureFirstAdd(runtime);
      expect(cost.indexRowsWritten).toBe(0);
      expect(dirtyRows(runtime)).toBe(0);
    } finally {
      fixture.dispose();
    }
  });
});
