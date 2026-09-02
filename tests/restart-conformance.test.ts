import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createGit, type Git } from "../src/git/client.js";
import { checkoutTree, indexFromTree } from "../src/git/ops/checkout.js";
import type { GitContext } from "../src/git/ops/context.js";
import type { Repository } from "../src/git/ops/repository.js";
import type { Worktree } from "../src/git/ops/worktree.js";
import type { IndexEntry, SqliteGitDatabase } from "../src/git/store/index.js";
import { GitFixture } from "./helpers/git.js";
import { importFixture } from "./helpers/import.js";
import { assertRepositoryReadable, reopenTestRepository } from "./helpers/repository-invariants.js";
import type { SqliteTestStorage } from "./helpers/storage.js";
import { makeRepo, type TestRepository } from "./helpers/workspace.js";

const PATH_COUNT = 513;
const utf8 = new TextEncoder();
let source: GitFixture | undefined;

interface PublicGitState {
  database: SqliteGitDatabase;
  worktree: Worktree;
  context: Pick<GitContext, "now" | "timezoneOffset">;
}

function pathAt(index: number): string {
  return `file-${index.toString().padStart(4, "0")}.txt`;
}

function contentAt(branch: "main" | "staged" | "topic", index: number): string {
  return `${branch} ${index}\n`;
}

beforeAll(() => {
  const created = new GitFixture().init();
  for (let index = 0; index < PATH_COUNT; index++) {
    created.write(pathAt(index), contentAt("main", index));
  }
  created.commit("main tree");
  created.git("checkout", "-q", "-b", "topic");
  for (let index = 0; index < PATH_COUNT; index++) {
    created.write(pathAt(index), contentAt("topic", index));
  }
  created.commit("topic tree");
  created.git("checkout", "-q", "main");
  source = created;
});

afterAll(() => {
  source?.dispose();
  source = undefined;
});

function requireSource(): GitFixture {
  if (source === undefined) throw new Error("restart fixture is missing");
  return source;
}

async function imported(): Promise<TestRepository> {
  const workspace = makeRepo("/", { now: () => 1_577_836_800_000 });
  await importFixture(requireSource(), workspace.repo.checkout);
  checkoutTree(workspace.repo, workspace.worktree, workspace.repo.headTree());
  workspace.repo.store.configSet("user.name", "Restart Fixture");
  workspace.repo.store.configSet("user.email", "restart@example.com");
  return workspace;
}

function publicGit(workspace: PublicGitState): Git {
  return createGit()({
    database: workspace.database,
    worktree: workspace.worktree,
    now: workspace.context.now,
    timezoneOffset: workspace.context.timezoneOffset,
  });
}

function treeAt(repo: Repository, ref: string): string {
  return repo.readCommit(repo.peel(repo.revParse(ref))).tree;
}

function expectedIndex(repo: Repository, ref: string): IndexEntry[] {
  return [...indexFromTree(repo, treeAt(repo, ref))];
}

function countMatching(entries: readonly IndexEntry[], expected: readonly IndexEntry[]): number {
  if (entries.length > expected.length) throw new Error("index contains unexpected rows");
  let matches = 0;
  for (let index = 0; index < entries.length; index++) {
    const actual = entries[index];
    const target = expected[index];
    if (actual === undefined || target === undefined || actual.path !== target.path) {
      throw new Error("index paths are not the expected ordered prefix");
    }
    if (actual.oid === target.oid && actual.mode === target.mode && actual.stage === target.stage) {
      matches++;
    }
  }
  return matches;
}

function expectExactIndex(repo: Repository, ref: string): void {
  const expected = expectedIndex(repo, ref);
  const actual = repo.checkout.indexEntries();
  expect(actual).toHaveLength(PATH_COUNT);
  expect(countMatching(actual, expected)).toBe(PATH_COUNT);
}

/**
 * Fail after a real index mutation page executes inside the public operation's outer transaction.
 */
function failAfterFirstIndexPage(storage: SqliteTestStorage): () => void {
  const originalExec = storage.sql.exec;
  let armed = true;
  storage.sql.exec = function exec<Row extends object>(query: string, ...bindings: unknown[]) {
    const cursor = originalExec<Row>(query, ...bindings);
    if (armed && query.replace(/\s+/g, " ").trim().startsWith("WITH mutation AS")) {
      armed = false;
      throw new Error("restart after first index page");
    }
    return cursor;
  };
  return () => {
    storage.sql.exec = originalExec;
  };
}

function writeStagedWorktree(workspace: TestRepository): void {
  workspace.worktree.writeFiles(
    Array.from({ length: PATH_COUNT }, (_, index) => ({
      path: `/${pathAt(index)}`,
      bytes: utf8.encode(contentAt("staged", index)),
    })),
  );
}

describe("paged local restart conformance", () => {
  it("rolls add back after its first indexApply page, then retries without duplicate objects", async () => {
    const workspace = await imported();
    writeStagedWorktree(workspace);
    const indexBeforeAdd = workspace.repo.checkout.indexEntries();
    const main = expectedIndex(workspace.repo, "main");
    const objectsBeforeAdd = workspace.repo.store.objectCount();
    workspace.storage.resetCounters();
    const restore = failAfterFirstIndexPage(workspace.storage);
    try {
      await expect(publicGit(workspace).add({ paths: [], all: true })).rejects.toThrow(
        "restart after first index page",
      );
    } finally {
      restore();
    }
    expect(workspace.storage.statementCount).toBeLessThan(1_000);

    const cold = reopenTestRepository(workspace);
    expect(cold.worktree).not.toBe(workspace.worktree);
    expect(cold.repo.checkout.indexEntries()).toEqual(indexBeforeAdd);
    expect(cold.repo.store.objectCount()).toBe(objectsBeforeAdd);
    assertRepositoryReadable(cold.repo);

    workspace.storage.resetCounters();
    const coldGit = publicGit(cold);
    await coldGit.add({ paths: [], all: true });
    expect(workspace.storage.statementCount).toBeLessThan(1_000);
    const staged = cold.repo.checkout.indexEntries();
    expect(staged).toHaveLength(PATH_COUNT);
    expect(countMatching(staged, main)).toBe(0);
    const objectsAfterRetry = cold.repo.store.objectCount();
    expect(objectsAfterRetry).toBe(objectsBeforeAdd + PATH_COUNT);
    assertRepositoryReadable(cold.repo);

    await coldGit.add({ paths: [], all: true });
    expect(cold.repo.checkout.indexEntries()).toEqual(staged);
    expect(cold.repo.store.objectCount()).toBe(objectsAfterRetry);
  });

  it("rolls a path soft reset back after its first indexApply page, then retries", async () => {
    const workspace = await imported();
    workspace.repo.checkout.indexReplace(expectedIndex(workspace.repo, "topic"));
    const topic = workspace.repo.checkout.indexEntries();
    workspace.storage.resetCounters();
    const restore = failAfterFirstIndexPage(workspace.storage);
    try {
      await expect(publicGit(workspace).reset({ paths: ["."] })).rejects.toThrow(
        "restart after first index page",
      );
    } finally {
      restore();
    }
    expect(workspace.storage.statementCount).toBeLessThan(1_000);

    const cold = reopenTestRepository(workspace);
    expect(cold.worktree).not.toBe(workspace.worktree);
    expect(cold.repo.checkout.indexEntries()).toEqual(topic);
    assertRepositoryReadable(cold.repo);

    workspace.storage.resetCounters();
    await publicGit(cold).reset({ paths: ["."] });
    expect(workspace.storage.statementCount).toBeLessThan(1_000);
    expectExactIndex(cold.repo, "main");
    assertRepositoryReadable(cold.repo);
  });

  it("rolls a bare reset back after its first delete-and-indexReplace page, then retries", async () => {
    const workspace = await imported();
    workspace.repo.checkout.indexReplace(expectedIndex(workspace.repo, "topic"));
    const topic = workspace.repo.checkout.indexEntries();
    workspace.storage.resetCounters();
    const restore = failAfterFirstIndexPage(workspace.storage);
    try {
      await expect(publicGit(workspace).reset()).rejects.toThrow("restart after first index page");
    } finally {
      restore();
    }
    expect(workspace.storage.statementCount).toBeLessThan(1_000);

    const cold = reopenTestRepository(workspace);
    expect(cold.worktree).not.toBe(workspace.worktree);
    expect(cold.repo.checkout.indexEntries()).toEqual(topic);
    assertRepositoryReadable(cold.repo);

    workspace.storage.resetCounters();
    await publicGit(cold).reset();
    expect(workspace.storage.statementCount).toBeLessThan(1_000);
    expectExactIndex(cold.repo, "main");
    assertRepositoryReadable(cold.repo);
  });

  it("keeps a 513-path checkout coherent through an immediate cold reopen", async () => {
    const workspace = await imported();
    const original = workspace.repo.head();
    const topic = workspace.repo.peel(workspace.repo.revParse("topic"));
    workspace.storage.resetCounters();

    await publicGit(workspace).checkout({ ref: "topic" });
    expect(workspace.storage.statementCount).toBeLessThan(1_000);

    const cold = reopenTestRepository(workspace);
    expect(cold.worktree).not.toBe(workspace.worktree);
    const coldGit = publicGit(cold);
    expect(cold.repo.head()).toEqual({ ref: "refs/heads/topic", oid: topic });
    expectExactIndex(cold.repo, "topic");
    await expect(coldGit.status()).resolves.toEqual([]);
    expect(cold.repo.checkout.reflog("HEAD")).toEqual([
      expect.objectContaining({
        oldRaw: `ref: ${original.ref}`,
        newRaw: "ref: refs/heads/topic",
        oldOid: original.oid,
        newOid: topic,
        reason: "checkout",
      }),
    ]);
    assertRepositoryReadable(cold.repo);
  });
});
