// Checkout and hard reset remove tracked paths the target drops. A path
// already gone from disk, or standing as a file where a directory was, is
// already where the target wants it.

import { describe, it } from "vitest";
import type { Op } from "../helpers/differential/ops.js";
import { expectAgreement } from "../helpers/differential/run.js";

const text = (value: string) => ({ text: value });
const base: Op[] = [
  { op: "write", path: "keep", content: text("k\n") },
  { op: "addAll" },
  { op: "commit", message: "base" },
];
/** Commits `a/b/c` and `a/b/d/e`, then replaces the directory `a/b` with a file. */
const replacedLeaf: Op[] = [
  { op: "write", path: "a/b/c", content: text("c\n") },
  { op: "write", path: "a/b/d/e", content: text("e\n") },
  { op: "addAll" },
  { op: "commit", message: "tree" },
  { op: "remove", path: "a/b" },
  { op: "write", path: "a/b", content: text("leaf\n") },
];

describe("differential regressions: checkout removes paths already gone", () => {
  it("hard-resets past a tracked file deleted from disk", async () => {
    await expectAgreement({
      start: "init",
      ops: [
        ...base,
        { op: "write", path: "gone", content: text("g\n") },
        { op: "addAll" },
        { op: "commit", message: "gone" },
        { op: "remove", path: "gone" },
        { op: "reset", ref: "main~1", hard: true },
      ],
    });
  });

  it("hard-resets past a directory replaced by a file", async () => {
    await expectAgreement({
      start: "init",
      ops: [...base, ...replacedLeaf, { op: "reset", ref: "main~1", hard: true }],
    });
  });

  it("force-checks out past a directory replaced by a file", async () => {
    await expectAgreement({
      start: "init",
      ops: [
        ...base,
        { op: "branch", name: "old" },
        ...replacedLeaf,
        { op: "checkout", ref: "old", force: true },
      ],
    });
  });

  it("hard-resets past a staged file whose directory is gone", async () => {
    await expectAgreement({
      start: "init",
      ops: [
        ...base,
        { op: "write", path: "x/c", content: text("c\n") },
        { op: "addAll" },
        { op: "commit", message: "x" },
        { op: "write", path: "x/a", content: text("a\n") },
        { op: "add", paths: ["x/a"] },
        { op: "remove", path: "x" },
        { op: "reset", ref: "main~1", hard: true },
      ],
    });
  });

  it("hard-resets into a sibling over a staged file whose directory is gone", async () => {
    await expectAgreement({
      start: "init",
      ops: [
        ...base,
        { op: "write", path: "x/b", content: text("b\n") },
        { op: "addAll" },
        { op: "commit", message: "b" },
        { op: "rm", paths: ["x/b"] },
        { op: "write", path: "x/c", content: text("c\n") },
        { op: "addAll" },
        { op: "commit", message: "c" },
        { op: "write", path: "x/a", content: text("a\n") },
        { op: "add", paths: ["x/a"] },
        { op: "remove", path: "x" },
        { op: "reset", ref: "main~1", hard: true },
      ],
    });
  });
});
