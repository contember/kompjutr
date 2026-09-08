// One consumer-shaped session journey across two linked checkouts. Every Git
// observation has a real-Git control; checkout ids are SQLite-native.

import { afterEach, describe, expect, it } from "vitest";

import type {
  DivergenceRelationship,
  DivergenceResult,
  RawRefTarget,
} from "../../packages/do/src/index.js";
import { createWorld, type E2ESnapshot, type E2EWorld, WORK } from "../helpers/e2e.js";
import type { GitFixture } from "../helpers/git.js";

let world: E2EWorld | undefined;

afterEach(async () => {
  await world?.dispose();
  world = undefined;
});

function rawGitRef(fixture: GitFixture, ref: string): RawRefTarget {
  try {
    return {
      kind: "symbolic",
      target: fixture.git("symbolic-ref", "--quiet", "--no-recurse", ref),
    };
  } catch {
    // A direct or absent ref is expected to make symbolic-ref fail.
  }

  try {
    const oid =
      ref === "HEAD"
        ? fixture.git("rev-parse", "--verify", "--quiet", "HEAD")
        : fixture.git("for-each-ref", "--count=1", "--format=%(objectname)", ref);
    return oid === "" ? { kind: "absent" } : { kind: "direct", oid };
  } catch {
    return { kind: "absent" };
  }
}

function gitDivergence(fixture: GitFixture, current: string, upstream: string): DivergenceResult {
  const fields = fixture.git("rev-list", "--left-right", "--count", `${current}...${upstream}`);
  const [aheadText, behindText] = fields.split(/\s+/);
  const ahead = Number(aheadText);
  const behind = Number(behindText);
  if (!Number.isSafeInteger(ahead) || !Number.isSafeInteger(behind)) {
    throw new Error(`invalid rev-list counts: ${fields}`);
  }

  let related = true;
  try {
    fixture.git("merge-base", current, upstream);
  } catch {
    related = false;
  }
  const relationship: DivergenceRelationship = !related
    ? "unrelated"
    : ahead === 0 && behind === 0
      ? "identical"
      : behind === 0
        ? "ahead"
        : ahead === 0
          ? "behind"
          : "diverged";
  return { relationship, ahead, behind };
}

async function poll(
  current: E2EWorld,
  worktree: string,
  expected: DivergenceRelationship,
): Promise<void> {
  const dir = current.checkoutRoot(worktree);
  const fixture = current.mirrorCheckout(worktree);
  const control = gitDivergence(fixture, "HEAD", "main");
  expect(control.relationship).toBe(expected);
  await expect(current.git.divergence({ dir, current: "HEAD", upstream: "main" })).resolves.toEqual(
    control,
  );

  for (const ref of ["HEAD", "refs/remotes/origin/HEAD", "refs/remotes/origin/main"]) {
    await expect(current.git.readRef({ dir, ref })).resolves.toEqual(rawGitRef(fixture, ref));
  }
}

async function expectWorktrees(
  current: E2EWorld,
  expected: Array<{ name: string; isPrimary: boolean; state: "present" | "missing" }>,
): Promise<void> {
  const observed = await current.worktrees();
  expect(observed.kompjutr).toEqual(observed.git);
  expect(
    observed.kompjutr.map(({ name, isPrimary, state }) => ({ name, isPrimary, state })),
  ).toEqual(expected);
}

function refOid(
  refs: ReadonlyArray<{ name: string; oid: string }>,
  name: string,
): string | undefined {
  return refs.find((ref) => ref.name === name)?.oid;
}

function checkoutPrivate(snapshot: E2ESnapshot): object {
  return {
    head: snapshot.head,
    currentBranch: snapshot.currentBranch,
    index: snapshot.index,
    status: snapshot.status,
    worktree: snapshot.worktree,
    operation: snapshot.operation,
  };
}

function checkoutId(rows: readonly { checkoutId: number; root: string }[], root: string): number {
  const row = rows.find((candidate) => candidate.root === root);
  if (row === undefined) throw new Error(`missing checkout row for ${root}`);
  return row.checkoutId;
}

describe("multi-checkout consumer admission", () => {
  it("rejects unsafe and duplicate logical worktree names before registration", async () => {
    world = await createWorld();

    // Logical routing names and cleanup roots belong to this harness, not Git.
    await world.runLocal(
      {
        op: "worktreeAdd",
        name: "../escape",
        target: { kind: "new-branch", name: "escape" },
        expect: { outcome: "failed" },
      },
      {
        op: "worktreeAdd",
        name: "primary",
        target: { kind: "new-branch", name: "other-primary" },
        expect: { outcome: "failed" },
      },
    );
    await expectWorktrees(world, [{ name: "primary", isPrimary: true, state: "present" }]);

    await world.run({
      op: "worktreeAdd",
      name: "safe-session",
      target: { kind: "new-branch", name: "safe-session" },
    });
    await world.runLocal({
      op: "worktreeAdd",
      name: "safe-session",
      target: { kind: "new-branch", name: "duplicate" },
      expect: { outcome: "failed" },
    });
    await expectWorktrees(world, [
      { name: "primary", isPrimary: true, state: "present" },
      { name: "safe-session", isPrimary: false, state: "present" },
    ]);
  });

  it("keeps two sessions isolated through conflict recovery, publication, and teardown", async () => {
    world = await createWorld({ seed: { "shared.txt": "base\n", "stable.txt": "stable\n" } });

    await world.run({
      op: "custom",
      local: async (git) => {
        await git.updateRef({
          dir: WORK,
          ref: "refs/remotes/origin/HEAD",
          value: "refs/remotes/origin/main",
          symbolic: true,
          force: true,
        });
      },
      mirror: (fixture) => {
        fixture.git("symbolic-ref", "refs/remotes/origin/HEAD", "refs/remotes/origin/main");
      },
    });
    await world.run({
      op: "worktreeAdd",
      name: "session-b",
      target: { kind: "new-branch", name: "session-b" },
    });
    await world.run(
      { op: "write", path: "session-base.txt", content: "session base\n", worktree: "session-b" },
      { op: "add", paths: ["session-base.txt"], worktree: "session-b" },
      { op: "commit", message: "session base", worktree: "session-b" },
      {
        op: "worktreeAdd",
        name: "session-a",
        target: { kind: "new-branch", name: "session-a" },
        worktree: "session-b",
      },
    );
    await expectWorktrees(world, [
      { name: "primary", isPrimary: true, state: "present" },
      { name: "session-a", isPrimary: false, state: "present" },
      { name: "session-b", isPrimary: false, state: "present" },
    ]);
    await world.compare("session A starts from session B HEAD", "session-a");
    const aCreated = await world.snapshot("session-a");
    const bCreated = await world.snapshot("session-b");
    expect(aCreated.kompjutr.head).toBe(bCreated.kompjutr.head);
    expect(aCreated.git.head).toBe(bCreated.git.head);
    await poll(world, "session-a", "ahead");
    await poll(world, "session-b", "ahead");

    const initialRows = await world.git.worktreeList({ dir: WORK });
    const primaryId = checkoutId(initialRows, WORK);
    const sessionAId = checkoutId(initialRows, world.checkoutRoot("session-a"));
    const sessionBId = checkoutId(initialRows, world.checkoutRoot("session-b"));

    const bBefore = await world.snapshot("session-b");
    await world.run(
      { op: "write", path: "shared.txt", content: "session A\n", worktree: "session-a" },
      { op: "add", paths: ["shared.txt"], worktree: "session-a" },
      { op: "commit", message: "session A change", worktree: "session-a" },
    );
    const bAfter = await world.snapshot("session-b");
    expect(checkoutPrivate(bAfter.kompjutr)).toEqual(checkoutPrivate(bBefore.kompjutr));
    expect(checkoutPrivate(bAfter.git)).toEqual(checkoutPrivate(bBefore.git));
    await poll(world, "session-a", "ahead");
    await poll(world, "session-b", "ahead");

    await world.run(
      {
        op: "peer",
        act: (peer) => {
          peer.write("shared.txt", "upstream\n");
          peer.commit("advance main");
          peer.git("push", "-q", "origin", "main");
        },
      },
      { op: "fetch" },
      { op: "merge", theirs: "origin/main", fastForwardOnly: true },
    );
    await poll(world, "session-a", "diverged");
    await poll(world, "session-b", "diverged");
    expect(await world.read("shared.txt", "session-b")).toBe("base\n");

    await world.run({
      op: "rebase",
      upstream: "main",
      worktree: "session-a",
      expect: { outcome: "conflicted" },
    });
    expect((await world.snapshot("session-a")).kompjutr.operation).toBe("rebase");
    await world.compare("session B remains usable during session A's conflict", "session-b");
    const bDuringConflict = await world.snapshot("session-b");
    expect(bDuringConflict.kompjutr.operation).toBeNull();
    expect(bDuringConflict.git.operation).toBeNull();
    await world.run({ op: "reopen", worktree: "session-a" });
    expect((await world.snapshot("session-a")).kompjutr.operation).toBe("rebase");
    const reopenedRows = await world.git.worktreeList({ dir: world.checkoutRoot("session-b") });
    expect(checkoutId(reopenedRows, WORK)).toBe(primaryId);
    expect(checkoutId(reopenedRows, world.checkoutRoot("session-a"))).toBe(sessionAId);
    expect(checkoutId(reopenedRows, world.checkoutRoot("session-b"))).toBe(sessionBId);
    await world.run(
      { op: "write", path: "shared.txt", content: "resolved session A\n", worktree: "session-a" },
      { op: "add", paths: ["shared.txt"], worktree: "session-a" },
      { op: "rebaseContinue", worktree: "session-a" },
    );
    await poll(world, "session-a", "ahead");
    await poll(world, "session-b", "diverged");

    await world.run({ op: "merge", theirs: "session-a", fastForwardOnly: true }, { op: "push" });
    await poll(world, "session-a", "identical");

    await world.run({ op: "worktreeRemove", name: "session-a" });
    await expectWorktrees(world, [
      { name: "primary", isPrimary: true, state: "present" },
      { name: "session-b", isPrimary: false, state: "present" },
    ]);
    await world.run({ op: "worktreeMakeAbsent", name: "session-b" });
    await expectWorktrees(world, [
      { name: "primary", isPrimary: true, state: "present" },
      { name: "session-b", isPrimary: false, state: "missing" },
    ]);
    await world.run({ op: "worktreePrune" });
    await expectWorktrees(world, [{ name: "primary", isPrimary: true, state: "present" }]);

    const final = await world.snapshot();
    expect(final.kompjutr).toEqual(final.git);
    expect(final.kompjutr.status).toBe("");
    expect(final.kompjutr.operation).toBeNull();
    expect(refOid(final.kompjutr.refs, "refs/heads/main")).toBe(final.kompjutr.head);
    expect(refOid(final.kompjutr.refs, "refs/remotes/origin/main")).toBe(final.kompjutr.head);
    expect(refOid(final.kompjutr.originRefs, "refs/heads/main")).toBe(final.kompjutr.head);
    await expect(
      world.git.readRef({ dir: WORK, ref: "refs/remotes/origin/HEAD" }),
    ).resolves.toEqual(rawGitRef(world.mirror, "refs/remotes/origin/HEAD"));

    // Checkout ids have no Git-binary equivalent and must survive reopen/removal routing.
    const retained = await world.git.worktreeList({ dir: WORK });
    expect(retained).toHaveLength(1);
    expect(retained[0]?.isPrimary).toBe(true);
    expect(retained[0]?.checkoutId).toBe(primaryId);
  }, 60_000);
});
