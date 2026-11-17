import { describe, it } from "vitest";
import type { Scenario } from "../helpers/differential/ops.js";
import { expectAgreement } from "../helpers/differential/run.js";

describe("differential regressions: branch rename", () => {
  it("renames the unborn current branch", async () => {
    const scenario: Scenario = {
      start: "init",
      ops: [{ op: "branchRename", from: "main", to: "topic" }],
    };
    await expectAgreement(scenario);
  });

  it("renames the unborn current branch to a non-ASCII name", async () => {
    const scenario: Scenario = {
      start: "init",
      ops: [{ op: "branchRename", from: "main", to: "ü-branch" }],
    };
    await expectAgreement(scenario);
  });

  it("commits onto the renamed unborn branch", async () => {
    const scenario: Scenario = {
      start: "init",
      ops: [
        { op: "branchRename", from: "main", to: "topic" },
        { op: "commit", message: "first", allowEmpty: true },
      ],
    };
    await expectAgreement(scenario);
  });

  it("renames the checked-out branch onto itself", async () => {
    const scenario: Scenario = {
      start: "clone",
      ops: [{ op: "branchRename", from: "main", to: "main" }],
    };
    await expectAgreement(scenario);
  });

  it("renames an inactive branch onto itself", async () => {
    const scenario: Scenario = {
      start: "clone",
      ops: [
        { op: "branch", name: "side" },
        { op: "branchRename", from: "side", to: "side" },
      ],
    };
    await expectAgreement(scenario);
  });

  it("renames the unborn current branch onto itself", async () => {
    const scenario: Scenario = {
      start: "init",
      ops: [{ op: "branchRename", from: "main", to: "main" }],
    };
    await expectAgreement(scenario);
  });

  it("refuses to rename a missing branch onto itself", async () => {
    const scenario: Scenario = {
      start: "init",
      ops: [{ op: "branchRename", from: "missing", to: "missing" }],
    };
    await expectAgreement(scenario);
  });
});
