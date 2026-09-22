import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { serializeCommit, serializeTree } from "../packages/git/src/common/objects.js";
import { applyIntegrationOwned } from "../packages/git/src/ops/integration/integration-apply-owned.js";
import { planIntegrationOwned } from "../packages/git/src/ops/integration/integration-plan-owned.js";
import { projectMergePlanOwned } from "../packages/git/src/ops/merge/merge-projection.js";
import { SqliteGitDatabase } from "../packages/git/src/store/index.js";
import type { IntegrationEntry } from "../packages/git/src/store/operations/integration-workspace/descriptors.js";
import { INTEGRATION_PAGE_ROWS } from "../packages/git/src/store/operations/integration-workspace/storage.js";
import type { IntegrationTouchedShape } from "../packages/git/src/store/operations/integration-workspace/touched.js";
import { withIntegrationWorkspaceOwned } from "../packages/git/src/store/operations/integration-workspace/workspace.js";
import { TestDatabase } from "./helpers/db.js";
import { GitFixture } from "./helpers/git.js";
import { makeRepo } from "./helpers/workspace.js";

function setup() {
  const db = new TestDatabase();
  const database = new SqliteGitDatabase(db);
  const checkout = database.openCheckout(
    database.createRepository("/repo", "ref: refs/heads/main"),
  );
  return { db, store: checkout.shared };
}

/** Wide enough that the 1.5 MB page policy cuts a page short of 256 records. */
const PADDED_PATH_BYTES = 100_000;
const DISCRIMINATOR_BYTES = 10;

function keysetPaths(count: number, padding = 0): string[] {
  const filler = "p".repeat(padding);
  return Array.from(
    { length: count },
    (_, index) => `${filler}file-${String(index).padStart(5, "0")}`,
  );
}

/** Compare only the ordered tails, so a failure does not print megabytes. */
function discriminators(paths: readonly string[]): string[] {
  return paths.map((path) => path.slice(-DISCRIMINATOR_BYTES));
}

function cleanEntries(paths: readonly string[]): IntegrationEntry[] {
  return paths.map((path) => ({
    kind: "clean",
    path,
    before: null,
    result: null,
    content: null,
  }));
}

function touchedShapes(paths: readonly string[]): IntegrationTouchedShape[] {
  return paths.map((path) => ({ path, logicalPath: path, purpose: "primary" }));
}

function measure<T>(db: TestDatabase, body: () => T): { result: T; statements: number } {
  db.storage.resetCounters();
  const result = body();
  return { result, statements: db.storage.statementCount };
}

describe("integration workspace ownership", () => {
  it("reuses a shared input across distant metadata pages without global use counts", () => {
    const { repo } = makeRepo();
    const shared = ["base\n", "current\n", "incoming\n"].map((text) =>
      repo.store.write("blob", new TextEncoder().encode(text)),
    );
    const trees = shared.map((oid) =>
      repo.store.write(
        "tree",
        serializeTree(
          Array.from({ length: 300 }, (_, index) => ({
            name: `file-${String(index).padStart(4, "0")}`,
            mode: "100644",
            oid,
          })),
        ),
      ),
    );
    const [baseTreeOid, currentTreeOid, incomingTreeOid] = trees;
    if (baseTreeOid === undefined || currentTreeOid === undefined || incomingTreeOid === undefined)
      throw new Error("fixture trees are missing");
    withIntegrationWorkspaceOwned(repo.store, (workspace) => {
      const reads = new Map<string, number>();
      const original = workspace.source.readBlobs.bind(workspace.source);
      workspace.source.readBlobs = (oids, options) => {
        const batch = original(oids, options);
        for (const oid of batch.blobs.keys()) reads.set(oid, (reads.get(oid) ?? 0) + 1);
        return batch;
      };
      const plan = planIntegrationOwned(workspace, {
        baseTreeOid,
        currentTreeOid,
        incomingTreeOid,
      });
      expect(plan.entryCount).toBe(300);
      for (const entry of plan.entries) expect(entry.kind).toBe("conflict");
      for (const oid of shared) expect(reads.get(oid)).toBe(1);
    });
  });

  it("adopts a virtual stage-1 blob but leaves worktree-only markers provisional", () => {
    const { repo, worktree } = makeRepo();
    const current = repo.store.write("blob", new TextEncoder().encode("current\n"));
    const incoming = repo.store.write("blob", new TextEncoder().encode("incoming\n"));
    const tree = repo.store.write("tree", serializeTree([]));
    const person = {
      name: "Fixture",
      email: "fixture@example.com",
      timestamp: 1700000000,
      timezoneOffset: 0,
    };
    const head = repo.store.write(
      "commit",
      serializeCommit({ tree, parent: [], author: person, committer: person, message: "root\n" }),
    );
    const result = withIntegrationWorkspaceOwned(repo.store, (workspace) => {
      const base = workspace.source.write("blob", new TextEncoder().encode("virtual ancestor\n"));
      const markers = new TextEncoder().encode("generated markers\n");
      const content = workspace.source.write("blob", markers);
      const projected = workspace.projectedPlan();
      projected.entries.write([
        {
          path: "file",
          logicalPath: "file",
          purpose: "primary",
          stageZero: null,
          stages: {
            base: { mode: "100644", oid: base },
            current: { mode: "100644", oid: current },
            incoming: { mode: "100644", oid: incoming },
          },
          worktree: { mode: "100644", oid: current },
          content: { oid: content, size: markers.length },
        },
      ]);
      projected.finish(1, 1);
      applyIntegrationOwned(workspace, repo, worktree, projected, {
        suspendedState: {
          kind: "merge",
          originalHeadRef: "refs/heads/main",
          originalHeadOid: head,
          currentParentOid: head,
          incomingParentOid: head,
          phase: "conflicted",
          mode: "commit",
          mergeOrigin: "merge",
          currentLabel: "HEAD",
          incomingLabel: "topic",
          message: "merge\n",
          author: null,
          committer: null,
        },
      });
      return { base, content, markers };
    });
    expect(repo.checkout.indexGet("file", 1)?.oid).toBe(result.base);
    expect(repo.store.read(result.base)?.data).toEqual(
      new TextEncoder().encode("virtual ancestor\n"),
    );
    expect(repo.store.has(result.content)).toBe(false);
    expect(worktree.readFile("/file")).toEqual(result.markers);
    expect(repo.checkout.requireMergeState().touched).toHaveLength(1);
  });

  it("applies a 1001-path projection without returning ownership arrays", () => {
    const { repo, worktree } = makeRepo();
    const body = new TextEncoder().encode("incoming\n");
    const oid = repo.store.write("blob", body);
    const entries = Array.from({ length: 1001 }, (_, index) => ({
      name: `file-${String(index).padStart(4, "0")}`,
      mode: "100644",
      oid,
    }));
    const tree = repo.store.write("tree", serializeTree(entries));
    withIntegrationWorkspaceOwned(repo.store, (workspace) => {
      const plan = planIntegrationOwned(workspace, {
        baseTreeOid: null,
        currentTreeOid: null,
        incomingTreeOid: tree,
      });
      const projected = projectMergePlanOwned(workspace, plan, {
        currentLabel: "HEAD",
        incomingLabel: "topic",
      });
      expect(
        applyIntegrationOwned(workspace, repo, worktree, projected, { suspendedState: null }),
      ).toEqual({ touched: null });
    });
    expect(repo.checkout.indexEntries()).toHaveLength(1001);
    expect(worktree.readFile("/file-1000")).toEqual(body);
    expect(repo.store.db.scalar("SELECT count(*) FROM git_integration_workspaces")).toBe(0);
  });

  it("plans and projects 1001 native-tree changes with repeatable bounded descriptors", () => {
    const { db, store } = setup();
    const native = new GitFixture().init();
    try {
      const body = new TextEncoder().encode("incoming\n");
      const oid = store.write("blob", body);
      expect(native.writeObject("blob", body)).toBe(oid);
      const names = Array.from(
        { length: 1001 },
        (_, index) => `file-${String(index).padStart(4, "0")}`,
      );
      const nativeTree = native.gitInput(
        names.map((name) => `100644 blob ${oid}\t${name}\n`).join(""),
        "mktree",
      );
      const tree = store.write(
        "tree",
        new Uint8Array(native.gitBinary("cat-file", "tree", nativeTree)),
      );
      expect(tree).toBe(nativeTree);
      withIntegrationWorkspaceOwned(store, (workspace) => {
        const plan = planIntegrationOwned(workspace, {
          baseTreeOid: null,
          currentTreeOid: null,
          incomingTreeOid: tree,
        });
        expect(plan.entryCount).toBe(1001);
        expect([...plan.entries].map((entry) => entry.path)).toEqual(names);
        const projected = projectMergePlanOwned(workspace, plan, {
          currentLabel: "HEAD",
          incomingLabel: "topic",
        });
        expect(projected.entryCount).toBe(1001);
        expect([...projected.entries].map((entry) => entry.path)).toEqual(names);
        expect([...plan.entries].map((entry) => entry.path)).toEqual(names);
      });
      expect(() =>
        withIntegrationWorkspaceOwned(store, (workspace) =>
          planIntegrationOwned(workspace, {
            baseTreeOid: null,
            currentTreeOid: null,
            incomingTreeOid: tree,
            limits: { maxEntries: 1000 },
          }),
        ),
      ).toThrowError(expect.objectContaining({ code: "E2BIG" }));
      expect(db.scalar("SELECT count(*) FROM git_integration_workspaces")).toBe(0);
    } finally {
      native.dispose();
    }
  });

  it("matches native generated conflict bytes without publishing them during validation", () => {
    const { db, store } = setup();
    const native = new GitFixture().init();
    try {
      const bodies = { base: "base\n", current: "current\n", incoming: "incoming\n" };
      const tree = (body: string) => {
        const oid = store.write("blob", new TextEncoder().encode(body));
        return store.write("tree", serializeTree([{ name: "file", mode: "100644", oid }]));
      };
      const input = {
        baseTreeOid: tree(bodies.base),
        currentTreeOid: tree(bodies.current),
        incomingTreeOid: tree(bodies.incoming),
        text: { labels: { current: "HEAD", base: "base", incoming: "topic" } },
      };
      native
        .write("base", bodies.base)
        .write("current", bodies.current)
        .write("incoming", bodies.incoming);
      expect(
        native.gitResult(
          "merge-file",
          "-L",
          "HEAD",
          "-L",
          "base",
          "-L",
          "topic",
          "current",
          "base",
          "incoming",
        ).status,
      ).toBe(1);
      const expected = new Uint8Array(readFileSync(join(native.dir, "current")));
      const ordinary = db.scalar("SELECT count(*) FROM git_objects");
      withIntegrationWorkspaceOwned(store, (workspace) => {
        const plan = planIntegrationOwned(workspace, input);
        const entry = plan.entries.get("file");
        if (entry?.content === null || entry === null)
          throw new Error("generated conflict output is missing");
        expect(entry.kind).toBe("conflict");
        expect(
          workspace.source.readBlobs([entry.content.oid]).blobs.get(entry.content.oid),
        ).toEqual(expected);
        expect(store.has(entry.content.oid)).toBe(false);
        expect(plan.entries.get("file")).toEqual(entry);
      });
      expect(db.scalar("SELECT count(*) FROM git_objects")).toBe(ordinary);
      expect(db.scalar("SELECT count(*) FROM git_integration_objects")).toBe(0);
    } finally {
      native.dispose();
    }
  });

  it("keeps generated output private and revokes handles and suspended traversal", () => {
    const { db, store } = setup();
    const retained = withIntegrationWorkspaceOwned(store, (workspace) => {
      const oid = workspace.source.write("blob", new TextEncoder().encode("private output"));
      expect(store.has(oid)).toBe(false);
      const plan = workspace.resolvedPlan();
      plan.entries.write([
        {
          kind: "clean",
          path: "a",
          before: null,
          result: { mode: "100644", oid },
          content: { oid, size: 14 },
        },
        { kind: "clean", path: "b", before: null, result: null, content: null },
      ]);
      plan.finish(2, 2);
      const cursor = plan.entries[Symbol.iterator]();
      expect(cursor.next().value?.path).toBe("a");
      expect([...plan.entries].map((entry) => entry.path)).toEqual(["a", "b"]);
      return { workspace, plan, cursor, oid };
    });
    expect(store.has(retained.oid)).toBe(false);
    expect(() => retained.cursor.next()).toThrowError(expect.objectContaining({ code: "ESTALE" }));
    expect(() => retained.plan.entryCount).toThrowError(
      expect.objectContaining({ code: "ESTALE" }),
    );
    expect(() => retained.workspace.source.objectInfo([retained.oid])).toThrowError(
      expect.objectContaining({ code: "ESTALE" }),
    );
    expect(db.scalar("SELECT count(*) FROM git_integration_workspaces")).toBe(0);
    expect(db.scalar("SELECT count(*) FROM git_integration_objects")).toBe(0);
  });

  it("poisons an outer scope after a caught nested failure and invalidates adopted-object caches", () => {
    const { db, store } = setup();
    let adopted = "";
    expect(() =>
      withIntegrationWorkspaceOwned(store, (workspace) => {
        adopted = workspace.source.write("blob", new TextEncoder().encode("rolled back"));
        workspace.source.adopt(adopted);
        expect(store.read(adopted)?.data).toEqual(new TextEncoder().encode("rolled back"));
        try {
          withIntegrationWorkspaceOwned(store, () => {
            throw new Error("nested failure");
          });
        } catch {
          // Catching a nested error cannot turn an abort-only scope into a commit.
        }
      }),
    ).toThrow("nested failure");
    expect(store.has(adopted)).toBe(false);
    expect(store.read(adopted)).toBeNull();
    expect(db.scalar("SELECT count(*) FROM git_integration_workspaces")).toBe(0);
  });

  it("adopts reachable tree dependencies without publishing unrelated temporary blobs", () => {
    const { db, store } = setup();
    const result = withIntegrationWorkspaceOwned(store, (workspace) => {
      const blob = workspace.source.write("blob", new TextEncoder().encode("retained"));
      const unused = workspace.source.write("blob", new TextEncoder().encode("discarded"));
      const tree = workspace.source.write(
        "tree",
        serializeTree([{ name: "file", mode: "100644", oid: blob }]),
      );
      expect([...workspace.source.walkTree(tree)]).toEqual([
        { path: "file", mode: "100644", oid: blob },
      ]);
      workspace.source.adopt(tree);
      return { tree, blob, unused };
    });
    expect(store.has(result.tree)).toBe(true);
    expect(store.read(result.blob)?.data).toEqual(new TextEncoder().encode("retained"));
    expect(store.has(result.unused)).toBe(false);
    expect([...store.walkTree(result.tree)]).toEqual([
      { path: "file", mode: "100644", oid: result.blob },
    ]);
    expect(db.scalar("SELECT count(*) FROM git_integration_objects")).toBe(0);
  });

  it("rejects asynchronous callbacks and cleans their provisional output", () => {
    const { db, store } = setup();
    expect(() =>
      withIntegrationWorkspaceOwned(store, async (workspace) => {
        workspace.source.write("blob", new Uint8Array([1]));
      }),
    ).toThrowError(expect.objectContaining({ code: "EINVAL" }));
    expect(db.scalar("SELECT count(*) FROM git_integration_workspaces")).toBe(0);
    expect(db.scalar("SELECT count(*) FROM git_integration_object_chunks")).toBe(0);
  });
});

describe("integration keyset paging", () => {
  it("ends a traversal on a short final page without an empty keyset query", () => {
    const { db, store } = setup();
    const paths = keysetPaths(INTEGRATION_PAGE_ROWS + 44);
    withIntegrationWorkspaceOwned(store, (workspace) => {
      const plan = workspace.resolvedPlan();
      plan.entries.write(cleanEntries(paths));
      plan.finish(paths.length, paths.length);
      const touched = workspace.touched(plan);
      touched.reserve(touchedShapes(paths));

      const entries = measure(db, () => [...plan.entries].map((entry) => entry.path));
      expect(entries.result).toEqual(paths);
      // A full page, then a page below the row limit: the limit did not truncate
      // the second query, so no third query can find anything.
      expect(entries.statements).toBe(2);

      const shapes = measure(db, () => [...touched.shapes()].map((shape) => shape.path));
      expect(shapes.result).toEqual(paths);
      expect(shapes.statements).toBe(2);
    });
  });

  it("keeps probing after a final page that fills the row limit exactly", () => {
    const { db, store } = setup();
    const paths = keysetPaths(INTEGRATION_PAGE_ROWS * 2);
    withIntegrationWorkspaceOwned(store, (workspace) => {
      const plan = workspace.resolvedPlan();
      plan.entries.write(cleanEntries(paths));
      plan.finish(paths.length, paths.length);
      const touched = workspace.touched(plan);
      touched.reserve(touchedShapes(paths));

      const entries = measure(db, () => [...plan.entries].map((entry) => entry.path));
      expect(entries.result).toEqual(paths);
      // Two pages the row limit truncated: only a third query can tell an exact
      // multiple of the page size from a longer plan.
      expect(entries.statements).toBe(3);

      const shapes = measure(db, () => [...touched.shapes()].map((shape) => shape.path));
      expect(shapes.result).toEqual(paths);
      expect(shapes.statements).toBe(3);
    });
  });

  it("follows a plan page the byte cap truncated below the row limit", () => {
    const { db, store } = setup();
    const paths = keysetPaths(20, PADDED_PATH_BYTES);
    withIntegrationWorkspaceOwned(store, (workspace) => {
      const plan = workspace.resolvedPlan();
      plan.entries.write(cleanEntries(paths));
      plan.finish(paths.length, paths.length);

      const entries = measure(db, () => [...plan.entries].map((entry) => entry.path));
      expect(discriminators(entries.result)).toEqual(discriminators(paths));
      // The first page stops on bytes with 14 of 256 rows, which proves nothing
      // about what follows, so the remaining six rows need a second query.
      expect(entries.statements).toBe(2);
    });
  });

  it("follows a touched page the byte cap truncated below the row limit", () => {
    const { db, store } = setup();
    const paths = keysetPaths(10, PADDED_PATH_BYTES);
    withIntegrationWorkspaceOwned(store, (workspace) => {
      const touched = workspace.touched(workspace.resolvedPlan());
      touched.reserve(touchedShapes(paths));

      const shapes = measure(db, () => [...touched.shapes()].map((shape) => shape.path));
      expect(discriminators(shapes.result)).toEqual(discriminators(paths));
      // A touched row carries the path twice, so the byte cap lands earlier.
      expect(shapes.statements).toBe(2);
    });
  });
});
