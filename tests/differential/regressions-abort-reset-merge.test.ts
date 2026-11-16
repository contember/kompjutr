import { describe, it } from "vitest";
import type { Op, Scenario } from "../helpers/differential/ops.js";
import { expectAgreement } from "../helpers/differential/run.js";

// Merge abort and cherry-pick or revert skip and abort are Git's
// `reset --merge` to HEAD over every path, not only the paths the operation
// touched. `cherryPick main` on main stops as an empty pick.
const emptyPick: Op = { op: "cherryPick", source: "main" };
const text = (value: string) => ({ text: value });

/** A local `side` branch that adds `dir/y.txt` and, optionally, `dir/z.txt`. */
function sideBranch(extra: boolean): Op[] {
  return [
    { op: "checkoutNew", name: "side" },
    { op: "write", path: "dir/y.txt", content: text("feature\n") },
    ...(extra ? [{ op: "write", path: "dir/z.txt", content: text("z\n") } satisfies Op] : []),
    { op: "addAll" },
    { op: "commit", message: "side" },
    { op: "checkout", ref: "main" },
  ];
}

/** `dir/y.txt` is added on both sides, so merging `side` conflicts. */
function conflictingMerge(extra = false): Op[] {
  return [
    ...sideBranch(extra),
    { op: "write", path: "dir/y.txt", content: text("mine\n") },
    { op: "add", paths: ["dir/y.txt"] },
    { op: "commit", message: "mine" },
    { op: "merge", theirs: "side", message: "merge side" },
  ];
}

/** Rebase abort is `reset --hard` to the original head instead. */
const conflictingRebase: Op[] = [
  { op: "write", path: "dir/y.txt", content: text("mine\n") },
  { op: "add", paths: ["dir/y.txt"] },
  { op: "commit", message: "mine" },
  { op: "rebase", upstream: "origin/feature" },
];

function clone(ops: Op[]): Scenario {
  return { start: "clone", ops };
}

describe("differential: abort and skip reset the index like reset --merge", () => {
  it("restores a deletion staged during an empty cherry-pick", async () => {
    await expectAgreement(
      clone([
        { op: "branch", name: "feature" },
        { op: "remove", path: "dir/x.txt" },
        { op: "cherryPick", source: "feature" },
        { op: "addAll" },
        { op: "cherryPickAbort" },
      ]),
    );
  });

  it("drops a staged edit on skip", async () => {
    await expectAgreement(
      clone([
        emptyPick,
        { op: "write", path: "README.md", content: text("x\n") },
        { op: "add", paths: ["."] },
        { op: "cherryPickSkip" },
      ]),
    );
  });

  it("removes a staged new file on skip", async () => {
    await expectAgreement(
      clone([
        emptyPick,
        { op: "write", path: "dir/sub/z.txt", content: text("x\n") },
        { op: "add", paths: ["."] },
        { op: "cherryPickSkip" },
      ]),
    );
  });

  it("drops an edit made before the pick and staged during it", async () => {
    await expectAgreement(
      clone([
        { op: "write", path: "dir/x.txt", content: text("x\n") },
        { op: "cherryPick", source: "main~1" },
        { op: "addAll" },
        { op: "cherryPickSkip" },
      ]),
    );
  });

  it("keeps an unstaged edit on abort", async () => {
    await expectAgreement(
      clone([
        emptyPick,
        { op: "write", path: "README.md", content: text("x\n") },
        { op: "cherryPickAbort" },
      ]),
    );
  });

  it("keeps a file deleted only in the worktree", async () => {
    await expectAgreement(
      clone([emptyPick, { op: "remove", path: "README.md" }, { op: "cherryPickAbort" }]),
    );
  });

  it("restores a staged edit whose file was then deleted", async () => {
    await expectAgreement(
      clone([
        emptyPick,
        { op: "write", path: "README.md", content: text("x\n") },
        { op: "add", paths: ["README.md"] },
        { op: "remove", path: "README.md" },
        { op: "cherryPickAbort" },
      ]),
    );
  });

  it("refuses over a staged edit changed again in the worktree", async () => {
    await expectAgreement(
      clone([
        emptyPick,
        { op: "write", path: "README.md", content: text("x\n") },
        { op: "add", paths: ["README.md"] },
        { op: "write", path: "README.md", content: text("y\n") },
        { op: "cherryPickAbort" },
      ]),
    );
  });

  it("refuses over a staged new file changed again in the worktree", async () => {
    await expectAgreement(
      clone([
        emptyPick,
        { op: "write", path: "new.txt", content: text("x\n") },
        { op: "add", paths: ["new.txt"] },
        { op: "write", path: "new.txt", content: text("y\n") },
        { op: "cherryPickSkip" },
      ]),
    );
  });

  it("refuses over an edit made before the pick, staged, then changed again", async () => {
    await expectAgreement(
      clone([
        { op: "write", path: "README.md", content: text("x\n") },
        emptyPick,
        { op: "add", paths: ["."] },
        { op: "write", path: "README.md", content: text("zeta\n") },
        { op: "cherryPickAbort" },
      ]),
    );
  });

  it("refuses over a new file staged during a repeated pick, then changed again", async () => {
    await expectAgreement(
      clone([
        { op: "cherryPick", source: "origin/feature" },
        { op: "write", path: "a/b", content: text("x\n") },
        { op: "cherryPick", source: "origin/feature" },
        { op: "add", paths: ["."] },
        { op: "write", path: "a/b", content: text("gamma\n") },
        { op: "cherryPickAbort" },
      ]),
    );
  });

  it("refuses over a file untracked by rm --cached", async () => {
    await expectAgreement(
      clone([
        emptyPick,
        { op: "rm", paths: ["README.md"], cached: true },
        { op: "cherryPickAbort" },
      ]),
    );
  });

  it("drops a staged edit on merge abort", async () => {
    await expectAgreement(
      clone([
        ...conflictingMerge(),
        { op: "write", path: "README.md", content: text("x\n") },
        { op: "add", paths: ["README.md"] },
        { op: "mergeAbort" },
      ]),
    );
  });

  it("keeps an edit to a conflicted path staged back to HEAD's entry", async () => {
    await expectAgreement(
      clone([
        ...conflictingMerge(),
        { op: "write", path: "dir/y.txt", content: text("mine\n") },
        { op: "add", paths: ["dir/y.txt"] },
        { op: "write", path: "dir/y.txt", content: text("edited\n") },
        { op: "mergeAbort" },
      ]),
    );
  });

  it("keeps a file the merge added once rm --cached untracks it", async () => {
    await expectAgreement(
      clone([
        ...conflictingMerge(true),
        { op: "rm", paths: ["dir/z.txt"], cached: true },
        { op: "mergeAbort" },
      ]),
    );
  });

  it("removes a staged new file on revert skip", async () => {
    await expectAgreement(
      clone([
        { op: "write", path: "README.md", content: text("later\n") },
        { op: "commit", message: "later", all: true },
        { op: "revert", source: "main~1" },
        { op: "write", path: "new.txt", content: text("x\n") },
        { op: "add", paths: ["new.txt"] },
        { op: "revertSkip" },
      ]),
    );
  });

  it("discards staged and unstaged edits on rebase abort", async () => {
    await expectAgreement(
      clone([
        ...conflictingRebase,
        { op: "write", path: "README.md", content: text("x\n") },
        { op: "add", paths: ["README.md"] },
        { op: "write", path: "README.md", content: text("y\n") },
        { op: "rebaseAbort" },
      ]),
    );
  });

  it("aborts a rebase stopped at a modify/delete conflict", async () => {
    await expectAgreement(
      clone([
        { op: "checkoutNew", name: "up" },
        { op: "rm", paths: ["README.md"] },
        { op: "commit", message: "drop readme" },
        { op: "checkout", ref: "main" },
        { op: "write", path: "README.md", content: text("edited\n") },
        { op: "commit", message: "edit readme", all: true },
        { op: "rebase", upstream: "up" },
        { op: "rebaseAbort" },
      ]),
    );
  });

  it("refuses rebase abort over a file untracked by rm --cached", async () => {
    await expectAgreement(
      clone([
        ...conflictingRebase,
        { op: "rm", paths: ["README.md"], cached: true },
        { op: "rebaseAbort" },
      ]),
    );
  });
});
