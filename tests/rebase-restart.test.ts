import { rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { fromHex } from "../src/core/bytes.js";
import type { GitContext } from "../src/core/context.js";
import { serializeCommit, serializeTree } from "../src/core/objects.js";
import { checkoutTree } from "../src/core/ops/checkout.js";
import { commit } from "../src/core/ops/commit.js";
import { integrationIndexMatchesTree } from "../src/core/ops/integration-worktree.js";
import { MAX_OPERATION_STEPS } from "../src/core/ops/operation-state.js";
import {
  type RebaseLifecycleResult,
  rebase,
  rebaseAbort,
  rebaseContinue,
  rebaseSkip,
} from "../src/core/ops/rebase.js";
import { preflightReplayCommitObjects } from "../src/core/ops/replay.js";
import { add } from "../src/core/ops/staging.js";
import { status } from "../src/core/ops/status.js";
import { worktreeAdd } from "../src/core/ops/worktrees.js";
import { Repository } from "../src/core/repository.js";
import type { Worktree } from "../src/core/worktree.js";
import type { ScanEntry, ScanOptions } from "../src/fs/types.js";
import { SqliteGitDatabase } from "../src/sqlite/store.js";
import { TestDatabase } from "./helpers/db.js";
import { GitFixture } from "./helpers/git.js";
import { importFixture } from "./helpers/import.js";
import { makeRepo, type TestRepository, writeWorkFile } from "./helpers/workspace.js";
import { CountingWorktree } from "./helpers/worktree.js";

const fixtures: GitFixture[] = [];

const PERSON = {
  name: "Rebase Fixture",
  email: "rebase@example.com",
  timestamp: 1_577_836_800,
  timezoneOffset: 0,
};

afterEach(() => {
  while (fixtures.length > 0) fixtures.pop()?.dispose();
});

function fixture(): GitFixture {
  const created = new GitFixture().init();
  fixtures.push(created);
  return created;
}

async function imported(source: GitFixture): Promise<TestRepository> {
  const workspace = makeRepo("/", { now: () => 1_577_836_800_000 });
  await importFixture(source, workspace.repo.checkout);
  checkoutTree(workspace.repo, workspace.worktree, workspace.repo.headTree());
  workspace.repo.store.configSet("user.name", "Fixture");
  workspace.repo.store.configSet("user.email", "fixture@example.com");
  return workspace;
}

function reopen(workspace: TestRepository): { context: GitContext; repo: Repository } {
  const database = new SqliteGitDatabase(new TestDatabase(workspace.storage), {
    now: workspace.context.now,
  });
  const row = database.findCheckout("/");
  if (row === null) throw new Error("reopened repository is missing");
  return {
    context: { ...workspace.context, database },
    repo: new Repository(database.openCheckout(row)),
  };
}

function reopenBThenA(
  workspace: TestRepository,
  bRoot: string,
): { context: GitContext; a: Repository; b: Repository } {
  const database = new SqliteGitDatabase(new TestDatabase(workspace.storage), {
    now: workspace.context.now,
  });
  const bRow = database.checkoutAt(bRoot);
  if (bRow === null) throw new Error("reopened checkout B is missing");
  const b = new Repository(database.openCheckout(bRow));
  const aRow = database.checkoutAt("/");
  if (aRow === null) throw new Error("reopened checkout A is missing");
  const a = new Repository(database.openCheckout(aRow));
  return { context: { ...workspace.context, database }, a, b };
}

class LateMetadataWorktree extends CountingWorktree {
  scanCalls = 0;

  constructor(
    inner: Worktree,
    private readonly cleanContentId: Uint8Array,
  ) {
    super(inner);
  }

  override scan(root: string, options: ScanOptions): ScanEntry[] {
    const page = super.scan(root, options);
    this.scanCalls++;
    return page.map((entry) =>
      entry.path === "/guard.bin"
        ? this.scanCalls <= 2
          ? { ...entry, contentId: this.cleanContentId }
          : { ...entry, mtime: entry.mtime + 1, rev: entry.rev + 1, contentId: null }
        : entry,
    );
  }
}

function history(
  source: GitFixture,
  conflictLast = false,
): {
  upstream: string;
  original: string;
} {
  source.write("shared.txt", "base\n");
  const base = source.commit("base");
  source.git("checkout", "-q", "-b", "upstream", base);
  source.write("upstream.txt", "upstream\n");
  if (conflictLast) source.write("shared.txt", "upstream\n");
  const upstream = source.commit("upstream");
  source.git("checkout", "-q", "-b", "current", base);
  source.write("one.txt", "one\n");
  source.commit("one");
  source.write("two.txt", "two\n");
  if (conflictLast) source.write("shared.txt", "current\n");
  const original = source.commit("two");
  return { upstream, original };
}

function objectProjectionCounts(workspace: TestRepository): {
  objects: number;
  commits: number;
  treeSources: number;
  treeEntries: number;
  treeEffective: number;
} {
  const row = workspace.storage.sql
    .exec<{
      objects: number;
      commits: number;
      treeSources: number;
      treeEntries: number;
      treeEffective: number;
    }>(
      `SELECT (SELECT COUNT(*) FROM git_objects) AS objects,
              (SELECT COUNT(*) FROM git_commits) AS commits,
              (SELECT COUNT(*) FROM git_tree_sources) AS treeSources,
              (SELECT COUNT(*) FROM git_tree_entries) AS treeEntries,
              (SELECT COUNT(*) FROM git_tree_effective) AS treeEffective`,
    )
    .toArray()[0];
  if (row === undefined) throw new Error("object projection counts are missing");
  return row;
}

function operationRowCount(workspace: TestRepository, checkoutId: number): number {
  return (
    workspace.repo.store.db.scalar<number>(
      `SELECT (SELECT count(*) FROM git_operation_state WHERE checkout_id = ?)
            + (SELECT count(*) FROM git_operation_steps WHERE checkout_id = ?)
            + (SELECT count(*) FROM git_operation_touched WHERE checkout_id = ?)`,
      checkoutId,
      checkoutId,
      checkoutId,
    ) ?? 0
  );
}

function checkoutIsolationSnapshot(workspace: TestRepository, repo: Repository) {
  return {
    rawHead: repo.checkout.head(),
    headLog: repo.checkout.reflog("HEAD"),
    operationRows: operationRowCount(workspace, repo.checkout.checkoutId),
    index: [...repo.checkout.indexScan()],
    worktree: workspace.worktree.scan(repo.root, { limit: 100 }).map((entry) => ({
      path: entry.path,
      type: entry.type,
      mode: entry.mode,
      size: entry.size,
      mtime: entry.mtime,
      ino: entry.ino,
      nlink: entry.nlink,
      rev: entry.rev,
      target: entry.target,
      contentId: entry.contentId,
      bytes: entry.type === "file" ? workspace.worktree.readFile(entry.path) : null,
    })),
  };
}

async function suspendedMultiCheckout(): Promise<{
  workspace: TestRepository;
  a: Repository;
  b: Repository;
  original: string;
  upstream: string;
  bCommit: string;
}> {
  const source = fixture();
  const { original, upstream } = history(source, true);
  const workspace = await imported(source);
  const created = worktreeAdd(workspace.context, workspace.repo, {
    root: "/checkout-b",
    target: { kind: "new-branch", name: "session-b", startPoint: "current" },
  });
  const row = workspace.database.checkoutAt(created.root);
  if (row === null) throw new Error("checkout B is missing");
  const b = new Repository(workspace.database.openCheckout(row));

  expect(rebase(workspace.context, workspace.repo, workspace.worktree, { upstream })).toMatchObject(
    { outcome: "conflicted", replayed: 1 },
  );
  expect(workspace.repo.checkout.requireOperationState("rebase").state.phase).toBe("conflicted");
  expect(b.checkout.readOperationState()).toBeNull();
  expect(status(b, workspace.worktree)).toEqual([]);

  writeWorkFile(workspace, "/checkout-b/b-only.txt", "checkout B\n");
  add(b, workspace.worktree, { paths: ["b-only.txt"] });
  const bCommit = commit(workspace.context, b, { message: "checkout B commit" }).oid;
  expect(status(b, workspace.worktree)).toEqual([]);
  expect(b.checkout.readOperationState()).toBeNull();
  expect(workspace.repo.store.getRef("refs/heads/session-b")).toBe(bCommit);
  expect(b.store.getRef("refs/heads/current")).toBe(original);
  return { workspace, a: workspace.repo, b, original, upstream, bCommit };
}

describe("rebase restart recovery", () => {
  it("authenticates replay commits after more than eight progressing object reads", () => {
    const workspace = makeRepo("/");
    const tree = workspace.repo.store.write("tree", serializeTree([]));
    const sourceOids: string[] = [];
    const message = "x".repeat(900 * 1024);
    for (let ordinal = 0; ordinal < 33; ordinal++) {
      sourceOids.push(
        workspace.repo.store.write(
          "commit",
          serializeCommit({
            tree,
            parent: [],
            author: PERSON,
            committer: PERSON,
            message: `${ordinal}\n${message}\n`,
          }),
        ),
      );
    }
    const before = workspace.repo.store.objectCount();
    const readObjects = workspace.repo.readObjects.bind(workspace.repo);
    let readCalls = 0;
    workspace.repo.readObjects = (oids, options) => {
      readCalls++;
      return readObjects(oids, options);
    };

    const result = preflightReplayCommitObjects(workspace.repo, sourceOids);

    expect(readCalls).toBeGreaterThan(8);
    expect(result.bytes).toBeGreaterThan(28 * 1024 * 1024);
    expect(workspace.repo.store.objectCount()).toBe(before);
    expect(workspace.repo.checkout.readOperationState()).toBeNull();
  });

  it("completes an actual maximum-entry replay transition", async () => {
    const source = fixture();
    source.write("base.txt", "base\n");
    const base = source.commit("base");
    source.git("checkout", "-q", "-b", "upstream", base);
    source.write("upstream.txt", "upstream\n");
    const upstream = source.commit("upstream");
    source.git("checkout", "-q", "-b", "current", base);
    for (let ordinal = 0; ordinal < 999; ordinal++) {
      source.write(`many/${ordinal.toString().padStart(4, "0")}.txt`, `${ordinal}\n`);
    }
    source.commit("maximum integration entries");
    const workspace = await imported(source);
    const result = rebase(workspace.context, workspace.repo, workspace.worktree, { upstream });
    expect(result).toMatchObject({ outcome: "completed", replayed: 1 });
    if (result.outcome !== "completed") throw new Error("maximum-entry rebase did not complete");
    expect(workspace.repo.head().oid).toBe(result.oid);
  });

  it("recovers the former first-excess rebase across two valid large baselines", async () => {
    const source = fixture();
    source.write("conflict.txt", "base\n");
    const base = source.commit("base");
    const baselineSizes = [4 * 1024 * 1024, 4 * 1024 * 1024, 1];

    source.git("checkout", "-q", "-b", "upstream", base);
    for (const [ordinal, size] of baselineSizes.entries()) {
      source.write(`upstream-${ordinal}.bin`, new Uint8Array(size).fill(0x75 + ordinal));
    }
    source.write("conflict.txt", "upstream\n");
    const upstream = source.commit("upstream");
    const upstreamBlobs = baselineSizes.map((_, ordinal) => ({
      path: `upstream-${ordinal}.bin`,
      oid: source.git("rev-parse", `upstream:upstream-${ordinal}.bin`),
    }));

    source.git("checkout", "-q", "-b", "current", base);
    for (const [ordinal, size] of baselineSizes.entries()) {
      source.write(`current-${ordinal}.bin`, new Uint8Array(size).fill(0x63 + ordinal));
    }
    source.write("conflict.txt", "current\n");
    source.commit("current");
    const currentBlobs = baselineSizes.map((_, ordinal) => ({
      path: `current-${ordinal}.bin`,
      oid: source.git("rev-parse", `current:current-${ordinal}.bin`),
    }));
    const workspace = await imported(source);

    expect(
      rebase(workspace.context, workspace.repo, workspace.worktree, { upstream }),
    ).toMatchObject({ outcome: "conflicted", replayed: 0 });
    const cold = reopen(workspace);
    expect(cold.repo.checkout.requireOperationState("rebase").state.phase).toBe("conflicted");
    for (const expected of [...upstreamBlobs, ...currentBlobs]) {
      expect(cold.repo.checkout.indexGet(expected.path)?.oid).toBe(expected.oid);
    }

    writeWorkFile(workspace, "/conflict.txt", "resolved\n");
    add(cold.repo, workspace.worktree, { paths: ["conflict.txt"] });
    const result = rebaseContinue(cold.context, cold.repo, workspace.worktree);

    expect(result).toMatchObject({ outcome: "completed", replayed: 1 });
    if (result.outcome !== "completed") throw new Error("large-baseline rebase did not complete");
    const durable = reopen(workspace);
    expect(durable.repo.head().oid).toBe(result.oid);
    expect(durable.repo.checkout.readOperationState()).toBeNull();
    for (const expected of [...upstreamBlobs, ...currentBlobs]) {
      expect(durable.repo.checkout.indexGet(expected.path)?.oid).toBe(expected.oid);
    }
    expect(workspace.worktree.readFile("/conflict.txt")).toEqual(
      new TextEncoder().encode("resolved\n"),
    );
  });

  it("aborts the former first-excess rebase recovery after a cold reopen", async () => {
    const source = fixture();
    source.write("conflict.txt", "base\n");
    const stableSizes = [
      4 * 1024 * 1024,
      4 * 1024 * 1024,
      4 * 1024 * 1024,
      4 * 1024 * 1024,
      4 * 1024 * 1024,
      4 * 1024 * 1024,
      4 * 1024 * 1024,
      1,
    ];
    for (const [ordinal, size] of stableSizes.entries()) {
      source.write(`stable-${ordinal}.bin`, new Uint8Array(size).fill(0x31 + ordinal));
    }
    const base = source.commit("base");

    source.git("checkout", "-q", "-b", "upstream", base);
    source.write("conflict.txt", "upstream\n");
    const upstream = source.commit("upstream");

    source.git("checkout", "-q", "-b", "current", base);
    source.write("conflict.txt", "current\n");
    const current = source.commit("current");
    const stable = stableSizes.map((size, ordinal) => ({
      path: `stable-${ordinal}.bin`,
      size,
      oid: source.git("rev-parse", `current:stable-${ordinal}.bin`),
    }));
    const conflictOid = source.git("rev-parse", "current:conflict.txt");
    const workspace = await imported(source);

    expect(
      rebase(workspace.context, workspace.repo, workspace.worktree, { upstream }),
    ).toMatchObject({ outcome: "conflicted", replayed: 0 });
    const cold = reopen(workspace);
    const journal = cold.repo.checkout.requireOperationState("rebase");
    expect(journal.steps).toHaveLength(1);
    expect(journal.touched).toHaveLength(1);
    expect(journal.retainedBytes).toBeGreaterThan(0);
    expect(journal.retainedBytes).toBeLessThan(1024 * 1024);

    rebaseAbort(cold.repo, workspace.worktree);

    const durable = reopen(workspace);
    expect(durable.repo.head()).toEqual({ ref: "refs/heads/current", oid: current });
    expect(durable.repo.checkout.readOperationState()).toBeNull();
    expect(durable.repo.checkout.indexGet("conflict.txt")?.oid).toBe(conflictOid);
    expect(workspace.worktree.readFile("/conflict.txt")).toEqual(
      new TextEncoder().encode("current\n"),
    );
    for (const expected of stable) {
      expect(durable.repo.checkout.indexGet(expected.path)?.oid).toBe(expected.oid);
      expect(workspace.worktree.stat(`/${expected.path}`)).toMatchObject({
        size: expected.size,
        contentId: fromHex(expected.oid),
      });
    }
  });

  it("fast-forwards after the rebase guard's former 65th range read", async () => {
    const source = fixture();
    const bytes = 4 * 1024 * 1024 + 1;
    const baseBytes = new Uint8Array(bytes).fill(0x62);
    const targetBytes = new Uint8Array(bytes).fill(0x74);
    source.write("guard.bin", baseBytes);
    const base = source.commit("base");
    source.write("guard.bin", targetBytes);
    const upstream = source.commit("upstream");
    source.git("checkout", "-q", "-b", "behind", base);
    const workspace = await imported(source);
    const guard = workspace.repo.checkout.indexGet("guard.bin");
    if (guard === null) throw new Error("guard index entry is missing");
    const worktree = new LateMetadataWorktree(workspace.worktree, fromHex(guard.oid));

    const result = rebase(workspace.context, workspace.repo, worktree, { upstream });

    expect(result).toMatchObject({ outcome: "completed", replayed: 0, fastForward: true });
    expect(worktree.rangeReads).toBe(65);
    expect(workspace.repo.head().oid).toBe(upstream);
    expect(workspace.worktree.readFile("/guard.bin")).toEqual(targetBytes);
    expect(workspace.repo.checkout.readOperationState()).toBeNull();
  });

  it("preflights the exact maximum replay queue before creating its journal", () => {
    const workspace = makeRepo("/");
    const tree = workspace.repo.store.write("tree", serializeTree([]));
    const base = workspace.repo.store.write(
      "commit",
      serializeCommit({
        tree,
        parent: [],
        author: PERSON,
        committer: PERSON,
        message: "base\n",
      }),
    );
    const upstream = workspace.repo.store.write(
      "commit",
      serializeCommit({
        tree,
        parent: [base],
        author: PERSON,
        committer: PERSON,
        message: "upstream\n",
      }),
    );
    let current = base;
    for (let ordinal = 1; ordinal <= MAX_OPERATION_STEPS; ordinal++) {
      current = workspace.repo.store.write(
        "commit",
        serializeCommit({
          tree,
          parent: [current],
          author: PERSON,
          committer: PERSON,
          message: `current ${ordinal}\n`,
        }),
      );
    }
    workspace.repo.store.setRef("refs/heads/main", current);
    const originalWrite = workspace.repo.checkout.writeOperationJournal.bind(
      workspace.repo.checkout,
    );
    let reachedJournal = false;
    workspace.repo.checkout.writeOperationJournal = (state, steps, touched) => {
      expect(steps).toHaveLength(MAX_OPERATION_STEPS);
      reachedJournal = true;
      originalWrite(state, steps, touched);
      throw new Error("maximum replay journal seam");
    };

    expect(() =>
      rebase(workspace.context, workspace.repo, workspace.worktree, { upstream }),
    ).toThrow("maximum replay journal seam");
    expect(reachedJournal).toBe(true);
    expect(workspace.repo.head().oid).toBe(current);
    expect(workspace.repo.checkout.readOperationState()).toBeNull();
  });

  it("rolls the upstream baseline back when initial journal creation fails", async () => {
    const source = fixture();
    const { original, upstream } = history(source);
    const workspace = await imported(source);
    const originalWrite = workspace.repo.checkout.writeOperationJournal.bind(
      workspace.repo.checkout,
    );
    workspace.repo.checkout.writeOperationJournal = (state, steps, touched) => {
      originalWrite(state, steps, touched);
      throw new Error("initial journal fault");
    };

    expect(() =>
      rebase(workspace.context, workspace.repo, workspace.worktree, { upstream }),
    ).toThrow("initial journal fault");
    expect(workspace.repo.head().oid).toBe(original);
    expect(workspace.repo.checkout.readOperationState()).toBeNull();
    expect(
      integrationIndexMatchesTree(workspace.repo, workspace.repo.readCommit(original).tree),
    ).toBe(true);
  });

  it("rolls a fast-forward checkout back when its expected-old ref update is stale", async () => {
    const source = fixture();
    source.write("file.txt", "one\n");
    const first = source.commit("one");
    source.write("file.txt", "two\n");
    const second = source.commit("two");
    source.git("checkout", "-q", "-b", "behind", first);
    const workspace = await imported(source);
    const originalUpdate = workspace.repo.mutateRefs.bind(workspace.repo);
    workspace.repo.mutateRefs = (mutation, metadata) => {
      originalUpdate({ puts: [{ name: "refs/heads/behind", target: second }] }, metadata);
      return originalUpdate(mutation, metadata);
    };

    expect(() =>
      rebase(workspace.context, workspace.repo, workspace.worktree, { upstream: second }),
    ).toThrow(/changed|stale/i);
    const durable = reopen(workspace);
    expect(durable.repo.head()).toEqual({ ref: "refs/heads/behind", oid: first });
    expect(integrationIndexMatchesTree(durable.repo, durable.repo.readCommit(first).tree)).toBe(
      true,
    );
    expect(durable.repo.checkout.readOperationState()).toBeNull();
    expect(durable.repo.store.reflog("refs/heads/behind")).toEqual([]);
    expect(durable.repo.checkout.reflog("HEAD")).toEqual([]);
  });

  it("rolls conflict files and stages back when journal suspension fails", async () => {
    const source = fixture();
    const { original, upstream } = history(source, true);
    const workspace = await imported(source);
    const originalReplace = workspace.repo.checkout.replaceOperationJournal.bind(
      workspace.repo.checkout,
    );
    workspace.repo.checkout.replaceOperationJournal = (integrity, state, steps, touched) => {
      originalReplace(integrity, state, steps, touched);
      if (state.phase === "conflicted") throw new Error("conflict journal fault");
    };

    expect(() =>
      rebase(workspace.context, workspace.repo, workspace.worktree, { upstream }),
    ).toThrow("conflict journal fault");
    const durable = reopen(workspace);
    const journal = durable.repo.checkout.requireOperationState("rebase");
    expect(journal.state).toMatchObject({ phase: "running", currentStep: 1 });
    expect(journal.touched).toEqual([]);
    expect(durable.repo.head().oid).toBe(original);
    expect(durable.repo.checkout.hasConflicts()).toBe(false);
  });

  it("rolls a hard skip checkout back when its cursor transition fails", async () => {
    const source = fixture();
    const { upstream } = history(source, true);
    const workspace = await imported(source);
    expect(
      rebase(workspace.context, workspace.repo, workspace.worktree, { upstream }).outcome,
    ).toBe("conflicted");
    writeWorkFile(workspace, "/one.txt", "conflict-time staged edit\n");
    add(workspace.repo, workspace.worktree, { paths: ["one.txt"] });
    const before = workspace.repo.checkout.requireOperationState("rebase");
    const originalReplace = workspace.repo.checkout.replaceOperationJournal.bind(
      workspace.repo.checkout,
    );
    workspace.repo.checkout.replaceOperationJournal = (integrity, state, steps, touched) => {
      originalReplace(integrity, state, steps, touched);
      if (state.phase === "running") throw new Error("skip cursor fault");
    };

    expect(() => rebaseSkip(workspace.context, workspace.repo, workspace.worktree)).toThrow(
      "skip cursor fault",
    );
    const durable = reopen(workspace);
    const after = durable.repo.checkout.requireOperationState("rebase");
    expect(after.integrityOid).toBe(before.integrityOid);
    expect(after.state).toMatchObject({
      phase: "conflicted",
      currentStep: before.state.currentStep,
    });
    expect(workspace.worktree.readFile("/one.txt")).toEqual(
      new TextEncoder().encode("conflict-time staged edit\n"),
    );
  });

  it("rolls a hard abort checkout back when journal clearing fails", async () => {
    const source = fixture();
    const { upstream } = history(source, true);
    const workspace = await imported(source);
    expect(
      rebase(workspace.context, workspace.repo, workspace.worktree, { upstream }).outcome,
    ).toBe("conflicted");
    writeWorkFile(workspace, "/one.txt", "abort-time edit\n");
    const before = workspace.repo.checkout.requireOperationState("rebase");
    const originalClear = workspace.repo.checkout.clearOperationState.bind(workspace.repo.checkout);
    workspace.repo.checkout.clearOperationState = () => {
      originalClear();
      throw new Error("abort clear fault");
    };

    expect(() => rebaseAbort(workspace.repo, workspace.worktree)).toThrow("abort clear fault");
    const durable = reopen(workspace);
    expect(durable.repo.checkout.requireOperationState("rebase").integrityOid).toBe(
      before.integrityOid,
    );
    expect(workspace.worktree.readFile("/one.txt")).toEqual(
      new TextEncoder().encode("abort-time edit\n"),
    );
  });

  it("rolls a clean unpublished commit back when its cursor transition fails", async () => {
    const source = fixture();
    const { original, upstream } = history(source);
    const workspace = await imported(source);
    const projectionsBefore = objectProjectionCounts(workspace);
    const originalReplace = workspace.repo.checkout.replaceOperationJournal.bind(
      workspace.repo.checkout,
    );
    workspace.repo.checkout.replaceOperationJournal = (integrity, state, steps, touched) => {
      originalReplace(integrity, state, steps, touched);
      if (state.phase === "running" && state.currentStep === 1) {
        throw new Error("clean cursor fault");
      }
    };

    expect(() =>
      rebase(workspace.context, workspace.repo, workspace.worktree, { upstream }),
    ).toThrow("clean cursor fault");
    const durable = reopen(workspace);
    const journal = durable.repo.checkout.requireOperationState("rebase");
    expect(journal.state).toMatchObject({
      phase: "running",
      currentStep: 0,
      currentParentOid: upstream,
    });
    expect(journal.steps.every((step) => step.outcome === "pending")).toBe(true);
    expect(durable.repo.head().oid).toBe(original);
    expect(integrationIndexMatchesTree(durable.repo, durable.repo.readCommit(upstream).tree)).toBe(
      true,
    );
    expect(objectProjectionCounts(workspace)).toEqual(projectionsBefore);
  });

  it("resumes after the initial upstream baseline and journal commit", async () => {
    const source = fixture();
    const { original, upstream } = history(source);
    const workspace = await imported(source);
    const originalRead = workspace.repo.checkout.readOperationState.bind(workspace.repo.checkout);
    let journalWritten = false;
    const originalWrite = workspace.repo.checkout.writeOperationJournal.bind(
      workspace.repo.checkout,
    );
    workspace.repo.checkout.writeOperationJournal = (state, steps, touched) => {
      originalWrite(state, steps, touched);
      journalWritten = true;
    };
    workspace.repo.checkout.readOperationState = () => {
      if (journalWritten) throw new Error("restart after baseline");
      return originalRead();
    };

    expect(() =>
      rebase(workspace.context, workspace.repo, workspace.worktree, { upstream }),
    ).toThrow("restart after baseline");
    const durable = reopen(workspace);
    const journal = durable.repo.checkout.requireOperationState("rebase");
    expect(journal.state).toMatchObject({
      phase: "running",
      currentStep: 0,
      currentParentOid: upstream,
      originalHeadOid: original,
    });
    expect(durable.repo.head().oid).toBe(original);
    expect(integrationIndexMatchesTree(durable.repo, durable.repo.readCommit(upstream).tree)).toBe(
      true,
    );

    const result = rebaseContinue(durable.context, durable.repo, workspace.worktree);
    expect(result.outcome).toBe("completed");
    expect(durable.repo.checkout.readOperationState()).toBeNull();
  });

  it("aborts a cold running baseline back to original HEAD", async () => {
    const source = fixture();
    const { original, upstream } = history(source);
    const workspace = await imported(source);
    const originalRead = workspace.repo.checkout.readOperationState.bind(workspace.repo.checkout);
    let journalWritten = false;
    const originalWrite = workspace.repo.checkout.writeOperationJournal.bind(
      workspace.repo.checkout,
    );
    workspace.repo.checkout.writeOperationJournal = (state, steps, touched) => {
      originalWrite(state, steps, touched);
      journalWritten = true;
    };
    workspace.repo.checkout.readOperationState = () => {
      if (journalWritten) throw new Error("restart at running baseline");
      return originalRead();
    };
    expect(() =>
      rebase(workspace.context, workspace.repo, workspace.worktree, { upstream }),
    ).toThrow("restart at running baseline");

    const durable = reopen(workspace);
    rebaseAbort(durable.repo, workspace.worktree);
    expect(durable.repo.head().oid).toBe(original);
    expect(durable.repo.checkout.readOperationState()).toBeNull();
    expect(integrationIndexMatchesTree(durable.repo, durable.repo.readCommit(original).tree)).toBe(
      true,
    );
  });

  it("resumes a cold conflict after a clean applied step and ignores a moved upstream ref", async () => {
    const source = fixture();
    const { original } = history(source, true);
    const workspace = await imported(source);

    const suspended = rebase(workspace.context, workspace.repo, workspace.worktree, {
      upstream: "upstream",
    });
    expect(suspended).toMatchObject({ outcome: "conflicted", replayed: 1 });
    const journal = workspace.repo.checkout.requireOperationState("rebase");
    expect(journal.state.currentStep).toBe(1);
    workspace.repo.store.setRef("refs/heads/upstream", original);

    const durable = reopen(workspace);
    writeWorkFile(workspace, "/shared.txt", "cold resolution\n");
    add(durable.repo, workspace.worktree, { paths: ["shared.txt"] });
    const result = rebaseContinue(durable.context, durable.repo, workspace.worktree);

    expect(result).toMatchObject({ outcome: "completed", replayed: 2 });
    expect(durable.repo.checkout.readOperationState()).toBeNull();
  });

  it("retains the completed journal when final publication fails, then publishes after reopen", async () => {
    const source = fixture();
    const { original, upstream } = history(source);
    const workspace = await imported(source);
    const originalUpdate = workspace.repo.mutateRefs.bind(workspace.repo);
    workspace.repo.mutateRefs = (mutation, metadata) => {
      originalUpdate(mutation, metadata);
      throw new Error("restart before publication");
    };

    expect(() =>
      rebase(workspace.context, workspace.repo, workspace.worktree, { upstream }),
    ).toThrow("restart before publication");
    const durable = reopen(workspace);
    const journal = durable.repo.checkout.requireOperationState("rebase");
    expect(journal.state.currentStep).toBe(journal.steps.length);
    expect(journal.state.committer).toEqual({
      name: "Fixture",
      email: "fixture@example.com",
    });
    expect(durable.repo.head().oid).toBe(original);
    expect(durable.repo.store.reflog("refs/heads/current")).toEqual([]);
    expect(durable.repo.checkout.reflog("HEAD")).toEqual([]);
    durable.repo.store.configSet("user.name", "Changed after restart");
    durable.repo.store.configSet("user.email", "changed@example.com");
    workspace.tick(60_000);

    const result: RebaseLifecycleResult = rebaseContinue(
      durable.context,
      durable.repo,
      workspace.worktree,
    );
    expect(result).toMatchObject({ outcome: "completed", replayed: 2 });
    if (result.outcome !== "completed") throw new Error("rebase did not complete");
    expect(durable.repo.head().oid).toBe(result.oid);
    expect(durable.repo.checkout.readOperationState()).toBeNull();
    expect(durable.repo.store.reflog("refs/heads/current")).toEqual([
      expect.objectContaining({
        oldOid: original,
        newOid: result.oid,
        actor: { name: "Fixture", email: "fixture@example.com" },
        timestamp: 1_577_836_860,
        timezoneOffset: 0,
        reason: "rebase: replay",
      }),
    ]);
  });

  it("retains a completed journal when the final CAS is stale without allocating history", async () => {
    const source = fixture();
    const { original, upstream } = history(source);
    const workspace = await imported(source);
    const originalUpdate = workspace.repo.mutateRefs.bind(workspace.repo);
    workspace.repo.mutateRefs = (mutation, metadata) => {
      workspace.repo.store.db.run(
        "UPDATE git_refs SET target = ? WHERE repo_id = ? AND name = 'refs/heads/current'",
        upstream,
        workspace.repo.store.repoId,
      );
      return originalUpdate(mutation, metadata);
    };

    expect(() =>
      rebase(workspace.context, workspace.repo, workspace.worktree, { upstream }),
    ).toThrowError(expect.objectContaining({ code: "ESTALEHEAD" }));

    const durable = reopen(workspace);
    const journal = durable.repo.checkout.requireOperationState("rebase");
    expect(journal.state.currentStep).toBe(journal.steps.length);
    expect(durable.repo.head().oid).toBe(original);
    expect(durable.repo.store.reflog("refs/heads/current")).toEqual([]);
    expect(durable.repo.checkout.reflog("HEAD")).toEqual([]);

    const result = rebaseContinue(durable.context, durable.repo, workspace.worktree);
    expect(result.outcome).toBe("completed");
    const named = durable.repo.store.reflog("refs/heads/current")[0];
    const head = durable.repo.checkout.reflog("HEAD")[0];
    if (named === undefined || head === undefined) throw new Error("rebase reflog is missing");
    expect(named.ordinal).toBe(1);
    expect(head.ordinal).toBe(2);
  });

  it("aborts a cold completed pre-publication journal back to original HEAD", async () => {
    const source = fixture();
    const { original, upstream } = history(source);
    const workspace = await imported(source);
    const originalUpdate = workspace.repo.mutateRefs.bind(workspace.repo);
    workspace.repo.mutateRefs = (mutation, metadata) => {
      originalUpdate(mutation, metadata);
      throw new Error("restart before completed abort");
    };
    expect(() =>
      rebase(workspace.context, workspace.repo, workspace.worktree, { upstream }),
    ).toThrow("restart before completed abort");

    const durable = reopen(workspace);
    const journal = durable.repo.checkout.requireOperationState("rebase");
    expect(journal.state.currentStep).toBe(journal.steps.length);
    rebaseAbort(durable.repo, workspace.worktree);
    expect(durable.repo.head().oid).toBe(original);
    expect(durable.repo.checkout.readOperationState()).toBeNull();
    expect(integrationIndexMatchesTree(durable.repo, durable.repo.readCommit(original).tree)).toBe(
      true,
    );
    expect(durable.repo.store.reflog("refs/heads/current")).toEqual([]);
    expect(durable.repo.checkout.reflog("HEAD")).toEqual([]);
  });

  it("rejects a stale checked-out branch without clearing recovery state", async () => {
    const source = fixture();
    const { upstream } = history(source, true);
    const workspace = await imported(source);
    expect(
      rebase(workspace.context, workspace.repo, workspace.worktree, { upstream }).outcome,
    ).toBe("conflicted");
    const journal = workspace.repo.checkout.requireOperationState("rebase");
    workspace.repo.store.setRef(journal.state.originalHeadRef, upstream);

    expect(() =>
      rebaseContinue(workspace.context, workspace.repo, workspace.worktree),
    ).toThrowError("HEAD changed during the rebase operation");
    expect(workspace.repo.checkout.requireOperationState("rebase").integrityOid).toBe(
      journal.integrityOid,
    );
  });
});

describe("multi-checkout rebase restart isolation", () => {
  it("reopens checkout B before A and continues A without changing B", async () => {
    const suspended = await suspendedMultiCheckout();
    const before = checkoutIsolationSnapshot(suspended.workspace, suspended.b);
    expect(before.rawHead).toBe("ref: refs/heads/session-b");
    expect(before.headLog.length).toBeGreaterThan(0);
    expect(before.operationRows).toBe(0);
    expect(before.index.length).toBeGreaterThan(0);

    const cold = reopenBThenA(suspended.workspace, suspended.b.root);
    expect(cold.b.store).toBe(cold.a.store);
    expect(cold.b.store.getRef("refs/heads/session-b")).toBe(suspended.bCommit);
    expect(cold.a.store.getRef("refs/heads/session-b")).toBe(suspended.bCommit);
    expect(cold.b.checkout.readOperationState()).toBeNull();
    expect(cold.a.checkout.requireOperationState("rebase").state.phase).toBe("conflicted");

    writeWorkFile(suspended.workspace, "/shared.txt", "continued by A\n");
    add(cold.a, suspended.workspace.worktree, { paths: ["shared.txt"] });
    const result = rebaseContinue(cold.context, cold.a, suspended.workspace.worktree);

    expect(result).toMatchObject({ outcome: "completed", replayed: 2 });
    if (result.outcome !== "completed") throw new Error("checkout A rebase did not complete");
    expect(cold.a.checkout.readOperationState()).toBeNull();
    expect(operationRowCount(suspended.workspace, cold.a.checkout.checkoutId)).toBe(0);
    expect(cold.b.store.getRef("refs/heads/current")).toBe(result.oid);
    expect(cold.b.store.getRef("refs/heads/upstream")).toBe(suspended.upstream);
    expect(cold.b.store.getRef("refs/heads/session-b")).toBe(suspended.bCommit);
    expect(status(cold.b, suspended.workspace.worktree)).toEqual([]);
    expect(checkoutIsolationSnapshot(suspended.workspace, cold.b)).toEqual(before);
  });

  it("reopens checkout B before A and aborts A without changing B", async () => {
    const suspended = await suspendedMultiCheckout();
    const before = checkoutIsolationSnapshot(suspended.workspace, suspended.b);
    expect(before.rawHead).toBe("ref: refs/heads/session-b");
    expect(before.headLog.length).toBeGreaterThan(0);
    expect(before.operationRows).toBe(0);

    const cold = reopenBThenA(suspended.workspace, suspended.b.root);
    expect(cold.b.store).toBe(cold.a.store);
    expect(cold.b.checkout.readOperationState()).toBeNull();
    expect(cold.a.checkout.requireOperationState("rebase").state.phase).toBe("conflicted");
    rebaseAbort(cold.a, suspended.workspace.worktree);

    expect(cold.a.head()).toEqual({ ref: "refs/heads/current", oid: suspended.original });
    expect(cold.a.checkout.readOperationState()).toBeNull();
    expect(operationRowCount(suspended.workspace, cold.a.checkout.checkoutId)).toBe(0);
    expect(integrationIndexMatchesTree(cold.a, cold.a.readCommit(suspended.original).tree)).toBe(
      true,
    );
    expect(cold.b.store.getRef("refs/heads/current")).toBe(suspended.original);
    expect(cold.b.store.getRef("refs/heads/upstream")).toBe(suspended.upstream);
    expect(cold.b.store.getRef("refs/heads/session-b")).toBe(suspended.bCommit);
    expect(status(cold.b, suspended.workspace.worktree)).toEqual([]);
    expect(checkoutIsolationSnapshot(suspended.workspace, cold.b)).toEqual(before);
  });

  it("matches real Git: a conflicted rebase in A does not block a clean commit in B", () => {
    const source = fixture();
    const { upstream } = history(source, true);
    const bRoot = `${source.dir}-checkout-b`;
    try {
      source.git("worktree", "add", "-b", "session-b", bRoot, "current");
      expect(() => source.git("rebase", "upstream")).toThrow();
      writeFileSync(join(bRoot, "b-only.txt"), "checkout B\n");
      source.git("-C", bRoot, "add", "b-only.txt");
      source.git("-C", bRoot, "commit", "-m", "checkout B commit");
      const bHead = source.git("-C", bRoot, "rev-parse", "HEAD");

      expect(source.git("rev-parse", "refs/heads/session-b")).toBe(bHead);
      expect(source.git("rev-parse", "refs/heads/upstream")).toBe(upstream);
      expect(source.git("-C", bRoot, "status", "--porcelain")).toBe("");
      source.git("rebase", "--abort");
      expect(source.git("-C", bRoot, "rev-parse", "HEAD")).toBe(bHead);
      expect(source.git("-C", bRoot, "status", "--porcelain")).toBe("");
    } finally {
      rmSync(bRoot, { recursive: true, force: true });
    }
  });
});
