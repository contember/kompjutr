// `commit --amend` refuses to leave the amended commit's first-parent tree (the
// empty tree at a root) unless `--allow-empty`; an amended merge is exempt.

import { describe, it } from "vitest";
import type { Op } from "../helpers/differential/ops.js";
import { expectAgreement } from "../helpers/differential/run.js";

const TWO_COMMITS: Op[] = [
  { op: "write", path: "a.txt", content: { text: "a\n" } },
  { op: "add", paths: ["a.txt"] },
  { op: "commit", message: "first" },
  { op: "write", path: "b.txt", content: { text: "b\n" } },
  { op: "add", paths: ["b.txt"] },
  { op: "commit", message: "second" },
];

describe("differential regressions: amend to an empty commit", () => {
  it("refuses to amend a root commit to the empty tree", async () => {
    await expectAgreement({
      start: "init",
      ops: [
        { op: "write", path: "日本語.md", content: { text: "x\n" } },
        { op: "addAll" },
        { op: "commit", message: "m" },
        { op: "rm", paths: ["日本語.md"] },
        { op: "commit", message: "m", amend: true },
      ],
    });
  });

  it("refuses to amend a commit to its parent's tree", async () => {
    await expectAgreement({
      start: "init",
      ops: [
        ...TWO_COMMITS,
        { op: "rm", paths: ["b.txt"] },
        { op: "commit", message: "amended", amend: true },
      ],
    });
  });

  it("amends to the parent's tree with allowEmpty", async () => {
    await expectAgreement({
      start: "init",
      ops: [
        ...TWO_COMMITS,
        { op: "rm", paths: ["b.txt"] },
        { op: "commit", message: "amended", amend: true, allowEmpty: true },
      ],
    });
  });

  it("refuses to amend an already empty commit with nothing staged", async () => {
    await expectAgreement({
      start: "init",
      ops: [
        ...TWO_COMMITS,
        { op: "commit", message: "empty", allowEmpty: true },
        { op: "commit", message: "reworded", amend: true },
      ],
    });
  });

  it("rewords a commit whose tree differs from its parent's", async () => {
    await expectAgreement({
      start: "init",
      ops: [...TWO_COMMITS, { op: "commit", message: "reworded", amend: true }],
    });
  });

  it("amends a merge to its first parent's tree", async () => {
    await expectAgreement({
      start: "init",
      ops: [
        ...TWO_COMMITS,
        { op: "checkoutNew", name: "side" },
        { op: "write", path: "side.txt", content: { text: "side\n" } },
        { op: "add", paths: ["side.txt"] },
        { op: "commit", message: "side" },
        { op: "checkout", ref: "main" },
        { op: "merge", theirs: "side", message: "merge", mode: "no-ff" },
        { op: "rm", paths: ["side.txt"] },
        { op: "commit", message: "amended merge", amend: true },
      ],
    });
  });
});
