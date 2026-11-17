import { describe, it } from "vitest";
import type { Scenario } from "../helpers/differential/ops.js";
import { expectAgreement } from "../helpers/differential/run.js";

describe("differential regressions: branch auto-upstream", () => {
  it("tracks a remote-tracking start point", async () => {
    const scenario: Scenario = {
      start: "clone",
      ops: [{ op: "branch", name: "feature", startPoint: "origin/main" }],
    };
    await expectAgreement(scenario);
  });

  it("tracks a remote-tracking start point of another branch", async () => {
    const scenario: Scenario = {
      start: "clone",
      ops: [{ op: "branch", name: "topic", startPoint: "origin/feature" }],
    };
    await expectAgreement(scenario);
  });

  it("tracks a start point given as a full remote-tracking ref", async () => {
    const scenario: Scenario = {
      start: "clone",
      ops: [{ op: "branch", name: "topic", startPoint: "refs/remotes/origin/feature" }],
    };
    await expectAgreement(scenario);
  });

  it("tracks the start point of checkout -b", async () => {
    const scenario: Scenario = {
      start: "clone",
      ops: [{ op: "checkoutNew", name: "topic", startPoint: "origin/feature" }],
    };
    await expectAgreement(scenario);
  });

  it("replaces the upstream when a forced branch restarts at a remote-tracking ref", async () => {
    const scenario: Scenario = {
      start: "clone",
      ops: [
        { op: "branch", name: "topic", startPoint: "origin/feature" },
        { op: "branch", name: "topic", startPoint: "origin/main", force: true },
      ],
    };
    await expectAgreement(scenario);
  });

  it("keeps the upstream when a forced branch restarts at a local branch", async () => {
    const scenario: Scenario = {
      start: "clone",
      ops: [
        { op: "branch", name: "topic", startPoint: "origin/feature" },
        { op: "branch", name: "topic", startPoint: "main", force: true },
      ],
    };
    await expectAgreement(scenario);
  });

  it("does not track a tag or a revision expression", async () => {
    const scenario: Scenario = {
      start: "clone",
      ops: [
        { op: "tag", name: "t", object: "origin/feature" },
        { op: "branch", name: "from-tag", startPoint: "t" },
        { op: "branch", name: "from-ancestor", startPoint: "origin/feature~1" },
      ],
    };
    await expectAgreement(scenario);
  });

  it("drops the upstream of a deleted branch before its name is reused", async () => {
    const scenario: Scenario = {
      start: "clone",
      ops: [
        { op: "branch", name: "topic", startPoint: "origin/feature" },
        { op: "branchDelete", name: "topic", force: true },
        { op: "branch", name: "topic", startPoint: "main" },
      ],
    };
    await expectAgreement(scenario);
  });

  it("renames onto the name of a deleted tracking branch", async () => {
    const scenario: Scenario = {
      start: "clone",
      ops: [
        { op: "branch", name: "topic", startPoint: "origin/feature" },
        { op: "branchDelete", name: "topic", force: true },
        { op: "branch", name: "other", startPoint: "main" },
        { op: "branchRename", from: "other", to: "topic" },
      ],
    };
    await expectAgreement(scenario);
  });
});
