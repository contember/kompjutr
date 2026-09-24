// Abandoning a stopped merge, cherry-pick or revert over edits made after it
// stopped. Git's `reset --merge` refuses when the restore would overwrite an
// unstaged edit or an untracked file, and otherwise resets. The harness compares
// the whole repository state — worktree bytes included — with real git after
// every step, so a refusal on one side and a restore on the other cannot pass.

import { afterEach, describe, it } from "vitest";

import { createWorld, type E2EStep, type E2EWorld } from "../helpers/e2e.js";

let world: E2EWorld | undefined;

afterEach(async () => {
  await world?.dispose();
  world = undefined;
});

const SEED = { "s.txt": "base\n", "c.txt": "c\n", "d.txt": "d\n" };

/** `topic` conflicts on s.txt, changes c.txt, deletes d.txt and adds n.txt; `main` changes s.txt. */
const DIVERGED: E2EStep[] = [
  { op: "branch", name: "topic", checkout: true },
  { op: "write", path: "s.txt", content: "topic\n" },
  { op: "write", path: "c.txt", content: "c topic\n" },
  { op: "write", path: "n.txt", content: "n\n" },
  { op: "rm", paths: ["d.txt"] },
  { op: "add", paths: ["s.txt", "c.txt", "n.txt"] },
  { op: "commit", message: "topic" },
  { op: "checkout", ref: "main" },
  { op: "write", path: "s.txt", content: "main\n" },
  { op: "add", paths: ["s.txt"] },
  { op: "commit", message: "main" },
];

const REFUSED = { outcome: "failed", code: "ECHECKOUTFAIL" } as const;

interface EditCase {
  name: string;
  edits: E2EStep[];
  refused: boolean;
}

const EDITS: readonly EditCase[] = [
  {
    name: "an unstaged edit to a cleanly merged path",
    edits: [{ op: "write", path: "c.txt", content: "edit\n" }],
    refused: true,
  },
  {
    name: "an unstaged edit to a path the operation added",
    edits: [{ op: "write", path: "n.txt", content: "edit\n" }],
    refused: true,
  },
  {
    name: "a staged edit changed again in the worktree",
    edits: [
      { op: "write", path: "c.txt", content: "staged\n" },
      { op: "add", paths: ["c.txt"] },
      { op: "write", path: "c.txt", content: "edit\n" },
    ],
    refused: true,
  },
  {
    name: "an untracked file where the operation deleted one",
    edits: [{ op: "write", path: "d.txt", content: "back\n" }],
    refused: true,
  },
  {
    name: "a staged edit that matches the worktree",
    edits: [
      { op: "write", path: "c.txt", content: "staged\n" },
      { op: "add", paths: ["c.txt"] },
    ],
    refused: false,
  },
  {
    name: "a removed cleanly merged path",
    edits: [{ op: "remove", path: "c.txt" }],
    refused: false,
  },
  {
    name: "an unstaged edit to the conflicted path",
    edits: [{ op: "write", path: "s.txt", content: "resolved\n" }],
    refused: false,
  },
];

const OPERATIONS = [
  {
    name: "merge --abort",
    start: { op: "merge", theirs: "topic", message: "merge topic" },
    stop: { op: "mergeAbort" },
  },
  {
    name: "cherry-pick --abort",
    start: { op: "cherryPick", source: "topic" },
    stop: { op: "cherryPickAbort" },
  },
  {
    name: "cherry-pick --skip",
    start: { op: "cherryPick", source: "topic" },
    stop: { op: "cherryPickSkip" },
  },
] as const satisfies readonly { name: string; start: E2EStep; stop: E2EStep }[];

describe("abort over edits made after the stop", () => {
  for (const operation of OPERATIONS) {
    for (const edit of EDITS) {
      it(`${operation.name} with ${edit.name}`, async () => {
        world = await createWorld({ seed: SEED });
        await world.run(
          ...DIVERGED,
          { ...operation.start, expect: { outcome: "conflicted" } },
          ...edit.edits,
          edit.refused ? { ...operation.stop, expect: REFUSED } : operation.stop,
        );
      });
    }
  }

  it.each([
    ["revert --abort", { op: "revertAbort" }],
    ["revert --skip", { op: "revertSkip" }],
  ] as const)("%s refuses over an unstaged edit to a cleanly reverted path", async (_, stop) => {
    world = await createWorld({ seed: SEED });
    await world.run(
      { op: "write", path: "s.txt", content: "x\n" },
      { op: "write", path: "c.txt", content: "c2\n" },
      { op: "add", paths: ["s.txt", "c.txt"] },
      { op: "commit", message: "x" },
      { op: "branch", name: "reverted" },
      { op: "write", path: "s.txt", content: "y\n" },
      { op: "add", paths: ["s.txt"] },
      { op: "commit", message: "y" },
      { op: "revert", source: "reverted", expect: { outcome: "conflicted" } },
      { op: "write", path: "c.txt", content: "edit\n" },
      { ...stop, expect: REFUSED },
      { op: "write", path: "c.txt", content: "c\n" },
      stop,
    );
  });
});
