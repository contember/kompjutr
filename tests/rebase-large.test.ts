import { afterEach, expect, it } from "vitest";
import { createFilesystem } from "../packages/do/src/fs/filesystem.js";
import type { Filesystem } from "../packages/do/src/fs/types.js";
import { utf8 } from "../packages/git/src/common/bytes.js";
import { createSqliteSparseCapability } from "../packages/git/src/do-fs/index.js";
import { checkoutTree } from "../packages/git/src/ops/checkout/checkout.js";
import type { GitContext } from "../packages/git/src/ops/core/context.js";
import { rebase, rebaseAbort, rebaseContinue } from "../packages/git/src/ops/rebase/rebase.js";
import { Repository } from "../packages/git/src/ops/repository/repository.js";
import { add } from "../packages/git/src/ops/staging/staging.js";
import { SqliteGitDatabase } from "../packages/git/src/store/index.js";
import { TestDatabase } from "./helpers/db.js";
import { GitFixture } from "./helpers/git.js";
import { importFixture } from "./helpers/import.js";
import { makeRepo, type TestRepository } from "./helpers/workspace.js";
import { CountingWorktree } from "./helpers/worktree.js";

const FILES_PER_DIRECTORY = 1_000;
const START = 1_577_836_800_000;
// The removed caps: 4,096 baseline entries, 10,000 dirty-path hashes, 50,000 guard rows.
const HASHED_FILES = 10_500;
const GUARD_ROW_FILES = 50_500;

const fixtures: GitFixture[] = [];

afterEach(() => {
  while (fixtures.length > 0) fixtures.pop()?.dispose();
});

function filePath(ordinal: number): string {
  return `d${Math.floor(ordinal / FILES_PER_DIRECTORY)}/f${ordinal}.txt`;
}

function largeHistory(files: number): GitFixture {
  const source = new GitFixture().init();
  fixtures.push(source);
  source.write("conflict.txt", "base\n");
  for (let ordinal = 0; ordinal < files; ordinal++) {
    source.write(filePath(ordinal), `${ordinal}\n`);
  }
  source.commit("base");
  source.git("checkout", "-qb", "topic");
  source.write("conflict.txt", "topic\n");
  source.write("topic.txt", "topic\n");
  source.commit("topic");
  source.git("checkout", "-q", "main");
  source.write("conflict.txt", "upstream\n");
  source.write("d0/f0.txt", "upstream\n");
  source.commit("upstream");
  source.git("checkout", "-q", "topic");
  return source;
}

async function imported(source: GitFixture): Promise<TestRepository> {
  const workspace = makeRepo("/", { now: () => START });
  await importFixture(source, workspace.repo.checkout);
  checkoutTree(workspace.repo, workspace.worktree, workspace.repo.headTree());
  workspace.repo.store.configSet("user.name", "Fixture");
  workspace.repo.store.configSet("user.email", "fixture@example.com");
  return workspace;
}

interface Reopened {
  context: GitContext;
  repo: Repository;
  worktree: Filesystem;
}

/** A cold reopen: every database, repository, and filesystem object is rebuilt. */
function reopen(workspace: TestRepository, now: number): Reopened {
  const db = new TestDatabase(workspace.storage);
  const clock = (): number => now;
  const worktree = createFilesystem(db, { now: clock });
  const database = new SqliteGitDatabase(db, { now: clock });
  const row = database.findCheckout("/");
  if (row === null) throw new Error("reopened repository is missing");
  return {
    context: {
      database,
      worktree,
      sparseWorkspace: createSqliteSparseCapability(db).workspace,
      now: clock,
      timezoneOffset: () => 0,
    },
    repo: new Repository(database.openCheckout(row)),
    worktree,
  };
}

/** Long synchronous phases starve Vitest's worker RPC unless the test yields between them. */
function yieldToEventLoop(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve));
}

/** Rewrites identical bytes at a later clock, so only hashing proves the files clean. */
function touchFiles(worktree: Filesystem, count: number): void {
  for (let start = 0; start < count; start += FILES_PER_DIRECTORY) {
    const end = Math.min(count, start + FILES_PER_DIRECTORY);
    const entries = [];
    for (let ordinal = Math.max(1, start); ordinal < end; ordinal++) {
      entries.push({ path: `/${filePath(ordinal)}`, bytes: utf8.encode(`${ordinal}\n`) });
    }
    worktree.writeFiles(entries);
  }
}

it.each([
  { files: 12_000, finish: "continue", touched: 0 },
  { files: 12_000, finish: "abort", touched: 0 },
  { files: 12_000, finish: "continue", touched: HASHED_FILES },
  { files: GUARD_ROW_FILES, finish: "continue", touched: 0 },
])(
  "rebases $files files through a conflict and a cold reopen ($finish, $touched touched)",
  async ({ files, finish, touched }) => {
    const source = largeHistory(files);
    await yieldToEventLoop();
    const workspace = await imported(source);
    const upstream = source.git("rev-parse", "main");

    expect(() => source.git("rebase", "main")).toThrow();
    await yieldToEventLoop();
    expect(
      rebase(workspace.context, workspace.repo, workspace.worktree, [], { upstream }),
    ).toMatchObject({ outcome: "conflicted", replayed: 0 });
    await yieldToEventLoop();

    const cold = reopen(workspace, START + 60_000);
    expect(cold.repo.checkout.requireOperationState("rebase").state.phase).toBe("conflicted");
    touchFiles(cold.worktree, touched);
    await yieldToEventLoop();
    const counting = new CountingWorktree(cold.worktree);
    if (finish === "abort") {
      source.git("rebase", "--abort");
      rebaseAbort(cold.repo, counting, []);
    } else {
      source.write("conflict.txt", "resolved\n");
      source.git("add", "conflict.txt");
      source.git("-c", "core.editor=true", "rebase", "--continue");
      cold.worktree.writeFiles([{ path: "/conflict.txt", bytes: utf8.encode("resolved\n") }]);
      add(cold.repo, cold.worktree, { paths: ["conflict.txt"] });
      expect(rebaseContinue(cold.context, cold.repo, counting, [])).toMatchObject({
        outcome: "completed",
        replayed: 1,
      });
    }
    await yieldToEventLoop();
    if (touched > 0) expect(counting.bulkReadPaths.length).toBeGreaterThan(10_000);

    const durable = reopen(workspace, START + 120_000);
    expect(durable.repo.checkout.readOperationState()).toBeNull();
    expect(durable.repo.headTree()).toBe(source.git("rev-parse", "HEAD^{tree}"));
    expect(durable.worktree.readFile("/conflict.txt")).toEqual(
      utf8.encode(finish === "abort" ? "topic\n" : "resolved\n"),
    );
    expect(durable.worktree.readFile("/d0/f0.txt")).toEqual(
      utf8.encode(finish === "abort" ? "0\n" : "upstream\n"),
    );
  },
);
