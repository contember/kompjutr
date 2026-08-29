import { describe, expect, it } from "vitest";
import type { GitContext, IndexTrackerSeedEntry } from "../src/core/context.js";
import { openRepository } from "../src/core/context.js";
import { CorruptError, GitError } from "../src/core/errors.js";
import { commit } from "../src/core/ops/commit.js";
import { eagerStatus, type StatusOptions, status, statusStream } from "../src/core/ops/status.js";
import { hashWorktreePath, indexEntryFor } from "../src/core/ops/worktree-io.js";
import type { SparseWorkspaceSource } from "../src/core/sparse-workspace.js";
import type { SqlDatabase } from "../src/sqlite/db.js";
import {
  advanceIndexTrackerBaseline,
  INDEX_DIRTY,
  readIndexTrackerState,
  resealIndexTracker,
  WORKTREE_DIRTY,
} from "../src/sqlite/index-tracker.js";
import {
  createSqliteCommitTreeSnapshotSource,
  createSqliteSparseWorkspaceSource,
} from "../src/sqlite/sparse-workspace.js";
import type { IndexEntry } from "../src/sqlite/store.js";
import { GitFixture } from "./helpers/git.js";
import {
  configureFixtureIdentity,
  requireSparseWorkspace,
  sealIndexTracker,
  sparseTrackerContext,
  stageWorktreePaths,
} from "./helpers/sparse.js";
import { makeRepo, type TestRepository, writeWorkFile } from "./helpers/workspace.js";
import { CountingWorktree } from "./helpers/worktree.js";

class NoScanWorktree extends CountingWorktree {
  override scan(): never {
    throw new Error("sparse status must not scan the worktree");
  }
}

class FailingHashWorktree extends CountingWorktree {
  override readFiles(): never {
    throw new Error("injected hash failure");
  }
}

class MutatingAncestorDatabase implements SqlDatabase {
  constructor(
    private readonly inner: SqlDatabase,
    private readonly mutate: (row: Record<string, unknown>) => Record<string, unknown>,
  ) {}

  run(query: string, ...bindings: unknown[]): void {
    this.inner.run(query, ...bindings);
  }

  all<Row extends object>(query: string, ...bindings: unknown[]): Row[] {
    return this.inner.all<Row>(query, ...bindings);
  }

  one<Row extends object>(query: string, ...bindings: unknown[]): Row | undefined {
    return this.inner.one<Row>(query, ...bindings);
  }

  scalar<T>(query: string, ...bindings: unknown[]): T | undefined {
    return this.inner.scalar<T>(query, ...bindings);
  }

  *iterate(query: string, ...bindings: unknown[]): Generator<Record<string, unknown>> {
    for (const row of this.inner.iterate(query, ...bindings)) {
      yield query.includes("index_ancestor_rows") ? this.mutate(row) : row;
    }
  }

  transactionSync<T>(closure: () => T): T {
    return this.inner.transactionSync(closure);
  }
}

function commitFiles(workspace: TestRepository, paths: readonly string[]): void {
  configureFixtureIdentity(workspace);
  stageWorktreePaths(workspace, paths);
  commit(workspace.context, workspace.repo, { message: "fixture" });
}

function recordingContext(workspace: TestRepository) {
  const reseals: Array<{
    checkoutId: number;
    baselineTreeOid: string | null;
    entries: IndexTrackerSeedEntry[];
  }> = [];
  const context: Pick<GitContext, "sparseWorkspace" | "indexTracker"> = {
    sparseWorkspace: workspace.context.sparseWorkspace,
    indexTracker: {
      reseal(checkoutId, baselineTreeOid, entries) {
        reseals.push({ checkoutId, baselineTreeOid, entries: [...entries] });
        return true;
      },
    },
  };
  return { context, reseals };
}

function bareIndexEntry(path: string, mode = 0o100644): IndexEntry {
  return {
    path,
    stage: 0,
    mode,
    oid: "ab".repeat(20),
    size: null,
    mtime: null,
    ino: null,
  };
}

interface AncestorIndexCorruption {
  name: string;
  mutate(workspace: TestRepository): void;
}

const ANCESTOR_INDEX_CORRUPTIONS: readonly AncestorIndexCorruption[] = [
  {
    name: "BLOB path",
    mutate(workspace) {
      workspace.storage.sql.exec("PRAGMA ignore_check_constraints = ON");
      workspace.storage.sql.exec(
        "UPDATE git_index SET path = ? WHERE checkout_id = ? AND path = ?",
        new TextEncoder().encode("tracked/file.txt"),
        workspace.repo.checkout.checkoutId,
        "tracked/file.txt",
      );
      workspace.storage.sql.exec("PRAGMA ignore_check_constraints = OFF");
    },
  },
  {
    name: "BLOB stage",
    mutate(workspace) {
      workspace.storage.sql.exec(
        "UPDATE git_index SET stage = ? WHERE checkout_id = ? AND path = ?",
        new Uint8Array([1]),
        workspace.repo.checkout.checkoutId,
        "tracked/file.txt",
      );
    },
  },
  {
    name: "invalid mode",
    mutate(workspace) {
      workspace.storage.sql.exec(
        "UPDATE git_index SET mode = 0 WHERE checkout_id = ? AND path = ?",
        workspace.repo.checkout.checkoutId,
        "tracked/file.txt",
      );
    },
  },
  {
    name: "invalid oid",
    mutate(workspace) {
      workspace.storage.sql.exec(
        "UPDATE git_index SET oid = 'broken' WHERE checkout_id = ? AND path = ?",
        workspace.repo.checkout.checkoutId,
        "tracked/file.txt",
      );
    },
  },
  {
    name: "negative size",
    mutate(workspace) {
      workspace.storage.sql.exec(
        "UPDATE git_index SET size = -1 WHERE checkout_id = ? AND path = ?",
        workspace.repo.checkout.checkoutId,
        "tracked/file.txt",
      );
    },
  },
  {
    name: "BLOB mtime",
    mutate(workspace) {
      workspace.storage.sql.exec(
        "UPDATE git_index SET mtime = ? WHERE checkout_id = ? AND path = ?",
        new Uint8Array([1]),
        workspace.repo.checkout.checkoutId,
        "tracked/file.txt",
      );
    },
  },
  {
    name: "nonpositive inode",
    mutate(workspace) {
      workspace.storage.sql.exec(
        "UPDATE git_index SET ino = 0 WHERE checkout_id = ? AND path = ?",
        workspace.repo.checkout.checkoutId,
        "tracked/file.txt",
      );
    },
  },
  {
    name: "negative revision",
    mutate(workspace) {
      workspace.storage.sql.exec(
        "UPDATE git_index SET rev = -1 WHERE checkout_id = ? AND path = ?",
        workspace.repo.checkout.checkoutId,
        "tracked/file.txt",
      );
    },
  },
];

describe("sparse eager status", () => {
  it("reseals one authoritative full status for an incomplete repository", () => {
    const workspace = makeRepo("/");
    writeWorkFile(workspace, "/a.txt", "a\n");
    commitFiles(workspace, ["a.txt"]);
    expect(
      readIndexTrackerState(workspace.database.db, workspace.repo.checkout.checkoutId),
    ).toEqual({
      available: false,
    });

    const expected = status(workspace.repo, workspace.worktree);
    expect(
      eagerStatus(workspace.repo, workspace.worktree, {}, sparseTrackerContext(workspace)),
    ).toEqual(expected);
    expect(
      readIndexTrackerState(workspace.database.db, workspace.repo.checkout.checkoutId),
    ).toEqual({
      available: true,
      baselineTreeOid: workspace.repo.headTree(),
    });
    expect([
      ...workspace.context.sparseWorkspace!.dirtyPaths(workspace.repo.checkout.checkoutId),
    ]).toEqual([]);
    expect(
      eagerStatus(
        workspace.repo,
        new NoScanWorktree(workspace.worktree),
        {},
        sparseTrackerContext(workspace),
      ),
    ).toEqual([]);
  });

  it("routes consumer status state through an unequal checkout id", () => {
    const workspace = makeRepo("/");
    const primaryCheckoutId = workspace.repo.checkout.checkoutId;
    const checkoutId = primaryCheckoutId + 100;
    workspace.worktree.mkdir("/linked");
    workspace.database.db.run(
      `INSERT INTO git_checkouts (id, repo_id, root, head, is_primary)
       VALUES (?, ?, '/linked', 'ref: refs/heads/linked', 0)`,
      checkoutId,
      workspace.repo.store.repoId,
    );
    const repo = openRepository(workspace.context, "/linked");
    const linked: TestRepository = { ...workspace, repo };
    expect(repo.store.repoId).not.toBe(repo.checkout.checkoutId);

    writeWorkFile(linked, "/linked/a.txt", "before\n");
    commitFiles(linked, ["a.txt"]);
    sealIndexTracker(linked);
    expect(readIndexTrackerState(workspace.database.db, checkoutId)).toEqual({
      available: true,
      baselineTreeOid: repo.headTree(),
    });
    expect(readIndexTrackerState(workspace.database.db, primaryCheckoutId)).toEqual({
      available: false,
    });

    linked.tick(60_000);
    writeWorkFile(linked, "/linked/a.txt", "after\n");
    expect([...requireSparseWorkspace(linked).dirtyPaths(checkoutId)]).toEqual([
      { path: "a.txt", flags: WORKTREE_DIRTY },
    ]);
    expect([...requireSparseWorkspace(linked).dirtyPaths(primaryCheckoutId)]).toEqual([]);
    expect(
      eagerStatus(repo, new NoScanWorktree(linked.worktree), {}, sparseTrackerContext(linked)),
    ).toEqual([expect.objectContaining({ path: "a.txt", index: " ", worktree: "M" })]);
  });

  it("reseals exact conservative dirty leaves hidden by status presentation", () => {
    const workspace = makeRepo("/");
    writeWorkFile(workspace, "/.gitignore", "cache/\n");
    writeWorkFile(workspace, "/conflict.txt", "base\n");
    workspace.worktree.symlink("before", "/link");
    for (const path of [
      "removed.txt",
      "retained.txt",
      "stable.txt",
      "staged.txt",
      "unstaged.txt",
    ]) {
      writeWorkFile(workspace, `/${path}`, `${path}\n`);
    }
    commitFiles(workspace, [
      ".gitignore",
      "conflict.txt",
      "link",
      "removed.txt",
      "retained.txt",
      "stable.txt",
      "staged.txt",
      "unstaged.txt",
    ]);
    workspace.repo.checkout.indexPut(bareIndexEntry("module", 0o160000));
    commit(workspace.context, workspace.repo, { message: "gitlink fixture" });
    workspace.tick(60_000);

    writeWorkFile(workspace, "/staged.txt", "staged after\n");
    const staged = hashWorktreePath(workspace.repo, workspace.worktree, "staged.txt");
    if (staged === null) throw new Error("missing staged fixture");
    workspace.repo.checkout.indexPut(indexEntryFor("staged.txt", staged));
    writeWorkFile(workspace, "/unstaged.txt", "unstaged after\n");
    writeWorkFile(workspace, "/stable.txt", "stable.txt\n");
    workspace.repo.checkout.indexRemove("retained.txt");
    workspace.repo.checkout.indexRemove("removed.txt");
    workspace.worktree.unlink("/removed.txt");
    workspace.worktree.unlink("/link");
    workspace.worktree.symlink("after", "/link");
    workspace.repo.checkout.indexRemove("conflict.txt");
    const conflictOid = workspace.repo.store.write("blob", new TextEncoder().encode("conflict\n"));
    for (const stage of [1, 2, 3]) {
      workspace.repo.checkout.indexPut({
        path: "conflict.txt",
        stage,
        mode: 0o100644,
        oid: conflictOid,
        size: null,
        mtime: null,
        ino: null,
      });
    }
    writeWorkFile(workspace, "/cache/noisy.log", "ignored\n");
    writeWorkFile(workspace, "/fresh/a.txt", "a\n");
    writeWorkFile(workspace, "/fresh/deeper/b.txt", "b\n");

    const expected = status(workspace.repo, workspace.worktree);
    expect(
      eagerStatus(workspace.repo, workspace.worktree, {}, sparseTrackerContext(workspace)),
    ).toEqual(expected);
    expect([
      ...workspace.context.sparseWorkspace!.dirtyPaths(workspace.repo.checkout.checkoutId),
    ]).toEqual([
      { path: "cache/noisy.log", flags: WORKTREE_DIRTY },
      { path: "conflict.txt", flags: INDEX_DIRTY | WORKTREE_DIRTY },
      { path: "fresh/a.txt", flags: WORKTREE_DIRTY },
      { path: "fresh/deeper/b.txt", flags: WORKTREE_DIRTY },
      { path: "link", flags: WORKTREE_DIRTY },
      { path: "module", flags: INDEX_DIRTY },
      { path: "removed.txt", flags: INDEX_DIRTY },
      { path: "retained.txt", flags: INDEX_DIRTY | WORKTREE_DIRTY },
      { path: "staged.txt", flags: INDEX_DIRTY },
      { path: "unstaged.txt", flags: WORKTREE_DIRTY },
    ]);
  });

  it("returns a clean sealed status without scanning the tree or worktree", () => {
    const workspace = makeRepo("/");
    writeWorkFile(workspace, "/a.txt", "a\n");
    commitFiles(workspace, ["a.txt"]);
    sealIndexTracker(workspace);
    const worktree = new NoScanWorktree(workspace.worktree);

    workspace.storage.resetCounters();
    expect(eagerStatus(workspace.repo, worktree, {}, sparseTrackerContext(workspace))).toEqual([]);
    expect(workspace.storage.statementCount).toBeLessThan(1_000);
    expect(workspace.storage.rowCount).toBeLessThan(10);
  });

  it("hashes one hundred modified tracked paths without a refresh scan", () => {
    const workspace = makeRepo("/");
    const paths = Array.from(
      { length: 100 },
      (_, index) => `src/f${index.toString().padStart(3, "0")}.txt`,
    );
    for (const path of paths) writeWorkFile(workspace, `/${path}`, "before\n");
    commitFiles(workspace, paths);
    sealIndexTracker(workspace);
    workspace.tick(60_000);
    for (const path of paths) writeWorkFile(workspace, `/${path}`, "after\n");
    const worktree = new NoScanWorktree(workspace.worktree);

    workspace.storage.resetCounters();
    const rows = eagerStatus(
      workspace.repo,
      worktree,
      { untrackedFiles: "all" },
      sparseTrackerContext(workspace),
    );

    expect(rows).toHaveLength(100);
    expect(rows.every((row) => row.index === " " && row.worktree === "M")).toBe(true);
    expect(worktree.bulkReadPaths).toHaveLength(100);
    expect(workspace.storage.statementCount).toBeLessThan(1_000);
    expect(workspace.storage.rowCount).toBeLessThan(10_000);
    expect([
      ...workspace.context.sparseWorkspace!.dirtyPaths(workspace.repo.checkout.checkoutId),
    ]).toEqual(paths.map((path) => ({ path, flags: WORKTREE_DIRTY })));
  });

  it("matches full status for staged, unstaged, mode, symlink, and conflict rows", () => {
    const workspace = makeRepo("/");
    writeWorkFile(workspace, "/staged.txt", "before\n");
    writeWorkFile(workspace, "/unstaged.txt", "before\n");
    writeWorkFile(workspace, "/mode.txt", "mode\n");
    workspace.worktree.symlink("before", "/link");
    writeWorkFile(workspace, "/conflict.txt", "base\n");
    const paths = ["conflict.txt", "link", "mode.txt", "staged.txt", "unstaged.txt"];
    commitFiles(workspace, paths);
    sealIndexTracker(workspace);
    workspace.tick(60_000);

    writeWorkFile(workspace, "/staged.txt", "staged\n");
    const staged = hashWorktreePath(workspace.repo, workspace.worktree, "staged.txt");
    if (staged === null) throw new Error("missing staged fixture");
    workspace.repo.checkout.indexPut(indexEntryFor("staged.txt", staged));
    writeWorkFile(workspace, "/unstaged.txt", "unstaged\n");
    workspace.worktree.chmod("/mode.txt", 0o755);
    workspace.worktree.unlink("/link");
    workspace.worktree.symlink("after", "/link");
    workspace.repo.checkout.indexRemove("conflict.txt");
    const oid = workspace.repo.store.write("blob", new TextEncoder().encode("conflict\n"));
    for (const stage of [1, 2, 3]) {
      const entry: IndexEntry = {
        path: "conflict.txt",
        stage,
        mode: 0o100644,
        oid,
        size: null,
        mtime: null,
        ino: null,
      };
      workspace.repo.checkout.indexPut(entry);
    }

    const expected = status(workspace.repo, workspace.worktree, { untrackedFiles: "all" });
    const actual = eagerStatus(
      workspace.repo,
      new NoScanWorktree(workspace.worktree),
      { untrackedFiles: "all" },
      sparseTrackerContext(workspace),
    );
    expect(actual).toEqual(expected);
    expect(actual).toContainEqual(
      expect.objectContaining({ path: "conflict.txt", index: "U", worktree: "U" }),
    );
    expect([
      ...workspace.context.sparseWorkspace!.dirtyPaths(workspace.repo.checkout.checkoutId),
    ]).toContainEqual({ path: "conflict.txt", flags: INDEX_DIRTY | WORKTREE_DIRTY });
  });

  it("matches full status for an exact staged rename", () => {
    const workspace = makeRepo("/");
    writeWorkFile(workspace, "/old.txt", "same\n");
    commitFiles(workspace, ["old.txt"]);
    sealIndexTracker(workspace);

    workspace.worktree.unlink("/old.txt");
    workspace.repo.checkout.indexRemove("old.txt");
    writeWorkFile(workspace, "/new.txt", "same\n");
    stageWorktreePaths(workspace, ["new.txt"]);

    const expected = status(workspace.repo, workspace.worktree, { untrackedFiles: "all" });
    expect(
      eagerStatus(
        workspace.repo,
        new NoScanWorktree(workspace.worktree),
        { untrackedFiles: "all" },
        sparseTrackerContext(workspace),
      ),
    ).toEqual(expected);
    expect(expected).toEqual([
      expect.objectContaining({
        path: "new.txt",
        originalPath: "old.txt",
        similarity: 100,
        index: "R",
        worktree: " ",
      }),
    ]);
  });

  it("keeps normal untracked collapsing and all-file reporting sparse", () => {
    const normal = makeRepo("/");
    sealIndexTracker(normal);
    writeWorkFile(normal, "/fresh/a.txt", "fresh\n");
    expect(
      eagerStatus(
        normal.repo,
        new NoScanWorktree(normal.worktree),
        {},
        sparseTrackerContext(normal),
      ).map((row) => row.path),
    ).toEqual(["fresh/"]);

    const all = makeRepo("/");
    sealIndexTracker(all);
    writeWorkFile(all, "/fresh/a.txt", "fresh\n");
    expect(
      eagerStatus(
        all.repo,
        new NoScanWorktree(all.worktree),
        { untrackedFiles: "all" },
        sparseTrackerContext(all),
      ).map((row) => row.path),
    ).toEqual(["fresh/a.txt"]);

    const ignored = makeRepo("/");
    writeWorkFile(ignored, "/.gitignore", "*.log\n");
    commitFiles(ignored, [".gitignore"]);
    sealIndexTracker(ignored);
    writeWorkFile(ignored, "/ignored/noisy.log", "noise\n");
    expect(
      eagerStatus(
        ignored.repo,
        ignored.worktree,
        { includeIgnored: true },
        sparseTrackerContext(ignored),
      ),
    ).toEqual([
      expect.objectContaining({
        ignored: true,
        path: "ignored/noisy.log",
        index: "!",
        worktree: "!",
      }),
    ]);
  });

  it("hashes a tracked candidate while normal untracked collapsing stays sparse", () => {
    const workspace = makeRepo("/");
    writeWorkFile(workspace, "/a.txt", "before\n");
    commitFiles(workspace, ["a.txt"]);
    sealIndexTracker(workspace);
    workspace.tick(60_000);
    writeWorkFile(workspace, "/a.txt", "after\n");
    writeWorkFile(workspace, "/z-untracked.txt", "untracked\n");
    const worktree = new NoScanWorktree(workspace.worktree);

    expect(eagerStatus(workspace.repo, worktree, {}, sparseTrackerContext(workspace))).toEqual([
      expect.objectContaining({ path: "a.txt", index: " ", worktree: "M" }),
      expect.objectContaining({ path: "z-untracked.txt", index: " ", worktree: "?" }),
    ]);
    expect(worktree.bulkReadPaths).toEqual(["/a.txt"]);
  });

  it("retains worktree dirtiness when a staged deletion leaves the old file", () => {
    const workspace = makeRepo("/");
    writeWorkFile(workspace, "/kept.txt", "kept\n");
    commitFiles(workspace, ["kept.txt"]);
    sealIndexTracker(workspace);
    workspace.repo.checkout.indexRemove("kept.txt");

    expect(
      eagerStatus(
        workspace.repo,
        new NoScanWorktree(workspace.worktree),
        { untrackedFiles: "all" },
        sparseTrackerContext(workspace),
      ),
    ).toEqual([
      expect.objectContaining({ path: "kept.txt", index: "D", worktree: " " }),
      expect.objectContaining({ path: "kept.txt", index: " ", worktree: "?" }),
    ]);
    expect([
      ...workspace.context.sparseWorkspace!.dirtyPaths(workspace.repo.checkout.checkoutId),
    ]).toEqual([{ path: "kept.txt", flags: INDEX_DIRTY | WORKTREE_DIRTY }]);
  });

  it("matches full normal collapse for tracked, whole, nested, replaced, and ignored paths", () => {
    const workspace = makeRepo("/");
    writeWorkFile(workspace, "/.gitignore", "*.log\n");
    for (const path of [
      "top.txt",
      "tracked/keep.txt",
      "tracked/removed.txt",
      "whole/a.txt",
      "whole/nested/b.txt",
      "cached.log",
      "replaced",
    ]) {
      writeWorkFile(workspace, `/${path}`, `${path}\n`);
    }
    commitFiles(workspace, [
      ".gitignore",
      "cached.log",
      "replaced",
      "top.txt",
      "tracked/keep.txt",
      "tracked/removed.txt",
      "whole/a.txt",
      "whole/nested/b.txt",
    ]);
    sealIndexTracker(workspace);
    for (const path of [
      "cached.log",
      "top.txt",
      "tracked/removed.txt",
      "whole/a.txt",
      "whole/nested/b.txt",
    ]) {
      workspace.repo.checkout.indexRemove(path);
    }
    workspace.worktree.unlink("/replaced");
    writeWorkFile(workspace, "/replaced/inner.txt", "inner\n");

    expect(
      status(workspace.repo, workspace.worktree)
        .filter((row) => row.worktree === "?")
        .map((row) => row.path),
    ).toEqual(["top.txt", "tracked/removed.txt", "whole/"]);

    const optionWitnesses: StatusOptions[] = [
      { untrackedFiles: "no", includeIgnored: true },
      { untrackedFiles: "normal" },
      { untrackedFiles: "normal", includeIgnored: true },
      { untrackedFiles: "all", includeIgnored: true },
    ];
    for (const options of optionWitnesses) {
      const expected = status(workspace.repo, workspace.worktree, options);
      expect(
        eagerStatus(
          workspace.repo,
          new NoScanWorktree(workspace.worktree),
          options,
          sparseTrackerContext(workspace),
        ),
        JSON.stringify(options),
      ).toEqual(expected);
    }

    const normal = eagerStatus(
      workspace.repo,
      new NoScanWorktree(workspace.worktree),
      {},
      sparseTrackerContext(workspace),
    );
    expect(normal.filter((row) => row.worktree === "?").map((row) => row.path)).toEqual([
      "top.txt",
      "tracked/removed.txt",
      "whole/",
    ]);
    expect(normal.filter((row) => row.path === "replaced/inner.txt")).toEqual([]);
    expect(
      [...requireSparseWorkspace(workspace).dirtyPaths(workspace.repo.checkout.checkoutId)].map(
        (entry) => entry.path,
      ),
    ).toEqual(
      expect.arrayContaining([
        "cached.log",
        "top.txt",
        "tracked/removed.txt",
        "whole/a.txt",
        "whole/nested/b.txt",
      ]),
    );
  });

  it("matches full status and Git when only unmerged stages track an untracked directory", () => {
    const fixture = new GitFixture().init();
    try {
      fixture.write("conflict/file.txt", "base\n");
      const base = fixture.commit("base");
      fixture.git("checkout", "-q", "-b", "topic", base);
      fixture.write("conflict/file.txt", "incoming\n");
      fixture.commit("incoming");
      fixture.git("checkout", "-q", "main");
      fixture.write("conflict/file.txt", "current\n");
      fixture.commit("current");
      expect(() => fixture.git("merge", "topic")).toThrow();
      fixture.write("conflict/untracked/deep.txt", "fresh\n");
      const gitRows = fixture
        .git("status", "--porcelain=v2", "--untracked-files=normal")
        .split("\n");
      expect(
        gitRows.some((row) => row.startsWith("u UU ") && row.endsWith(" conflict/file.txt")),
      ).toBe(true);
      expect(gitRows).toContain("? conflict/untracked/");

      const workspace = makeRepo("/");
      writeWorkFile(workspace, "/conflict/file.txt", "base\n");
      commitFiles(workspace, ["conflict/file.txt"]);
      sealIndexTracker(workspace);
      const baseEntry = workspace.repo.checkout.indexGet("conflict/file.txt", 0);
      if (baseEntry === null) throw new Error("base index entry is missing");
      workspace.repo.checkout.indexRemove("conflict/file.txt");
      const currentOid = workspace.repo.store.write("blob", new TextEncoder().encode("current\n"));
      const incomingOid = workspace.repo.store.write(
        "blob",
        new TextEncoder().encode("incoming\n"),
      );
      const stages: Array<{ stage: number; oid: string }> = [
        { stage: 1, oid: baseEntry.oid },
        { stage: 2, oid: currentOid },
        { stage: 3, oid: incomingOid },
      ];
      for (const { stage, oid } of stages) {
        workspace.repo.checkout.indexPut({
          path: "conflict/file.txt",
          stage,
          mode: 0o100644,
          oid,
          size: null,
          mtime: null,
          ino: null,
        });
      }
      writeWorkFile(workspace, "/conflict/file.txt", "conflicted\n");
      writeWorkFile(workspace, "/conflict/untracked/deep.txt", "fresh\n");

      const full = status(workspace.repo, workspace.worktree);
      const sparse = eagerStatus(
        workspace.repo,
        new NoScanWorktree(workspace.worktree),
        {},
        sparseTrackerContext(workspace),
      );
      expect(sparse).toEqual(full);
      expect(
        sparse.map((row) => ({ path: row.path, index: row.index, worktree: row.worktree })),
      ).toEqual([
        { path: "conflict/file.txt", index: "U", worktree: "U" },
        { path: "conflict/untracked/", index: " ", worktree: "?" },
      ]);
      expect([
        ...requireSparseWorkspace(workspace).dirtyPaths(workspace.repo.checkout.checkoutId),
      ]).toEqual([
        { path: "conflict/file.txt", flags: INDEX_DIRTY | WORKTREE_DIRTY },
        { path: "conflict/untracked/deep.txt", flags: WORKTREE_DIRTY },
      ]);
    } finally {
      fixture.dispose();
    }
  });

  it("keeps sparse statement count within target as normal untracked leaves grow", () => {
    const measure = (count: number): number => {
      const workspace = makeRepo("/");
      sealIndexTracker(workspace);
      for (let index = 0; index < count; index++) {
        writeWorkFile(
          workspace,
          `/fresh/d${index.toString().padStart(3, "0")}/leaf.txt`,
          "fresh\n",
        );
      }
      const source = requireSparseWorkspace(workspace);
      const lookup = source.indexAncestorFacts;
      if (lookup === undefined) throw new Error("SQLite sparse workspace has no ancestor lookup");
      const ancestorStatements: number[] = [];
      workspace.storage.resetCounters();
      expect(
        eagerStatus(
          workspace.repo,
          new NoScanWorktree(workspace.worktree),
          {},
          sparseTrackerContext(workspace, {
            ...source,
            indexAncestorFacts(request) {
              const before = workspace.storage.statementCount;
              const result = lookup(request);
              ancestorStatements.push(workspace.storage.statementCount - before);
              return result;
            },
          }),
        ).map((row) => row.path),
      ).toEqual(["fresh/"]);
      expect(ancestorStatements).toEqual([1]);
      return workspace.storage.statementCount;
    };

    const one = measure(1);
    const many = measure(400);
    expect(one).toBeLessThan(1_000);
    expect(many).toBeLessThan(1_000);
  });

  it("rejects ancestor facts above retained headroom before SQL", () => {
    const workspace = makeRepo("/");
    const lookup = requireSparseWorkspace(workspace).indexAncestorFacts;
    if (lookup === undefined) throw new Error("SQLite sparse workspace has no ancestor lookup");
    workspace.storage.resetCounters();

    expect(() =>
      lookup({
        checkoutId: workspace.repo.checkout.checkoutId,
        ancestors: ["fresh"],
        maxRetainedBytes: 0,
      }),
    ).toThrowError(expect.objectContaining({ code: "E2BIG" }));
    expect(workspace.storage.statementCount).toBe(0);
  });

  it("rejects malformed ancestor requests before SQL", () => {
    const workspace = makeRepo("/");
    const lookup = requireSparseWorkspace(workspace).indexAncestorFacts;
    if (lookup === undefined) throw new Error("SQLite sparse workspace has no ancestor lookup");
    const sparseAncestors = new Array<string>(1);
    const checkoutId = workspace.repo.checkout.checkoutId;
    const malformed: unknown[] = [
      null,
      {},
      { checkoutId, ancestors: null },
      { checkoutId, ancestors: sparseAncestors },
      { checkoutId, ancestors: ["valid", 1] },
      { checkoutId, ancestors: ["valid"], maxRetainedBytes: "large" },
    ];

    for (const request of malformed) {
      workspace.storage.resetCounters();
      expect(() => Reflect.apply(lookup, undefined, [request])).toThrowError(
        expect.objectContaining({ code: "EINVAL" }),
      );
      expect(workspace.storage.statementCount).toBe(0);
    }
  });

  it.each([-1, 1])("rejects malformed ancestor path_bytes=%i", (pathBytes) => {
    const workspace = makeRepo("/");
    const source = createSqliteSparseWorkspaceSource(
      new MutatingAncestorDatabase(workspace.database.db, (row) => ({
        ...row,
        wanted_path_bytes: pathBytes,
      })),
    );
    const lookup = source.indexAncestorFacts;
    if (lookup === undefined) throw new Error("SQLite sparse workspace has no ancestor lookup");

    expect(() =>
      lookup({ checkoutId: workspace.repo.checkout.checkoutId, ancestors: ["føø"] }),
    ).toThrowError(expect.objectContaining({ code: "ECORRUPT" }));
  });

  it.each(ANCESTOR_INDEX_CORRUPTIONS)(
    "fails closed on a relevant $name index row without resealing",
    ({ mutate }) => {
      const workspace = makeRepo("/");
      writeWorkFile(workspace, "/tracked/file.txt", "tracked\n");
      commitFiles(workspace, ["tracked/file.txt"]);
      sealIndexTracker(workspace);
      writeWorkFile(workspace, "/tracked/new/deep.txt", "fresh\n");
      mutate(workspace);
      const dirtyAfterCorruption = [
        ...requireSparseWorkspace(workspace).dirtyPaths(workspace.repo.checkout.checkoutId),
      ];
      const recorded = recordingContext(workspace);

      expect(() =>
        eagerStatus(workspace.repo, new NoScanWorktree(workspace.worktree), {}, recorded.context),
      ).toThrowError(expect.objectContaining({ code: "ECORRUPT" }));
      expect(recorded.reseals).toEqual([]);
      expect([
        ...requireSparseWorkspace(workspace).dirtyPaths(workspace.repo.checkout.checkoutId),
      ]).toEqual(dirtyAfterCorruption);
    },
  );

  it("falls back when capabilities or tracker state are unavailable", () => {
    const workspace = makeRepo("/");
    writeWorkFile(workspace, "/untracked.txt", "untracked\n");
    const expected = status(workspace.repo, workspace.worktree);

    expect(eagerStatus(workspace.repo, workspace.worktree, {}, {})).toEqual(expected);
    expect(
      eagerStatus(workspace.repo, workspace.worktree, {}, sparseTrackerContext(workspace)),
    ).toEqual(expected);
  });

  it("does not reseal a filtered or only partly capable full status", () => {
    const workspace = makeRepo("/");
    writeWorkFile(workspace, "/a.txt", "a\n");
    const recorded = recordingContext(workspace);

    expect(
      eagerStatus(workspace.repo, workspace.worktree, { paths: ["a.txt"] }, recorded.context),
    ).toHaveLength(1);
    expect(
      eagerStatus(
        workspace.repo,
        workspace.worktree,
        { excludeRoots: ["/nested"] },
        recorded.context,
      ),
    ).toHaveLength(1);
    expect(
      eagerStatus(
        workspace.repo,
        workspace.worktree,
        {},
        {
          sparseWorkspace: workspace.context.sparseWorkspace,
        },
      ),
    ).toHaveLength(1);
    expect(
      eagerStatus(
        workspace.repo,
        workspace.worktree,
        {},
        {
          indexTracker: recorded.context.indexTracker,
        },
      ),
    ).toHaveLength(1);
    expect(recorded.reseals).toEqual([]);
    expect(
      readIndexTrackerState(workspace.database.db, workspace.repo.checkout.checkoutId),
    ).toEqual({
      available: false,
    });
  });

  it("does not reseal a partial full status when hashing fails", () => {
    const workspace = makeRepo("/");
    writeWorkFile(workspace, "/a.txt", "before\n");
    commitFiles(workspace, ["a.txt"]);
    workspace.tick(60_000);
    writeWorkFile(workspace, "/a.txt", "after\n");
    const recorded = recordingContext(workspace);

    expect(() =>
      eagerStatus(
        workspace.repo,
        new FailingHashWorktree(workspace.worktree),
        {},
        recorded.context,
      ),
    ).toThrowError(/injected hash failure/);
    expect(recorded.reseals).toEqual([]);
    expect(
      readIndexTrackerState(workspace.database.db, workspace.repo.checkout.checkoutId),
    ).toEqual({
      available: false,
    });
  });

  it("keeps the exported lazy status stream side-effect free when abandoned", () => {
    const workspace = makeRepo("/");
    writeWorkFile(workspace, "/a.txt", "a\n");
    const stream = statusStream(workspace.repo, workspace.worktree, { untrackedFiles: "all" });

    expect(stream.next().value).toEqual(expect.objectContaining({ path: "a.txt" }));
    stream.return(undefined);
    expect(
      readIndexTrackerState(workspace.database.db, workspace.repo.checkout.checkoutId),
    ).toEqual({
      available: false,
    });
  });

  it("returns normal status and reseals after the former dirty-row cap", () => {
    const workspace = makeRepo("/");
    workspace.repo.checkout.indexReplace(
      Array.from({ length: 32_001 }, (_, index) =>
        bareIndexEntry(`f${index.toString().padStart(5, "0")}.txt`),
      ),
    );
    const recorded = recordingContext(workspace);

    expect(
      eagerStatus(workspace.repo, workspace.worktree, { untrackedFiles: "all" }, recorded.context),
    ).toHaveLength(32_001);
    expect(recorded.reseals).toHaveLength(1);
    expect(recorded.reseals[0]?.entries).toHaveLength(32_001);
    expect(recorded.reseals[0]?.entries[0]).toEqual({ path: "f00000.txt", flags: 3 });
    expect(recorded.reseals[0]?.entries.at(-1)).toEqual({
      path: "f32000.txt",
      flags: 3,
    });
  });

  it("returns normal status and skips reseal above the retained-memory cap", () => {
    const workspace = makeRepo("/");
    const suffix = "x".repeat(2_000);
    workspace.repo.checkout.indexReplace(
      Array.from({ length: 4_000 }, (_, index) =>
        bareIndexEntry(`${index.toString().padStart(4, "0")}/${suffix}`),
      ),
    );
    const recorded = recordingContext(workspace);

    expect(
      eagerStatus(workspace.repo, workspace.worktree, { untrackedFiles: "all" }, recorded.context),
    ).toHaveLength(4_000);
    expect(recorded.reseals).toEqual([]);
  });

  it("skips reseal for a worktree leaf the tracker cannot represent", () => {
    const workspace = makeRepo("/");
    const path = "x".repeat(2_201);
    writeWorkFile(workspace, `/${path}`, "large path\n");
    const recorded = recordingContext(workspace);

    expect(
      eagerStatus(workspace.repo, workspace.worktree, { untrackedFiles: "all" }, recorded.context),
    ).toEqual([expect.objectContaining({ path })]);
    expect(recorded.reseals).toEqual([]);
  });

  it("uses the tree diff when HEAD changes after the tracker baseline", () => {
    const workspace = makeRepo("/");
    writeWorkFile(workspace, "/a.txt", "one\n");
    commitFiles(workspace, ["a.txt"]);
    const oldTree = workspace.repo.headTree();
    writeWorkFile(workspace, "/a.txt", "two\n");
    const hashed = hashWorktreePath(workspace.repo, workspace.worktree, "a.txt");
    if (hashed === null) throw new Error("missing updated fixture");
    workspace.repo.checkout.indexPut(indexEntryFor("a.txt", hashed));
    commit(workspace.context, workspace.repo, { message: "second" });
    sealIndexTracker(workspace, { baselineTreeOid: oldTree });

    expect(
      eagerStatus(
        workspace.repo,
        new NoScanWorktree(workspace.worktree),
        {},
        sparseTrackerContext(workspace),
      ),
    ).toEqual([]);
    expect(
      readIndexTrackerState(workspace.database.db, workspace.repo.checkout.checkoutId),
    ).toEqual({
      available: true,
      baselineTreeOid: workspace.repo.headTree(),
    });
  });

  it("uses the advanced commit baseline while retaining the dirty journal", () => {
    const workspace = makeRepo("/");
    writeWorkFile(workspace, "/a.txt", "one\n");
    commitFiles(workspace, ["a.txt"]);
    sealIndexTracker(workspace);
    writeWorkFile(workspace, "/a.txt", "two\n");
    stageWorktreePaths(workspace, ["a.txt"]);
    const context: GitContext = {
      ...workspace.context,
      commitTrees: createSqliteCommitTreeSnapshotSource(workspace.database.db),
      indexTracker: {
        reseal: (checkoutId, baselineTreeOid, entries) =>
          resealIndexTracker(workspace.database.db, checkoutId, baselineTreeOid, entries),
        advanceBaseline: (checkoutId, baselineTreeOid) =>
          advanceIndexTrackerBaseline(workspace.database.db, checkoutId, baselineTreeOid),
      },
    };

    const oid = commit(context, workspace.repo, { message: "second" }).oid;

    expect([
      ...requireSparseWorkspace(workspace).dirtyPaths(workspace.repo.checkout.checkoutId),
    ]).toEqual([{ path: "a.txt", flags: INDEX_DIRTY | WORKTREE_DIRTY }]);
    expect(
      readIndexTrackerState(workspace.database.db, workspace.repo.checkout.checkoutId),
    ).toEqual({ available: true, baselineTreeOid: workspace.repo.readCommit(oid).tree });
    workspace.storage.resetCounters();
    expect(
      eagerStatus(workspace.repo, new NoScanWorktree(workspace.worktree), {}, context),
    ).toEqual([]);
    expect(workspace.storage.statementCount).toBeLessThan(1_000);
  });

  it("propagates sparse hydration corruption without resealing", () => {
    const workspace = makeRepo("/");
    sealIndexTracker(workspace, { entries: [{ path: "broken.txt", flags: INDEX_DIRTY }] });
    const source = requireSparseWorkspace(workspace);
    const broken: SparseWorkspaceSource = {
      readState: (checkoutId) => source.readState(checkoutId),
      dirtyPaths: (checkoutId) => source.dirtyPaths(checkoutId),
      hydrate: () => {
        throw new CorruptError("injected sparse corruption");
      },
    };
    let reseals = 0;
    const context: Pick<GitContext, "sparseWorkspace" | "indexTracker"> = {
      sparseWorkspace: broken,
      indexTracker: {
        reseal: () => {
          reseals++;
          return true;
        },
      },
    };

    expect(() => eagerStatus(workspace.repo, workspace.worktree, {}, context)).toThrowError(
      /injected sparse corruption/,
    );
    expect(reseals).toBe(0);
  });

  it("falls back when bounded dirty traversal reports E2BIG", () => {
    const workspace = makeRepo("/");
    let hydrates = 0;
    let reseals = 0;
    const source: SparseWorkspaceSource = {
      readState: () => ({ available: true, baselineTreeOid: null }),
      dirtyPaths: function* () {
        yield* [];
        throw new GitError("E2BIG", "injected sparse bound");
      },
      hydrate: () => {
        hydrates++;
        return { available: false };
      },
    };
    const context: Pick<GitContext, "sparseWorkspace" | "indexTracker"> = {
      sparseWorkspace: source,
      indexTracker: {
        reseal: () => {
          reseals++;
          return true;
        },
      },
    };

    expect(eagerStatus(workspace.repo, workspace.worktree, {}, context)).toEqual([]);
    expect(hydrates).toBe(0);
    expect(reseals).toBe(0);
  });
});
