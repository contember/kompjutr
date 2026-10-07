// ADR-0030: pack ingest projects no tree; readers project the closures they
// walk, and the projected set stays downward-closed.

import { afterAll, describe, expect, it } from "vitest";
import { runGitCli } from "../packages/git/src/cli/index.js";
import { createGitCliReadHandlers } from "../packages/git/src/cli/read/read.js";
import { GitError } from "../packages/git/src/common/errors.js";
import {
  hashObject,
  MODE_FILE,
  MODE_TREE,
  serializeTree,
} from "../packages/git/src/common/objects.js";
import { createSqliteSparseCapability } from "../packages/git/src/do-fs/index.js";
import { openRepository } from "../packages/git/src/ops/core/context.js";
import { clone } from "../packages/git/src/ops/network/network.js";
import { checkout } from "../packages/git/src/ops/refs/refs.js";
import { commit } from "../packages/git/src/ops/repository/commit.js";
import { lsTree } from "../packages/git/src/ops/repository/reads.js";
import { add } from "../packages/git/src/ops/staging/staging.js";
import { reset } from "../packages/git/src/ops/staging/staging-reset.js";
import { SqliteGitDatabase } from "../packages/git/src/store/index.js";
import { TestDatabase } from "./helpers/db.js";
import {
  blobObject as blob,
  commitObject,
  fetchPacked,
  type PackObject,
  packOf,
  treeObject as tree,
} from "./helpers/fetch-pack.js";
import { GitFixture, slices } from "./helpers/git.js";
import { startGitServer } from "./helpers/http-backend.js";
import { makeWorkspace, type TestRepository, type TestWorkspace } from "./helpers/workspace.js";

const OID = "1".repeat(40);
const fixtures: GitFixture[] = [];
afterAll(() => {
  for (const fixture of fixtures) fixture.dispose();
});

/** Five commits; each changes a file in a different nested directory, so old trees differ. */
function historyFixture(): GitFixture {
  const fixture = new GitFixture().init();
  fixtures.push(fixture);
  fixture.write("README.md", "readme\n");
  fixture.write("src/lib/a.txt", "a0\n");
  fixture.write("src/app/b.txt", "b0\n");
  fixture.write("docs/guide/c.txt", "c0\n");
  fixture.commit("initial");
  for (const [path, text] of [
    ["src/lib/a.txt", "a1\n"],
    ["docs/guide/c.txt", "c1\n"],
    ["src/app/b.txt", "b1\n"],
    ["src/lib/deeper/d.txt", "d1\n"],
  ] as const) {
    fixture.write(path, text);
    fixture.commit(`change ${path}`);
  }
  return fixture;
}

/** Every tree of `revision`'s closure, root included, as native Git lists them. */
function closure(fixture: GitFixture, revision: string): Set<string> {
  const trees = new Set([fixture.git("rev-parse", `${revision}^{tree}`)]);
  for (const line of fixture.git("ls-tree", "-r", "-t", revision).split("\n")) {
    const [mode, type, oid] = line.split("\t")[0]?.split(" ") ?? [];
    if (mode !== undefined && type === "tree" && oid !== undefined) trees.add(oid);
  }
  return trees;
}

function projectedTrees(db: { all<Row extends object>(query: string): Row[] }): Set<string> {
  return new Set(
    db
      .all<{ tree_oid: string }>("SELECT tree_oid FROM git_tree_sources WHERE complete = 1")
      .map((row) => row.tree_oid),
  );
}

/** Subtrees a projected tree names without any projection row; the invariant demands none. */
function unclosedSubtrees(db: { scalar<T>(query: string): T | undefined }): number | undefined {
  return db.scalar<number>(
    `SELECT count(*) FROM git_tree_sources parent
       JOIN git_tree_entries entry ON entry.source_key = parent.source_key
      WHERE parent.complete = 1 AND entry.mode IN ('40000', '040000')
        AND NOT EXISTS (
          SELECT 1 FROM git_tree_sources child
           WHERE child.repo_id = parent.repo_id AND child.tree_oid = entry.oid
        )`,
  );
}

/** Count every later projection write: entry inserts, source inserts and updates. */
function watchProjectionWrites(workspace: TestWorkspace): () => number {
  const db = workspace.storage.db;
  db.exec("CREATE TEMP TABLE projection_writes (n INTEGER)");
  for (const [name, event] of [
    ["entry_insert", "INSERT ON main.git_tree_entries"],
    ["source_insert", "INSERT ON main.git_tree_sources"],
    ["source_update", "UPDATE ON main.git_tree_sources"],
  ]) {
    db.exec(
      `CREATE TEMP TRIGGER ${name} AFTER ${event}
       BEGIN INSERT INTO projection_writes VALUES (1); END`,
    );
  }
  return () =>
    Number(db.prepare("SELECT count(*) AS n FROM projection_writes").get()?.n ?? Number.NaN);
}

async function clonedHistory() {
  const fixture = historyFixture();
  const server = await startGitServer(fixture.dir);
  const workspace = makeWorkspace();
  try {
    await clone(workspace.context, { url: server.url, dir: "/repo" });
  } finally {
    await server.close();
  }
  const db = new TestDatabase(workspace.storage);
  return { fixture, workspace, db, repo: openRepository(workspace.context, "/repo") };
}

function cli(workspace: TestWorkspace, argv: string[]) {
  return runGitCli({ argv, cwd: "/repo" }, createGitCliReadHandlers(workspace.context));
}

describe("trees projected on demand", () => {
  it("projects only the HEAD closure after a full-history clone", async () => {
    const { fixture, db } = await clonedHistory();
    expect(projectedTrees(db)).toEqual(closure(fixture, "HEAD"));
    expect(unclosedSubtrees(db)).toBe(0);
  });

  it("keeps the HEAD tree projected after clone, checkout, commit and reset", async () => {
    const { fixture, workspace, db, repo } = await clonedHistory();
    const headProjected = () => {
      expect(projectedTrees(db).has(repo.headTree() ?? "")).toBe(true);
      expect(unclosedSubtrees(db)).toBe(0);
    };
    headProjected();
    checkout(workspace.context, repo, workspace.worktree, {
      ref: fixture.git("rev-parse", "HEAD~3"),
    });
    headProjected();
    workspace.worktree.writeFiles([
      { path: "/repo/src/lib/e.txt", bytes: new TextEncoder().encode("e\n"), mode: 0o644 },
    ]);
    add(repo, workspace.worktree, { paths: ["src/lib/e.txt"] });
    repo.store.configSet("user.name", "Fixture");
    repo.store.configSet("user.email", "fixture@example.com");
    commit(workspace.context, repo, { message: "local\n" });
    headProjected();
    reset(workspace.context, repo, workspace.worktree, {
      ref: fixture.git("rev-parse", "HEAD~4"),
      hard: true,
    });
    headProjected();
  });

  it("falls back from the sparse tree snapshot after a soft reset to an unprojected commit", async () => {
    const { fixture, workspace, db, repo } = await clonedHistory();
    const commitTrees = createSqliteSparseCapability(db).commitTrees;
    const old = fixture.git("rev-parse", "HEAD~3");
    const oldTree = fixture.git("rev-parse", "HEAD~3^{tree}");
    const tipTree = fixture.git("rev-parse", "HEAD^{tree}");
    // `reset --soft`: the branch moves, index and worktree stay.
    repo.store.setRef("refs/heads/main", old);
    expect(projectedTrees(db).has(oldTree)).toBe(false);
    const request = {
      repoId: repo.store.repoId,
      checkoutId: repo.checkout.checkoutId,
      root: repo.root,
      baselineTreeOid: oldTree,
    };
    expect(commitTrees.snapshot(request).available).toBe(false);

    repo.store.configSet("user.name", "Fixture");
    repo.store.configSet("user.email", "fixture@example.com");
    const result = commit({ ...workspace.context, commitTrees }, repo, { message: "squash\n" });
    // Git commits the unchanged index: the tip's tree, now on top of the old commit.
    expect(repo.readCommit(result.oid).tree).toBe(tipTree);
    expect(repo.readCommit(result.oid).parent).toEqual([old]);
    expect(unclosedSubtrees(db)).toBe(0);
  });

  it("answers ls-tree, diff, show and log -p on old commits as git does, projecting once", async () => {
    const { fixture, workspace, db, repo } = await clonedHistory();
    const commits = fixture.git("rev-list", "HEAD").split("\n");
    const old = "HEAD~3";
    const before = projectedTrees(db);
    const read = new Set<string>();
    for (const commit of commits) for (const oid of closure(fixture, commit)) read.add(oid);

    const run = async () => {
      const listed = lsTree(repo, old, "", { recursive: true }).map(
        (entry) => `${entry.mode} ${entry.type} ${entry.oid}\t${entry.path}`,
      );
      expect(listed).toEqual(fixture.git("ls-tree", "-r", old).split("\n"));
      expect((await cli(workspace, ["diff", old, "HEAD"])).stdout).toBe(
        fixture.gitBinary("diff", old, "HEAD").toString("utf8"),
      );
      expect((await cli(workspace, ["show", old])).stdout).toBe(
        fixture.gitBinary("show", old).toString("utf8"),
      );
      // `log -p` is each commit's patch against its parent; the CLI exposes it through `show`.
      for (const commit of commits) {
        expect((await cli(workspace, ["show", commit])).stdout).toBe(
          fixture.gitBinary("show", commit).toString("utf8"),
        );
      }
    };

    await run();
    const created = new Set([...projectedTrees(db)].filter((oid) => !before.has(oid)));
    expect(created).toEqual(new Set([...read].filter((oid) => !before.has(oid))));
    expect(created.size).toBeGreaterThan(0);
    expect(unclosedSubtrees(db)).toBe(0);

    const writes = watchProjectionWrites(workspace);
    await run();
    expect(writes()).toBe(0);
  });

  it("leaves no projection row when a closure fails part-way", async () => {
    const fixture = historyFixture();
    const db = new FaultingDatabase();
    const database = new SqliteGitDatabase(db);
    const store = database.openCheckout(database.createRepository("/repo", "ref: refs/heads/main"));
    await store.packs.ingest(slices(fixture.packAll(), 64 * 1024));
    const root = fixture.git("rev-parse", "HEAD^{tree}");
    expect(db.scalar<number>("SELECT count(*) FROM git_tree_sources")).toBe(0);

    db.failMarkers = true;
    expect(() => [...store.walkTree(root)]).toThrow("injected projection fault");
    expect(db.scalar<number>("SELECT count(*) FROM git_tree_sources")).toBe(0);
    expect(db.scalar<number>("SELECT count(*) FROM git_tree_entries")).toBe(0);

    db.failMarkers = false;
    expect([...store.walkTree(root)].map((entry) => entry.path)).toEqual(
      fixture.git("ls-tree", "-r", "--name-only", "HEAD").split("\n"),
    );
    expect(unclosedSubtrees(db)).toBe(0);
  });

  it("stops a closure at an unprojectable subtree", async () => {
    const db = new RowLimitDatabase();
    const database = new SqliteGitDatabase(db);
    const store = database.openCheckout(database.createRepository("/repo", "ref: refs/heads/main"));
    const missing = hashObject("tree", serializeTree([{ mode: MODE_FILE, name: "g", oid: OID }]));
    // A name beyond the batch arena takes the single-row insert, which the row limit refuses.
    const oversized = tree([
      { mode: MODE_TREE, name: "grandchild", oid: missing },
      { mode: MODE_FILE, name: "n".repeat(200 * 1024), oid: OID },
    ]);
    const root = tree([{ mode: MODE_TREE, name: "big", oid: oversized.oid }]);
    await store.packs.ingest(slices(packOf([root, oversized]), 4096));

    expect(() => [...store.walkTree(root.oid)]).toThrowError(
      expect.objectContaining({ code: "ECORRUPT" }),
    );
    expect(
      db.all<{ tree_oid: string; complete: number }>(
        "SELECT tree_oid, complete FROM git_tree_sources ORDER BY complete",
      ),
    ).toEqual([
      { tree_oid: oversized.oid, complete: 0 },
      { tree_oid: root.oid, complete: 1 },
    ]);
  });

  it("projects the unprojected subtrees a loose tree names", async () => {
    const fixture = historyFixture();
    const db = new TestDatabase();
    const database = new SqliteGitDatabase(db);
    const store = database.openCheckout(database.createRepository("/repo", "ref: refs/heads/main"));
    await store.packs.ingest(slices(fixture.packAll(), 64 * 1024));
    const src = fixture.git("rev-parse", "HEAD~2:src");
    expect(db.scalar<number>("SELECT count(*) FROM git_tree_sources")).toBe(0);

    const top = store.write("tree", serializeTree([{ mode: MODE_TREE, name: "src", oid: src }]));
    const expected = closure(fixture, src);
    expected.add(top);
    expect(projectedTrees(db)).toEqual(expected);
    expect(unclosedSubtrees(db)).toBe(0);

    // A written tree may not name an absent subtree: "no row" must keep meaning "missing".
    const absent = hashObject("tree", serializeTree([{ mode: MODE_FILE, name: "x", oid: src }]));
    const dangling = serializeTree([{ mode: MODE_TREE, name: "gone", oid: absent }]);
    expect(() => store.write("tree", dangling)).toThrowError(
      expect.objectContaining({ code: "ENOTFOUND" }),
    );
    expect(store.has(hashObject("tree", dangling))).toBe(false);
    expect(unclosedSubtrees(db)).toBe(0);
  });

  it("projects the unprojected subtrees of trees written in a batch or streamed", async () => {
    const fixture = historyFixture();
    const db = new TestDatabase();
    const database = new SqliteGitDatabase(db);
    const store = database.openCheckout(database.createRepository("/repo", "ref: refs/heads/main"));
    await store.packs.ingest(slices(fixture.packAll(), 64 * 1024));
    const src = fixture.git("rev-parse", "HEAD~2:src");
    const docs = fixture.git("rev-parse", "HEAD~2:docs");

    const batched = store.writeObjects((batch) =>
      batch.write("tree", serializeTree([{ mode: MODE_TREE, name: "src", oid: src }])),
    );
    const expected = closure(fixture, src);
    expected.add(batched);
    expect(projectedTrees(db)).toEqual(expected);

    const data = serializeTree([{ mode: MODE_TREE, name: "docs", oid: docs }]);
    const streamed = store.writeStream("tree", data.length, () => [data]);
    for (const oid of closure(fixture, docs)) expected.add(oid);
    expected.add(streamed);
    expect(projectedTrees(db)).toEqual(expected);
    expect(unclosedSubtrees(db)).toBe(0);
  });
});

describe("a non-fresh fetch over unprojected history", () => {
  const kept = blob("kept\n");
  const nested = blob("nested\n");
  const dir = tree([{ mode: MODE_FILE, name: "nested", oid: nested.oid }]);
  const baseRoot = tree([
    { mode: MODE_FILE, name: "kept", oid: kept.oid },
    { mode: MODE_TREE, name: "dir", oid: dir.oid },
  ]);
  const base = commitObject(baseRoot.oid, [], "base\n");
  const added = blob("added\n");

  /** History in the store through an unchecked pack, which projects no tree. */
  function seed(extra: readonly PackObject[]) {
    return async ({ repo }: TestRepository): Promise<void> => {
      await repo.store.packs.ingest(
        slices(packOf([base, baseRoot, dir, kept, nested, ...extra]), 4096),
      );
      repo.store.setRef("refs/remotes/origin/main", base.oid);
      expect(repo.store.db.scalar<number>("SELECT count(*) FROM git_tree_sources")).toBe(0);
    };
  }

  function child(extra: { mode: string; name: string; oid: string }) {
    const root = tree([
      { mode: MODE_FILE, name: "added", oid: added.oid },
      { mode: MODE_TREE, name: "dir", oid: dir.oid },
      { mode: MODE_FILE, name: "kept", oid: kept.oid },
      extra,
    ]);
    return { root, commit: commitObject(root.oid, [base.oid], "child\n") };
  }

  it("projects the external closure it verifies and publishes", async () => {
    const leaf = blob("leaf\n");
    const outside = tree([{ mode: MODE_FILE, name: "leaf", oid: leaf.oid }]);
    const { root, commit } = child({ mode: MODE_TREE, name: "outside", oid: outside.oid });
    const state = await fetchPacked([commit, root, added], commit.oid, {
      seed: seed([leaf, outside]),
    });
    expect(state.outcome).toBeNull();
    expect(state.refsChanged).toBe(true);
    const db = state.workspace.repo.store.db;
    expect(projectedTrees(db)).toEqual(new Set([baseRoot.oid, dir.oid, outside.oid]));
    expect(unclosedSubtrees(db)).toBe(0);
  });

  it("rolls the projection back with a rejected pack", async () => {
    const inner = tree([{ mode: MODE_FILE, name: "lost", oid: nested.oid }]);
    const outer = tree([{ mode: MODE_TREE, name: "inner", oid: inner.oid }]);
    const { root, commit } = child({ mode: MODE_TREE, name: "outer", oid: outer.oid });
    const state = await fetchPacked([commit, root, added], commit.oid, { seed: seed([outer]) });
    expect(state.outcome).toMatchObject({ code: "EFETCHFAIL" });
    expect(state.outcome).toBeInstanceOf(GitError);
    expect(state.refsChanged).toBe(false);
    expect(state.packsAdded).toBe(0);
    const db = state.workspace.repo.store.db;
    expect(db.scalar<number>("SELECT count(*) FROM git_tree_sources")).toBe(0);
    expect(db.scalar<number>("SELECT count(*) FROM git_tree_entries")).toBe(0);
  });
});

/** Refuses every single-row entry insert as SQLite refuses a row above its size limit. */
class RowLimitDatabase extends TestDatabase {
  override run(query: string, ...bindings: unknown[]): void {
    if (query.startsWith("INSERT INTO git_tree_entries") && typeof bindings[0] === "number") {
      throw new GitError("E2BIG", "injected SQLite row-size limit");
    }
    super.run(query, ...bindings);
  }
}

/** Fails every projection marker write while armed, after the entries were written. */
class FaultingDatabase extends TestDatabase {
  failMarkers = false;

  override run(query: string, ...bindings: unknown[]): void {
    if (this.failMarkers && query.startsWith("INSERT INTO git_tree_sources")) {
      throw new Error("injected projection fault");
    }
    super.run(query, ...bindings);
  }
}
