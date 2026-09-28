import { afterEach, describe, expect, it } from "vitest";
import { hasErrorCode } from "../packages/git/src/common/errors.js";
import { createSqliteSparseCapability } from "../packages/git/src/do-fs/index.js";
import { checkoutTree } from "../packages/git/src/ops/checkout/checkout.js";
import type { GitContext } from "../packages/git/src/ops/core/context.js";
import { rebase } from "../packages/git/src/ops/rebase/rebase.js";
import { add } from "../packages/git/src/ops/staging/staging.js";
import { GitFixture } from "./helpers/git.js";
import { importFixture } from "./helpers/import.js";
import { makeRepo, type TestRepository, writeWorkFile } from "./helpers/workspace.js";

// A sealed index tracker answers the rebase start checks; anything short of a
// clean tracker at HEAD falls back to the full checks.

const fixtures: GitFixture[] = [];

afterEach(() => {
  while (fixtures.length > 0) fixtures.pop()?.dispose();
});

interface Started {
  source: GitFixture;
  workspace: TestRepository;
  context: GitContext;
  base: string;
  original: string;
  seal(tree: string): void;
}

async function started(): Promise<Started> {
  const source = new GitFixture().init();
  fixtures.push(source);
  source.write("shared.txt", "base\n");
  source.write("other.txt", "base\n");
  const base = source.commit("base");
  source.git("checkout", "-q", "-b", "upstream", base);
  source.write("upstream.txt", "upstream\n");
  source.commit("upstream");
  source.git("checkout", "-q", "-b", "current", base);
  source.write("shared.txt", "current\n");
  const original = source.commit("current");
  const workspace = makeRepo("/", { now: () => 1_577_836_800_000 });
  await importFixture(source, workspace.repo.checkout);
  checkoutTree(workspace.repo, workspace.worktree, workspace.repo.headTree());
  workspace.repo.store.configSet("user.name", "Fixture");
  workspace.repo.store.configSet("user.email", "fixture@example.com");
  const sparse = createSqliteSparseCapability(workspace.database.db);
  const context: GitContext = {
    ...workspace.context,
    indexTracker: sparse.tracker,
    selectedPaths: sparse.selected,
    commitTrees: sparse.commitTrees,
  };
  const seal = (tree: string): void => {
    expect(sparse.tracker.reseal(workspace.repo.checkout.checkoutId, tree, [])).toBe(true);
  };
  return { source, workspace, context, base, original, seal };
}

function expectRefused(action: () => unknown, message: string): void {
  let caught: unknown = null;
  try {
    action();
  } catch (error) {
    caught = error;
  }
  expect(hasErrorCode(caught, "ECHECKOUTFAIL")).toBe(true);
  expect(caught).toBeInstanceOf(Error);
  if (caught instanceof Error) expect(caught.message).toContain(message);
}

function expectUnstarted(start: Started): void {
  expect(start.workspace.repo.head().oid).toBe(start.original);
  expect(start.workspace.repo.checkout.readOperationState()).toBeNull();
}

/** An up-to-date rebase runs only the start checks, so its queries show which path ran. */
function upToDateWorktreeQueries(start: Started, context: GitContext): string[] {
  const storage = start.workspace.storage;
  const histogram = new Map<string, number>();
  storage.histogram = histogram;
  try {
    const result = rebase(context, start.workspace.repo, start.workspace.worktree, [], {
      upstream: start.base,
    });
    expect(result).toEqual({ outcome: "up-to-date", oid: start.original });
  } finally {
    storage.histogram = null;
  }
  return [...histogram.keys()].filter((query) => query.includes("fs_paths"));
}

describe("rebase start from the index tracker", () => {
  it("answers the start checks without a worktree walk", async () => {
    const start = await started();
    start.seal(start.workspace.repo.readCommit(start.original).tree);

    expect(upToDateWorktreeQueries(start, start.context)).toEqual([]);
    expect(upToDateWorktreeQueries(start, start.workspace.context).length).toBeGreaterThan(0);
  });

  it("starts from a clean tracker and matches real Git", async () => {
    const start = await started();
    start.seal(start.workspace.repo.readCommit(start.original).tree);
    start.source.git("rebase", "-q", "upstream");
    const expectedTree = start.source.git("rev-parse", "HEAD^{tree}");

    const result = rebase(start.context, start.workspace.repo, start.workspace.worktree, [], {
      upstream: "upstream",
    });

    expect(result).toMatchObject({ outcome: "completed", replayed: 1 });
    expect(start.workspace.repo.headTree()).toBe(expectedTree);
  });

  it("refuses a worktree edit the tracker recorded", async () => {
    const start = await started();
    start.seal(start.workspace.repo.readCommit(start.original).tree);
    writeWorkFile(start.workspace, "/other.txt", "edited\n");

    expectRefused(
      () =>
        rebase(start.context, start.workspace.repo, start.workspace.worktree, [], {
          upstream: "upstream",
        }),
      "tracked working tree changes are present at other.txt",
    );
    expectUnstarted(start);
  });

  it("refuses a staged change the tracker recorded", async () => {
    const start = await started();
    start.seal(start.workspace.repo.readCommit(start.original).tree);
    writeWorkFile(start.workspace, "/other.txt", "staged\n");
    add(start.workspace.repo, start.workspace.worktree, { paths: ["other.txt"] });

    expectRefused(
      () =>
        rebase(start.context, start.workspace.repo, start.workspace.worktree, [], {
          upstream: "upstream",
        }),
      "the index contains staged changes",
    );
    expectUnstarted(start);
  });

  it("runs the full checks when the tracker baseline is not HEAD", async () => {
    const start = await started();
    writeWorkFile(start.workspace, "/other.txt", "edited before the seal\n");
    start.seal(start.workspace.repo.readCommit(start.base).tree);

    expectRefused(
      () =>
        rebase(start.context, start.workspace.repo, start.workspace.worktree, [], {
          upstream: "upstream",
        }),
      "tracked working tree changes are present at other.txt",
    );
    expectUnstarted(start);
  });
});

describe("rebase start without a tracker", () => {
  it("reports staged changes before worktree changes", async () => {
    const start = await started();
    writeWorkFile(start.workspace, "/other.txt", "staged\n");
    add(start.workspace.repo, start.workspace.worktree, { paths: ["other.txt"] });
    writeWorkFile(start.workspace, "/shared.txt", "edited\n");

    expectRefused(
      () =>
        rebase(start.workspace.context, start.workspace.repo, start.workspace.worktree, [], {
          upstream: "upstream",
        }),
      "the index contains staged changes",
    );
    expectUnstarted(start);
  });
});
