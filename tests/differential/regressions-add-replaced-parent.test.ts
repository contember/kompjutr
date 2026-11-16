// An indexed path whose parent directory became a file or a symlink on disk:
// add stages its removal instead of failing on the non-directory component.

import { describe, it } from "vitest";
import type { Op, Scenario } from "../helpers/differential/ops.js";
import { expectAgreement } from "../helpers/differential/run.js";

function parentBecameFile(add: Op): Scenario {
  return {
    start: "init",
    ops: [
      { op: "write", path: "x/y", content: { text: "x\n" } },
      { op: "write", path: "target.txt", content: { text: "t\n" } },
      { op: "addAll" },
      { op: "write", path: "x", content: { text: "x\n" } },
      add,
    ],
  };
}

function parentBecameSymlink(add: Op): Scenario {
  return {
    start: "init",
    ops: [
      { op: "write", path: "x/y", content: { text: "x\n" } },
      { op: "write", path: "target.txt", content: { text: "t\n" } },
      { op: "addAll" },
      { op: "remove", path: "x" },
      { op: "write", path: "realdir/y", content: { text: "inner\n" } },
      { op: "symlink", path: "x", target: "realdir" },
      add,
    ],
  };
}

describe("differential regressions: add under a replaced parent", () => {
  it("stages the removal when the indexed path is named", async () => {
    await expectAgreement({
      start: "init",
      ops: [
        { op: "write", path: "x/y", content: { text: "x\n" } },
        { op: "addAll" },
        { op: "write", path: "x", content: { text: "x\n" } },
        { op: "add", paths: ["x/y"] },
      ],
    });
  });

  it("stages the file and the removal through add -A", async () => {
    await expectAgreement(parentBecameFile({ op: "addAll" }));
  });

  it("stages the file and the removal through add .", async () => {
    await expectAgreement(parentBecameFile({ op: "add", paths: ["."] }));
  });

  it("stages the removal through add -u", async () => {
    await expectAgreement(parentBecameFile({ op: "addAll", update: true }));
  });

  it("stages the file and the removal when the parent is named", async () => {
    await expectAgreement(parentBecameFile({ op: "add", paths: ["x"] }));
  });

  it("stages the symlink and the removal through add -A", async () => {
    await expectAgreement(parentBecameSymlink({ op: "addAll" }));
  });

  it("stages the symlink and the removal through add .", async () => {
    await expectAgreement(parentBecameSymlink({ op: "add", paths: ["."] }));
  });

  it("stages the removal under a symlinked parent through add -u", async () => {
    await expectAgreement(parentBecameSymlink({ op: "addAll", update: true }));
  });

  it("stages the symlink and the removal when the parent is named", async () => {
    await expectAgreement(parentBecameSymlink({ op: "add", paths: ["x"] }));
  });
});
