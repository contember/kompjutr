// Restart safety. A Durable Object can be evicted between any two calls, so
// every long-running integration is driven across a `reopen` — the harness
// rebuilds the Workspace over the same SQLite storage — and then finished.
// Real git holds nothing between commands, so the mirror skips the reopen and
// the comparison after it says whether kompjutr rebuilt the same repository.
//
// One content conflict on `c.txt` is the vehicle throughout; the conflict
// matrix itself lives elsewhere.

import { afterEach, describe, expect, it } from "vitest";

import { createWorld, type E2EStep, type E2EWorld, WORK } from "../helpers/e2e.js";

/**
 * A conflicting `git pull`, played on both sides and compared.
 *
 * The DSL's own `pull` step spells the mirror out as `merge origin/main`, and
 * that labels the incoming conflict hunk with the ref name. Real `git pull`
 * labels it with the fetched OID — so does kompjutr — so the mirror runs its
 * own `git pull` here and the marker bytes stay under comparison.
 */
async function pullBothSides(target: E2EWorld): Promise<void> {
  const result = await target.git.pull({ dir: WORK, message: "merge origin" });
  expect(result.conflicted).toBe(true);

  let conflicted = false;
  try {
    target.mirror.git("pull", "--no-rebase");
  } catch {
    conflicted = target.mirror.git("ls-files", "-u") !== "";
  }
  expect(conflicted, "git did not conflict where kompjutr did").toBe(true);

  await target.compare("conflicted pull");
}

let world: E2EWorld | undefined;

afterEach(async () => {
  await world?.dispose();
  world = undefined;
});

const SEED = { "c.txt": "base\n" };

/** `main` and `feature` edit the seeded `c.txt` differently, from one base. */
const DIVERGE: E2EStep[] = [
  { op: "branch", name: "feature", checkout: true },
  { op: "write", path: "c.txt", content: "feature\n" },
  { op: "add", paths: ["c.txt"] },
  { op: "commit", message: "feature" },
  { op: "checkout", ref: "main" },
  { op: "write", path: "c.txt", content: "main\n" },
  { op: "add", paths: ["c.txt"] },
  { op: "commit", message: "main" },
];

const RESOLVE: E2EStep[] = [
  { op: "write", path: "c.txt", content: "resolved\n" },
  { op: "add", paths: ["c.txt"] },
];

describe("e2e recovery across a restart", () => {
  it("resumes a conflicted merge after a reopen", async () => {
    world = await createWorld({ seed: SEED });
    await world.run(
      ...DIVERGE,
      {
        op: "merge",
        theirs: "feature",
        message: "merge feature",
        expect: { outcome: "conflicted" },
      },
      { op: "reopen" },
      ...RESOLVE,
      { op: "mergeContinue", message: "merge feature" },
      { op: "reopen" },
    );
    expect(await world.read("c.txt")).toBe("resolved\n");
  });

  it("aborts a conflicted merge after a reopen", async () => {
    world = await createWorld({ seed: SEED });
    await world.run(...DIVERGE);
    const before = await world.snapshot();
    await world.run(
      {
        op: "merge",
        theirs: "feature",
        message: "merge feature",
        expect: { outcome: "conflicted" },
      },
      { op: "reopen" },
      { op: "mergeAbort" },
    );
    expect((await world.snapshot()).kompjutr).toEqual(before.kompjutr);
  });

  it("resumes a conflicted cherry-pick after a reopen", async () => {
    world = await createWorld({ seed: SEED });
    await world.run(
      ...DIVERGE,
      { op: "cherryPick", source: "feature", expect: { outcome: "conflicted" } },
      { op: "reopen" },
      ...RESOLVE,
      { op: "cherryPickContinue" },
      { op: "reopen" },
    );
    expect(await world.read("c.txt")).toBe("resolved\n");
  });

  it("aborts a conflicted cherry-pick after a reopen", async () => {
    world = await createWorld({ seed: SEED });
    await world.run(...DIVERGE);
    const before = await world.snapshot();
    await world.run(
      { op: "cherryPick", source: "feature", expect: { outcome: "conflicted" } },
      { op: "reopen" },
      { op: "cherryPickAbort" },
    );
    expect((await world.snapshot()).kompjutr).toEqual(before.kompjutr);
  });

  it("resumes a conflicted revert after a reopen", async () => {
    world = await createWorld({ seed: SEED });
    await world.run(
      { op: "write", path: "c.txt", content: "one\n" },
      { op: "add", paths: ["c.txt"] },
      { op: "commit", message: "one" },
      { op: "write", path: "c.txt", content: "two\n" },
      { op: "add", paths: ["c.txt"] },
      { op: "commit", message: "two" },
      // Reverting `one` fights the later edit to the same file.
      { op: "revert", source: "HEAD~1", expect: { outcome: "conflicted" } },
      { op: "reopen" },
      ...RESOLVE,
      { op: "revertContinue" },
      { op: "reopen" },
    );
    expect(await world.read("c.txt")).toBe("resolved\n");
  });

  it("aborts a conflicted revert after a reopen", async () => {
    world = await createWorld({ seed: SEED });
    await world.run(
      { op: "write", path: "c.txt", content: "one\n" },
      { op: "add", paths: ["c.txt"] },
      { op: "commit", message: "one" },
      { op: "write", path: "c.txt", content: "two\n" },
      { op: "add", paths: ["c.txt"] },
      { op: "commit", message: "two" },
    );
    const before = await world.snapshot();
    await world.run(
      { op: "revert", source: "HEAD~1", expect: { outcome: "conflicted" } },
      { op: "reopen" },
      { op: "revertAbort" },
    );
    expect((await world.snapshot()).kompjutr).toEqual(before.kompjutr);
  });

  it("completes a conflicted rebase after a reopen", async () => {
    world = await createWorld({ seed: SEED });
    await world.run(
      ...DIVERGE,
      { op: "checkout", ref: "feature" },
      { op: "rebase", upstream: "main", expect: { outcome: "conflicted" } },
      { op: "reopen" },
      ...RESOLVE,
      { op: "rebaseContinue" },
      { op: "reopen" },
    );
    expect(await world.read("c.txt")).toBe("resolved\n");
  });

  it("aborts a conflicted rebase after a reopen", async () => {
    world = await createWorld({ seed: SEED });
    await world.run(...DIVERGE, { op: "checkout", ref: "feature" });
    const before = await world.snapshot();
    await world.run(
      { op: "rebase", upstream: "main", expect: { outcome: "conflicted" } },
      { op: "reopen" },
      { op: "rebaseAbort" },
    );
    expect((await world.snapshot()).kompjutr).toEqual(before.kompjutr);
  });

  it("skips a conflicted rebase commit after a reopen", async () => {
    // `e.txt` gives the branch a commit that replays cleanly, so the skip
    // drops the colliding commit rather than the whole branch.
    world = await createWorld({ seed: { ...SEED, "e.txt": "base\n" } });
    await world.run(
      { op: "branch", name: "feature", checkout: true },
      { op: "write", path: "e.txt", content: "feature-e\n" },
      { op: "add", paths: ["e.txt"] },
      { op: "commit", message: "feature e" },
      { op: "write", path: "c.txt", content: "feature\n" },
      { op: "add", paths: ["c.txt"] },
      { op: "commit", message: "feature c" },
      { op: "checkout", ref: "main" },
      { op: "write", path: "c.txt", content: "main\n" },
      { op: "add", paths: ["c.txt"] },
      { op: "commit", message: "main" },
      { op: "checkout", ref: "feature" },
      { op: "rebase", upstream: "main", expect: { outcome: "conflicted" } },
      { op: "reopen" },
      { op: "rebaseSkip" },
      { op: "reopen" },
    );
    expect(await world.read("c.txt")).toBe("main\n");
    expect(await world.read("e.txt")).toBe("feature-e\n");
  });

  it("replays a three-commit rebase with a reopen between every step", async () => {
    world = await createWorld({ seed: SEED });
    await world.run(
      { op: "branch", name: "feature", checkout: true },
      { op: "write", path: "c.txt", content: "f1\n" },
      { op: "add", paths: ["c.txt"] },
      { op: "commit", message: "f1" },
      { op: "write", path: "c.txt", content: "f2\n" },
      { op: "add", paths: ["c.txt"] },
      { op: "commit", message: "f2" },
      { op: "write", path: "c.txt", content: "f3\n" },
      { op: "add", paths: ["c.txt"] },
      { op: "commit", message: "f3" },
      { op: "checkout", ref: "main" },
      { op: "write", path: "c.txt", content: "main\n" },
      { op: "add", paths: ["c.txt"] },
      { op: "commit", message: "main" },
      { op: "checkout", ref: "feature" },
      // Each replayed commit rewrites the same line, so every one conflicts
      // against the resolution the step before it left behind.
      { op: "rebase", upstream: "main", expect: { outcome: "conflicted" } },
      { op: "reopen" },
      { op: "write", path: "c.txt", content: "r1\n" },
      { op: "add", paths: ["c.txt"] },
      { op: "reopen" },
      { op: "rebaseContinue", expect: { outcome: "conflicted" } },
      { op: "reopen" },
      { op: "write", path: "c.txt", content: "r2\n" },
      { op: "add", paths: ["c.txt"] },
      { op: "reopen" },
      { op: "rebaseContinue", expect: { outcome: "conflicted" } },
      { op: "reopen" },
      { op: "write", path: "c.txt", content: "r3\n" },
      { op: "add", paths: ["c.txt"] },
      { op: "reopen" },
      { op: "rebaseContinue" },
      { op: "reopen" },
    );
    expect(await world.read("c.txt")).toBe("r3\n");
  });

  it("resumes a conflicted pull after a reopen", async () => {
    world = await createWorld({ seed: SEED });
    await world.run(
      {
        op: "peer",
        act: (peer) => {
          peer.write("c.txt", "theirs\n");
          peer.commit("colleague");
          peer.git("push", "-q", "origin", "main");
        },
      },
      { op: "write", path: "c.txt", content: "mine\n" },
      { op: "add", paths: ["c.txt"] },
      { op: "commit", message: "mine" },
    );
    await pullBothSides(world);
    await world.run(
      { op: "reopen" },
      ...RESOLVE,
      { op: "mergeContinue", message: "merge origin" },
      { op: "reopen" },
    );
    expect(await world.read("c.txt")).toBe("resolved\n");
  });

  it("changes nothing observable when a reopen finds nothing pending", async () => {
    world = await createWorld({ seed: SEED });
    await world.run(
      { op: "write", path: "a.txt", content: "one\n" },
      { op: "add", paths: ["a.txt"] },
      { op: "commit", message: "add a" },
      // An untracked and a dirty tracked path, so the reopen has cache to lose.
      { op: "write", path: "b.txt", content: "loose\n" },
      { op: "write", path: "a.txt", content: "edited\n" },
    );
    const before = await world.snapshot();
    await world.run({ op: "reopen" });
    expect((await world.snapshot()).kompjutr).toEqual(before.kompjutr);
  });

  it("survives several reopens back to back", async () => {
    world = await createWorld({ seed: SEED });
    await world.run(
      { op: "reopen" },
      { op: "reopen" },
      ...DIVERGE,
      {
        op: "merge",
        theirs: "feature",
        message: "merge feature",
        expect: { outcome: "conflicted" },
      },
      { op: "reopen" },
      { op: "reopen" },
      { op: "reopen" },
      ...RESOLVE,
      { op: "mergeContinue", message: "merge feature" },
      { op: "reopen" },
      { op: "reopen" },
    );
  });

  it("keeps staged content across a reopen between add and commit", async () => {
    world = await createWorld({ seed: SEED });
    await world.run(
      { op: "write", path: "staged.txt", content: "staged\n" },
      { op: "write", path: "c.txt", content: "restaged\n" },
      { op: "add", paths: ["staged.txt", "c.txt"] },
      { op: "reopen" },
      // The commit must build the tree from the index the previous incarnation
      // wrote, not from anything it kept in memory.
      { op: "commit", message: "staged before the restart" },
      { op: "reopen" },
    );
    expect(await world.read("c.txt")).toBe("restaged\n");
  });

  it("resumes a pending no-commit pull after a reopen", async () => {
    world = await createWorld({ seed: SEED });
    // `pull({ commit: false })` is a kompjutr extension with no single Git
    // command behind it, so this journey runs on kompjutr alone.
    await world.runLocal(
      {
        op: "peer",
        act: (peer) => {
          peer.write("theirs.txt", "theirs\n");
          peer.commit("colleague");
          peer.git("push", "-q", "origin", "main");
        },
      },
      { op: "write", path: "mine.txt", content: "mine\n" },
      { op: "add", paths: ["mine.txt"] },
      { op: "commit", message: "mine" },
      {
        op: "custom",
        local: async (git) => {
          await git.pull({ dir: WORK, message: "merge origin", commit: false });
        },
        mirror: () => {
          throw new Error("unreachable: runLocal never plays the mirror");
        },
      },
      { op: "reopen" },
    );

    const pending = await world.snapshot();
    expect(pending.kompjutr.operation).toBe("merge");
    // A clean no-commit merge stages the colleague's work without committing.
    expect(pending.kompjutr.index).toContain("theirs.txt");
    expect(await world.read("theirs.txt")).toBe("theirs\n");

    await world.runLocal({ op: "mergeContinue", message: "merge origin" }, { op: "reopen" });

    const done = await world.snapshot();
    expect(done.kompjutr.operation).toBeNull();
    const merge = done.kompjutr.log[0];
    expect(merge?.message).toBe("merge origin");
    expect(merge?.parents).toHaveLength(2);
  });
});
