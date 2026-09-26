import { afterEach, describe, it } from "vitest";

import { createWorld, type E2EWorld, type StepExpectation } from "../helpers/e2e.js";

let world: E2EWorld | undefined;

afterEach(async () => {
  await world?.dispose();
  world = undefined;
});

describe("ignored untracked paths replaced by tracked files", () => {
  for (const operation of ["checkout", "merge", "cherryPick"]) {
    it(`${operation} overwrites an ignored file`, async () => {
      world = await createWorld({ seed: { ".gitignore": "*.log\n" } });
      await world.run(
        { op: "branch", name: "feature", checkout: true },
        { op: "write", path: "x.log", content: "tracked\n" },
        { op: "add", paths: ["x.log"], force: true },
        { op: "commit", message: "track log" },
        { op: "checkout", ref: "main" },
        { op: "write", path: "x.log", content: "ignored\n" },
      );
      if (operation === "checkout") await world.run({ op: "checkout", ref: "feature" });
      if (operation === "merge") await world.run({ op: "merge", theirs: "feature" });
      if (operation === "cherryPick") await world.run({ op: "cherryPick", source: "feature" });
    });

    it(`${operation} refuses to overwrite a non-ignored file`, async () => {
      world = await createWorld();
      await world.run(
        { op: "branch", name: "feature", checkout: true },
        { op: "write", path: "x.txt", content: "tracked\n" },
        { op: "add", paths: ["x.txt"] },
        { op: "commit", message: "track file" },
        { op: "checkout", ref: "main" },
        { op: "write", path: "x.txt", content: "untracked\n" },
      );
      const expect: StepExpectation = { outcome: "failed", code: "ECHECKOUTFAIL" };
      if (operation === "checkout") await world.run({ op: "checkout", ref: "feature", expect });
      if (operation === "merge") await world.run({ op: "merge", theirs: "feature", expect });
      if (operation === "cherryPick") {
        await world.run({ op: "cherryPick", source: "feature", expect });
      }
    });
  }

  it("rebase overwrites an ignored file", async () => {
    world = await createWorld({ seed: { ".gitignore": "*.log\n" } });
    await world.run(
      { op: "branch", name: "feature", checkout: true },
      { op: "write", path: "feature.txt", content: "feature\n" },
      { op: "add", paths: ["feature.txt"] },
      { op: "commit", message: "feature" },
      { op: "checkout", ref: "main" },
      { op: "write", path: "x.log", content: "tracked\n" },
      { op: "add", paths: ["x.log"], force: true },
      { op: "commit", message: "track log" },
      { op: "checkout", ref: "feature" },
      { op: "write", path: "x.log", content: "ignored\n" },
      { op: "rebase", upstream: "main" },
    );
  });

  it("rebase refuses to overwrite a non-ignored file", async () => {
    world = await createWorld();
    await world.run(
      { op: "branch", name: "feature", checkout: true },
      { op: "write", path: "feature.txt", content: "feature\n" },
      { op: "add", paths: ["feature.txt"] },
      { op: "commit", message: "feature" },
      { op: "checkout", ref: "main" },
      { op: "write", path: "x.txt", content: "tracked\n" },
      { op: "add", paths: ["x.txt"] },
      { op: "commit", message: "track file" },
      { op: "checkout", ref: "feature" },
      { op: "write", path: "x.txt", content: "untracked\n" },
      { op: "rebase", upstream: "main", expect: { outcome: "failed", code: "ECHECKOUTFAIL" } },
    );
  });

  it("checkout replaces an ignored directory with a tracked file", async () => {
    world = await createWorld({ seed: { ".gitignore": "cache/\n" } });
    await world.run(
      { op: "branch", name: "feature", checkout: true },
      { op: "write", path: "cache", content: "tracked\n" },
      { op: "add", paths: ["cache"], force: true },
      { op: "commit", message: "track cache" },
      { op: "checkout", ref: "main" },
      { op: "write", path: "cache/data", content: "ignored\n" },
      { op: "checkout", ref: "feature" },
    );
  });

  it("checkout replaces an empty ignored directory with a tracked file", async () => {
    world = await createWorld({ seed: { ".gitignore": "cache/\n" } });
    await world.run(
      { op: "branch", name: "feature", checkout: true },
      { op: "write", path: "cache", content: "tracked\n" },
      { op: "add", paths: ["cache"], force: true },
      { op: "commit", message: "track cache" },
      { op: "checkout", ref: "main" },
      { op: "mkdir", path: "cache" },
      { op: "checkout", ref: "feature" },
    );
  });

  it("checkout keeps a directory with a non-ignored descendant", async () => {
    world = await createWorld({ seed: { ".gitignore": "*.tmp\n" } });
    await world.run(
      { op: "branch", name: "feature", checkout: true },
      { op: "write", path: "cache", content: "tracked\n" },
      { op: "add", paths: ["cache"] },
      { op: "commit", message: "track cache" },
      { op: "checkout", ref: "main" },
      { op: "write", path: "cache/ignored.tmp", content: "ignored\n" },
      { op: "write", path: "cache/keep.txt", content: "untracked\n" },
      { op: "checkout", ref: "feature", expect: { outcome: "failed", code: "ECHECKOUTFAIL" } },
    );
  });

  it("merge replaces an ignored directory with a tracked file", async () => {
    world = await createWorld({ seed: { ".gitignore": "cache/\n" } });
    await world.run(
      { op: "branch", name: "feature", checkout: true },
      { op: "write", path: "cache", content: "tracked\n" },
      { op: "add", paths: ["cache"], force: true },
      { op: "commit", message: "track cache" },
      { op: "checkout", ref: "main" },
      { op: "write", path: "cache/data", content: "ignored\n" },
      { op: "merge", theirs: "feature" },
    );
  });

  it("rebase replaces an ignored directory with a tracked file", async () => {
    world = await createWorld({ seed: { ".gitignore": "cache/\n" } });
    await world.run(
      { op: "branch", name: "feature", checkout: true },
      { op: "write", path: "feature.txt", content: "feature\n" },
      { op: "add", paths: ["feature.txt"] },
      { op: "commit", message: "feature" },
      { op: "checkout", ref: "main" },
      { op: "write", path: "cache", content: "tracked\n" },
      { op: "add", paths: ["cache"], force: true },
      { op: "commit", message: "track cache" },
      { op: "checkout", ref: "feature" },
      { op: "write", path: "cache/data", content: "ignored\n" },
      { op: "rebase", upstream: "main" },
    );
  });
});
