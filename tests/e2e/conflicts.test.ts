// The conflict matrix, played end to end. Every shape a three-way merge can
// produce is reached against both implementations, then carried to a finished
// commit — or abandoned — through every resolution route the surface offers.
//
// Nothing here spells out what a conflict looks like: the harness compares the
// index stages, the porcelain v2 `u` rows and the worktree bytes against real
// git after every step, so the marker text is git's own answer, not ours.

import { afterEach, describe, it } from "vitest";

import { createWorld, type E2EWorld } from "../helpers/e2e.js";

let world: E2EWorld | undefined;

afterEach(async () => {
  await world?.dispose();
  world = undefined;
});

/** A file long enough that two edits can land outside each other's context. */
const PARAGRAPH = "alpha\nbravo\ncharlie\ndelta\necho\nfoxtrot\ngolf\nhotel\nindia\n";

/** Two PNG-shaped blobs: a NUL in the first bytes is what makes git call it binary. */
const OURS_BINARY = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x00, 0x01, 0x02, 0x03, 0xff]);
const THEIRS_BINARY = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x00, 0x0a, 0x0b, 0x0c, 0xfe]);
const MERGED_BINARY = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x00, 0xaa, 0xbb, 0xcc, 0x01]);

describe("merge conflicts", () => {
  it("conflicts on overlapping lines and takes a fresh resolution", async () => {
    world = await createWorld({ seed: { "story.txt": "one\ntwo\nthree\n" } });
    await world.run(
      { op: "branch", name: "feature", checkout: true },
      { op: "write", path: "story.txt", content: "one\nfeature\nthree\n" },
      { op: "add", paths: ["story.txt"] },
      { op: "commit", message: "feature edit" },
      { op: "checkout", ref: "main" },
      { op: "write", path: "story.txt", content: "one\nmain\nthree\n" },
      { op: "add", paths: ["story.txt"] },
      { op: "commit", message: "main edit" },
      {
        op: "merge",
        theirs: "feature",
        message: "merge feature",
        expect: { outcome: "conflicted" },
      },
      { op: "write", path: "story.txt", content: "one\nboth\nthree\n" },
      { op: "add", paths: ["story.txt"] },
      { op: "mergeContinue", message: "merge feature" },
    );
  });

  it("merges two edits to different regions of one file cleanly", async () => {
    world = await createWorld({ seed: { "story.txt": PARAGRAPH } });
    await world.run(
      { op: "branch", name: "feature", checkout: true },
      { op: "write", path: "story.txt", content: PARAGRAPH.replace("india", "INDIA") },
      { op: "add", paths: ["story.txt"] },
      { op: "commit", message: "feature edits the tail" },
      { op: "checkout", ref: "main" },
      { op: "write", path: "story.txt", content: PARAGRAPH.replace("alpha", "ALPHA") },
      { op: "add", paths: ["story.txt"] },
      { op: "commit", message: "main edits the head" },
      { op: "merge", theirs: "feature", message: "merge feature" },
    );
  });

  it("conflicts on add/add and resolves by taking ours", async () => {
    world = await createWorld();
    await world.run(
      { op: "branch", name: "feature", checkout: true },
      { op: "write", path: "notes.md", content: "feature notes\n" },
      { op: "write", path: "feature-only.txt", content: "only on the branch\n" },
      { op: "add", paths: ["notes.md", "feature-only.txt"] },
      { op: "commit", message: "feature notes" },
      { op: "checkout", ref: "main" },
      { op: "write", path: "notes.md", content: "main notes\n" },
      { op: "add", paths: ["notes.md"] },
      { op: "commit", message: "main notes" },
      {
        op: "merge",
        theirs: "feature",
        message: "merge feature",
        expect: { outcome: "conflicted" },
      },
      // No `checkout --ours` on the surface, so ours is re-written verbatim.
      { op: "write", path: "notes.md", content: "main notes\n" },
      { op: "add", paths: ["notes.md"] },
      { op: "mergeContinue", message: "merge feature" },
    );
  });

  it("conflicts on modify/delete and resolves by removing the path", async () => {
    world = await createWorld({ seed: { "doomed.txt": "keep me\n", "other.txt": "stable\n" } });
    await world.run(
      { op: "branch", name: "feature", checkout: true },
      { op: "rm", paths: ["doomed.txt"] },
      { op: "commit", message: "feature drops the file" },
      { op: "checkout", ref: "main" },
      { op: "write", path: "doomed.txt", content: "keep me, edited\n" },
      { op: "add", paths: ["doomed.txt"] },
      { op: "commit", message: "main edits the file" },
      {
        op: "merge",
        theirs: "feature",
        message: "merge feature",
        expect: { outcome: "conflicted" },
      },
      { op: "rm", paths: ["doomed.txt"], force: true },
      { op: "mergeContinue", message: "merge feature" },
    );
  });

  it("conflicts on delete/modify and resolves by taking theirs", async () => {
    world = await createWorld({ seed: { "doomed.txt": "keep me\n", "other.txt": "stable\n" } });
    await world.run(
      { op: "branch", name: "feature", checkout: true },
      { op: "write", path: "doomed.txt", content: "keep me, edited\n" },
      { op: "add", paths: ["doomed.txt"] },
      { op: "commit", message: "feature edits the file" },
      { op: "checkout", ref: "main" },
      { op: "rm", paths: ["doomed.txt"] },
      { op: "commit", message: "main drops the file" },
      {
        op: "merge",
        theirs: "feature",
        message: "merge feature",
        expect: { outcome: "conflicted" },
      },
      // Taking theirs is the incoming blob restaged where the merge left it.
      { op: "add", paths: ["doomed.txt"] },
      { op: "mergeContinue", message: "merge feature" },
    );
  });

  it("conflicts on file versus directory at the same path", async () => {
    world = await createWorld();
    await world.run(
      { op: "branch", name: "feature", checkout: true },
      { op: "write", path: "thing/inner.txt", content: "inside\n" },
      { op: "add", paths: ["thing/inner.txt"] },
      { op: "commit", message: "feature makes thing a directory" },
      { op: "checkout", ref: "main" },
      { op: "write", path: "thing", content: "a plain file\n" },
      { op: "add", paths: ["thing"] },
      { op: "commit", message: "main makes thing a file" },
      {
        op: "merge",
        theirs: "feature",
        message: "merge feature",
        expect: { outcome: "conflicted" },
      },
      // Keep the directory; the file side lives at the relocated path.
      { op: "rm", paths: ["thing~HEAD"], force: true },
      { op: "mergeContinue", message: "merge feature" },
    );
  });

  it("conflicts on the executable bit alone", async () => {
    world = await createWorld();
    await world.run(
      { op: "branch", name: "feature", checkout: true },
      { op: "write", path: "run.sh", content: "echo hi\n", mode: 0o755 },
      { op: "add", paths: ["run.sh"] },
      { op: "commit", message: "feature adds it executable" },
      { op: "checkout", ref: "main" },
      { op: "write", path: "run.sh", content: "echo hi\n" },
      { op: "add", paths: ["run.sh"] },
      { op: "commit", message: "main adds it plain" },
      // Identical bytes, different modes: the only thing left to disagree on.
      {
        op: "merge",
        theirs: "feature",
        message: "merge feature",
        expect: { outcome: "conflicted" },
      },
      { op: "chmod", path: "run.sh", mode: 0o755 },
      { op: "add", paths: ["run.sh"] },
      { op: "mergeContinue", message: "merge feature" },
    );
  });

  it("conflicts on a symlink versus a regular file at the same path", async () => {
    world = await createWorld({ seed: { "target.txt": "pointed at\n" } });
    await world.run(
      { op: "branch", name: "feature", checkout: true },
      { op: "symlink", path: "lnk", target: "target.txt" },
      { op: "add", paths: ["lnk"] },
      { op: "commit", message: "feature adds a symlink" },
      { op: "checkout", ref: "main" },
      { op: "write", path: "lnk", content: "not a link\n" },
      { op: "add", paths: ["lnk"] },
      { op: "commit", message: "main adds a file" },
      {
        op: "merge",
        theirs: "feature",
        message: "merge feature",
        expect: { outcome: "conflicted" },
      },
      // Keep the regular file; replace the symlink before staging the resolution.
      { op: "rm", paths: ["lnk"], force: true },
      { op: "write", path: "lnk", content: "not a link\n" },
      { op: "add", paths: ["lnk"] },
      { op: "rm", paths: ["lnk~HEAD"], force: true },
      { op: "mergeContinue", message: "merge feature" },
    );
  });

  it("conflicts on binary versus binary", async () => {
    world = await createWorld();
    await world.run(
      { op: "writeBytes", path: "logo.png", bytes: OURS_BINARY },
      { op: "add", paths: ["logo.png"] },
      { op: "commit", message: "add the logo" },
      { op: "branch", name: "feature", checkout: true },
      { op: "writeBytes", path: "logo.png", bytes: THEIRS_BINARY },
      { op: "add", paths: ["logo.png"] },
      { op: "commit", message: "feature redraws it" },
      { op: "checkout", ref: "main" },
      { op: "writeBytes", path: "logo.png", bytes: MERGED_BINARY },
      { op: "add", paths: ["logo.png"] },
      { op: "commit", message: "main redraws it" },
      {
        op: "merge",
        theirs: "feature",
        message: "merge feature",
        expect: { outcome: "conflicted" },
      },
      { op: "writeBytes", path: "logo.png", bytes: OURS_BINARY },
      { op: "add", paths: ["logo.png"] },
      { op: "mergeContinue", message: "merge feature" },
    );
  });

  it("conflicts inside a nested directory", async () => {
    world = await createWorld({ seed: { "src/app/config.json": '{"mode":"base"}\n' } });
    await world.run(
      { op: "branch", name: "feature", checkout: true },
      { op: "write", path: "src/app/config.json", content: '{"mode":"feature"}\n' },
      { op: "add", paths: ["src/app/config.json"] },
      { op: "commit", message: "feature config" },
      { op: "checkout", ref: "main" },
      { op: "write", path: "src/app/config.json", content: '{"mode":"main"}\n' },
      { op: "add", paths: ["src/app/config.json"] },
      { op: "commit", message: "main config" },
      {
        op: "merge",
        theirs: "feature",
        message: "merge feature",
        expect: { outcome: "conflicted" },
      },
      { op: "write", path: "src/app/config.json", content: '{"mode":"merged"}\n' },
      { op: "add", paths: ["src/app/config.json"] },
      { op: "mergeContinue", message: "merge feature" },
    );
  });

  it("conflicts on two files in one merge and resolves them differently", async () => {
    world = await createWorld({ seed: { "a.txt": "a base\n", "b.txt": "b base\n" } });
    await world.run(
      { op: "branch", name: "feature", checkout: true },
      { op: "write", path: "a.txt", content: "a feature\n" },
      { op: "write", path: "b.txt", content: "b feature\n" },
      { op: "add", paths: ["a.txt", "b.txt"] },
      { op: "commit", message: "feature touches both" },
      { op: "checkout", ref: "main" },
      { op: "write", path: "a.txt", content: "a main\n" },
      { op: "write", path: "b.txt", content: "b main\n" },
      { op: "add", paths: ["a.txt", "b.txt"] },
      { op: "commit", message: "main touches both" },
      {
        op: "merge",
        theirs: "feature",
        message: "merge feature",
        expect: { outcome: "conflicted" },
      },
      { op: "write", path: "a.txt", content: "a main\n" },
      { op: "write", path: "b.txt", content: "b feature\n" },
      { op: "add", paths: ["a.txt", "b.txt"] },
      { op: "mergeContinue", message: "merge feature" },
    );
  });

  it("abandons a conflicted merge with mergeAbort", async () => {
    world = await createWorld({ seed: { "story.txt": "one\ntwo\nthree\n" } });
    await world.run(
      { op: "branch", name: "feature", checkout: true },
      { op: "write", path: "story.txt", content: "one\nfeature\nthree\n" },
      { op: "add", paths: ["story.txt"] },
      { op: "commit", message: "feature edit" },
      { op: "checkout", ref: "main" },
      { op: "write", path: "story.txt", content: "one\nmain\nthree\n" },
      { op: "add", paths: ["story.txt"] },
      { op: "commit", message: "main edit" },
      {
        op: "merge",
        theirs: "feature",
        message: "merge feature",
        expect: { outcome: "conflicted" },
      },
      { op: "mergeAbort" },
    );
  });
});

describe("clean merges", () => {
  it("fast-forwards onto the branch tip", async () => {
    world = await createWorld();
    await world.run(
      { op: "branch", name: "feature", checkout: true },
      { op: "write", path: "ahead.txt", content: "ahead\n" },
      { op: "add", paths: ["ahead.txt"] },
      { op: "commit", message: "feature moves ahead" },
      { op: "checkout", ref: "main" },
      { op: "merge", theirs: "feature", message: "merge feature" },
    );
  });

  it("records a merge commit when fast-forward is refused", async () => {
    world = await createWorld();
    await world.run(
      { op: "branch", name: "feature", checkout: true },
      { op: "write", path: "ahead.txt", content: "ahead\n" },
      { op: "add", paths: ["ahead.txt"] },
      { op: "commit", message: "feature moves ahead" },
      { op: "checkout", ref: "main" },
      { op: "merge", theirs: "feature", message: "merge feature", fastForward: false },
    );
  });

  it("accepts a fast-forward-only merge that is one", async () => {
    world = await createWorld();
    await world.run(
      { op: "branch", name: "feature", checkout: true },
      { op: "write", path: "ahead.txt", content: "ahead\n" },
      { op: "add", paths: ["ahead.txt"] },
      { op: "commit", message: "feature moves ahead" },
      { op: "checkout", ref: "main" },
      { op: "merge", theirs: "feature", message: "merge feature", fastForwardOnly: true },
    );
  });

  it("does nothing when the branch is already merged", async () => {
    world = await createWorld();
    await world.run(
      { op: "write", path: "ahead.txt", content: "ahead\n" },
      { op: "add", paths: ["ahead.txt"] },
      { op: "commit", message: "main moves ahead" },
      { op: "branch", name: "behind", startPoint: "HEAD~1" },
      { op: "merge", theirs: "behind", message: "merge behind" },
    );
  });
});

describe("cherry-pick conflicts", () => {
  it("conflicts on content, resolves, and continues", async () => {
    world = await createWorld({ seed: { "recipe.txt": "salt\n" } });
    await world.run(
      { op: "branch", name: "feature", checkout: true },
      { op: "write", path: "recipe.txt", content: "sugar\n" },
      { op: "add", paths: ["recipe.txt"] },
      { op: "commit", message: "sweeten" },
      { op: "checkout", ref: "main" },
      { op: "write", path: "recipe.txt", content: "pepper\n" },
      { op: "add", paths: ["recipe.txt"] },
      { op: "commit", message: "spice" },
      { op: "cherryPick", source: "feature", expect: { outcome: "conflicted" } },
      { op: "write", path: "recipe.txt", content: "sugar and pepper\n" },
      { op: "add", paths: ["recipe.txt"] },
      { op: "cherryPickContinue" },
    );
  });

  it("conflicts on content and abandons the pick", async () => {
    world = await createWorld({ seed: { "recipe.txt": "salt\n" } });
    await world.run(
      { op: "branch", name: "feature", checkout: true },
      { op: "write", path: "recipe.txt", content: "sugar\n" },
      { op: "add", paths: ["recipe.txt"] },
      { op: "commit", message: "sweeten" },
      { op: "checkout", ref: "main" },
      { op: "write", path: "recipe.txt", content: "pepper\n" },
      { op: "add", paths: ["recipe.txt"] },
      { op: "commit", message: "spice" },
      { op: "cherryPick", source: "feature", expect: { outcome: "conflicted" } },
      { op: "cherryPickAbort" },
    );
  });

  it("conflicts on modify/delete and continues after removing the path", async () => {
    world = await createWorld({ seed: { "recipe.txt": "salt\n" } });
    await world.run(
      { op: "branch", name: "feature", checkout: true },
      { op: "write", path: "recipe.txt", content: "sugar\n" },
      // A second, unrelated change so the pick still commits once the
      // conflicted path is dropped.
      { op: "write", path: "method.txt", content: "stir\n" },
      { op: "add", paths: ["recipe.txt", "method.txt"] },
      { op: "commit", message: "sweeten and describe" },
      { op: "checkout", ref: "main" },
      { op: "rm", paths: ["recipe.txt"] },
      { op: "commit", message: "drop the recipe" },
      { op: "cherryPick", source: "feature", expect: { outcome: "conflicted" } },
      { op: "rm", paths: ["recipe.txt"], force: true },
      { op: "cherryPickContinue" },
    );
  });
});

describe("revert conflicts", () => {
  it("conflicts on content, resolves, and continues", async () => {
    world = await createWorld({ seed: { "recipe.txt": "salt\n" } });
    await world.run(
      { op: "write", path: "recipe.txt", content: "sugar\n" },
      { op: "add", paths: ["recipe.txt"] },
      { op: "commit", message: "sweeten" },
      { op: "write", path: "recipe.txt", content: "pepper\n" },
      { op: "add", paths: ["recipe.txt"] },
      { op: "commit", message: "spice" },
      { op: "revert", source: "HEAD~1", expect: { outcome: "conflicted" } },
      { op: "write", path: "recipe.txt", content: "salt\n" },
      { op: "add", paths: ["recipe.txt"] },
      { op: "revertContinue" },
    );
  });

  it("conflicts on content and abandons the revert", async () => {
    world = await createWorld({ seed: { "recipe.txt": "salt\n" } });
    await world.run(
      { op: "write", path: "recipe.txt", content: "sugar\n" },
      { op: "add", paths: ["recipe.txt"] },
      { op: "commit", message: "sweeten" },
      { op: "write", path: "recipe.txt", content: "pepper\n" },
      { op: "add", paths: ["recipe.txt"] },
      { op: "commit", message: "spice" },
      { op: "revert", source: "HEAD~1", expect: { outcome: "conflicted" } },
      { op: "revertAbort" },
    );
  });

  it("conflicts on modify/delete and continues after restoring the path", async () => {
    world = await createWorld({ seed: { "recipe.txt": "salt\n" } });
    await world.run(
      { op: "write", path: "recipe.txt", content: "sugar\n" },
      { op: "add", paths: ["recipe.txt"] },
      { op: "commit", message: "sweeten" },
      { op: "rm", paths: ["recipe.txt"] },
      { op: "write", path: "method.txt", content: "stir\n" },
      { op: "add", paths: ["method.txt"] },
      { op: "commit", message: "drop the recipe" },
      // Reverting "sweeten" wants a file HEAD has already deleted.
      { op: "revert", source: "HEAD~1", expect: { outcome: "conflicted" } },
      { op: "write", path: "recipe.txt", content: "salt\n" },
      { op: "add", paths: ["recipe.txt"] },
      { op: "revertContinue" },
    );
  });
});
