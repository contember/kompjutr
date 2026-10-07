// Whole-tree `git add` over the complete index tracker. Every journey runs
// twice — with the tracker sealed and with it invalidated — against the real
// git binary, so the tracker-driven candidate set must stage exactly what the
// full index and filesystem scan stages.

import { afterEach, describe, expect, it } from "vitest";
import type { SqlDatabase } from "../packages/do/src/db/db.js";
import type { RealPath } from "../packages/do/src/fs/types.js";
import { utf8 } from "../packages/git/src/common/bytes.js";
import { createSqliteSparseCapability } from "../packages/git/src/do-fs/index.js";
import {
  invalidateIndexTracker,
  readIndexTrackerState,
  resealIndexTracker,
} from "../packages/git/src/do-fs/indexes/index-tracker.js";
import { nestedRoots, openRepository } from "../packages/git/src/ops/core/context.js";
import { commit } from "../packages/git/src/ops/repository/commit.js";
import { initRepository } from "../packages/git/src/ops/repository/init.js";
import { add } from "../packages/git/src/ops/staging/staging.js";
import { eagerStatus } from "../packages/git/src/ops/status/status.js";
import { SqliteGitDatabase } from "../packages/git/src/store/index.js";
import { createWorld, type E2EStep, type E2EWorld, WORK } from "./helpers/e2e.js";
import {
  configureFixtureIdentity,
  sparseTrackerContext,
  stageWorktreePaths,
} from "./helpers/sparse.js";
import { makeRepo, type TestRepository, writeWorkFile } from "./helpers/workspace.js";
import { CountingWorktree } from "./helpers/worktree.js";

type TrackerMode = "sealed" | "invalid";

let world: E2EWorld | undefined;

afterEach(async () => {
  await world?.dispose();
  world = undefined;
});

function checkoutId(target: E2EWorld): number {
  const id = target.workspace.db.scalar<unknown>(
    "SELECT id FROM git_checkouts WHERE root = ?",
    WORK,
  );
  if (typeof id !== "number") throw new Error("e2e checkout is missing");
  return id;
}

function trackerComplete(target: E2EWorld): boolean {
  return readIndexTrackerState(target.workspace.db, checkoutId(target)).available;
}

/** Seal through eager status, the production reseal, or invalidate. */
function track(mode: TrackerMode): E2EStep {
  return {
    op: "custom",
    async local(git, target) {
      if (mode === "sealed") await git.status({ dir: WORK });
      else invalidateIndexTracker(target.workspace.db, checkoutId(target));
      expect(trackerComplete(target)).toBe(mode === "sealed");
    },
    mirror: () => {},
  };
}

/** Seal with no dirty rows, so pre-existing ignored files have none either. */
function sealClean(): E2EStep {
  return {
    op: "custom",
    local(_git, target) {
      const repo = openRepository(
        {
          database: new SqliteGitDatabase(target.workspace.db),
          worktree: target.workspace.filesystem,
          now: () => 0,
          timezoneOffset: () => 0,
        },
        WORK,
      );
      expect(
        resealIndexTracker(target.workspace.db, repo.checkout.checkoutId, repo.headTree(), []),
      ).toBe(true);
    },
    mirror: () => {},
  };
}

/** The tracker state a whole-tree add is about to observe. */
function expectTracker(mode: TrackerMode): E2EStep {
  return {
    op: "custom",
    local(_git, target) {
      expect(trackerComplete(target)).toBe(mode === "sealed");
    },
    mirror: () => {},
  };
}

describe.each<TrackerMode>(["sealed", "invalid"])("whole-tree add, tracker %s", (mode) => {
  it("stages deletions, partial staging, -u and -A", async () => {
    world = await createWorld({
      seed: {
        "README.md": "seed\n",
        "a.txt": "a\n",
        "b.txt": "b\n",
        "dir/c.txt": "c\n",
        "dir/d.txt": "d\n",
      },
    });
    await world.run(
      track(mode),
      { op: "write", path: "a.txt", content: "a1\n" },
      { op: "remove", path: "b.txt" },
      { op: "remove", path: "dir/c.txt" },
      { op: "write", path: "new.txt", content: "new\n" },
      { op: "write", path: "dir/e.txt", content: "e\n" },
      // A selected add leaves every dirty path outside the selection alone.
      { op: "add", paths: ["a.txt"] },
      expectTracker(mode),
      { op: "write", path: "a.txt", content: "a2\n" },
      { op: "add", all: true, trackedOnly: true },
      expectTracker(mode),
      { op: "add", all: true },
      { op: "commit", message: "one" },
      expectTracker(mode),
      { op: "write", path: "README.md", content: "changed\n" },
      { op: "add", paths: ["."] },
      { op: "commit", message: "two" },
    );
  });

  it("stages conflict resolutions, including a deleted path", async () => {
    world = await createWorld({
      seed: { "story.txt": "one\ntwo\n", "doomed.txt": "keep\n", "other.txt": "stable\n" },
    });
    await world.run(
      track(mode),
      { op: "branch", name: "feature", checkout: true },
      { op: "write", path: "story.txt", content: "one\nfeature\n" },
      { op: "remove", path: "doomed.txt" },
      { op: "add", all: true },
      { op: "commit", message: "feature" },
      { op: "checkout", ref: "main" },
      { op: "write", path: "story.txt", content: "one\nmain\n" },
      { op: "write", path: "doomed.txt", content: "keep, edited\n" },
      { op: "add", paths: ["."] },
      { op: "commit", message: "main" },
      { op: "merge", theirs: "feature", message: "merge", expect: { outcome: "conflicted" } },
      { op: "write", path: "story.txt", content: "one\nboth\n" },
      { op: "remove", path: "doomed.txt" },
      expectTracker(mode),
      { op: "add", paths: ["."] },
      { op: "mergeContinue", message: "merge" },
    );
  });

  it("re-adds a path after rm --cached", async () => {
    world = await createWorld({ seed: { "a.txt": "a\n", "b.txt": "b\n" } });
    await world.run(
      track(mode),
      { op: "rm", paths: ["a.txt"], cached: true },
      expectTracker(mode),
      { op: "add", paths: ["."] },
      { op: "rm", paths: ["b.txt"], cached: true },
      { op: "write", path: "b.txt", content: "b changed\n" },
      expectTracker(mode),
      { op: "add", all: true },
    );
  });

  it("keeps ignored files out unless forced, even when they predate the seal", async () => {
    world = await createWorld({ seed: { ".gitignore": "*.log\n", "README.md": "seed\n" } });
    await world.run(
      { op: "write", path: "early.log", content: "before the seal\n" },
      mode === "sealed" ? sealClean() : track(mode),
      { op: "write", path: "late.log", content: "after the seal\n" },
      { op: "write", path: "new.txt", content: "new\n" },
      expectTracker(mode),
      { op: "add", paths: ["."] },
      expectTracker(mode),
      { op: "add", paths: ["."], force: true },
      { op: "commit", message: "forced" },
      { op: "write", path: "later.log", content: "later\n" },
      expectTracker(mode),
      { op: "add", all: true, force: true },
    );
  });

  it("stages a directory replaced by a file and back", async () => {
    world = await createWorld({
      seed: { "README.md": "seed\n", "d/x.txt": "x\n", "f.txt": "f\n" },
    });
    await world.run(
      track(mode),
      { op: "remove", path: "d" },
      { op: "write", path: "d", content: "now a file\n" },
      { op: "remove", path: "f.txt" },
      { op: "write", path: "f.txt/y.txt", content: "now a directory\n" },
      expectTracker(mode),
      { op: "add", all: true },
      { op: "commit", message: "swap" },
      { op: "remove", path: "d" },
      { op: "write", path: "d/x.txt", content: "x again\n" },
      { op: "remove", path: "f.txt" },
      { op: "write", path: "f.txt", content: "f again\n" },
      expectTracker(mode),
      { op: "add", paths: ["."] },
      { op: "commit", message: "swap back" },
    );
  });

  it("falls back to the full scan once a .gitignore edit invalidates the tracker", async () => {
    world = await createWorld({ seed: { "README.md": "seed\n", "a.tmp": "tracked tmp\n" } });
    await world.run(
      track(mode),
      { op: "write", path: "b.tmp", content: "untracked tmp\n" },
      { op: "write", path: ".gitignore", content: "*.tmp\n" },
      { op: "write", path: "a.tmp", content: "tracked tmp, edited\n" },
      { op: "write", path: "c.txt", content: "c\n" },
      expectTracker("invalid"),
      { op: "add", paths: ["."] },
    );
  });

  it("stages against HEAD moved without touching the index", async () => {
    world = await createWorld({ seed: { "README.md": "seed\n", "a.txt": "a\n" } });
    await world.run(
      track(mode),
      { op: "write", path: "a.txt", content: "a2\n" },
      { op: "write", path: "b.txt", content: "b\n" },
      { op: "add", all: true },
      { op: "commit", message: "second" },
      {
        op: "custom",
        async local(git) {
          const parent = await git.revParse({ dir: WORK, ref: "HEAD~1" });
          await git.updateRef({ dir: WORK, ref: "refs/heads/main", value: parent, force: true });
        },
        mirror: (fixture) => fixture.git("reset", "-q", "--soft", "HEAD~1"),
      },
      { op: "write", path: "c.txt", content: "c\n" },
      { op: "remove", path: "b.txt" },
      expectTracker(mode),
      { op: "add", paths: ["."] },
      { op: "commit", message: "again" },
    );
  });

  it("stages a mode change and a file replaced by a symlink", async () => {
    world = await createWorld({
      seed: { "README.md": "seed\n", "run.sh": "echo\n", "link.txt": "file\n" },
    });
    // kompjutr's porcelain v2 reports a pending type change as `M` where git
    // says `T`, so each type change is compared once its commit lands.
    const typeChange = (toSymlink: boolean, message: string): E2EStep => ({
      op: "custom",
      async local(_git, target) {
        await target.runLocal(
          { op: "remove", path: "link.txt" },
          toSymlink
            ? { op: "symlink", path: "link.txt", target: "README.md" }
            : { op: "write", path: "link.txt", content: "file again\n" },
          expectTracker(mode),
          toSymlink ? { op: "add", paths: ["."] } : { op: "add", all: true },
          { op: "commit", message },
        );
      },
      mirror(fixture) {
        fixture.remove("link.txt");
        if (toSymlink) fixture.symlink("README.md", "link.txt");
        else fixture.write("link.txt", "file again\n");
        fixture.git("add", ...(toSymlink ? ["--", "."] : ["--all"]));
        fixture.git("commit", "-q", "-m", message);
      },
    });
    await world.run(
      track(mode),
      { op: "chmod", path: "run.sh", mode: 0o755 },
      typeChange(true, "to symlink"),
      { op: "chmod", path: "run.sh", mode: 0o644 },
      typeChange(false, "to file"),
    );
  });

  it("leaves dirty paths outside a selection unstaged and reported", async () => {
    world = await createWorld({ seed: { "a.txt": "a\n", "b.txt": "b\n" } });
    await world.run(
      track(mode),
      { op: "write", path: "a.txt", content: "a2\n" },
      { op: "write", path: "b.txt", content: "b2\n" },
      { op: "add", paths: ["a.txt"] },
      expectTracker(mode),
      {
        op: "custom",
        // The compared snapshot uses the full status; this checks the eager one.
        async local(git) {
          await expect(git.status({ dir: WORK })).resolves.toEqual([
            { path: "a.txt", index: "M", worktree: " " },
            { path: "b.txt", index: " ", worktree: "M" },
          ]);
        },
        mirror: () => {},
      },
    );
  });
});

describe.each<TrackerMode>(["sealed", "invalid"])(
  "whole-tree add beside a nested repository, tracker %s",
  (mode) => {
    // Git records a nested repository as a gitlink and kompjutr excludes it,
    // so this case has no git parity and asserts the full scan directly.
    it("takes the full scan and leaves the nested repository out", () => {
      const workspace = cleanRepository();
      initRepository(workspace.context, { dir: "/nested" });
      writeWorkFile(workspace, "/nested/inside.txt", "nested\n");
      writeWorkFile(workspace, "/outside.txt", "outside\n");
      if (mode === "sealed") sealThroughStatus(workspace);
      else invalidateIndexTracker(workspace.database.db, workspace.repo.checkout.checkoutId);
      const excludeRoots = nestedRoots(workspace.context, workspace.repo.root);
      expect(excludeRoots).toEqual(["/nested"]);
      const worktree = new NoScanWorktree(workspace.worktree);

      expect(() =>
        add(workspace.repo, worktree, { paths: [], all: true, excludeRoots }, workspace.context),
      ).toThrow(/must not scan/);
      add(
        workspace.repo,
        workspace.worktree,
        { paths: [], all: true, excludeRoots },
        workspace.context,
      );

      expect(workspace.repo.checkout.indexGet("outside.txt")).toBeDefined();
      expect(workspace.repo.checkout.indexGet("nested/inside.txt")).toBeNull();
    });
  },
);

class NoScanWorktree extends CountingWorktree {
  scans = 0;

  override scanStream(root: RealPath): never {
    this.scans++;
    throw new Error(`tracker-driven add must not scan ${root}`);
  }
}

/** 2,000 committed files whose index rows already hold stat data. */
function cleanRepository(): TestRepository {
  const workspace = makeRepo("/");
  const paths = Array.from(
    { length: 2_000 },
    (_, index) => `d${Math.floor(index / 100)}/f${index % 100}.txt`,
  );
  workspace.worktree.writeFiles(
    paths.map((path) => ({ path: `/${path}`, bytes: utf8.encode(`${path}\n`) })),
  );
  configureFixtureIdentity(workspace);
  stageWorktreePaths(workspace, paths);
  commit(workspace.context, workspace.repo, { message: "fixture" });
  workspace.tick(1_000);
  return workspace;
}

function sealThroughStatus(workspace: TestRepository): void {
  eagerStatus(workspace.repo, workspace.worktree, {}, sparseTrackerContext(workspace));
  expect(
    readIndexTrackerState(workspace.database.db, workspace.repo.checkout.checkoutId).available,
  ).toBe(true);
}

describe("tracker-driven add cost", () => {
  it("reads rows proportional to candidates on a second clean add", () => {
    const workspace = cleanRepository();
    add(workspace.repo, workspace.worktree, { paths: ["."] }, workspace.context);
    sealThroughStatus(workspace);
    writeWorkFile(workspace, "/d3/f7.txt", "changed\n");
    writeWorkFile(workspace, "/zz-new.txt", "new\n");
    const worktree = new NoScanWorktree(workspace.worktree);
    workspace.storage.histogram = new Map();
    workspace.storage.resetCounters();

    add(workspace.repo, worktree, { paths: ["."] }, workspace.context);

    const statements = workspace.storage.statementCount;
    const rows = workspace.storage.rowCount;
    expect(worktree.scans).toBe(0);
    expect(worktree.bulkReadPaths).toEqual(["/d3/f7.txt", "/zz-new.txt"]);
    expect(statements).toBeLessThan(40);
    expect(rows).toBeLessThan(40);
    expect(workspace.repo.checkout.indexGet("zz-new.txt")).toBeDefined();

    workspace.storage.resetCounters();
    add(workspace.repo, worktree, { paths: [], all: true }, workspace.context);
    expect(workspace.storage.statementCount).toBeLessThan(40);
    expect(workspace.storage.rowCount).toBeLessThan(40);
    expect(worktree.bulkReadPaths).toHaveLength(2);
  });

  it("takes the full scan for a forced whole-tree add over a complete tracker", () => {
    const workspace = cleanRepository();
    sealThroughStatus(workspace);
    const worktree = new NoScanWorktree(workspace.worktree);
    expect(() =>
      add(workspace.repo, worktree, { paths: ["."], force: true }, workspace.context),
    ).toThrow(/must not scan/);
    expect(worktree.scans).toBe(1);
  });

  it("looks selected index rows up by the full key", () => {
    const workspace = cleanRepository();
    const recorded: Array<{ query: string; bindings: unknown[] }> = [];
    const db = workspace.database.db;
    const recording: SqlDatabase = {
      run: (query, ...bindings) => db.run(query, ...bindings),
      all: (query, ...bindings) => db.all(query, ...bindings),
      one: (query, ...bindings) => db.one(query, ...bindings),
      scalar: (query, ...bindings) => db.scalar(query, ...bindings),
      iterate(query, ...bindings) {
        recorded.push({ query, bindings });
        return db.iterate(query, ...bindings);
      },
      transactionSync: (closure) => db.transactionSync(closure),
    };
    const selectedContext = {
      selectedPaths: createSqliteSparseCapability(recording).selected,
      sparseWorkspace: workspace.context.sparseWorkspace,
    };
    const planOf = (prefix: string): string[] => {
      const selected = recorded.find(({ query }) => query.startsWith(prefix));
      if (selected === undefined) throw new Error(`${prefix} did not run`);
      return db
        .all<{ detail: string }>(`EXPLAIN QUERY PLAN ${selected.query}`, ...selected.bindings)
        .map((row) => row.detail);
    };
    writeWorkFile(workspace, "/d3/f7.txt", "changed\n");
    writeWorkFile(workspace, "/d4/new.txt", "new\n");

    add(workspace.repo, workspace.worktree, { paths: ["d3/f7.txt", "d4"] }, selectedContext);

    expect(planOf("WITH wanted(path) AS")).toContainEqual(
      expect.stringContaining("(checkout_id=? AND path=?)"),
    );
    const recursive = planOf("WITH wanted(path, recursive) AS");
    expect(recursive).toContainEqual(expect.stringContaining("(checkout_id=? AND path=?)"));
    expect(recursive).toContainEqual(
      expect.stringContaining("(checkout_id=? AND path>? AND path<?)"),
    );
    expect(workspace.repo.checkout.indexGet("d4/new.txt")).toBeDefined();
  });
});
