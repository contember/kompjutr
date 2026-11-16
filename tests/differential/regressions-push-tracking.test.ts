// An explicitly named branch pushes to the remote branch of the same name, even
// when its upstream names another, and moves only that remote-tracking ref.
// Deleting a short branch name the remote lacks fails, as in git.

import { describe, it } from "vitest";
import type { Scenario } from "../helpers/differential/ops.js";
import { expectAgreement } from "../helpers/differential/run.js";

describe("differential regressions: push destination and tracking", () => {
  it("pushes a renamed branch under its new name", async () => {
    const scenario: Scenario = {
      start: "clone",
      ops: [
        { op: "branchRename", from: "main", to: "release-1" },
        { op: "push", ref: "release-1" },
      ],
    };
    await expectAgreement(scenario);
  });

  it("pushes a renamed branch with a new commit without moving its upstream", async () => {
    const scenario: Scenario = {
      start: "clone",
      ops: [
        { op: "branchRename", from: "main", to: "release-1" },
        { op: "commit", message: "two", allowEmpty: true },
        { op: "push", ref: "release-1" },
      ],
    };
    await expectAgreement(scenario);
  });

  it("deletes a renamed branch by its own name, not its upstream", async () => {
    const scenario: Scenario = {
      start: "clone",
      ops: [
        { op: "branchRename", from: "main", to: "release-1" },
        { op: "push", ref: "release-1" },
        { op: "push", ref: "release-1", delete: true },
      ],
    };
    await expectAgreement(scenario);
  });

  it("rejects a renamed branch against its diverged namesake, not its upstream", async () => {
    const scenario: Scenario = {
      start: "clone",
      ops: [
        { op: "branchRename", from: "main", to: "feature" },
        { op: "push", ref: "feature" },
      ],
    };
    await expectAgreement(scenario);
  });

  it("refuses to delete a remote branch that does not exist", async () => {
    const scenario: Scenario = {
      start: "clone",
      ops: [{ op: "push", ref: "nosuch", delete: true }],
    };
    await expectAgreement(scenario);
  });

  it("refuses to delete an unpushed local branch on the remote", async () => {
    const scenario: Scenario = {
      start: "clone",
      ops: [
        { op: "checkoutNew", name: "x" },
        { op: "push", ref: "x", delete: true },
      ],
    };
    await expectAgreement(scenario);
  });

  it("accepts deleting an absent remote branch by its full name", async () => {
    const scenario: Scenario = {
      start: "clone",
      ops: [{ op: "push", ref: "refs/heads/nosuch", delete: true }],
    };
    await expectAgreement(scenario);
  });

  it("pushes and deletes a new branch without an upstream", async () => {
    const scenario: Scenario = {
      start: "clone",
      ops: [
        { op: "checkoutNew", name: "x" },
        { op: "commit", message: "x", allowEmpty: true },
        { op: "push", ref: "x" },
        { op: "push", ref: "x", delete: true },
      ],
    };
    await expectAgreement(scenario);
  });
});
