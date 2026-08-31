// The single developer, alone with one repository and no remote. Every step
// is played against the real git binary too, so the journeys below describe
// work rather than assert Git behaviour — the harness demands Git agrees.

import { afterEach, describe, expect, it } from "vitest";

import { createWorld, type E2EWorld } from "../helpers/e2e.js";

let world: E2EWorld | undefined;

afterEach(async () => {
  await world?.dispose();
  world = undefined;
});

/** The tip as the reference implementation reports it, for later steps. */
async function tip(current: E2EWorld): Promise<string> {
  const { git } = await current.snapshot();
  if (git.head === null) throw new Error("HEAD is unborn");
  return git.head;
}

describe("solo workflow", () => {
  it("grows an unborn repository into its first commit", async () => {
    world = await createWorld({ start: "init" });

    // KNOWN DIVERGENCE: `init()` makes no directory (src/git/ops/init.ts), so
    // the repository root does not exist until something writes into it, while
    // git's worktree root always does. Pinned rather than worked around.
    await expect(world.compare("fresh init")).rejects.toThrow(/ENOENT/);

    await world.run(
      { op: "write", path: "README.md", content: "# solo\n" },
      { op: "write", path: "src/main.ts", content: "export const main = 1;\n" },
    );

    const unborn = await world.snapshot();
    expect(unborn.kompjutr.head).toBeNull();
    expect(unborn.kompjutr.currentBranch).toBe("refs/heads/main");
    expect(unborn.kompjutr.log).toEqual([]);

    await world.run(
      // Nothing staged: there is no root commit to make yet.
      {
        op: "commit",
        message: "nothing yet",
        expect: { outcome: "failed", code: "EEMPTYCOMMIT" },
      },
      { op: "add", all: true },
      { op: "commit", message: "root commit" },
    );

    const born = await world.snapshot();
    expect(born.kompjutr.head).not.toBeNull();
    expect(born.kompjutr.log).toHaveLength(1);
    expect(born.kompjutr.log[0]?.parents).toEqual([]);
    expect(born.kompjutr.status).toBe("");
  });

  it("repeats the edit, status, add, status, commit loop", async () => {
    world = await createWorld({ start: "init" });
    await world.run(
      { op: "write", path: "notes.md", content: "one\n" },
      { op: "add", paths: ["notes.md"] },
      { op: "commit", message: "start notes" },
    );

    for (const round of ["two", "three", "four"]) {
      await world.run({ op: "write", path: "notes.md", content: `${round}\n` });
      const edited = await world.snapshot();
      expect(edited.kompjutr.status).toContain("notes.md");

      await world.run({ op: "add", paths: ["notes.md"] });
      const staged = await world.snapshot();
      expect(staged.kompjutr.status).toContain("notes.md");

      await world.run({ op: "commit", message: `notes ${round}` });
      const committed = await world.snapshot();
      expect(committed.kompjutr.status).toBe("");
    }

    const final = await world.snapshot();
    expect(final.kompjutr.log).toHaveLength(4);
    expect(await world.read("notes.md")).toBe("four\n");
  });

  it("stages subsets by path, by all, and tracked-only", async () => {
    world = await createWorld({ start: "init" });
    await world.run(
      { op: "write", path: "a.txt", content: "a1\n" },
      { op: "write", path: "b.txt", content: "b1\n" },
      { op: "add", all: true },
      { op: "commit", message: "two tracked files" },

      { op: "write", path: "a.txt", content: "a2\n" },
      { op: "write", path: "b.txt", content: "b2\n" },
      { op: "write", path: "c.txt", content: "c1\n" },
      // An explicit pathspec takes one file and leaves the rest alone.
      { op: "add", paths: ["a.txt"] },
      { op: "add", paths: ["nowhere.txt"], expect: { outcome: "failed", code: "EPATHSPEC" } },
      { op: "commit", message: "only a" },

      // `add -u`: the `commit -a` shape, which never picks up c.txt.
      { op: "add", all: true, trackedOnly: true },
      { op: "commit", message: "tracked only" },
    );

    const beforeAll = await world.snapshot();
    expect(beforeAll.kompjutr.index).not.toContain("c.txt");

    await world.run({ op: "add", all: true }, { op: "commit", message: "everything" });

    const afterAll = await world.snapshot();
    expect(afterAll.kompjutr.index).toEqual(["a.txt", "b.txt", "c.txt"]);
  });

  it("amends the tip for its message and then for its content", async () => {
    world = await createWorld({ start: "init" });
    await world.run(
      { op: "write", path: "f.txt", content: "v1\n" },
      { op: "add", all: true },
      { op: "commit", message: "root" },
      { op: "write", path: "f.txt", content: "v2\n" },
      { op: "add", all: true },
      { op: "commit", message: "teh second" },
      // Nothing staged: the amend rewrites the message alone.
      { op: "commit", message: "the second", amend: true },
    );

    const messageOnly = await world.snapshot();
    expect(messageOnly.kompjutr.log).toHaveLength(2);
    expect(messageOnly.kompjutr.log[0]?.message).toBe("the second");

    await world.run(
      { op: "write", path: "f.txt", content: "v3\n" },
      { op: "add", all: true },
      { op: "commit", message: "the second, corrected", amend: true },
    );

    const withContent = await world.snapshot();
    expect(withContent.kompjutr.log).toHaveLength(2);
    expect(await world.read("f.txt")).toBe("v3\n");
  });

  it("refuses an unchanged commit unless it is allowed to be empty", async () => {
    world = await createWorld({ start: "init" });
    await world.run(
      { op: "write", path: "one.txt", content: "one\n" },
      { op: "add", all: true },
      { op: "commit", message: "root" },
      { op: "commit", message: "no changes", expect: { outcome: "failed", code: "EEMPTYCOMMIT" } },
      { op: "commit", message: "marker", allowEmpty: true },
    );

    const snapshot = await world.snapshot();
    expect(snapshot.kompjutr.log).toHaveLength(2);
    expect(snapshot.kompjutr.log[0]?.message).toBe("marker");
  });

  it("removes paths from the index, the tree, and a whole directory", async () => {
    world = await createWorld({ start: "init" });
    await world.run(
      { op: "write", path: "keep.txt", content: "keep\n" },
      { op: "write", path: "drop.txt", content: "drop\n" },
      { op: "write", path: "untrack.txt", content: "untrack\n" },
      { op: "write", path: "edited.txt", content: "edited\n" },
      { op: "write", path: "docs/one.md", content: "one\n" },
      { op: "write", path: "docs/two.md", content: "two\n" },
      { op: "add", all: true },
      { op: "commit", message: "root" },

      // Default: the index entry and the working-tree file both go.
      { op: "rm", paths: ["drop.txt"] },
    );

    // Cached: the index deletion and the file left behind are separate rows.
    await world.run({ op: "rm", paths: ["untrack.txt"], cached: true });

    const cached = await world.snapshot();
    expect(cached.kompjutr.index).not.toContain("untrack.txt");
    const cachedRows = cached.kompjutr.status
      .split("\n")
      .filter((row) => row.endsWith(" untrack.txt"));
    expect(cachedRows).toHaveLength(2);
    expect(cachedRows.some((row) => row.startsWith("1 D."))).toBe(true);
    expect(cachedRows).toContain("? untrack.txt");

    await world.run(
      // Clean up the file left behind by the cached removal.
      { op: "remove", path: "untrack.txt" },
      // A directory needs `recursive`, exactly as `git rm` does.
      { op: "rm", paths: ["docs"], expect: { outcome: "failed", code: "EISDIR" } },
      { op: "rm", paths: ["docs"], recursive: true },
    );

    const removed = await world.snapshot();
    expect(removed.kompjutr.index).toEqual(["edited.txt", "keep.txt"]);

    await world.run(
      { op: "write", path: "edited.txt", content: "changed\n" },
      // A modified file is unsafe to remove until `force` says so.
      { op: "rm", paths: ["edited.txt"], expect: { outcome: "failed", code: "EUNSAFEREMOVE" } },
      { op: "rm", paths: ["edited.txt"], force: true },
      { op: "add", all: true },
      { op: "commit", message: "prune the tree" },
    );

    const settled = await world.snapshot();
    expect(settled.kompjutr.index).toEqual(["keep.txt"]);
    expect(settled.kompjutr.status).toBe("");
  });

  it("resets the index, the working tree, and single paths", async () => {
    world = await createWorld({ start: "init" });
    await world.run(
      { op: "write", path: "x.txt", content: "x1\n" },
      { op: "write", path: "y.txt", content: "y1\n" },
      { op: "add", all: true },
      { op: "commit", message: "root" },
      { op: "write", path: "x.txt", content: "x2\n" },
      { op: "write", path: "y.txt", content: "y2\n" },
      { op: "add", all: true },
      // Mixed: the index goes back to HEAD, the edits stay on disk.
      { op: "reset" },
    );

    expect(await world.read("x.txt")).toBe("x2\n");

    await world.run(
      { op: "add", all: true },
      // Paths-only: y.txt is unstaged again, x.txt stays staged.
      { op: "reset", paths: ["y.txt"] },
      { op: "commit", message: "only x" },
    );

    const staged = await world.snapshot();
    expect(staged.kompjutr.status).toContain("y.txt");

    // Hard: the working tree is rewritten and the branch moves back.
    await world.run({ op: "reset", ref: "HEAD~1", hard: true });

    const rewound = await world.snapshot();
    expect(rewound.kompjutr.log).toHaveLength(1);
    expect(rewound.kompjutr.status).toBe("");
    expect(await world.read("x.txt")).toBe("x1\n");
  });

  it("restores a file from a commit with checkout paths", async () => {
    world = await createWorld({ start: "init" });
    await world.run(
      { op: "write", path: "doc.txt", content: "first\n" },
      { op: "write", path: "other.txt", content: "other\n" },
      { op: "add", all: true },
      { op: "commit", message: "first" },
      { op: "write", path: "doc.txt", content: "second\n" },
      { op: "add", all: true },
      { op: "commit", message: "second" },
      { op: "write", path: "doc.txt", content: "scratch\n" },
      // From HEAD: the scratch edit disappears, the branch stays put.
      { op: "checkout", ref: "HEAD", paths: ["doc.txt"] },
    );

    expect(await world.read("doc.txt")).toBe("second\n");

    // From an older commit: the old bytes land in the index and on disk.
    await world.run({ op: "checkout", ref: "HEAD~1", paths: ["doc.txt"] });

    const restored = await world.snapshot();
    expect(await world.read("doc.txt")).toBe("first\n");
    expect(restored.kompjutr.currentBranch).toBe("refs/heads/main");
    expect(restored.kompjutr.log).toHaveLength(2);
  });

  it("cleans untracked files, then untracked directories", async () => {
    world = await createWorld({ start: "init" });
    await world.run(
      { op: "write", path: "tracked.txt", content: "tracked\n" },
      { op: "add", all: true },
      { op: "commit", message: "root" },
      { op: "write", path: "junk.txt", content: "junk\n" },
      { op: "write", path: "scratch/note.txt", content: "note\n" },
      // A dry run reports and removes nothing.
      { op: "clean", dryRun: true },
    );

    const dry = await world.snapshot();
    expect(dry.kompjutr.worktree.map((entry) => entry.path)).toContain("junk.txt");

    // Without `directories`, git leaves an untracked directory alone.
    await world.run({ op: "clean" });

    const files = await world.snapshot();
    expect(files.kompjutr.worktree.map((entry) => entry.path)).toContain("scratch/note.txt");
    expect(files.kompjutr.worktree.map((entry) => entry.path)).not.toContain("junk.txt");

    await world.run({ op: "clean", directories: true });

    const swept = await world.snapshot();
    expect(swept.kompjutr.worktree.map((entry) => entry.path)).toEqual(["tracked.txt"]);
    expect(swept.kompjutr.status).toBe("");
  });

  it("creates, switches between and deletes branches", async () => {
    world = await createWorld({ start: "init" });
    await world.run(
      { op: "write", path: "base.txt", content: "base\n" },
      { op: "add", all: true },
      { op: "commit", message: "base" },
    );
    const base = await tip(world);

    await world.run(
      // Branching at HEAD, so `checkout: true` and `git checkout -b` agree.
      { op: "branch", name: "feature", checkout: true },
      { op: "write", path: "feature.txt", content: "feature\n" },
      { op: "write", path: "base.txt", content: "base, reworked\n" },
      { op: "add", all: true },
      { op: "commit", message: "feature work" },
      { op: "checkout", ref: "main" },
      { op: "write", path: "main.txt", content: "main\n" },
      { op: "add", all: true },
      { op: "commit", message: "main work" },

      // Branching elsewhere is create-then-checkout: kompjutr's
      // `checkout: true` repoints HEAD without moving the working tree.
      { op: "branch", name: "release", startPoint: base },
      { op: "checkout", ref: "release" },
    );

    const onRelease = await world.snapshot();
    expect(onRelease.kompjutr.currentBranch).toBe("refs/heads/release");
    expect(onRelease.kompjutr.worktree.map((entry) => entry.path)).toEqual(["base.txt"]);

    await world.run(
      // A local edit that the switch would overwrite blocks it until forced.
      { op: "write", path: "base.txt", content: "scribbled\n" },
      { op: "checkout", ref: "feature", expect: { outcome: "failed", code: "ECHECKOUTFAIL" } },
      { op: "checkout", ref: "feature", force: true },
      { op: "checkout", ref: "main" },
      { op: "branchDelete", name: "main", expect: { outcome: "failed", code: "EBRANCHFAIL" } },
      { op: "branchDelete", name: "release" },
      { op: "branchDelete", name: "feature", force: true },
    );

    const pruned = await world.snapshot();
    expect(pruned.kompjutr.refs.map((ref) => ref.name)).toEqual(["refs/heads/main"]);
  });

  it("detaches HEAD onto a commit and returns to the branch", async () => {
    world = await createWorld({ start: "init" });
    await world.run(
      { op: "write", path: "v.txt", content: "one\n" },
      { op: "add", all: true },
      { op: "commit", message: "one" },
    );
    const first = await tip(world);

    await world.run(
      { op: "write", path: "v.txt", content: "two\n" },
      { op: "add", all: true },
      { op: "commit", message: "two" },
      { op: "checkout", ref: first },
    );

    const detached = await world.snapshot();
    expect(detached.kompjutr.currentBranch).toBeNull();
    expect(detached.kompjutr.head).toBe(first);
    expect(await world.read("v.txt")).toBe("one\n");

    await world.run({ op: "checkout", ref: "main" });

    const attached = await world.snapshot();
    expect(attached.kompjutr.currentBranch).toBe("refs/heads/main");
    expect(await world.read("v.txt")).toBe("two\n");
  });

  it("marks commits with lightweight tags and removes them", async () => {
    world = await createWorld({ start: "init" });
    await world.run(
      { op: "write", path: "app.txt", content: "one\n" },
      { op: "add", all: true },
      { op: "commit", message: "one" },
    );
    const first = await tip(world);

    await world.run(
      { op: "tag", name: "v1.0.0" },
      { op: "write", path: "app.txt", content: "two\n" },
      { op: "add", all: true },
      { op: "commit", message: "two" },
      { op: "tag", name: "v1.1.0" },
      // An explicit object tags something other than HEAD.
      { op: "tag", name: "release", object: first },
      // A tag that already exists needs `force` to move.
      { op: "tag", name: "release", expect: { outcome: "failed" } },
      { op: "tag", name: "release", force: true },
    );

    const tagged = await world.snapshot();
    expect(tagged.kompjutr.refs.map((ref) => ref.name)).toEqual([
      "refs/heads/main",
      "refs/tags/release",
      "refs/tags/v1.0.0",
      "refs/tags/v1.1.0",
    ]);

    // A tag resolves as a checkout target like any other rev.
    await world.run(
      { op: "checkout", ref: "v1.0.0" },
      { op: "checkout", ref: "main" },
      { op: "tagDelete", name: "release" },
      { op: "tagDelete", name: "v1.0.0" },
    );

    const remaining = await world.snapshot();
    expect(remaining.kompjutr.refs.map((ref) => ref.name)).toEqual([
      "refs/heads/main",
      "refs/tags/v1.1.0",
    ]);
  });

  it("tracks executable bits, symlinks, nested directories and binary bytes", async () => {
    world = await createWorld({ start: "init" });
    await world.run(
      { op: "write", path: "bin/run.sh", content: "#!/bin/sh\necho hi\n", mode: 0o755 },
      { op: "write", path: "deep/nested/inner/leaf.txt", content: "leaf\n" },
      { op: "writeBytes", path: "assets/blob.bin", bytes: new Uint8Array([0, 1, 2, 250, 10, 0]) },
      { op: "symlink", path: "latest.txt", target: "deep/nested/inner/leaf.txt" },
      // An empty directory is not content; nothing should stage it.
      { op: "mkdir", path: "empty" },
      { op: "add", all: true },
      { op: "commit", message: "file shapes" },
    );

    const committed = await world.snapshot();
    expect(committed.kompjutr.index).toEqual([
      "assets/blob.bin",
      "bin/run.sh",
      "deep/nested/inner/leaf.txt",
      "latest.txt",
    ]);
    expect(
      committed.kompjutr.worktree.find((entry) => entry.path === "bin/run.sh")?.executable,
    ).toBe(true);
    expect(committed.kompjutr.worktree.find((entry) => entry.path === "latest.txt")?.target).toBe(
      "deep/nested/inner/leaf.txt",
    );

    // Dropping the executable bit is a tracked change of its own.
    await world.run(
      { op: "chmod", path: "bin/run.sh", mode: 0o644 },
      { op: "add", all: true },
      { op: "commit", message: "drop the exec bit" },
    );

    const plain = await world.snapshot();
    expect(plain.kompjutr.worktree.find((entry) => entry.path === "bin/run.sh")?.executable).toBe(
      false,
    );
  });

  it("replaces a tracked file with a directory of the same name", async () => {
    world = await createWorld({ start: "init" });
    await world.run(
      { op: "write", path: "config", content: "single\n" },
      { op: "add", all: true },
      { op: "commit", message: "config as a file" },

      { op: "remove", path: "config" },
      { op: "write", path: "config/app.json", content: "{}\n" },
      { op: "add", all: true },
      { op: "commit", message: "config as a directory" },
    );

    const swapped = await world.snapshot();
    expect(swapped.kompjutr.index).toEqual(["config/app.json"]);
    expect(swapped.kompjutr.status).toBe("");
  });

  it("keeps ignored paths untracked until add is forced", async () => {
    world = await createWorld({ start: "init" });
    await world.run(
      { op: "write", path: ".gitignore", content: "build/\n*.log\n" },
      { op: "write", path: "app.js", content: "console.log(1);\n" },
      { op: "write", path: "build/out.js", content: "built\n" },
      { op: "write", path: "debug.log", content: "noise\n" },
      // `add --all` walks past everything .gitignore matches.
      { op: "add", all: true },
      { op: "commit", message: "root" },
    );

    const ignored = await world.snapshot();
    expect(ignored.kompjutr.index).toEqual([".gitignore", "app.js"]);
    expect(ignored.kompjutr.status).toBe("");

    // KNOWN DIVERGENCE: naming an ignored path outright is an error in git
    // ("paths are ignored by one of your .gitignore files", exit 1), while
    // kompjutr skips it and reports success (src/git/ops/staging.ts, above
    // `assertPathspecsMatch`). Both leave the index alone, so only the outcome
    // differs. Pinned rather than worked around.
    await expect(world.run({ op: "add", paths: ["debug.log"] })).rejects.toThrow(
      /git was failed, kompjutr was clean/,
    );
    expect((await world.snapshot()).kompjutr.index).toEqual([".gitignore", "app.js"]);

    // `force` overrides the ignore rule for the paths it names.
    await world.run(
      { op: "add", paths: ["debug.log"], force: true },
      { op: "commit", message: "keep one log" },
    );

    const forced = await world.snapshot();
    expect(forced.kompjutr.index).toEqual([".gitignore", "app.js", "debug.log"]);
    expect(forced.kompjutr.status).toBe("");
  });
});
