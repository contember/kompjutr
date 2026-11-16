import { describe, expect, it } from "vitest";
import { knownDivergence } from "../helpers/differential/known.js";
import type { Op, Scenario } from "../helpers/differential/ops.js";
import { expectAgreement, play } from "../helpers/differential/run.js";

const COMMITTED: Op[] = [
  { op: "write", path: "b.txt", content: { text: "x\n" } },
  { op: "add", paths: ["b.txt"] },
  { op: "commit", message: "m" },
];

/** The scenario's last op hits the documented untracked-blocker difference. */
async function expectUntrackedBlocker(scenario: Scenario): Promise<void> {
  const divergence = await play(scenario);
  expect(divergence?.step).toBe(scenario.ops.length - 1);
  expect(divergence === null ? undefined : knownDivergence(divergence)?.id).toBe(
    "path-checkout-untracked-blocker",
  );
}

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

  it("path checkout of the root overwrites staged changes", async () => {
    await expectAgreement({
      start: "clone",
      ops: [
        { op: "write", path: "dir/x.txt", content: { text: "x\n" } },
        { op: "add", paths: ["dir/x.txt"] },
        { op: "checkoutPaths", ref: "main", paths: ["."] },
      ],
    });
  });

  it("path checkout overwrites a staged and unstaged file", async () => {
    await expectAgreement({
      start: "clone",
      ops: [
        { op: "write", path: "README.md", content: { text: "x\n" } },
        { op: "add", paths: ["README.md"] },
        { op: "write", path: "README.md", content: { text: "y\n" } },
        { op: "checkoutPaths", ref: "origin/main", paths: ["README.md"] },
      ],
    });
  });

  it("path checkout overwrites a file staged with add -A", async () => {
    await expectAgreement({
      start: "clone",
      ops: [
        { op: "write", path: "dir/x.txt", content: { text: "alpha\nbeta\ngamma 6\n" } },
        { op: "addAll" },
        { op: "checkoutPaths", ref: "main", paths: ["dir/x.txt"] },
      ],
    });
  });

  it("path checkout refuses to delete an untracked file in the way", async () => {
    await expectUntrackedBlocker({
      start: "init",
      ops: [
        ...COMMITTED,
        { op: "rm", paths: ["b.txt"], cached: true },
        { op: "write", path: "b.txt", content: { text: "untracked\n" } },
        { op: "checkoutPaths", ref: "main", paths: ["b.txt"] },
      ],
    });
  });

  it("path checkout refuses to delete an untracked directory in the way", async () => {
    await expectUntrackedBlocker({
      start: "init",
      ops: [
        ...COMMITTED,
        { op: "rm", paths: ["b.txt"] },
        { op: "commit", message: "d" },
        { op: "write", path: "b.txt/z", content: { text: "untracked\n" } },
        { op: "checkoutPaths", ref: "main~1", paths: ["b.txt"] },
      ],
    });
  });

  it("an explicit HEAD is not a revision on an unborn branch", async () => {
    await expectAgreement({ start: "init", ops: [{ op: "reset", ref: "HEAD", hard: true }] });
    await expectAgreement({ start: "init", ops: [{ op: "reset", ref: "HEAD" }] });
  });

  it("reset resolves a relative revision once, before HEAD moves", async () => {
    await expectAgreement({
      start: "clone",
      ops: [
        { op: "revert", source: "main" },
        { op: "reset", ref: "HEAD~1" },
      ],
    });
    await expectAgreement({
      start: "clone",
      ops: [
        { op: "revert", source: "main" },
        { op: "reset", ref: "HEAD^" },
      ],
    });
    await expectAgreement({
      start: "clone",
      ops: [
        { op: "revert", source: "main" },
        { op: "reset", ref: "HEAD~1", hard: true },
      ],
    });
  });

  it("reset without a revision succeeds on an unborn branch", async () => {
    await expectAgreement({
      start: "init",
      ops: [
        { op: "write", path: "a.txt", content: { text: "a\n" } },
        { op: "add", paths: ["a.txt"] },
        { op: "reset", hard: true },
        { op: "write", path: "a.txt", content: { text: "a\n" } },
        { op: "add", paths: ["a.txt"] },
        { op: "reset" },
        { op: "add", paths: ["a.txt"] },
        { op: "reset", ref: "HEAD", paths: ["a.txt"] },
      ],
    });
  });
});
