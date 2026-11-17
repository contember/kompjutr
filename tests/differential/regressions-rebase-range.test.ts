// Without --rebase-merges git drops merge commits from the replayed range, and
// it replays a range above an upstream HEAD already contains unless the range
// is linear.

import { describe, expect, it } from "vitest";
import { knownDivergence } from "../helpers/differential/known.js";
import type { Op, Scenario } from "../helpers/differential/ops.js";
import { expectAgreement, play } from "../helpers/differential/run.js";

const base: Op[] = [
  { op: "write", path: "a.txt", content: { text: "a\n" } },
  { op: "addAll" },
  { op: "commit", message: "base" },
];

function commitFile(path: string, message: string): Op[] {
  return [
    { op: "write", path, content: { text: `${message}\n` } },
    { op: "add", paths: [path] },
    { op: "commit", message },
  ];
}

describe("differential regressions: rebase range selection", () => {
  it("drops a merge and an amended commit already upstream", async () => {
    const scenario: Scenario = {
      start: "clone",
      ops: [
        { op: "branch", name: "release-1" },
        { op: "commit", message: "m", amend: true },
        { op: "merge", theirs: "release-1", message: "m" },
        { op: "rebase", upstream: "release-1" },
      ],
    };
    await expectAgreement(scenario);
  });

  it("replays a commit beneath a merge of the upstream", async () => {
    const scenario: Scenario = {
      start: "init",
      ops: [
        ...base,
        { op: "checkoutNew", name: "topic" },
        ...commitFile("t.txt", "side"),
        { op: "checkout", ref: "main" },
        ...commitFile("x.txt", "mainline"),
        { op: "merge", theirs: "topic", message: "merge" },
        { op: "rebase", upstream: "topic" },
      ],
    };
    await expectAgreement(scenario);
  });

  it("resets to the upstream when the range holds only a merge", async () => {
    const scenario: Scenario = {
      start: "init",
      ops: [
        ...base,
        { op: "checkoutNew", name: "release-1" },
        ...commitFile("u.txt", "up"),
        { op: "checkout", ref: "main" },
        { op: "merge", theirs: "release-1", message: "merge", mode: "no-ff" },
        { op: "rebase", upstream: "release-1" },
      ],
    };
    await expectAgreement(scenario);
  });

  it("drops a merge of history the divergent upstream already holds", async () => {
    const scenario: Scenario = {
      start: "init",
      ops: [
        ...base,
        { op: "checkoutNew", name: "side" },
        ...commitFile("s.txt", "side"),
        { op: "checkoutNew", name: "release-1" },
        ...commitFile("u.txt", "up"),
        { op: "checkout", ref: "main" },
        ...commitFile("m.txt", "mine"),
        { op: "merge", theirs: "side", message: "merge", mode: "no-ff" },
        ...commitFile("n.txt", "after"),
        { op: "rebase", upstream: "release-1" },
      ],
    };
    await expectAgreement(scenario);
  });

  it("refuses a merge that brings in commits the upstream lacks", async () => {
    const scenario: Scenario = {
      start: "init",
      ops: [
        ...base,
        { op: "branch", name: "release-1" },
        { op: "checkoutNew", name: "topic" },
        ...commitFile("t.txt", "side"),
        { op: "checkout", ref: "main" },
        ...commitFile("x.txt", "mainline"),
        { op: "merge", theirs: "topic", message: "merge" },
        { op: "rebase", upstream: "release-1" },
      ],
    };
    const divergence = await play(scenario);
    expect(divergence?.step).toBe(scenario.ops.length - 1);
    expect(divergence === null ? undefined : knownDivergence(divergence)?.id).toBe(
      "rebase-merge-side-commits",
    );
  });
});
