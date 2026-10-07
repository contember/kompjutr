import { describe, expect, it } from "vitest";
import { utf8 } from "../packages/git/src/common/bytes.js";
import { hashObject, MODE_FILE, MODE_TREE } from "../packages/git/src/common/objects.js";
import { fetchInto } from "../packages/git/src/ops/network/network.js";
import { RefReachability } from "../packages/git/src/ops/network/network-reachability.js";
import { worktreeAdd } from "../packages/git/src/ops/worktree/worktrees.js";
import { REACHABLE_ANCESTRY_SQL } from "../packages/git/src/store/trees/commits.js";
import { WALK_TREE_DIFF_SQL } from "../packages/git/src/store/trees/tree-walk-sql.js";
import {
  ANCESTRY_WALK,
  blobObject as blob,
  commitObject,
  completePacks,
  fetchPacked,
  fingerprint,
  type PackObject,
  packOf,
  statementsOf,
  tagObject,
  treeObject as tree,
} from "./helpers/fetch-pack.js";
import { GitFixture, slices } from "./helpers/git.js";
import { startGitServer } from "./helpers/http-backend.js";
import { makeRepo, type TestRepository } from "./helpers/workspace.js";

const TREE_WALK = fingerprint(WALK_TREE_DIFF_SQL);

/** A history already in the store through an unchecked pack, named by a tracking ref. */
function seedHistory(objects: readonly PackObject[], tip: string) {
  return async ({ repo }: TestRepository): Promise<void> => {
    await repo.store.packs.ingest(slices(packOf(objects), 4096));
    repo.store.setRef("refs/remotes/origin/main", tip);
  };
}

function deleteLoose(repo: TestRepository["repo"], oid: string): void {
  repo.store.db.run(
    "DELETE FROM git_objects WHERE repo_id = ? AND oid = ?",
    repo.store.repoId,
    oid,
  );
  expect(repo.store.has(oid)).toBe(false);
}

function expectRejected(
  state: Awaited<ReturnType<typeof fetchPacked>>,
  code: string,
  message?: string,
): void {
  expect(state.outcome).toMatchObject(message === undefined ? { code } : { code, message });
  expect(state.refsChanged).toBe(false);
  expect(state.packsAdded).toBe(0);
  expect(state.promisesAdded).toBe(0);
}

describe("per-pack connectivity on a non-fresh store", () => {
  const kept = blob("kept\n");
  const nested = blob("nested\n");
  const dir = tree([{ mode: MODE_FILE, name: "nested", oid: nested.oid }]);
  const baseRoot = tree([
    { mode: MODE_FILE, name: "kept", oid: kept.oid },
    { mode: MODE_TREE, name: "dir", oid: dir.oid },
  ]);
  const base = commitObject(baseRoot.oid, [], "base\n");
  const seed = seedHistory([base, baseRoot, dir, kept, nested], base.oid);
  const added = blob("added\n");

  /** A child of `base` whose root tree keeps `kept` and `dir` and adds `extra`. */
  function child(extra: { mode: string; name: string; oid: string }[] = []) {
    const root = tree([
      { mode: MODE_FILE, name: "added", oid: added.oid },
      { mode: MODE_TREE, name: "dir", oid: dir.oid },
      { mode: MODE_FILE, name: "kept", oid: kept.oid },
      ...extra,
    ]);
    return { root, commit: commitObject(root.oid, [base.oid], "child\n") };
  }

  it("publishes a pack that builds on present, ref-reachable history", async () => {
    const { root, commit } = child();
    const state = await fetchPacked([commit, root, added], commit.oid, { seed });
    expect(state.outcome).toBeNull();
    expect(state.packsAdded).toBe(1);
    expect(state.workspace.repo.store.getRef("refs/remotes/origin/main")).toBe(commit.oid);
  });

  it("accepts a parent reachable only through an annotated tag ref", async () => {
    const side = commitObject(baseRoot.oid, [], "side\n");
    const release = tagObject(side.oid, "commit", "release");
    const root = tree([{ mode: MODE_FILE, name: "kept", oid: kept.oid }]);
    const commit = commitObject(root.oid, [side.oid], "on side\n");
    const state = await fetchPacked([commit, root], commit.oid, {
      async seed(workspace) {
        await seedHistory([base, baseRoot, dir, kept, nested, side, release], base.oid)(workspace);
        workspace.repo.store.setRef("refs/tags/release", release.oid);
      },
    });
    expect(state.outcome).toBeNull();
    expect(state.packsAdded).toBe(1);
  });

  it("accepts a parent only a detached linked checkout HEAD names", async () => {
    const side = commitObject(baseRoot.oid, [], "side\n");
    const root = tree([{ mode: MODE_FILE, name: "kept", oid: kept.oid }]);
    const commit = commitObject(root.oid, [side.oid], "on detached\n");
    const state = await fetchPacked([commit, root], commit.oid, {
      async seed(workspace) {
        await seedHistory([base, baseRoot, dir, kept, nested, side], base.oid)(workspace);
        worktreeAdd(workspace.context, workspace.repo, {
          root: "/linked",
          target: { kind: "detached", startPoint: side.oid },
        });
      },
    });
    expect(state.outcome).toBeNull();
    expect(state.packsAdded).toBe(1);
  });

  it.each([
    ["rejects a parent behind the shallow boundary", "behind", "EFETCHFAIL"],
    ["accepts the boundary commit itself as parent", "boundary", null],
  ] as const)("%s", async (_name, parent, code) => {
    const older = commitObject(baseRoot.oid, [], "older\n");
    const boundary = commitObject(baseRoot.oid, [older.oid], "boundary\n");
    const root = tree([{ mode: MODE_FILE, name: "kept", oid: kept.oid }]);
    const commit = commitObject(
      root.oid,
      [parent === "behind" ? older.oid : boundary.oid],
      "after boundary\n",
    );
    const state = await fetchPacked([commit, root], commit.oid, {
      async seed(workspace) {
        await seedHistory([older, boundary, baseRoot, dir, kept, nested], boundary.oid)(workspace);
        workspace.repo.store.setShallow([boundary.oid]);
      },
    });
    if (code === null) expect(state.outcome).toBeNull();
    else expectRejected(state, code, "fetched graph references a missing object");
  });

  it("promises no present blob in a filtered incremental fetch", async () => {
    const { root, commit } = child();
    const state = await fetchPacked([commit, root], commit.oid, { seed, filter: true });
    expect(state.outcome).toBeNull();
    const promised = [...state.workspace.repo.store.iteratePromisedBlobs()].map((row) => row.oid);
    expect(promised).toEqual([added.oid]);
  });

  it("accepts a present tree outside every proven closure when its closure is present", async () => {
    const leaf = blob("loose leaf\n");
    const loose = tree([{ mode: MODE_FILE, name: "leaf", oid: leaf.oid }]);
    const { root, commit } = child([{ mode: MODE_TREE, name: "loose", oid: loose.oid }]);
    const state = await fetchPacked([commit, root, added], commit.oid, {
      async seed(workspace) {
        await seed(workspace);
        workspace.repo.store.write("blob", leaf.data);
        workspace.repo.store.write("tree", loose.data);
      },
    });
    expect(state.outcome).toBeNull();
    expect(state.refsChanged).toBe(true);
  });

  it("rejects a present tree whose closure misses a subtree", async () => {
    const inner = tree([{ mode: MODE_FILE, name: "lost", oid: nested.oid }]);
    const outer = tree([{ mode: MODE_TREE, name: "inner", oid: inner.oid }]);
    const { root, commit } = child([{ mode: MODE_TREE, name: "outer", oid: outer.oid }]);
    const state = await fetchPacked([commit, root, added], commit.oid, {
      async seed(workspace) {
        await seed(workspace);
        workspace.repo.store.write("tree", inner.data);
        workspace.repo.store.write("tree", outer.data);
        deleteLoose(workspace.repo, inner.oid);
      },
    });
    expectRejected(state, "EFETCHFAIL", "fetched graph references a missing object");
  });

  it("rejects an unfiltered pack naming an absent, unpromised blob", async () => {
    const absent = hashObject("blob", utf8.encode("never sent\n"));
    const { root, commit } = child([{ mode: MODE_FILE, name: "absent", oid: absent }]);
    expectRejected(
      await fetchPacked([commit, root, added], commit.oid, { seed }),
      "EFETCHFAIL",
      "fetched graph references a missing object",
    );
  });

  it.each([
    ["accepts a promised blob", MODE_FILE, null],
    ["rejects a promised OID named as a subtree", MODE_TREE, "EFETCHFAIL"],
  ] as const)("%s in an unfiltered fetch", async (_name, mode, code) => {
    const promised = hashObject("blob", utf8.encode("promised elsewhere\n"));
    const { root, commit } = child([{ mode, name: "promised", oid: promised }]);
    const state = await fetchPacked([commit, root, added], commit.oid, {
      async seed(workspace) {
        await seed(workspace);
        workspace.repo.store.registerPromisorRemote("origin", "https://example.test/repo.git");
        workspace.repo.store.addPromisedBlobs("origin", [promised]);
      },
    });
    if (code === null) expect(state.outcome).toBeNull();
    else expectRejected(state, code, "fetched graph references a missing object");
  });

  it("rejects an unreachable parent whose tree was swept", async () => {
    // Maintenance sweeps unreachable objects by OID, so a commit can outlive its tree.
    const orphanRoot = tree([{ mode: MODE_FILE, name: "kept", oid: kept.oid }]);
    const orphan = commitObject(orphanRoot.oid, [], "orphan\n");
    const root = tree([{ mode: MODE_FILE, name: "kept", oid: kept.oid }]);
    const commit = commitObject(root.oid, [orphan.oid], "on orphan\n");
    const state = await fetchPacked([commit, root], commit.oid, {
      async seed(workspace) {
        await seed(workspace);
        workspace.repo.store.write("tree", orphanRoot.data);
        workspace.repo.store.write("commit", orphan.data);
        deleteLoose(workspace.repo, orphanRoot.oid);
      },
    });
    expectRejected(state, "EFETCHFAIL", "fetched graph references a missing object");
  });

  describe("external references by type", () => {
    it("rejects a subtree entry naming a present blob", async () => {
      const { root, commit } = child([{ mode: MODE_TREE, name: "fake", oid: kept.oid }]);
      expectRejected(
        await fetchPacked([commit, root, added], commit.oid, { seed }),
        "ECORRUPT",
        `fetched graph requires ${kept.oid} to be a tree`,
      );
    });

    it("rejects a file entry naming a present tree", async () => {
      const { root, commit } = child([{ mode: MODE_FILE, name: "fake", oid: baseRoot.oid }]);
      expectRejected(
        await fetchPacked([commit, root, added], commit.oid, { seed }),
        "ECORRUPT",
        `fetched graph requires ${baseRoot.oid} to be a blob`,
      );
    });

    it("does not let a promise exempt an object that is physically a tree", async () => {
      const leaf = blob("leaf\n");
      const shadow = tree([{ mode: MODE_FILE, name: "leaf", oid: leaf.oid }]);
      const { root, commit } = child([{ mode: MODE_FILE, name: "file", oid: shadow.oid }]);
      const state = await fetchPacked([commit, root, added], commit.oid, {
        async seed(workspace) {
          await seed(workspace);
          const { repo } = workspace;
          repo.store.registerPromisorRemote("origin", "https://example.test/repo.git");
          repo.store.addPromisedBlobs("origin", [shadow.oid]);
          repo.store.write("blob", leaf.data);
          repo.store.write("tree", shadow.data);
        },
      });
      expectRejected(state, "ECORRUPT", `fetched graph requires ${shadow.oid} to be a blob`);
    });

    it.each(["tree", "blob"] as const)(
      "rejects a %s present only in an incomplete pack",
      async (type) => {
        const pending =
          type === "tree" ? tree([{ mode: MODE_FILE, name: "kept", oid: kept.oid }]) : blob("p\n");
        const mode = type === "tree" ? MODE_TREE : MODE_FILE;
        const { root, commit } = child([{ mode, name: "pending", oid: pending.oid }]);
        const state = await fetchPacked([commit, root, added], commit.oid, {
          async seed(workspace) {
            await seed(workspace);
            await expect(
              workspace.repo.store.packs.ingest(slices(packOf([pending]), 4096), {
                lifecycle: {
                  reserved: () => undefined,
                  published: () => {
                    throw new Error("interrupted publication");
                  },
                },
              }),
            ).rejects.toThrow(/interrupted publication/);
            expect(workspace.repo.store.has(pending.oid)).toBe(false);
          },
        });
        expectRejected(state, "EFETCHFAIL", "fetched graph references a missing object");
      },
    );
  });
});

describe("fetch roots on a non-fresh store", () => {
  function history(): GitFixture {
    const fixture = new GitFixture().init();
    for (let index = 0; index < 3; index++) {
      fixture.write("file.txt", `${index}\n`);
      fixture.commit(`commit ${index}`);
    }
    return fixture;
  }

  it("refetches a tip a failed depth fetch left, instead of trusting its missing history", async () => {
    const fixture = history();
    const tip = fixture.git("rev-parse", "HEAD");
    const parent = fixture.git("rev-parse", "HEAD~1");
    const server = await startGitServer(fixture.dir);
    const { repo, context } = makeRepo("/work");
    try {
      repo.store.configSet("remote.origin.url", server.url);
      const failed = await fetchInto(context, repo, { remote: "origin", depth: 1 }, "fetch", {
        checkpoint: (stage) => {
          if (stage === "before-ref-publication") throw new Error("interrupted publication");
          return undefined;
        },
      }).then(
        () => null,
        (error: unknown) => error,
      );
      expect(failed).toMatchObject({ message: "interrupted publication" });
      expect(repo.store.has(tip)).toBe(true);
      expect(repo.store.has(parent)).toBe(false);
      expect(repo.store.getRef("refs/remotes/origin/main")).toBeNull();

      const posts = server.requests.filter((request) => request.method === "POST").length;
      await fetchInto(context, repo, { remote: "origin" });
      expect(server.requests.filter((request) => request.method === "POST").length).toBe(posts + 1);
      expect(repo.store.getRef("refs/remotes/origin/main")).toBe(tip);
      expect(repo.store.has(parent)).toBe(true);
      expect(repo.shallow().size).toBe(0);
    } finally {
      await server.close();
      fixture.dispose();
    }
  });
});

describe("non-fresh fetch cost", () => {
  it("walks no history: only the proven parent's root-tree closure", async () => {
    const fixture = new GitFixture().init();
    const commits = 30;
    for (let index = 0; index < commits; index++) {
      fixture.write(`old/file-${index}.txt`, `${index}\n`);
      fixture.commit(`commit ${index}`);
    }
    const server = await startGitServer(fixture.dir);
    const workspace = makeRepo("/work");
    const { repo, context } = workspace;
    try {
      repo.store.configSet("remote.origin.url", server.url);
      await fetchInto(context, repo, { remote: "origin" });
      // A checkout would have projected the tip's tree; this fetch-only setup projects it here,
      // so the measured fetch prices the steady state rather than first projection (ADR-0030).
      [...repo.store.walkTree(fixture.git("rev-parse", "HEAD^{tree}"))];
      const closure = fixture.git("ls-tree", "-r", "-t", "HEAD").split("\n").length + 1;
      fixture.write("root.txt", "changed at the root only\n");
      const head = fixture.commit("incremental");
      const { statements, rows } = await statementsOf(workspace, () =>
        fetchInto(context, repo, { remote: "origin" }),
      );
      expect(repo.store.getRef("refs/remotes/origin/main")).toBe(head);
      // The parent is a ref tip, so no commit is walked; `old/` is proven inside its root tree.
      const recursive = [...statements.keys()].filter((query) =>
        query.startsWith("WITH RECURSIVE"),
      );
      expect(recursive).toEqual([TREE_WALK]);
      expect(statements.has(ANCESTRY_WALK)).toBe(false);
      expect(statements.get(TREE_WALK)).toBe(1);
      expect(rows.get(TREE_WALK) ?? 0).toBeLessThanOrEqual(closure);
    } finally {
      await server.close();
      fixture.dispose();
    }
  });

  it("walks one root-tree closure plus diffs for many proven parents", async () => {
    const branches = 20;
    const fixture = new GitFixture().init();
    for (let index = 0; index < 20; index++) {
      for (let file = 0; file < 5; file++) {
        fixture.write(`shared/dir-${index}/file-${file}.txt`, `${index}.${file}\n`);
      }
    }
    fixture.commit("shared");
    for (let index = 0; index < branches; index++) {
      fixture.git("checkout", "-q", "-b", `b${index}`, "main");
      fixture.write(`own-${index}/file.txt`, `own ${index}\n`);
      fixture.commit(`branch ${index}`);
    }
    const server = await startGitServer(fixture.dir);
    const workspace = makeRepo("/work");
    const { repo, context } = workspace;
    try {
      repo.store.configSet("remote.origin.url", server.url);
      await fetchInto(context, repo, { remote: "origin", singleBranch: false, tags: false });
      const closure = fixture.git("ls-tree", "-r", "-t", "b0").split("\n").length + 1;
      // Project the fetched tips' trees, as checkouts of them would have (ADR-0030).
      for (let index = 0; index < branches; index++) {
        [...repo.store.walkTree(fixture.git("rev-parse", `b${index}^{tree}`))];
      }
      for (let index = 0; index < branches; index++) {
        fixture.git("checkout", "-q", `b${index}`);
        fixture.write(`moved-${index}.txt`, "moved\n");
        fixture.commit(`move ${index}`);
      }
      const { statements, rows } = await statementsOf(workspace, () =>
        fetchInto(context, repo, { remote: "origin", singleBranch: false, tags: false }),
      );
      expect(repo.store.getRef("refs/remotes/origin/b19")).toBe(fixture.git("rev-parse", "b19"));
      // Each new root keeps `shared/` and its own `own-N/`: the first parent's closure is walked
      // once, and each later parent adds only the subtrees its diff against the previous one names.
      expect(statements.get(TREE_WALK)).toBeLessThanOrEqual(branches);
      expect(rows.get(TREE_WALK) ?? 0).toBeLessThanOrEqual(closure + branches * 4);
    } finally {
      await server.close();
      fixture.dispose();
    }
  });

  it("proves an unreachable external commit with one walk over a long history", async () => {
    const length = 300;
    const file = blob("file\n");
    const root = tree([{ mode: MODE_FILE, name: "file", oid: file.oid }]);
    const chain: PackObject[] = [root, file];
    let tip = "";
    for (let index = 0; index < length; index++) {
      const commit = commitObject(root.oid, tip === "" ? [] : [tip], `history ${index}\n`);
      chain.push(commit);
      tip = commit.oid;
    }
    const orphan = commitObject(root.oid, [], "unreachable\n");
    const incoming = commitObject(root.oid, [orphan.oid], "on unreachable\n");
    const measured = { statements: new Map<string, number>(), rows: new Map<string, number>() };
    const state = await fetchPacked([incoming], incoming.oid, {
      async seed(workspace) {
        await seedHistory(chain, tip)(workspace);
        workspace.repo.store.write("commit", orphan.data);
        workspace.storage.histogram = measured.statements;
        workspace.storage.rowHistogram = measured.rows;
      },
    });
    state.workspace.storage.histogram = null;
    state.workspace.storage.rowHistogram = null;
    expectRejected(state, "EFETCHFAIL", "fetched graph references a missing object");
    // Each commit row leaves SQLite once; the statement count does not grow with history.
    expect(measured.statements.get(ANCESTRY_WALK)).toBe(1);
    expect(measured.rows.get(ANCESTRY_WALK)).toBe(length);
    const total = [...measured.statements.values()].reduce((sum, count) => sum + count, 0);
    expect(total).toBeLessThan(1_000);
  });
});

describe("ref reachability", () => {
  it("seeks every walked commit by primary key", () => {
    const { repo } = makeRepo("/work");
    const plan = repo.store.db
      .all<{ detail: string }>(
        `EXPLAIN QUERY PLAN ${REACHABLE_ANCESTRY_SQL}`,
        repo.store.repoId,
        JSON.stringify(["1".repeat(40)]),
      )
      .map((row) => row.detail);
    const lookups = plan.filter((detail) => detail.startsWith("SEARCH c "));
    expect(lookups).toEqual([
      "SEARCH c USING PRIMARY KEY (repo_id=? AND oid=?)",
      "SEARCH c USING PRIMARY KEY (repo_id=? AND oid=?)",
    ]);
  });

  it("answers from its cache and resumes the walk from its frontier", async () => {
    const file = blob("file\n");
    const root = tree([{ mode: MODE_FILE, name: "file", oid: file.oid }]);
    const chain: string[] = [];
    const objects: PackObject[] = [root, file];
    for (let index = 0; index < 50; index++) {
      const parent = chain.at(-1);
      const commit = commitObject(root.oid, parent === undefined ? [] : [parent], `c${index}\n`);
      objects.push(commit);
      chain.push(commit.oid);
    }
    const workspace = makeRepo("/work");
    const { repo } = workspace;
    await repo.store.packs.ingest(slices(packOf(objects), 4096));
    const tip = chain.at(-1);
    const near = chain[40];
    const far = chain[10];
    if (tip === undefined || near === undefined || far === undefined) throw new Error("no chain");
    const reachability = new RefReachability(repo, [tip]);
    const walk = async (oid: string) => {
      const measured = await statementsOf(workspace, async () => {
        expect(reachability.reached([oid])).toEqual(new Set([oid]));
      });
      return {
        statements: measured.statements.get(ANCESTRY_WALK) ?? 0,
        rows: measured.rows.get(ANCESTRY_WALK) ?? 0,
      };
    };
    expect(await walk(near)).toEqual({ statements: 1, rows: 10 });
    expect(await walk(near)).toEqual({ statements: 0, rows: 0 });
    expect(await walk(far)).toEqual({ statements: 1, rows: 30 });
    expect(completePacks(repo)).toBe(1);
  });
});
