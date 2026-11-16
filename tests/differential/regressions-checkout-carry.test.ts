// Branch checkout is git's two-way merge: a path HEAD and the target agree on
// keeps its staged state; a staged path the switch would change is refused; a
// path the switch takes replaces a kept entry it collides with.

import { describe, it } from "vitest";
import type { Op, Scenario } from "../helpers/differential/ops.js";
import { expectAgreement } from "../helpers/differential/run.js";

describe("differential regressions: checkout carries staged changes", () => {
  it("carries a staged new file absent from both trees", async () => {
    const scenario: Scenario = {
      start: "init",
      ops: [
        { op: "write", path: "dir/y.txt", content: { text: "x\n" } },
        { op: "addAll" },
        { op: "commit", message: "m15" },
        { op: "write", path: "deep/1/2/3/4/5/6/7/leaf.txt", content: { text: "x\n" } },
        { op: "add", paths: ["."] },
        { op: "checkout", ref: "main" },
      ],
    };
    await expectAgreement(scenario);
  });

  it("carries a staged new file next to a committed one", async () => {
    const scenario: Scenario = {
      start: "init",
      ops: [
        { op: "write", path: "a-b", content: { text: "x\n" } },
        { op: "write", path: "spaced name.txt", content: { text: "x\n" } },
        { op: "add", paths: ["a-b"] },
        { op: "commit", message: "m" },
        { op: "add", paths: ["spaced name.txt"] },
        { op: "checkout", ref: "main" },
      ],
    };
    await expectAgreement(scenario);
  });

  it("carries a staged rename to a new branch at another commit", async () => {
    const scenario: Scenario = {
      start: "clone",
      ops: [
        { op: "mv", from: "dir/x.txt", to: "a/b" },
        { op: "checkoutNew", name: "fix/one", startPoint: "main~1" },
      ],
    };
    await expectAgreement(scenario);
  });

  it("carries a staged deletion to a new branch", async () => {
    const scenario: Scenario = {
      start: "clone",
      ops: [
        { op: "rm", paths: ["README.md"] },
        { op: "checkoutNew", name: "feature", startPoint: "main" },
      ],
    };
    await expectAgreement(scenario);
  });

  it("carries a cached deletion whose file stays on disk", async () => {
    const scenario: Scenario = {
      start: "clone",
      ops: [
        { op: "rm", paths: ["dir/x.txt"], cached: true },
        { op: "checkoutNew", name: "fix/one", startPoint: "main~1" },
      ],
    };
    await expectAgreement(scenario);
  });

  it("carries a staged new file between two different branches", async () => {
    const scenario: Scenario = {
      start: "clone",
      ops: [
        { op: "checkoutNew", name: "side", startPoint: "main~1" },
        { op: "write", path: "new.txt", content: { text: "x\n" } },
        { op: "add", paths: ["new.txt"] },
        { op: "checkout", ref: "main" },
      ],
    };
    await expectAgreement(scenario);
  });

  it("refuses a staged edit on a path the target changes", async () => {
    const scenario: Scenario = {
      start: "clone",
      ops: [
        { op: "write", path: "README.md", content: { text: "local\n" } },
        { op: "add", paths: ["README.md"] },
        { op: "checkoutNew", name: "fix/one", startPoint: "main~1" },
      ],
    };
    await expectAgreement(scenario);
  });

  it("forces a checkout over a staged new file missing from disk", async () => {
    const scenario: Scenario = {
      start: "clone",
      ops: [
        { op: "write", path: "x", content: { text: "x\n" } },
        { op: "addAll" },
        { op: "remove", path: "x" },
        { op: "checkout", ref: "origin/feature", force: true },
      ],
    };
    await expectAgreement(scenario);
  });

  it("forces a checkout over a nested staged file missing from disk", async () => {
    const scenario: Scenario = {
      start: "clone",
      ops: [
        { op: "branchRename", from: "main", to: "fix/one" },
        { op: "write", path: "dir/sub/z.txt", content: { text: "x\n" } },
        { op: "add", paths: ["dir/sub/z.txt"] },
        { op: "remove", path: "dir/sub/z.txt" },
        { op: "checkout", ref: "fix/one", force: true },
      ],
    };
    await expectAgreement(scenario);
  });

  it("removes a tracked path already deleted from disk", async () => {
    const scenario: Scenario = {
      start: "clone",
      ops: [
        { op: "checkout", ref: "origin/feature" },
        { op: "remove", path: "dir/y.txt" },
        { op: "checkout", ref: "main" },
      ],
    };
    await expectAgreement(scenario);
  });

  it("carries a staged new file missing from disk", async () => {
    const scenario: Scenario = {
      start: "clone",
      ops: [
        { op: "write", path: "x", content: { text: "x\n" } },
        { op: "addAll" },
        { op: "remove", path: "x" },
        { op: "checkout", ref: "origin/feature" },
      ],
    };
    await expectAgreement(scenario);
  });

  it("refuses a staged deletion of a path the target changes", async () => {
    const scenario: Scenario = {
      start: "clone",
      ops: [
        { op: "rm", paths: ["README.md"] },
        { op: "checkoutNew", name: "fix/one", startPoint: "main~1" },
      ],
    };
    await expectAgreement(scenario);
  });
});

/** `side` adds `path`; back on `main`, `staged` runs, then `side` is checked out. */
function switchOver(path: string, staged: Op[]): Scenario {
  return {
    start: "init",
    ops: [
      { op: "write", path: "keep", content: { text: "k\n" } },
      { op: "addAll" },
      { op: "commit", message: "base" },
      { op: "checkoutNew", name: "side" },
      { op: "write", path, content: { text: "side\n" } },
      { op: "add", paths: [path] },
      { op: "commit", message: "side" },
      { op: "checkout", ref: "main" },
      ...staged,
      { op: "checkout", ref: "side" },
      { op: "commit", message: "after", allowEmpty: true },
    ],
  };
}

function stage(path: string): Op[] {
  return [
    { op: "write", path, content: { text: "staged\n" } },
    { op: "add", paths: [path] },
  ];
}

describe("differential regressions: carried entries never collide as file and directory", () => {
  it("drops a staged file below a file the target adds", async () => {
    await expectAgreement(switchOver("a", stage("a/b")));
  });

  it("drops a nested staged file below a file the target adds", async () => {
    await expectAgreement(switchOver("a", stage("a/b/c")));
  });

  it("drops staged files below the target's file when one is gone from disk", async () => {
    await expectAgreement(
      switchOver("a", [...stage("a/b"), ...stage("a/c"), { op: "remove", path: "a/c" }]),
    );
  });

  it("refuses when a staged file below the target's file has local changes", async () => {
    await expectAgreement(
      switchOver("a", [...stage("a/b"), { op: "write", path: "a/b", content: { text: "x\n" } }]),
    );
  });

  it("refuses a staged file on disk where the target adds a path below it", async () => {
    await expectAgreement(switchOver("a/b/c", stage("a")));
  });

  it("drops a staged file gone from disk where the target adds a path below it", async () => {
    await expectAgreement(switchOver("a/b", [...stage("a"), { op: "remove", path: "a" }]));
  });

  it("drops a nested staged file gone from disk below the target's new directory", async () => {
    await expectAgreement(switchOver("a/b/c", [...stage("a/b"), { op: "remove", path: "a" }]));
  });
});
