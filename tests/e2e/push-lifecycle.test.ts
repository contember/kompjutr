// The life of a pushed ref, end to end: publish, republish, lose a race,
// force over it, rename it, delete it. Every step is replayed against the
// real git binary and the whole state — including each side's own origin —
// is compared, so these journeys assert almost nothing of their own.

import { afterEach, describe, expect, it } from "vitest";

import { createWorld, type E2ESnapshot, type E2EWorld } from "../helpers/e2e.js";

let world: E2EWorld | undefined;

afterEach(async () => {
  await world?.dispose();
  world = undefined;
});

function refOid(snapshot: E2ESnapshot, name: string): string | undefined {
  return snapshot.refs.find((ref) => ref.name === name)?.oid;
}

function originOid(snapshot: E2ESnapshot, name: string): string | undefined {
  return snapshot.originRefs.find((ref) => ref.name === name)?.oid;
}

/** The commit HEAD sits on top of, as both sides agree it is. */
function parentOid(snapshot: E2ESnapshot): string {
  const parent = snapshot.log[1]?.oid;
  if (parent === undefined) throw new Error("expected a parent commit in the log");
  return parent;
}

function posts(world: E2EWorld): number {
  return world.requests.filter((request) => request.method === "POST").length;
}

describe("push lifecycle", () => {
  it("publishes a new branch and then a second commit on it", async () => {
    world = await createWorld();
    await world.run(
      { op: "branch", name: "feature", checkout: true },
      { op: "write", path: "feature.txt", content: "one\n" },
      { op: "add", paths: ["feature.txt"] },
      { op: "commit", message: "feature one" },
      { op: "push" },
      { op: "write", path: "feature.txt", content: "two\n" },
      { op: "add", paths: ["feature.txt"] },
      { op: "commit", message: "feature two" },
      { op: "push" },
    );

    const { kompjutr } = await world.snapshot();
    expect(originOid(kompjutr, "refs/heads/feature")).toBe(kompjutr.head);
  });

  it("moves the remote-tracking ref only once the push succeeds", async () => {
    world = await createWorld();
    await world.run(
      { op: "write", path: "tracked.txt", content: "local\n" },
      { op: "add", paths: ["tracked.txt"] },
      { op: "commit", message: "local work" },
    );

    const before = (await world.snapshot()).kompjutr;
    expect(refOid(before, "refs/remotes/origin/main")).not.toBe(before.head);
    expect(originOid(before, "refs/heads/main")).not.toBe(before.head);

    await world.run({ op: "push" });

    const after = (await world.snapshot()).kompjutr;
    expect(refOid(after, "refs/remotes/origin/main")).toBe(after.head);
  });

  it("re-pushing an unchanged branch sends no second pack", async () => {
    world = await createWorld();
    await world.run(
      { op: "write", path: "once.txt", content: "once\n" },
      { op: "add", paths: ["once.txt"] },
      { op: "commit", message: "once" },
      { op: "push" },
    );

    // The retry still asks for the advertisement (a GET); what it must not do
    // is open a receive-pack POST for a ref the remote already carries.
    const sent = posts(world);
    await world.run({ op: "push" });
    expect(posts(world)).toBe(sent);
  });

  it("is rejected behind a colleague and recovers through pull", async () => {
    world = await createWorld();
    await world.run(
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
      { op: "push", expect: { outcome: "failed", code: "ENONFASTFORWARD" } },
      { op: "pull", message: "merge origin" },
      { op: "push" },
    );

    const { kompjutr } = await world.snapshot();
    expect(originOid(kompjutr, "refs/heads/main")).toBe(kompjutr.head);
    expect(await world.read("theirs.txt")).toBe("theirs\n");
  });

  it("force-pushes an amended commit over the published one", async () => {
    world = await createWorld();
    await world.run(
      { op: "write", path: "amend.txt", content: "draft\n" },
      { op: "add", paths: ["amend.txt"] },
      { op: "commit", message: "draft" },
      { op: "push" },
      { op: "write", path: "amend.txt", content: "final\n" },
      { op: "add", paths: ["amend.txt"] },
      { op: "commit", message: "final", amend: true },
      // The published commit is no longer an ancestor, so the lease holds.
      { op: "push", expect: { outcome: "failed", code: "ENONFASTFORWARD" } },
      { op: "push", force: true },
    );

    const { kompjutr } = await world.snapshot();
    expect(originOid(kompjutr, "refs/heads/main")).toBe(kompjutr.head);
    expect(kompjutr.log).toHaveLength(2);
  });

  it("force-pushes a hard reset, moving the remote branch backwards", async () => {
    world = await createWorld();
    await world.run(
      { op: "write", path: "keep.txt", content: "keep\n" },
      { op: "add", paths: ["keep.txt"] },
      { op: "commit", message: "keep" },
      { op: "write", path: "drop.txt", content: "drop\n" },
      { op: "add", paths: ["drop.txt"] },
      { op: "commit", message: "drop" },
      { op: "push" },
    );

    const keep = parentOid((await world.snapshot()).kompjutr);

    await world.run({ op: "reset", ref: keep, hard: true }, { op: "push", force: true });

    const { kompjutr } = await world.snapshot();
    expect(originOid(kompjutr, "refs/heads/main")).toBe(keep);
  });

  it("deletes a published branch from the origin", async () => {
    world = await createWorld();
    await world.run(
      { op: "branch", name: "topic", checkout: true },
      { op: "write", path: "topic.txt", content: "topic\n" },
      { op: "add", paths: ["topic.txt"] },
      { op: "commit", message: "topic" },
      { op: "push" },
    );

    const published = (await world.snapshot()).kompjutr;
    expect(originOid(published, "refs/heads/topic")).toBe(published.head);

    await world.run({ op: "push", delete: true });

    const { kompjutr } = await world.snapshot();
    expect(originOid(kompjutr, "refs/heads/topic")).toBeUndefined();
    // Deleting the published copy leaves the local branch alone.
    expect(refOid(kompjutr, "refs/heads/topic")).toBe(kompjutr.head);
  });

  it("publishes a branch under a different name on the origin", async () => {
    world = await createWorld();
    await world.run(
      { op: "branch", name: "feature", checkout: true },
      { op: "write", path: "renamed.txt", content: "renamed\n" },
      { op: "add", paths: ["renamed.txt"] },
      { op: "commit", message: "renamed" },
      { op: "checkout", ref: "main" },
      { op: "push", ref: "feature", remoteRef: "published" },
    );

    const { kompjutr } = await world.snapshot();
    const feature = refOid(kompjutr, "refs/heads/feature");
    expect(originOid(kompjutr, "refs/heads/published")).toBe(feature);
    expect(originOid(kompjutr, "refs/heads/feature")).toBeUndefined();
  });

  it("pushes a branch that is not checked out", async () => {
    world = await createWorld();
    await world.run(
      // main moves too, so the push has a checked-out branch it could drag
      // along by mistake.
      { op: "write", path: "main.txt", content: "main\n" },
      { op: "add", paths: ["main.txt"] },
      { op: "commit", message: "main work" },
      { op: "branch", name: "sidecar", checkout: true },
      { op: "write", path: "sidecar.txt", content: "sidecar\n" },
      { op: "add", paths: ["sidecar.txt"] },
      { op: "commit", message: "sidecar" },
      { op: "checkout", ref: "main" },
      { op: "push", ref: "sidecar" },
    );

    const { kompjutr } = await world.snapshot();
    expect(originOid(kompjutr, "refs/heads/sidecar")).toBe(refOid(kompjutr, "refs/heads/sidecar"));
    // main was checked out throughout and stayed unpublished.
    expect(originOid(kompjutr, "refs/heads/main")).not.toBe(refOid(kompjutr, "refs/heads/main"));
  });

  it("loses a race that opens between the fetch and the push", async () => {
    world = await createWorld();
    await world.run(
      { op: "write", path: "racer.txt", content: "mine\n" },
      { op: "add", paths: ["racer.txt"] },
      { op: "commit", message: "mine" },
      // Fetch first: the tracking ref is up to date at this instant, so only
      // the advertised old oid can catch what the colleague does next.
      { op: "fetch" },
      {
        op: "peer",
        act: (peer) => {
          peer.write("theirs.txt", "theirs\n");
          peer.commit("colleague");
          peer.git("push", "-q", "origin", "main");
        },
      },
      { op: "push", expect: { outcome: "failed", code: "ENONFASTFORWARD" } },
      { op: "push", force: true },
    );

    const { kompjutr } = await world.snapshot();
    expect(originOid(kompjutr, "refs/heads/main")).toBe(kompjutr.head);
  });

  it("refuses to push a detached HEAD without an explicit ref", async () => {
    world = await createWorld();
    await world.run(
      { op: "write", path: "detach.txt", content: "detach\n" },
      { op: "add", paths: ["detach.txt"] },
      { op: "commit", message: "detach" },
    );

    const seed = parentOid((await world.snapshot()).kompjutr);
    await world.run({ op: "checkout", ref: seed });

    // kompjutr-only: real git rejects a detached `push origin HEAD` for an
    // unrelated reason (an unqualified destination), so the codes cannot be
    // compared and the mirror is left where the last mirrored step put it.
    await world.runLocal({ op: "push", expect: { outcome: "failed", code: "EDETACHED" } });
  });
});
