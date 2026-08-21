import { afterEach, describe, expect, it } from "vitest";

import { utf8, utf8Decoder } from "../src/core/bytes.js";
import { PathspecNotFoundError } from "../src/core/errors.js";
import { hashObject } from "../src/core/objects.js";
import { checkoutTree } from "../src/core/ops/checkout.js";
import { add, lsFiles, reset, rm } from "../src/core/ops/staging.js";
import type { Repository } from "../src/core/repository.js";
import { GitFixture } from "./helpers/git.js";
import { importFixture } from "./helpers/import.js";
import { makeRepo, type TestRepository, writeWorkFile } from "./helpers/workspace.js";
import { CountingWorktree } from "./helpers/worktree.js";

/**
 * The oracle throughout is `git ls-files -s`, which prints
 * `<mode> <oid> <stage>\t<path>` with the mode as six octal digits. Our
 * index stores the mode as a number, so render it the same way: `0o100644`
 * back to base 8 is already "100644", and the pad only guards a hypothetical
 * short mode.
 */
function indexLines(repo: Repository): string[] {
  return repo.store
    .indexEntries()
    .map(
      (entry) =>
        `${entry.mode.toString(8).padStart(6, "0")} ${entry.oid} ${entry.stage}\t${entry.path}`,
    );
}

function gitIndexLines(fixture: GitFixture): string[] {
  const output = fixture.git("ls-files", "-s");
  return output === "" ? [] : output.split("\n");
}

const fixtures: GitFixture[] = [];

function newFixture(): GitFixture {
  const fixture = new GitFixture().init();
  fixtures.push(fixture);
  return fixture;
}

afterEach(() => {
  while (fixtures.length > 0) fixtures.pop()?.dispose();
});

/** A workspace whose objects, refs, working tree and index match a fixture's HEAD. */
async function clonedFrom(fixture: GitFixture): Promise<TestRepository> {
  const workspace = makeRepo("/");
  await importFixture(fixture, workspace.repo.store);
  checkoutTree(workspace.repo, workspace.worktree, workspace.repo.headTree());
  // The fixture clock is frozen, so a later same-size edit would land on the
  // checkout's own mtime and read as clean — git's racily-clean window.
  workspace.tick(1000);
  return workspace;
}

function writeBoth(
  workspace: TestRepository,
  fixture: GitFixture,
  path: string,
  content: string,
): void {
  writeWorkFile(workspace, `/${path}`, content);
  fixture.write(path, content);
}

function removeBoth(workspace: TestRepository, fixture: GitFixture, path: string): void {
  workspace.worktree.unlink(`/${path}`);
  fixture.remove(path);
}

describe("add", () => {
  it("stages a single new file the way git does", () => {
    const fixture = newFixture();
    const workspace = makeRepo("/");
    writeBoth(workspace, fixture, "a.txt", "a\n");
    writeBoth(workspace, fixture, "b.txt", "b\n");

    add(workspace.repo, workspace.worktree, { paths: ["a.txt"] });
    fixture.git("add", "a.txt");

    expect(indexLines(workspace.repo)).toEqual(gitIndexLines(fixture));
    expect(lsFiles(workspace.repo)).toEqual(["a.txt"]);
  });

  it("stages a directory pathspec the way git does", () => {
    const fixture = newFixture();
    const workspace = makeRepo("/");
    writeBoth(workspace, fixture, "src/a.ts", "export const a = 1;\n");
    writeBoth(workspace, fixture, "src/nested/b.ts", "export const b = 2;\n");
    writeBoth(workspace, fixture, "top.txt", "top\n");

    add(workspace.repo, workspace.worktree, { paths: ["src"] });
    fixture.git("add", "src");

    expect(indexLines(workspace.repo)).toEqual(gitIndexLines(fixture));
    expect(lsFiles(workspace.repo)).toEqual(["src/a.ts", "src/nested/b.ts"]);
  });

  it("does not load ignore rules when updating tracked paths", () => {
    const workspace = makeRepo("/");
    writeWorkFile(workspace, "/tracked.txt", "one\n");
    add(workspace.repo, workspace.worktree, { paths: ["tracked.txt"], force: true });
    writeWorkFile(workspace, "/.gitignore", "*?\n".repeat(65));
    writeWorkFile(workspace, "/tracked.txt", "two\n");

    add(workspace.repo, workspace.worktree, { paths: ["tracked.txt"] });

    expect(workspace.repo.store.indexGet("tracked.txt")?.oid).toBe(
      hashObject("blob", utf8.encode("two\n")),
    );
    writeWorkFile(workspace, "/new.txt", "new\n");
    expect(() => add(workspace.repo, workspace.worktree, { paths: ["new.txt"] })).toThrow(
      /wildcardSegments/,
    );
  });

  it("stages new, modified and deleted tracked files with all", async () => {
    const fixture = newFixture();
    fixture.write("keep.txt", "keep\n");
    fixture.write("mod.txt", "one\n");
    fixture.write("gone.txt", "gone\n");
    fixture.commit("first");
    const workspace = await clonedFrom(fixture);

    writeBoth(workspace, fixture, "mod.txt", "two\n");
    writeBoth(workspace, fixture, "sub/new.txt", "new\n");
    removeBoth(workspace, fixture, "gone.txt");

    add(workspace.repo, workspace.worktree, { paths: [], all: true });
    fixture.git("add", "-A");

    expect(indexLines(workspace.repo)).toEqual(gitIndexLines(fixture));
    expect(lsFiles(workspace.repo)).toEqual(["keep.txt", "mod.txt", "sub/new.txt"]);
  });

  it("stages an executable file as 100755", () => {
    const fixture = newFixture();
    const workspace = makeRepo("/");
    workspace.worktree.writeFile("/run.sh", new TextEncoder().encode("#!/bin/sh\necho hi\n"), {
      mode: 0o755,
    });
    fixture.writeExecutable("run.sh", "#!/bin/sh\necho hi\n");

    add(workspace.repo, workspace.worktree, { paths: ["run.sh"] });
    fixture.git("add", "run.sh");

    expect(indexLines(workspace.repo)).toEqual(gitIndexLines(fixture));
    expect(indexLines(workspace.repo)[0]).toMatch(/^100755 /);
  });

  it("stages a symlink as 120000", () => {
    const fixture = newFixture();
    const workspace = makeRepo("/");
    writeBoth(workspace, fixture, "target.txt", "t\n");
    workspace.worktree.symlink("target.txt", "/link");
    fixture.symlink("target.txt", "link");

    add(workspace.repo, workspace.worktree, { paths: ["."] });
    fixture.git("add", ".");

    expect(indexLines(workspace.repo)).toEqual(gitIndexLines(fixture));
    expect(indexLines(workspace.repo).some((line) => line.startsWith("120000 "))).toBe(true);
  });

  it("leaves untracked files alone when trackedOnly is set", async () => {
    const fixture = newFixture();
    fixture.write("tracked.txt", "one\n");
    fixture.commit("first");
    const workspace = await clonedFrom(fixture);

    writeBoth(workspace, fixture, "tracked.txt", "two\n");
    writeBoth(workspace, fixture, "untracked.txt", "new\n");

    add(workspace.repo, workspace.worktree, { paths: [], all: true, trackedOnly: true });
    fixture.git("add", "-u");

    expect(indexLines(workspace.repo)).toEqual(gitIndexLines(fixture));
    expect(lsFiles(workspace.repo)).toEqual(["tracked.txt"]);
  });

  it("skips an ignored path unless force is set", () => {
    const fixture = newFixture();
    const workspace = makeRepo("/");
    writeBoth(workspace, fixture, ".gitignore", "*.log\n");
    writeBoth(workspace, fixture, "x.log", "noisy\n");

    add(workspace.repo, workspace.worktree, { paths: [".gitignore"] });
    fixture.git("add", ".gitignore");

    add(workspace.repo, workspace.worktree, { paths: ["x.log"] });
    expect(lsFiles(workspace.repo)).toEqual([".gitignore"]);

    add(workspace.repo, workspace.worktree, { paths: ["x.log"], force: true });
    fixture.git("add", "-f", "x.log");
    expect(indexLines(workspace.repo)).toEqual(gitIndexLines(fixture));
  });

  it("reports a pathspec that matches nothing", () => {
    const workspace = makeRepo("/");
    writeWorkFile(workspace, "/a.txt", "a\n");

    expect(() => add(workspace.repo, workspace.worktree, { paths: ["nosuch.txt"] })).toThrow(
      PathspecNotFoundError,
    );
    expect(() => add(workspace.repo, workspace.worktree, { paths: ["a.txt", "nope/"] })).toThrow(
      /pathspec 'nope' did not match any files/,
    );
    expect(lsFiles(workspace.repo)).toEqual([]);
  });

  it("does nothing when the pathspec list is empty", () => {
    const workspace = makeRepo("/");
    writeWorkFile(workspace, "/a.txt", "a\n");
    add(workspace.repo, workspace.worktree, { paths: [] });
    expect(lsFiles(workspace.repo)).toEqual([]);
  });

  it("replaces conflict-only stages for present and deleted paths", () => {
    const workspace = makeRepo("/");
    writeWorkFile(workspace, "/present.txt", "resolved\n");
    for (const path of ["present.txt", "deleted.txt"]) {
      for (const stage of [1, 2, 3]) {
        workspace.repo.store.indexPut({
          path,
          stage,
          mode: 0o100644,
          oid: String(stage).repeat(40),
          size: null,
          mtime: null,
          ino: null,
        });
      }
    }

    add(workspace.repo, workspace.worktree, { paths: [], all: true });

    expect(workspace.repo.store.indexEntries()).toEqual([
      expect.objectContaining({
        path: "present.txt",
        stage: 0,
        oid: hashObject("blob", utf8.encode("resolved\n")),
      }),
    ]);
  });
});

describe("rm", () => {
  it("unstages a path without touching the working tree", () => {
    const fixture = newFixture();
    const workspace = makeRepo("/");
    writeBoth(workspace, fixture, "a.txt", "a\n");
    writeBoth(workspace, fixture, "b.txt", "b\n");
    add(workspace.repo, workspace.worktree, { paths: ["."] });
    fixture.git("add", ".");

    rm(workspace.repo, workspace.worktree, { paths: ["a.txt"] });
    fixture.git("rm", "--cached", "-q", "a.txt");

    expect(indexLines(workspace.repo)).toEqual(gitIndexLines(fixture));
    expect(lsFiles(workspace.repo)).toEqual(["b.txt"]);
    expect(workspace.worktree.stat("/a.txt")).not.toBeNull();
  });

  it("reports a pathspec that is not in the index", () => {
    const workspace = makeRepo("/");
    writeWorkFile(workspace, "/a.txt", "a\n");
    expect(() => rm(workspace.repo, workspace.worktree, { paths: ["a.txt"] })).toThrow(
      /pathspec 'a.txt' did not match any files/,
    );
  });
});

describe("reset", () => {
  it("resets listed paths back to HEAD and leaves the working tree alone", async () => {
    const fixture = newFixture();
    fixture.write("a.txt", "a\n");
    fixture.write("b.txt", "b\n");
    fixture.commit("first");
    const workspace = await clonedFrom(fixture);

    writeBoth(workspace, fixture, "a.txt", "a changed\n");
    writeBoth(workspace, fixture, "c.txt", "c\n");
    add(workspace.repo, workspace.worktree, { paths: [], all: true });
    fixture.git("add", "-A");

    reset(workspace.repo, workspace.worktree, { paths: ["a.txt"] });
    fixture.git("reset", "-q", "--", "a.txt");

    expect(indexLines(workspace.repo)).toEqual(gitIndexLines(fixture));
    expect(utf8Decoder.decode(workspace.worktree.readFile("/a.txt"))).toBe("a changed\n");
  });

  it("unstages everything when called bare", async () => {
    const fixture = newFixture();
    fixture.write("a.txt", "a\n");
    fixture.commit("first");
    const workspace = await clonedFrom(fixture);

    writeBoth(workspace, fixture, "a.txt", "a changed\n");
    writeBoth(workspace, fixture, "c.txt", "c\n");
    add(workspace.repo, workspace.worktree, { paths: [], all: true });
    fixture.git("add", "-A");

    reset(workspace.repo, workspace.worktree, {});
    fixture.git("reset", "-q");

    expect(indexLines(workspace.repo)).toEqual(gitIndexLines(fixture));
    expect(lsFiles(workspace.repo)).toEqual(["a.txt"]);
    expect(workspace.worktree.stat("/c.txt")).not.toBeNull();
  });

  it("hard reset restores a deleted file and drops an added one", async () => {
    const fixture = newFixture();
    fixture.write("a.txt", "a\n");
    fixture.write("b.txt", "b\n");
    fixture.commit("first");
    const workspace = await clonedFrom(fixture);

    removeBoth(workspace, fixture, "a.txt");
    writeBoth(workspace, fixture, "c.txt", "c\n");
    add(workspace.repo, workspace.worktree, { paths: [], all: true });
    fixture.git("add", "-A");

    reset(workspace.repo, workspace.worktree, { hard: true });
    fixture.git("reset", "--hard", "-q");

    expect(indexLines(workspace.repo)).toEqual(gitIndexLines(fixture));
    expect(utf8Decoder.decode(workspace.worktree.readFile("/a.txt"))).toBe("a\n");
    expect(workspace.worktree.stat("/c.txt")).toBeNull();
  });

  it("hard reset to a ref moves the current branch", async () => {
    const fixture = newFixture();
    fixture.write("a.txt", "one\n");
    fixture.commit("first");
    fixture.write("a.txt", "two\n");
    fixture.write("b.txt", "b\n");
    fixture.commit("second");
    const workspace = await clonedFrom(fixture);

    reset(workspace.repo, workspace.worktree, { hard: true, ref: "HEAD~1" });
    fixture.git("reset", "--hard", "-q", "HEAD~1");

    expect(workspace.repo.resolveRef("refs/heads/main")).toBe(fixture.git("rev-parse", "HEAD"));
    expect(indexLines(workspace.repo)).toEqual(gitIndexLines(fixture));
    expect(utf8Decoder.decode(workspace.worktree.readFile("/a.txt"))).toBe("one\n");
    expect(workspace.worktree.stat("/b.txt")).toBeNull();
  });
});

describe("cost", () => {
  class BulkOnlyWorktree extends CountingWorktree {
    override stat(path: string): never {
      throw new Error(`scalar stat is forbidden during add: ${path}`);
    }

    override readFile(path: string): never {
      throw new Error(`scalar readFile is forbidden during add: ${path}`);
    }

    override readlink(path: string): never {
      throw new Error(`scalar readlink is forbidden during add: ${path}`);
    }
  }

  it("stages 9,329 files and exactly 1,000 changes through bounded bulk calls", () => {
    const workspace = makeRepo("/");
    const original = utf8.encode("original\n");
    const paths = Array.from({ length: 9_329 }, (_, index) => {
      const directory = index % 3_346;
      const generation = Math.floor(index / 3_346);
      return `/d${directory.toString().padStart(4, "0")}/f${generation
        .toString()
        .padStart(4, "0")}.txt`;
    });
    workspace.worktree.writeFiles(paths.map((path) => ({ path, bytes: original })));
    const worktree = new BulkOnlyWorktree(workspace.worktree);

    workspace.storage.resetCounters();
    add(workspace.repo, worktree, { paths: [], all: true });
    const first = workspace.storage.statementCount;
    expect(workspace.repo.store.indexEntries()).toHaveLength(paths.length);
    expect(first).toBeLessThanOrEqual(230);
    expect(worktree.bulkReadPaths).toHaveLength(paths.length);

    workspace.tick(60_000);
    const changed = paths.slice(0, 1_000);
    workspace.worktree.writeFiles(
      changed.map((path) => ({ path, bytes: utf8.encode("changed\n") })),
    );
    worktree.bulkReadPaths.length = 0;

    workspace.storage.resetCounters();
    add(workspace.repo, worktree, { paths: [], all: true });
    const second = workspace.storage.statementCount;

    expect(second).toBeLessThanOrEqual(230);
    expect(worktree.bulkReadPaths).toHaveLength(changed.length);
    expect(new Set(worktree.bulkReadPaths)).toEqual(new Set(changed));
    const changedOid = hashObject("blob", utf8.encode("changed\n"));
    const stagedChanged = workspace.repo.store
      .indexEntries()
      .filter((entry) => entry.oid === changedOid)
      .map((entry) => `/${entry.path}`);
    expect(stagedChanged).toHaveLength(changed.length);
    expect(new Set(stagedChanged)).toEqual(new Set(changed));

    workspace.storage.resetCounters();
    rm(workspace.repo, worktree, { paths: ["."] });
    expect(workspace.storage.statementCount).toBeLessThanOrEqual(230);
    expect(workspace.repo.store.indexEntries()).toEqual([]);
  });

  it("stages 100 explicit paths without retaining an oversized index", () => {
    const workspace = makeRepo("/");
    const original = utf8.encode("original\n");
    const changed = utf8.encode("changed\n");
    const originalOid = workspace.repo.store.write("blob", original);
    const paths = Array.from(
      { length: 24_252 },
      (_, index) => `f${index.toString().padStart(5, "0")}.txt`,
    );
    workspace.repo.store.indexReplace(
      paths.map((path) => ({
        path,
        stage: 0,
        mode: 0o100644,
        oid: originalOid,
        size: original.length,
        mtime: null,
        ino: null,
      })),
    );
    const selected = paths.slice(0, 100);
    workspace.worktree.writeFiles(selected.map((path) => ({ path: `/${path}`, bytes: changed })));

    workspace.storage.resetCounters();
    add(workspace.repo, workspace.worktree, { paths: selected });

    expect(workspace.storage.statementCount).toBeLessThanOrEqual(400);
    const changedOid = hashObject("blob", changed);
    expect(selected.every((path) => workspace.repo.store.indexGet(path)?.oid === changedOid)).toBe(
      true,
    );
    expect(workspace.repo.store.indexGet(paths[100] ?? "")?.oid).toBe(originalOid);
  });
});
