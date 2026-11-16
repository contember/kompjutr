// Git labels the incoming side of a merge with the revision exactly as the
// user spelled it, in conflict markers and in `path~label` relocations.

import { describe, it } from "vitest";
import type { Op, Scenario } from "../helpers/differential/ops.js";
import { expectAgreement } from "../helpers/differential/run.js";

// The seeded origin's `feature` tip; fixture dates make it deterministic.
const FEATURE_OID = "4c12e50fb43cf6a98478190d2231b649eb6ffe58";

const ADD_ADD: Op[] = [
  { op: "write", path: "dir/y.txt", content: { text: "beta\n" } },
  { op: "addAll" },
  { op: "commit", message: "m" },
];

function conflictWith(theirs: string, setup: Op[] = []): Scenario {
  return {
    start: "clone",
    ops: [...setup, ...ADD_ADD, { op: "merge", theirs, message: "m" }],
  };
}

describe("differential regressions: merge labels", () => {
  it("labels a remote-tracking branch as given", async () => {
    await expectAgreement(conflictWith("origin/feature"));
  });

  it("labels a fully spelled ref as given", async () => {
    await expectAgreement(conflictWith("refs/remotes/origin/feature"));
  });

  it("labels a local branch", async () => {
    await expectAgreement(
      conflictWith("feature", [{ op: "branch", name: "feature", startPoint: FEATURE_OID }]),
    );
  });

  it("labels a tag as given", async () => {
    await expectAgreement(
      conflictWith("v1", [{ op: "tag", name: "v1", object: "origin/feature" }]),
    );
  });

  it("labels revision expressions as given", async () => {
    await expectAgreement(conflictWith("origin/feature~0"));
    await expectAgreement(conflictWith("origin/feature^0"));
  });

  it("labels a full and an abbreviated object id as given", async () => {
    await expectAgreement(conflictWith(FEATURE_OID));
    await expectAgreement(conflictWith(FEATURE_OID.slice(0, 7)));
  });

  it("names a file/directory relocation after the label as given", async () => {
    await expectAgreement({
      start: "clone",
      ops: [
        { op: "write", path: "dir/y.txt/z", content: { text: "dir\n" } },
        { op: "addAll" },
        { op: "commit", message: "m" },
        { op: "merge", theirs: "origin/feature", message: "m" },
      ],
    });
  });

  it("labels a conflicted pull with the fetched commit", async () => {
    await expectAgreement({
      start: "clone",
      ops: [
        { op: "write", path: "README.md", content: { text: "ours\n" } },
        { op: "addAll" },
        { op: "commit", message: "m" },
        {
          op: "peerCommit",
          branch: "main",
          path: "README.md",
          content: { text: "theirs\n" },
          message: "p",
        },
        { op: "pull", message: "m" },
      ],
    });
  });
});
