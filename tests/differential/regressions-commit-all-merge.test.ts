import { describe, expect, it } from "vitest";
import type { Op, Scenario } from "../helpers/differential/ops.js";
import { expectAgreement, play } from "../helpers/differential/run.js";

// main and topic both change a.txt, so the merge stops on a conflict.
const conflictingTopic: Op[] = [
  { op: "write", path: "a.txt", content: { text: "base\n" } },
  { op: "write", path: "b.txt", content: { text: "b\n" } },
  { op: "add", paths: ["a.txt", "b.txt"] },
  { op: "commit", message: "base" },
  { op: "branch", name: "topic" },
  { op: "checkout", ref: "topic" },
  { op: "write", path: "a.txt", content: { text: "topic\n" } },
  { op: "add", paths: ["a.txt"] },
  { op: "commit", message: "topic" },
  { op: "checkout", ref: "main" },
  { op: "write", path: "a.txt", content: { text: "main\n" } },
  { op: "add", paths: ["a.txt"] },
  { op: "commit", message: "main" },
];

const pausedMerge: Op[] = [
  ...conflictingTopic,
  { op: "merge", theirs: "topic", message: "merge topic" },
];

const resolvedMerge: Op[] = [
  ...pausedMerge,
  { op: "write", path: "a.txt", content: { text: "resolved\n" } },
  { op: "add", paths: ["a.txt"] },
];

describe("commit -a concluding a paused merge", () => {
  it("stages a tracked modification", async () => {
    const scenario: Scenario = {
      start: "init",
      ops: [
        ...resolvedMerge,
        { op: "write", path: "b.txt", content: { text: "edited\n" } },
        { op: "commit", message: "m", all: true },
      ],
    };
    await expectAgreement(scenario);
  });

  it("stages a tracked deletion", async () => {
    const scenario: Scenario = {
      start: "init",
      ops: [
        ...resolvedMerge,
        { op: "remove", path: "b.txt" },
        { op: "commit", message: "m", all: true },
      ],
    };
    await expectAgreement(scenario);
  });

  it("stages a resolution left unstaged", async () => {
    const scenario: Scenario = {
      start: "init",
      ops: [
        ...pausedMerge,
        { op: "write", path: "a.txt", content: { text: "resolved\n" } },
        { op: "commit", message: "m", all: true },
      ],
    };
    await expectAgreement(scenario);
  });

  it("stages a file the merge added and the user then edited", async () => {
    const scenario: Scenario = {
      start: "init",
      ops: [
        ...conflictingTopic.slice(0, 7),
        { op: "write", path: "new.txt", content: { text: "added\n" } },
        { op: "add", paths: ["a.txt", "new.txt"] },
        ...conflictingTopic.slice(8),
        { op: "merge", theirs: "topic", message: "merge topic" },
        { op: "write", path: "a.txt", content: { text: "resolved\n" } },
        { op: "add", paths: ["a.txt"] },
        { op: "write", path: "new.txt", content: { text: "edited\n" } },
        { op: "commit", message: "m", all: true },
      ],
    };
    await expectAgreement(scenario);
  });

  it("resolves a modify/delete conflict whose path HEAD deleted", async () => {
    const scenario: Scenario = {
      start: "init",
      ops: [
        { op: "write", path: "a.txt", content: { text: "base\n" } },
        { op: "add", paths: ["a.txt"] },
        { op: "commit", message: "base" },
        { op: "checkoutNew", name: "topic" },
        { op: "write", path: "a.txt", content: { text: "topic\n" } },
        { op: "commit", message: "topic", all: true },
        { op: "checkout", ref: "main" },
        { op: "rm", paths: ["a.txt"] },
        { op: "commit", message: "main" },
        { op: "merge", theirs: "topic", message: "merge topic" },
        { op: "commit", message: "m", all: true },
      ],
    };
    await expectAgreement(scenario);
  });
});

// git commits beside its sequencer state; kompjutr refuses on purpose
// (git-support.md, "A pending integration owns the checkout").
async function expectRefusedWhilePending(scenario: Scenario): Promise<void> {
  const divergence = await play(scenario);
  expect(divergence?.step).toBe(scenario.ops.length - 1);
  expect(divergence?.outcomes.kompjutr).toEqual({
    kind: "failed",
    detail: "exit 128: fatal: cannot commit while another operation is in progress",
  });
}

describe("commit -a while a replay is paused", () => {
  it("is refused during a cherry-pick", async () => {
    await expectRefusedWhilePending({
      start: "init",
      ops: [
        ...conflictingTopic,
        { op: "cherryPick", source: "topic" },
        { op: "write", path: "a.txt", content: { text: "resolved\n" } },
        { op: "add", paths: ["a.txt"] },
        { op: "commit", message: "m", all: true },
      ],
    });
  });

  it("is refused during a revert", async () => {
    await expectRefusedWhilePending({
      start: "init",
      ops: [
        ...conflictingTopic,
        { op: "write", path: "a.txt", content: { text: "later\n" } },
        { op: "commit", message: "later", all: true },
        { op: "revert", source: "HEAD~1" },
        { op: "write", path: "a.txt", content: { text: "reverted\n" } },
        { op: "add", paths: ["a.txt"] },
        { op: "commit", message: "m", all: true },
      ],
    });
  });
});
