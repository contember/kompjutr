// The two-actor loop over a Smart HTTP origin: a colleague pushes, we fetch,
// pull and push back. Every step is replayed against the real git binary, so
// what `fetch` and `pull` mean here is whatever git says they mean.

import { afterEach, describe, expect, it } from "vitest";

import { createWorld, type E2ESnapshot, type E2EWorld, WORK } from "../helpers/e2e.js";
import type { GitFixture } from "../helpers/git.js";

let world: E2EWorld | undefined;

afterEach(async () => {
  await world?.dispose();
  world = undefined;
});

/** A colleague commits one file on `main` and publishes it. */
function colleaguePush(path: string, content: string, message: string): (peer: GitFixture) => void {
  return (peer) => {
    peer.write(path, content);
    peer.commit(message);
    peer.git("push", "-q", "origin", "main");
  };
}

/** A colleague publishes a new branch carrying one commit. */
function colleagueBranch(
  branch: string,
  path: string,
  content: string,
): (peer: GitFixture) => void {
  return (peer) => {
    peer.git("checkout", "-q", "-b", branch);
    peer.write(path, content);
    peer.commit(`${branch} work`);
    peer.git("push", "-q", "origin", branch);
  };
}

function refOid(snapshot: E2ESnapshot, name: string): string | undefined {
  return snapshot.refs.find((ref) => ref.name === name)?.oid;
}

/**
 * The compared status deliberately carries no branch header, so the upstream
 * and its ahead/behind counts are checked here — against `rev-list` on the
 * mirror rather than against a number written into the test.
 */
async function expectAheadBehind(current: E2EWorld, label: string): Promise<void> {
  const report = await current.git.statusReport({ dir: WORK, branch: true });
  const upstream = current.mirror.git(
    "rev-parse",
    "--abbrev-ref",
    "--symbolic-full-name",
    "@{upstream}",
  );
  expect(report.branch?.upstream, `${label}: upstream`).toBe(upstream);

  const counts = current.mirror
    .git("rev-list", "--left-right", "--count", "HEAD...@{upstream}")
    .split("\t");
  expect(counts, `${label}: rev-list --left-right --count`).toHaveLength(2);
  expect([report.branch?.ahead, report.branch?.behind].map(String), `${label}: counts`).toEqual(
    counts,
  );
}

describe("collaboration over a Smart HTTP origin", () => {
  it("moves only the tracking ref when a colleague pushes", async () => {
    const w = await createWorld();
    world = w;
    const before = await w.snapshot();

    await w.run(
      { op: "peer", act: colleaguePush("theirs.txt", "theirs\n", "colleague") },
      { op: "fetch" },
    );

    const after = await w.snapshot();
    expect(refOid(after.kompjutr, "refs/heads/main")).toBe(
      refOid(before.kompjutr, "refs/heads/main"),
    );
    expect(refOid(after.kompjutr, "refs/remotes/origin/main")).not.toBe(
      refOid(before.kompjutr, "refs/remotes/origin/main"),
    );
    // The colleague's file is fetched but not checked out.
    expect(after.kompjutr.worktree.map((entry) => entry.path)).not.toContain("theirs.txt");
    await expectAheadBehind(w, "after fetch");
  });

  it("fast-forwards a pull when only the colleague moved", async () => {
    const w = await createWorld();
    world = w;

    await w.run(
      { op: "peer", act: colleaguePush("theirs.txt", "theirs\n", "colleague") },
      { op: "pull", message: "merge origin" },
    );

    const { kompjutr } = await w.snapshot();
    // A fast-forward replays the colleague's commit, it does not merge it.
    expect(kompjutr.log[0]?.parents).toHaveLength(1);
    expect(await w.read("theirs.txt")).toBe("theirs\n");
    await expectAheadBehind(w, "after the fast-forward");
  });

  it("makes a merge commit when a pull finds both sides moved", async () => {
    const w = await createWorld();
    world = w;

    await w.run(
      { op: "peer", act: colleaguePush("theirs.txt", "theirs\n", "colleague") },
      { op: "write", path: "mine.txt", content: "mine\n" },
      { op: "add", paths: ["mine.txt"] },
      { op: "commit", message: "mine" },
      { op: "pull", message: "merge colleague work" },
    );

    const { kompjutr } = await w.snapshot();
    expect(kompjutr.log[0]?.parents).toHaveLength(2);
    expect(await w.read("theirs.txt")).toBe("theirs\n");
    expect(await w.read("mine.txt")).toBe("mine\n");
    await expectAheadBehind(w, "after the merge");
  });

  it("leaves HEAD alone when a pull has nothing to integrate", async () => {
    const w = await createWorld();
    world = w;

    const cloned = await w.snapshot();
    await w.run({ op: "pull", message: "merge origin" });
    expect((await w.snapshot()).kompjutr.head, "up to date").toBe(cloned.kompjutr.head);

    await w.run(
      { op: "write", path: "mine.txt", content: "mine\n" },
      { op: "add", paths: ["mine.txt"] },
      { op: "commit", message: "mine" },
    );

    // Ahead of the upstream: the upstream is already an ancestor, so the pull
    // integrates nothing and leaves the unpushed commit on top.
    const ahead = await w.snapshot();
    await w.run({ op: "pull", message: "merge origin" });
    expect((await w.snapshot()).kompjutr.head, "ahead of upstream").toBe(ahead.kompjutr.head);
    await expectAheadBehind(w, "ahead of upstream");
  });

  it("forces a merge commit when a pull refuses to fast-forward", async () => {
    const w = await createWorld();
    world = w;

    await w.run(
      { op: "peer", act: colleaguePush("theirs.txt", "theirs\n", "colleague") },
      { op: "pull", fastForward: false, message: "merge colleague work" },
    );

    const { kompjutr } = await w.snapshot();
    expect(kompjutr.log[0]?.parents).toHaveLength(2);
    expect(await w.read("theirs.txt")).toBe("theirs\n");
  });

  it("publishes local work and follows it with the tracking ref", async () => {
    const w = await createWorld();
    world = w;

    await w.run(
      { op: "write", path: "mine.txt", content: "mine\n" },
      { op: "add", paths: ["mine.txt"] },
      { op: "commit", message: "mine" },
    );
    await expectAheadBehind(w, "before the push");

    await w.run({ op: "push" });

    const { kompjutr } = await w.snapshot();
    expect(refOid(kompjutr, "refs/remotes/origin/main")).toBe(kompjutr.head);
    expect(kompjutr.originRefs.find((ref) => ref.name === "refs/heads/main")?.oid).toBe(
      kompjutr.head,
    );
    await expectAheadBehind(w, "after the push");
  });

  it("completes the round trip: local work, a colleague's work, pull, push", async () => {
    const w = await createWorld();
    world = w;

    await w.run(
      { op: "write", path: "mine.txt", content: "mine\n" },
      { op: "add", paths: ["mine.txt"] },
      { op: "commit", message: "mine one" },
      { op: "peer", act: colleaguePush("theirs.txt", "theirs\n", "colleague one") },
      { op: "write", path: "mine.txt", content: "mine again\n" },
      { op: "add", paths: ["mine.txt"] },
      { op: "commit", message: "mine two" },
      { op: "pull", message: "merge colleague work" },
      { op: "push" },
    );

    const { kompjutr } = await w.snapshot();
    expect(refOid(kompjutr, "refs/remotes/origin/main")).toBe(kompjutr.head);
    expect(kompjutr.originRefs.find((ref) => ref.name === "refs/heads/main")?.oid).toBe(
      kompjutr.head,
    );
    expect(await w.read("theirs.txt")).toBe("theirs\n");
    expect(await w.read("mine.txt")).toBe("mine again\n");
    await expectAheadBehind(w, "after the round trip");
  });

  it("checks out a branch the colleague created", async () => {
    const w = await createWorld();
    world = w;

    await w.run(
      { op: "peer", act: colleagueBranch("feature", "feature.txt", "feature\n") },
      { op: "fetch" },
    );
    expect(refOid((await w.snapshot()).kompjutr, "refs/remotes/origin/feature")).toBeDefined();

    // Naming the tracking ref detaches HEAD on both sides.
    await w.run({ op: "checkout", ref: "origin/feature" });
    expect((await w.snapshot()).kompjutr.currentBranch).toBeNull();
    expect(await w.read("feature.txt")).toBe("feature\n");

    // A local branch on top of it needs the start point spelled out: kompjutr
    // has no DWIM checkout that would create one (`--track` is unsupported).
    await w.run(
      { op: "checkout", ref: "main" },
      { op: "branch", name: "feature", startPoint: "origin/feature" },
      { op: "checkout", ref: "feature" },
    );
    expect((await w.snapshot()).kompjutr.currentBranch).toBe("refs/heads/feature");
    expect(await w.read("feature.txt")).toBe("feature\n");
  });

  it("prunes the tracking ref of a branch the colleague deleted", async () => {
    const w = await createWorld();
    world = w;

    await w.run(
      { op: "peer", act: colleagueBranch("feature", "feature.txt", "feature\n") },
      { op: "fetch" },
    );
    expect(refOid((await w.snapshot()).kompjutr, "refs/remotes/origin/feature")).toBeDefined();

    await w.run(
      {
        op: "peer",
        act: (peer) => {
          peer.git("push", "-q", "origin", "--delete", "feature");
        },
      },
      // A plain fetch keeps the stale tracking ref; only prune drops it.
      { op: "fetch" },
    );
    expect(refOid((await w.snapshot()).kompjutr, "refs/remotes/origin/feature")).toBeDefined();

    await w.run({ op: "fetch", prune: true });
    expect(refOid((await w.snapshot()).kompjutr, "refs/remotes/origin/feature")).toBeUndefined();
  });

  it("brings a colleague's tags across on a fetch", async () => {
    const w = await createWorld();
    world = w;

    await w.run(
      {
        op: "peer",
        act: (peer) => {
          peer.write("release.txt", "1.0\n");
          peer.commit("release");
          peer.git("tag", "v1.0");
          peer.git("tag", "-a", "v1.0-signed-off", "-m", "annotated release");
          peer.git("push", "-q", "origin", "main", "v1.0", "v1.0-signed-off");
        },
      },
      { op: "fetch" },
      // kompjutr never creates an annotated tag, but it stores one that
      // arrived from a remote — and a start point peels it, which the
      // compared branch ref proves against git.
      { op: "branch", name: "from-tag", startPoint: "v1.0-signed-off" },
    );

    expect(await w.git.tagList({ dir: WORK })).toEqual(["v1.0", "v1.0-signed-off"]);
    const { kompjutr } = await w.snapshot();
    expect(refOid(kompjutr, "refs/tags/v1.0")).toBe(refOid(kompjutr, "refs/remotes/origin/main"));
    expect(refOid(kompjutr, "refs/tags/v1.0-signed-off")).not.toBe(
      refOid(kompjutr, "refs/heads/from-tag"),
    );
  });

  it("adds a second remote and fetches from it", async () => {
    const w = await createWorld();
    world = w;

    await w.run({
      op: "custom",
      local: async (git) => {
        await git.remoteAdd({ dir: WORK, name: "upstream", url: w.url });
      },
      mirror: (fixture) => {
        fixture.git("remote", "add", "upstream", w.originG.dir);
      },
    });

    // Each side reaches its own origin over a different transport, so only the
    // names line up; the URL is checked against the one just configured.
    const remotes = await w.git.remoteList({ dir: WORK });
    expect(remotes.map((remote) => remote.name)).toEqual(["origin", "upstream"]);
    expect(remotes.find((remote) => remote.name === "upstream")?.url).toBe(w.url);
    expect(w.mirror.git("remote").split("\n").sort()).toEqual(["origin", "upstream"]);

    // The added remote is a real one: a colleague's push arrives through it.
    await w.run(
      { op: "peer", act: colleaguePush("theirs.txt", "theirs\n", "colleague") },
      { op: "fetch", remote: "upstream" },
    );
    const { kompjutr } = await w.snapshot();
    expect(refOid(kompjutr, "refs/remotes/upstream/main")).toBe(
      kompjutr.originRefs.find((ref) => ref.name === "refs/heads/main")?.oid,
    );
    // Only the fetched remote's namespace moved.
    expect(refOid(kompjutr, "refs/remotes/origin/main")).not.toBe(
      refOid(kompjutr, "refs/remotes/upstream/main"),
    );
  });

  it("reports ahead and behind counts through the whole loop", async () => {
    const w = await createWorld();
    world = w;
    await expectAheadBehind(w, "fresh clone");

    await w.run(
      { op: "write", path: "mine.txt", content: "mine\n" },
      { op: "add", paths: ["mine.txt"] },
      { op: "commit", message: "mine" },
    );
    await expectAheadBehind(w, "one local commit");

    await w.run(
      { op: "peer", act: colleaguePush("theirs.txt", "theirs\n", "colleague") },
      { op: "fetch" },
    );
    await expectAheadBehind(w, "diverged");

    await w.run({ op: "pull", message: "merge colleague work" });
    await expectAheadBehind(w, "merged");

    await w.run({ op: "push" });
    await expectAheadBehind(w, "published");
  });
});
