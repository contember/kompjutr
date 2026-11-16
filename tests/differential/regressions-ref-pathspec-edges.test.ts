import { describe, it } from "vitest";
import type { Op, Scenario } from "../helpers/differential/ops.js";
import { expectAgreement } from "../helpers/differential/run.js";

const COMMITTED: Op[] = [
  { op: "write", path: "b.txt", content: { text: "x\n" } },
  { op: "add", paths: ["b.txt"] },
  { op: "commit", message: "m" },
];

describe("differential regressions: ref and pathspec edges", () => {
  it("checkout -b on an unborn branch renames the unborn branch", async () => {
    const scenario: Scenario = {
      start: "init",
      ops: [{ op: "checkoutNew", name: "feature" }],
    };
    await expectAgreement(scenario);
  });

  it("the first commit after checkout -b on an unborn branch lands on the new branch", async () => {
    const scenario: Scenario = {
      start: "init",
      ops: [{ op: "checkoutNew", name: "feature" }, ...COMMITTED],
    };
    await expectAgreement(scenario);
  });

  it("checkout -b with a start point fails on an unborn branch", async () => {
    const scenario: Scenario = {
      start: "init",
      ops: [{ op: "checkoutNew", name: "feature", startPoint: "main" }],
    };
    await expectAgreement(scenario);
  });

  it("checkout of an ancestor revision detaches HEAD", async () => {
    for (const ref of ["main~1", "HEAD~1", "main^"]) {
      await expectAgreement({ start: "clone", ops: [{ op: "checkout", ref }] });
    }
  });

  it("checkout of a tag or a full branch ref detaches HEAD", async () => {
    await expectAgreement({
      start: "clone",
      ops: [
        { op: "tag", name: "v1", object: "main~1" },
        { op: "checkout", ref: "v1" },
        { op: "checkout", ref: "refs/heads/main" },
      ],
    });
  });

  it("checkout prefers a local branch over a tag of the same name", async () => {
    await expectAgreement({
      start: "clone",
      ops: [
        { op: "branch", name: "side", startPoint: "main~1" },
        { op: "tag", name: "side" },
        { op: "checkout", ref: "side" },
      ],
    });
  });

  it("reset of an unmatched path on an unborn branch succeeds", async () => {
    const scenario: Scenario = {
      start: "init",
      ops: [{ op: "reset", paths: ["😀.txt"] }],
    };
    await expectAgreement(scenario);
  });

  it("reset of an unmatched path after a commit succeeds", async () => {
    const scenario: Scenario = {
      start: "init",
      ops: [
        ...COMMITTED,
        { op: "reset", paths: ["nope"] },
        { op: "reset", ref: "main", paths: ["nope"] },
      ],
    };
    await expectAgreement(scenario);
  });

  it("reset to an unresolvable ref fails even when the path is unmatched", async () => {
    const scenario: Scenario = {
      start: "init",
      ops: [{ op: "reset", ref: "main", paths: ["nope"] }],
    };
    await expectAgreement(scenario);
  });

  it("path checkout fails when the path is not in the ref's tree", async () => {
    const scenario: Scenario = {
      start: "init",
      ops: [...COMMITTED, { op: "checkoutPaths", ref: "main", paths: ["a-b"] }],
    };
    await expectAgreement(scenario);
  });

  it("path checkout from a new branch fails for a path outside its tree", async () => {
    const scenario: Scenario = {
      start: "clone",
      ops: [
        { op: "checkoutNew", name: "ü-branch", startPoint: "main" },
        { op: "checkoutPaths", ref: "ü-branch", paths: ["c.bin"] },
      ],
    };
    await expectAgreement(scenario);
  });

  it("path checkout ignores index entries the ref's tree lacks", async () => {
    const scenario: Scenario = {
      start: "init",
      ops: [
        ...COMMITTED,
        { op: "write", path: "new.txt", content: { text: "new\n" } },
        { op: "add", paths: ["new.txt"] },
        { op: "write", path: "b.txt", content: { text: "changed\n" } },
        { op: "checkoutPaths", ref: "main", paths: ["new.txt"] },
        { op: "checkoutPaths", ref: "main", paths: ["b.txt", "new.txt"] },
      ],
    };
    await expectAgreement(scenario);
  });
});
