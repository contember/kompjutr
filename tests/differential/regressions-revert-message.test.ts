import { describe, it } from "vitest";
import type { Op, Scenario } from "../helpers/differential/ops.js";
import { expectAgreement } from "../helpers/differential/run.js";

/** Commits one change titled `message`, then reverts HEAD. */
function revertTitled(message: string): Scenario {
  const ops: Op[] = [
    { op: "write", path: "a.txt", content: { text: "a\n" } },
    { op: "add", paths: ["a.txt"] },
    { op: "commit", message: "base" },
    { op: "write", path: "a.txt", content: { text: "b\n" } },
    { op: "commit", message, all: true },
    { op: "revert", source: "HEAD" },
  ];
  return { start: "init", ops };
}

describe("differential regressions: revert message", () => {
  it("reapplies a reverted commit", async () => {
    await expectAgreement({
      start: "clone",
      ops: [
        { op: "revert", source: "origin/main" },
        { op: "revert", source: "main" },
      ],
    });
  });

  for (const title of ['Revert "x"', 'Revert "unclosed', 'Revert ""', 'Revert "Revert "x""']) {
    it(`reverts a commit titled ${title}`, async () => {
      await expectAgreement(revertTitled(title));
    });
  }

  it("reverts a commit titled Reapply", async () => {
    await expectAgreement(revertTitled('Reapply "x"'));
  });
});
