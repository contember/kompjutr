// Branch checkout is git's two-way merge: a path HEAD and the target agree on
// keeps its staged state; a staged path the switch would change is refused.

import { describe, it } from "vitest";
import type { Scenario } from "../helpers/differential/ops.js";
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
