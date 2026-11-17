// Messages given to `commit -m`, `merge -m`, and the merge-continue commit are
// stored after git's whitespace cleanup, and a continued pick also drops `#`
// lines, so both sides agree on commit OIDs.

import { describe, it } from "vitest";
import type { Op, Scenario } from "../helpers/differential/ops.js";
import { expectAgreement } from "../helpers/differential/run.js";

const BASE: Op[] = [
  { op: "write", path: "README.md", content: { text: "x\n" } },
  { op: "add", paths: ["README.md"] },
  { op: "commit", message: "base" },
];

/** `side` and `main` both change README.md after BASE; `side` carries `message`. */
function conflicting(message: string): Op[] {
  return [
    ...BASE,
    { op: "checkoutNew", name: "side" },
    { op: "write", path: "README.md", content: { text: "side\n" } },
    { op: "add", paths: ["README.md"] },
    { op: "commit", message },
    { op: "checkout", ref: "main" },
    { op: "write", path: "README.md", content: { text: "main\n" } },
    { op: "add", paths: ["README.md"] },
    { op: "commit", message: "main" },
  ];
}

const RESOLVE: Op[] = [
  { op: "write", path: "README.md", content: { text: "resolved\n" } },
  { op: "add", paths: ["README.md"] },
];

function committed(message: string): Scenario {
  return {
    start: "init",
    ops: [
      { op: "write", path: "README.md", content: { text: "x\n" } },
      { op: "add", paths: ["README.md"] },
      { op: "commit", message },
    ],
  };
}

describe("differential regressions: commit message cleanup", () => {
  it("strips trailing spaces on the subject and trailing blank lines", async () => {
    await expectAgreement(committed("m21  \n\n\n"));
  });

  it("collapses inner runs of blank lines", async () => {
    await expectAgreement(committed("subject\n\n\n\nbody\n \n\t\nmore\n"));
  });

  it("drops leading blank lines", async () => {
    await expectAgreement(committed("\n \n\nsubject\n"));
  });

  it("strips trailing whitespace on a body line", async () => {
    await expectAgreement(committed("subject\n\nbody \t\nend"));
  });

  it("keeps a mid-line CR and strips a trailing one", async () => {
    await expectAgreement(committed("sub\rject\r\n\r\nbody\r\n"));
  });

  it("commits a message of only a vertical tab, which git does not count as whitespace", async () => {
    await expectAgreement(committed("\v\n \n"));
  });

  it("strips `#` lines when a conflicted cherry-pick continues", async () => {
    await expectAgreement({
      start: "init",
      ops: [
        ...conflicting("subject\n#hash line\n #kept\n\n#gone\n\nbody\n#tail\n"),
        { op: "cherryPick", source: "side" },
        ...RESOLVE,
        { op: "cherryPickContinue" },
      ],
    });
  });

  it("concludes a conflicted revert like git", async () => {
    await expectAgreement({
      start: "init",
      ops: [
        ...BASE,
        { op: "write", path: "README.md", content: { text: "a\n" } },
        { op: "add", paths: ["README.md"] },
        { op: "commit", message: "#subject  \n\nbody\n" },
        { op: "write", path: "README.md", content: { text: "b\n" } },
        { op: "add", paths: ["README.md"] },
        { op: "commit", message: "later" },
        { op: "revert", source: "main~1" },
        ...RESOLVE,
        { op: "revertContinue" },
      ],
    });
  });

  it("cleans an amended message", async () => {
    await expectAgreement({
      start: "init",
      ops: [...BASE, { op: "commit", message: "amended  \n\n\nbody \n", amend: true }],
    });
  });

  it("cleans a commit -a message", async () => {
    await expectAgreement({
      start: "init",
      ops: [
        ...BASE,
        { op: "write", path: "README.md", content: { text: "y\n" } },
        { op: "commit", message: "all \t\n\n\n", all: true },
      ],
    });
  });

  it("cleans a merge message", async () => {
    await expectAgreement({
      start: "init",
      ops: [
        ...BASE,
        { op: "checkoutNew", name: "side" },
        { op: "write", path: "side.txt", content: { text: "side\n" } },
        { op: "add", paths: ["side.txt"] },
        { op: "commit", message: "side" },
        { op: "checkout", ref: "main" },
        { op: "merge", theirs: "side", message: "merge  \n\n\nbody \n", mode: "no-ff" },
      ],
    });
  });

  it("cleans the message that concludes a conflicted merge", async () => {
    await expectAgreement({
      start: "init",
      ops: [
        ...BASE,
        { op: "checkoutNew", name: "side" },
        { op: "write", path: "README.md", content: { text: "side\n" } },
        { op: "add", paths: ["README.md"] },
        { op: "commit", message: "side" },
        { op: "checkout", ref: "main" },
        { op: "write", path: "README.md", content: { text: "main\n" } },
        { op: "add", paths: ["README.md"] },
        { op: "commit", message: "main" },
        { op: "merge", theirs: "side", message: "merge" },
        { op: "write", path: "README.md", content: { text: "resolved\n" } },
        { op: "add", paths: ["README.md"] },
        { op: "mergeContinue", message: "\nresolved  \n\n\n" },
      ],
    });
  });

  it("cleans a pull's merge message", async () => {
    await expectAgreement({
      start: "clone",
      ops: [
        {
          op: "peerCommit",
          branch: "main",
          path: "peer.txt",
          content: { text: "peer\n" },
          message: "peer",
        },
        { op: "pull", message: "pull  \n\n\nbody \n", mode: "no-ff" },
      ],
    });
  });
});
