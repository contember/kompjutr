// Rebase journeys. Every step is played against real git as well, so the
// shape of a replay — which commits survive, what the index and worktree
// hold mid-conflict, where the branch ends up — is Git's answer, not ours.

import { afterEach, describe, expect, it } from "vitest";

import { createWorld, type E2EWorld } from "../helpers/e2e.js";

let world: E2EWorld | undefined;

afterEach(async () => {
  await world?.dispose();
  world = undefined;
});

describe("e2e rebase", () => {
  it("does nothing when the upstream is already an ancestor", async () => {
    world = await createWorld({ seed: { "base.txt": "base\n" } });
    await world.run(
      { op: "rebase", upstream: "main" },
      { op: "branch", name: "feature", checkout: true },
      { op: "write", path: "feature.txt", content: "feature\n" },
      { op: "add", paths: ["feature.txt"] },
      { op: "commit", message: "feature one" },
      { op: "rebase", upstream: "main" },
    );
    const { kompjutr } = await world.snapshot();
    expect(kompjutr.log).toHaveLength(2);
  });

  it("fast-forwards a branch that is strictly behind its upstream", async () => {
    world = await createWorld({ seed: { "base.txt": "base\n" } });
    await world.run(
      { op: "branch", name: "behind" },
      { op: "write", path: "one.txt", content: "one\n" },
      { op: "add", paths: ["one.txt"] },
      { op: "commit", message: "upstream one" },
      { op: "write", path: "two.txt", content: "two\n" },
      { op: "add", paths: ["two.txt"] },
      { op: "commit", message: "upstream two" },
      { op: "checkout", ref: "behind" },
      { op: "rebase", upstream: "main" },
    );
  });

  it("replays one commit onto the new base", async () => {
    world = await createWorld({ seed: { "base.txt": "base\n" } });
    await world.run(
      { op: "branch", name: "feature", checkout: true },
      { op: "write", path: "feature.txt", content: "feature\n" },
      { op: "add", paths: ["feature.txt"] },
      { op: "commit", message: "feature one" },
      { op: "checkout", ref: "main" },
      { op: "write", path: "upstream.txt", content: "upstream\n" },
      { op: "add", paths: ["upstream.txt"] },
      { op: "commit", message: "upstream one" },
      { op: "checkout", ref: "feature" },
      { op: "rebase", upstream: "main" },
    );
    const { kompjutr } = await world.snapshot();
    expect(kompjutr.log).toHaveLength(3);
  });

  it("replays three commits onto the new base", async () => {
    world = await createWorld({ seed: { "base.txt": "base\n" } });
    await world.run(
      { op: "branch", name: "feature", checkout: true },
      { op: "write", path: "one.txt", content: "one\n" },
      { op: "add", paths: ["one.txt"] },
      { op: "commit", message: "feature one" },
      { op: "write", path: "two.txt", content: "two\n" },
      { op: "add", paths: ["two.txt"] },
      { op: "commit", message: "feature two" },
      { op: "write", path: "three.txt", content: "three\n" },
      { op: "add", paths: ["three.txt"] },
      { op: "commit", message: "feature three" },
      { op: "checkout", ref: "main" },
      { op: "write", path: "upstream.txt", content: "upstream\n" },
      { op: "add", paths: ["upstream.txt"] },
      { op: "commit", message: "upstream one" },
      { op: "checkout", ref: "feature" },
      { op: "rebase", upstream: "main" },
    );
    const { kompjutr } = await world.snapshot();
    expect(kompjutr.log).toHaveLength(5);
  });

  // Mid-conflict the pinned HEAD is the original branch tip, so porcelain v2
  // also reports every path where that tip differs from the replay baseline —
  // rows real git never emits from its detached HEAD, and rows the harness's
  // field mask does not cover. The conflict journeys therefore keep the whole
  // divergence on the conflicted path, where it shows up as a compared `u` row.
  it("resolves a conflict on the first replayed commit and continues", async () => {
    world = await createWorld({ seed: { "c.txt": "base\n" } });
    await world.run(
      { op: "branch", name: "feature", checkout: true },
      { op: "write", path: "c.txt", content: "feature\n" },
      { op: "add", paths: ["c.txt"] },
      { op: "commit", message: "feature one" },
      { op: "write", path: "c.txt", content: "feature two\n" },
      { op: "add", paths: ["c.txt"] },
      { op: "commit", message: "feature two" },
      { op: "checkout", ref: "main" },
      { op: "write", path: "c.txt", content: "upstream\n" },
      { op: "add", paths: ["c.txt"] },
      { op: "commit", message: "upstream one" },
      { op: "checkout", ref: "feature" },
      { op: "rebase", upstream: "main", expect: { outcome: "conflicted" } },
      // Resolving to the feature side leaves the queued second commit appliable.
      { op: "write", path: "c.txt", content: "feature\n" },
      { op: "add", paths: ["c.txt"] },
      { op: "rebaseContinue" },
    );
    expect(await world.read("c.txt")).toBe("feature two\n");
  });

  it("resolves a conflict on the middle commit of three and runs to completion", async () => {
    world = await createWorld({ seed: { "c.txt": "base\n" } });
    await world.run(
      { op: "branch", name: "feature", checkout: true },
      { op: "write", path: "one.txt", content: "one\n" },
      { op: "add", paths: ["one.txt"] },
      { op: "commit", message: "feature one" },
      { op: "write", path: "c.txt", content: "feature\n" },
      { op: "add", paths: ["c.txt"] },
      { op: "commit", message: "feature two" },
      { op: "write", path: "c.txt", content: "feature three\n" },
      { op: "add", paths: ["c.txt"] },
      { op: "commit", message: "feature three" },
      { op: "checkout", ref: "main" },
      { op: "write", path: "c.txt", content: "upstream\n" },
      { op: "add", paths: ["c.txt"] },
      { op: "commit", message: "upstream one" },
      { op: "checkout", ref: "feature" },
      { op: "rebase", upstream: "main", expect: { outcome: "conflicted" } },
      { op: "write", path: "c.txt", content: "feature\n" },
      { op: "add", paths: ["c.txt"] },
      { op: "rebaseContinue" },
    );
    const { kompjutr } = await world.snapshot();
    expect(kompjutr.log).toHaveLength(5);
    expect(await world.read("c.txt")).toBe("feature three\n");
  });

  it("drops a conflicting commit with skip", async () => {
    world = await createWorld({ seed: { "c.txt": "base\n" } });
    await world.run(
      { op: "branch", name: "feature", checkout: true },
      { op: "write", path: "one.txt", content: "one\n" },
      { op: "add", paths: ["one.txt"] },
      { op: "commit", message: "feature one" },
      { op: "write", path: "c.txt", content: "feature\n" },
      { op: "add", paths: ["c.txt"] },
      { op: "commit", message: "feature two" },
      { op: "checkout", ref: "main" },
      { op: "write", path: "c.txt", content: "upstream\n" },
      { op: "add", paths: ["c.txt"] },
      { op: "commit", message: "upstream one" },
      { op: "checkout", ref: "feature" },
      { op: "rebase", upstream: "main", expect: { outcome: "conflicted" } },
      // The already-replayed first commit survives; only the conflicting one goes.
      { op: "rebaseSkip" },
    );
    expect(await world.read("c.txt")).toBe("upstream\n");
    const { kompjutr } = await world.snapshot();
    expect(kompjutr.log).toHaveLength(3);
  });

  it("restores the starting state on abort", async () => {
    world = await createWorld({ seed: { "c.txt": "base\n" } });
    await world.run(
      { op: "branch", name: "feature", checkout: true },
      { op: "write", path: "one.txt", content: "one\n" },
      { op: "add", paths: ["one.txt"] },
      { op: "commit", message: "feature one" },
      { op: "write", path: "c.txt", content: "feature\n" },
      { op: "add", paths: ["c.txt"] },
      { op: "commit", message: "feature two" },
      { op: "checkout", ref: "main" },
      { op: "write", path: "c.txt", content: "upstream\n" },
      { op: "add", paths: ["c.txt"] },
      { op: "commit", message: "upstream one" },
      { op: "checkout", ref: "feature" },
    );
    const before = await world.snapshot();

    await world.run(
      { op: "rebase", upstream: "main", expect: { outcome: "conflicted" } },
      // A conflict-time edit goes with the replay when the rebase is abandoned.
      { op: "write", path: "c.txt", content: "half resolved\n" },
      { op: "rebaseAbort" },
    );

    const after = await world.snapshot();
    expect(after.kompjutr).toEqual(before.kompjutr);
  });

  it("keeps a source-empty commit and drops one whose patch is already upstream", async () => {
    world = await createWorld({ seed: { "base.txt": "base\n" } });
    await world.run(
      { op: "branch", name: "empty", checkout: true },
      { op: "commit", message: "empty at source", allowEmpty: true },
      { op: "checkout", ref: "main" },
      { op: "write", path: "up.txt", content: "up\n" },
      { op: "add", paths: ["up.txt"] },
      { op: "commit", message: "upstream moves" },
      { op: "checkout", ref: "empty" },
      { op: "rebase", upstream: "main" },

      // The same change on both sides: nothing is left to apply on the new base.
      { op: "checkout", ref: "main" },
      { op: "branch", name: "dup", checkout: true },
      { op: "write", path: "same.txt", content: "same\n" },
      { op: "add", paths: ["same.txt"] },
      { op: "commit", message: "dup adds same" },
      { op: "checkout", ref: "main" },
      { op: "write", path: "same.txt", content: "same\n" },
      { op: "add", paths: ["same.txt"] },
      { op: "commit", message: "main adds same" },
      { op: "checkout", ref: "dup" },
      { op: "rebase", upstream: "main" },
    );
  });

  it("rebases onto an upstream that arrived by fetch", async () => {
    world = await createWorld();
    await world.run(
      { op: "write", path: "local.txt", content: "local\n" },
      { op: "add", paths: ["local.txt"] },
      { op: "commit", message: "local work" },
      {
        op: "peer",
        act: (peer) => {
          peer.write("theirs.txt", "theirs\n");
          peer.commit("colleague");
          peer.git("push", "-q", "origin", "main");
        },
      },
      { op: "fetch" },
      { op: "rebase", upstream: "origin/main" },
    );
    expect(await world.read("theirs.txt")).toBe("theirs\n");
  });

  it("replays a mode change and a rename-shaped add/delete pair", async () => {
    world = await createWorld({
      seed: { "keep.txt": "keep\n", "tool.sh": "#!/bin/sh\n", "old.txt": "moved\n" },
    });
    await world.run(
      { op: "branch", name: "feature", checkout: true },
      { op: "chmod", path: "tool.sh", mode: 0o755 },
      { op: "add", paths: ["tool.sh"] },
      { op: "commit", message: "make the tool executable" },
      { op: "remove", path: "old.txt" },
      { op: "write", path: "new.txt", content: "moved\n" },
      { op: "add", all: true },
      { op: "commit", message: "move old to new" },
      { op: "checkout", ref: "main" },
      { op: "write", path: "keep.txt", content: "keep\nupstream\n" },
      { op: "add", paths: ["keep.txt"] },
      { op: "commit", message: "upstream touches keep" },
      { op: "checkout", ref: "feature" },
      { op: "rebase", upstream: "main" },
    );
  });

  it("refuses to start with a dirty worktree, and again once the change is staged", async () => {
    world = await createWorld({ seed: { "c.txt": "base\n" } });
    await world.run(
      { op: "branch", name: "feature", checkout: true },
      { op: "write", path: "feature.txt", content: "feature\n" },
      { op: "add", paths: ["feature.txt"] },
      { op: "commit", message: "feature one" },
      { op: "checkout", ref: "main" },
      { op: "write", path: "upstream.txt", content: "upstream\n" },
      { op: "add", paths: ["upstream.txt"] },
      { op: "commit", message: "upstream one" },
      { op: "checkout", ref: "feature" },
      { op: "write", path: "c.txt", content: "dirty\n" },
      { op: "rebase", upstream: "main", expect: { outcome: "failed", code: "ECHECKOUTFAIL" } },
      { op: "add", paths: ["c.txt"] },
      { op: "rebase", upstream: "main", expect: { outcome: "failed", code: "ECHECKOUTFAIL" } },
    );
  });

  it("refuses a detached HEAD", async () => {
    world = await createWorld({ seed: { "base.txt": "base\n" } });
    await world.run(
      { op: "branch", name: "feature", checkout: true },
      { op: "write", path: "feature.txt", content: "feature\n" },
      { op: "add", paths: ["feature.txt"] },
      { op: "commit", message: "feature one" },
      { op: "tag", name: "feature-tip" },
      { op: "checkout", ref: "main" },
      { op: "write", path: "upstream.txt", content: "upstream\n" },
      { op: "add", paths: ["upstream.txt"] },
      { op: "commit", message: "upstream one" },
      { op: "checkout", ref: "feature-tip" },
    );
    // Git replays a detached HEAD in place; kompjutr needs a branch to publish to.
    await world.runLocal({
      op: "rebase",
      upstream: "main",
      expect: { outcome: "failed", code: "EDETACHED" },
    });
    await world.compare("a refused detached rebase changed nothing");
  });

  it("refuses a merge commit inside the replayed range", async () => {
    world = await createWorld({ seed: { "base.txt": "base\n" } });
    await world.run(
      { op: "branch", name: "side", checkout: true },
      { op: "write", path: "side.txt", content: "side\n" },
      { op: "add", paths: ["side.txt"] },
      { op: "commit", message: "side one" },
      { op: "checkout", ref: "main" },
      { op: "branch", name: "feature", checkout: true },
      { op: "write", path: "feature.txt", content: "feature\n" },
      { op: "add", paths: ["feature.txt"] },
      { op: "commit", message: "feature one" },
      { op: "merge", theirs: "side", message: "merge side" },
      { op: "checkout", ref: "main" },
      { op: "write", path: "upstream.txt", content: "upstream\n" },
      { op: "add", paths: ["upstream.txt"] },
      { op: "commit", message: "upstream one" },
      { op: "checkout", ref: "feature" },
    );
    // Git flattens the merge out of the replayed range; kompjutr rejects it.
    await world.runLocal({
      op: "rebase",
      upstream: "main",
      expect: { outcome: "failed", code: "EUNSUPPORTED" },
    });
    await world.compare("a refused merge-commit rebase changed nothing");
  });
});
