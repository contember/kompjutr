import { afterEach, describe, expect, it } from "vitest";

import { createWorld, type E2EWorld } from "../helpers/e2e.js";

let world: E2EWorld | undefined;

afterEach(async () => {
  await world?.dispose();
  world = undefined;
});

describe("e2e harness", () => {
  it("clones both sides to the same state", async () => {
    world = await createWorld();
    await world.compare("clone");
  });

  it("mirrors a commit", async () => {
    world = await createWorld();
    await world.run(
      { op: "write", path: "a.txt", content: "one\n" },
      { op: "add", paths: ["a.txt"] },
      { op: "commit", message: "add a" },
    );
    const { kompjutr } = await world.snapshot();
    expect(kompjutr.log).toHaveLength(2);
  });

  it("mirrors a conflicting merge and its resolution", async () => {
    world = await createWorld({ seed: { "c.txt": "base\n" } });
    await world.run(
      { op: "branch", name: "feature", checkout: true },
      { op: "write", path: "c.txt", content: "feature\n" },
      { op: "add", paths: ["c.txt"] },
      { op: "commit", message: "feature" },
      { op: "checkout", ref: "main" },
      { op: "write", path: "c.txt", content: "main\n" },
      { op: "add", paths: ["c.txt"] },
      { op: "commit", message: "main" },
      {
        op: "merge",
        theirs: "feature",
        message: "merge feature",
        expect: { outcome: "conflicted" },
      },
      { op: "write", path: "c.txt", content: "resolved\n" },
      { op: "add", paths: ["c.txt"] },
      { op: "mergeContinue", message: "merge feature" },
    );
  });

  it("mirrors a push of local work", async () => {
    world = await createWorld();
    await world.run(
      { op: "write", path: "p.txt", content: "pushed\n" },
      { op: "add", paths: ["p.txt"] },
      { op: "commit", message: "push me" },
      { op: "push" },
    );
  });

  it("mirrors colleague work arriving through pull", async () => {
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
      { op: "pull", message: "merge origin" },
    );
    expect(await world.read("theirs.txt")).toBe("theirs\n");
  });
});
