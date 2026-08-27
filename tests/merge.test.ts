import { afterEach, describe, expect, it } from "vitest";

import type { GitContext } from "../src/core/context.js";
import { checkoutTree } from "../src/core/ops/checkout.js";
import { merge } from "../src/core/ops/merge.js";
import { GitFixture } from "./helpers/git.js";
import { importFixture } from "./helpers/import.js";
import { makeRepo, type TestRepository } from "./helpers/workspace.js";

const fixtures: GitFixture[] = [];

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

function recordingContext(workspace: TestRepository): {
  context: GitContext;
  advances: Array<{ checkoutId: number; tree: string | null }>;
} {
  const advances: Array<{ checkoutId: number; tree: string | null }> = [];
  return {
    context: {
      ...workspace.context,
      indexTracker: {
        reseal: () => true,
        advanceBaseline: (checkoutId, tree) => {
          advances.push({ checkoutId, tree });
          return true;
        },
      },
    },
    advances,
  };
}

describe("merge commit baseline", () => {
  it("advances once for a divergent merge commit", async () => {
    const source = fixture();
    source.write("base.txt", "base\n");
    const base = source.commit("base");
    source.git("checkout", "-q", "-b", "topic", base);
    source.write("topic.txt", "topic\n");
    source.commit("topic");
    source.git("checkout", "-q", "main");
    source.write("main.txt", "main\n");
    source.commit("main");
    const workspace = await imported(source);
    const recorded = recordingContext(workspace);

    const result = merge(recorded.context, workspace.repo, workspace.worktree, {
      theirs: "topic",
    });

    if (result.oid === undefined) throw new Error("merge returned no commit");
    expect(recorded.advances).toEqual([
      {
        checkoutId: workspace.repo.checkout.checkoutId,
        tree: workspace.repo.readCommit(result.oid).tree,
      },
    ]);
  });

  it("advances once for a fast-forward publication", async () => {
    const source = fixture();
    source.write("base.txt", "base\n");
    const base = source.commit("base");
    source.git("checkout", "-q", "-b", "topic", base);
    source.write("topic.txt", "topic\n");
    const incoming = source.commit("topic");
    source.git("checkout", "-q", "main");
    const workspace = await imported(source);
    const recorded = recordingContext(workspace);

    expect(
      merge(recorded.context, workspace.repo, workspace.worktree, { theirs: "topic" }),
    ).toEqual({ oid: incoming, fastForward: true });
    expect(recorded.advances).toEqual([
      {
        checkoutId: workspace.repo.checkout.checkoutId,
        tree: workspace.repo.readCommit(incoming).tree,
      },
    ]);
  });

  it("rolls ref, index, and objects back when merge baseline advancement throws", async () => {
    const source = fixture();
    source.write("base.txt", "base\n");
    const base = source.commit("base");
    source.git("checkout", "-q", "-b", "topic", base);
    source.write("topic.txt", "topic\n");
    source.commit("topic");
    source.git("checkout", "-q", "main");
    source.write("main.txt", "main\n");
    source.commit("main");
    const workspace = await imported(source);
    const before = {
      head: workspace.repo.head(),
      refs: workspace.repo.store.listRefs(),
      index: workspace.repo.checkout.indexEntries(),
      objects: workspace.repo.store.objectCount(),
    };
    const context: GitContext = {
      ...workspace.context,
      indexTracker: {
        reseal: () => true,
        advanceBaseline: () => {
          throw new Error("injected merge baseline failure");
        },
      },
    };

    expect(() => merge(context, workspace.repo, workspace.worktree, { theirs: "topic" })).toThrow(
      "injected merge baseline failure",
    );

    expect({
      head: workspace.repo.head(),
      refs: workspace.repo.store.listRefs(),
      index: workspace.repo.checkout.indexEntries(),
      objects: workspace.repo.store.objectCount(),
    }).toEqual(before);
    expect(workspace.repo.checkout.readMergeState()).toBeNull();
  });
});
