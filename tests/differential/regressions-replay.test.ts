import { describe, it } from "vitest";
import type { Scenario } from "../helpers/differential/ops.js";
import { expectAgreement } from "../helpers/differential/run.js";

describe("differential regressions: cherry-pick and revert", () => {
  it("reverts onto a missing worktree file and stops on the conflict", async () => {
    const scenario: Scenario = {
      start: "clone",
      ops: [
        { op: "remove", path: "dir/x.txt" },
        { op: "revert", source: "HEAD^" },
      ],
    };
    await expectAgreement(scenario);
  });

  for (const leave of ["revertAbort", "revertSkip"] as const) {
    it(`leaves a stop over a missing worktree file with ${leave}`, async () => {
      const scenario: Scenario = {
        start: "clone",
        ops: [
          { op: "remove", path: "dir/x.txt" },
          { op: "revert", source: "HEAD^" },
          { op: leave },
        ],
      };
      await expectAgreement(scenario);
    });
  }

  it("aborts a cherry-pick that stopped over a missing worktree file", async () => {
    const scenario: Scenario = {
      start: "init",
      ops: [
        { op: "write", path: "a.txt", content: { text: "a\n" } },
        { op: "write", path: "b.txt", content: { text: "b\n" } },
        { op: "addAll" },
        { op: "commit", message: "base" },
        { op: "checkoutNew", name: "topic" },
        { op: "rm", paths: ["a.txt"] },
        { op: "write", path: "b.txt", content: { text: "topic\n" } },
        { op: "commit", message: "drop", all: true },
        { op: "checkout", ref: "main" },
        { op: "write", path: "b.txt", content: { text: "main\n" } },
        { op: "commit", message: "edit", all: true },
        { op: "remove", path: "a.txt" },
        { op: "cherryPick", source: "topic" },
        { op: "cherryPickAbort" },
      ],
    };
    await expectAgreement(scenario);
  });

  it("reverts a commit whose added file is missing from the worktree", async () => {
    const scenario: Scenario = {
      start: "init",
      ops: [
        { op: "write", path: "dir/x.txt", content: { text: "x\n" } },
        { op: "add", paths: ["."] },
        { op: "remove", path: "dir/x.txt" },
        { op: "commit", message: "m" },
        { op: "revert", source: "main" },
      ],
    };
    await expectAgreement(scenario);
  });

  it("removes a directory a conflicted revert emptied", async () => {
    const scenario: Scenario = {
      start: "clone",
      ops: [{ op: "revert", source: "main~1" }],
    };
    await expectAgreement(scenario);
  });

  it("keeps a directory an untracked file still occupies", async () => {
    const scenario: Scenario = {
      start: "clone",
      ops: [
        { op: "write", path: "dir/u.txt", content: { text: "u\n" } },
        { op: "revert", source: "main~1" },
      ],
    };
    await expectAgreement(scenario);
  });

  it("removes a directory a clean revert emptied", async () => {
    const scenario: Scenario = {
      start: "init",
      ops: [
        { op: "write", path: "f", content: { text: "f\n" } },
        { op: "addAll" },
        { op: "commit", message: "base" },
        { op: "write", path: "d/e/a.txt", content: { text: "a\n" } },
        { op: "addAll" },
        { op: "commit", message: "add" },
        { op: "revert", source: "HEAD" },
      ],
    };
    await expectAgreement(scenario);
  });

  it("removes a directory a merge emptied", async () => {
    const scenario: Scenario = {
      start: "init",
      ops: [
        { op: "write", path: "f", content: { text: "f\n" } },
        { op: "write", path: "d/a.txt", content: { text: "a\n" } },
        { op: "addAll" },
        { op: "commit", message: "base" },
        { op: "checkoutNew", name: "side" },
        { op: "rm", paths: ["d/a.txt"] },
        { op: "commit", message: "drop" },
        { op: "checkout", ref: "main" },
        { op: "write", path: "f", content: { text: "g\n" } },
        { op: "addAll" },
        { op: "commit", message: "edit" },
        { op: "merge", theirs: "side", message: "merge" },
      ],
    };
    await expectAgreement(scenario);
  });

  it("continues an empty cherry-pick with newly staged changes", async () => {
    const scenario: Scenario = {
      start: "init",
      ops: [
        { op: "write", path: "a-b", content: { text: "x\n" } },
        { op: "commit", message: "m", allowEmpty: true },
        { op: "cherryPick", source: "main" },
        { op: "addAll" },
        { op: "cherryPickContinue" },
      ],
    };
    await expectAgreement(scenario);
  });

  it("continues an empty cherry-pick of a branch tip with staged changes", async () => {
    const scenario: Scenario = {
      start: "clone",
      ops: [
        { op: "branch", name: "topic", startPoint: "main" },
        { op: "write", path: "dir/sub/z.txt", content: { text: "x\n" } },
        { op: "cherryPick", source: "topic" },
        { op: "add", paths: ["."] },
        { op: "cherryPickContinue" },
      ],
    };
    await expectAgreement(scenario);
  });

  it("stays stopped when an empty cherry-pick continues with nothing staged", async () => {
    const scenario: Scenario = {
      start: "clone",
      ops: [{ op: "cherryPick", source: "main" }, { op: "cherryPickContinue" }],
    };
    await expectAgreement(scenario);
  });

  it("stays stopped when a conflicted revert is resolved to HEAD", async () => {
    const scenario: Scenario = {
      start: "clone",
      ops: [
        { op: "rm", paths: ["README.md"], force: true },
        { op: "commit", message: "m" },
        { op: "revert", source: "origin/main" },
        { op: "rm", paths: ["README.md"], force: true },
        { op: "revertContinue" },
      ],
    };
    await expectAgreement(scenario);
  });

  it("stays stopped when a conflicted cherry-pick is resolved to HEAD", async () => {
    const scenario: Scenario = {
      start: "clone",
      ops: [
        { op: "checkoutNew", name: "topic", startPoint: "main~1" },
        { op: "rm", paths: ["README.md"], force: true },
        { op: "commit", message: "m" },
        { op: "cherryPick", source: "main" },
        { op: "rm", paths: ["README.md"], force: true },
        { op: "cherryPickContinue" },
      ],
    };
    await expectAgreement(scenario);
  });
});
