import { lstatSync, readdirSync, readFileSync, readlinkSync, unlinkSync } from "node:fs";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { utf8, utf8Decoder } from "../src/core/bytes.js";
import type { GitContext } from "../src/core/context.js";
import { GitError } from "../src/core/errors.js";
import { MODE_FILE, serializeTree } from "../src/core/objects.js";
import { checkoutTree } from "../src/core/ops/checkout.js";
import { readTree, writeTree } from "../src/core/ops/plumbing.js";
import { add } from "../src/core/ops/staging.js";
import {
  MAX_TREE_BUILD_LEAF_ENTRIES,
  MAX_TREE_BUILD_OBJECTS,
  MAX_TREE_BUILD_TOTAL_PATH_BYTES,
} from "../src/core/ops/tree-build.js";
import { comparePaths } from "../src/core/streams.js";
import type { Worktree } from "../src/core/worktree.js";
import type { ScanEntry } from "../src/fs/types.js";
import {
  INDEX_DIRTY,
  iterateIndexTrackerDirty,
  readIndexTrackerState,
  resealIndexTracker,
  WORKTREE_DIRTY,
} from "../src/sqlite/index-tracker.js";
import type { IndexEntry, IndexStore } from "../src/sqlite/store.js";
import { GitFixture } from "./helpers/git.js";
import { importFixture } from "./helpers/import.js";
import { makeRepo, type TestRepository, writeWorkFile } from "./helpers/workspace.js";

const fixtures: GitFixture[] = [];

function newFixture(): GitFixture {
  const fixture = new GitFixture().init();
  fixtures.push(fixture);
  return fixture;
}

afterEach(() => {
  while (fixtures.length > 0) fixtures.pop()?.dispose();
});

function indexLines(index: IndexStore): string[] {
  return [...index.indexScan()].map(
    (entry) =>
      `${entry.mode.toString(8).padStart(6, "0")} ${entry.oid} ${entry.stage}\t${entry.path}`,
  );
}

function outputLines(output: string): string[] {
  return output === "" ? [] : output.split("\n");
}

function controlState(workspace: TestRepository) {
  const checkoutId = workspace.repo.checkout.checkoutId;
  const refs = workspace.repo.store.listRefs();
  return {
    head: workspace.repo.checkout.head(),
    refs,
    reflogs: [
      { ref: "HEAD", entries: workspace.repo.reflog("HEAD") },
      ...refs.map((ref) => ({ ref: ref.name, entries: workspace.repo.reflog(ref.name) })),
    ],
    index: [...workspace.repo.checkout.indexScan()],
    tracker: readIndexTrackerState(workspace.database.db, checkoutId),
    trackerDirty: [...iterateIndexTrackerDirty(workspace.database.db, checkoutId)],
  };
}

function worktreeState(workspace: TestRepository) {
  return workspace.worktree.scan("/", { limit: 1_000 }).map((entry) => ({
    path: entry.path,
    type: entry.type,
    executable: entry.type === "file" && (entry.mode & 0o111) !== 0,
    target: entry.type === "symlink" ? workspace.worktree.readlink(entry.path) : null,
    bytes: entry.type === "file" ? [...workspace.worktree.readFile(entry.path)] : [],
  }));
}

function nativeWorktreeState(root: string) {
  const state: Array<{
    path: string;
    type: "file" | "dir" | "symlink";
    executable: boolean;
    target: string | null;
    bytes: number[];
  }> = [];
  const visit = (directory: string, prefix: string): void => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      if (prefix === "" && entry.name === ".git") continue;
      const relative = prefix === "" ? entry.name : `${prefix}/${entry.name}`;
      const absolute = join(directory, entry.name);
      const stat = lstatSync(absolute);
      const type = stat.isSymbolicLink() ? "symlink" : stat.isDirectory() ? "dir" : "file";
      state.push({
        path: `/${relative}`,
        type,
        executable: type === "file" && (stat.mode & 0o111) !== 0,
        target: type === "symlink" ? readlinkSync(absolute) : null,
        bytes: type === "file" ? [...readFileSync(absolute)] : [],
      });
      if (type === "dir") visit(absolute, relative);
    }
  };
  visit(root, "");
  return state.sort((left, right) => comparePaths(left.path, right.path));
}

function syntheticWorktree(
  inner: Worktree,
  count: number,
  contentId: Uint8Array | null,
  size = 0,
): Worktree {
  return {
    ...inner,
    scan(_root, options): ScanEntry[] {
      const after = options.after;
      const start =
        after === undefined
          ? 0
          : Number.parseInt(after.slice(after.lastIndexOf("f") + 1, -4), 10) + 1;
      const rows: ScanEntry[] = [];
      for (let index = start; index < count && rows.length < options.limit; index++) {
        rows.push({
          path: `/f${index.toString().padStart(5, "0")}.txt`,
          type: "file",
          mode: 0o100644,
          size,
          mtime: 1,
          ino: index + 2,
          nlink: 1,
          rev: 1,
          target: null,
          contentId,
        });
      }
      return rows;
    },
  };
}

function syntheticDirectoryWorktree(inner: Worktree, count: number): Worktree {
  return {
    ...inner,
    scan(_root, options): ScanEntry[] {
      const after = options.after;
      const start =
        after === undefined ? 0 : Number.parseInt(after.slice(after.lastIndexOf("d") + 1), 10) + 1;
      const rows: ScanEntry[] = [];
      for (let index = start; index < count && rows.length < options.limit; index++) {
        rows.push({
          path: `/d${index.toString().padStart(5, "0")}`,
          type: "dir",
          mode: 0o40755,
          size: 0,
          mtime: 1,
          ino: index + 2,
          nlink: 1,
          rev: 1,
          target: null,
          contentId: null,
        });
      }
      return rows;
    },
  };
}

function pageIndex(index: IndexStore, pageSize: number): IndexStore {
  return {
    indexScan(options) {
      return index.indexScan({ ...options, pageSize });
    },
    indexApply(body, options) {
      return index.indexApply(body, options);
    },
    indexReplace(entries, options) {
      index.indexReplace(entries, options);
    },
    hasConflicts() {
      return index.hasConflicts();
    },
  };
}

function indexed(path: string, oid: string, mode = 0o100644, stage = 0): IndexEntry {
  return {
    path,
    stage,
    mode,
    oid,
    size: null,
    mtime: null,
    ino: null,
    rev: null,
  };
}

function readOnlyIndex(open: () => IterableIterator<IndexEntry>): IndexStore {
  return {
    indexScan() {
      return open();
    },
    indexApply() {
      throw new Error("read-only test index cannot mutate");
    },
    indexReplace() {
      throw new Error("read-only test index cannot mutate");
    },
    hasConflicts() {
      return false;
    },
  };
}

describe("tree and index write plumbing", () => {
  it("matches Git write-tree for checkout, scratch, empty, mixed-mode, and non-BMP indexes", async () => {
    const fixture = newFixture();
    fixture
      .write("plain.txt", "plain\n")
      .write("emoji-😀.txt", "emoji\n")
      .writeExecutable("bin/run", "#!/bin/sh\n")
      .symlink("../plain.txt", "links/plain");
    const base = fixture.commit("base");
    const baseTree = fixture.git("rev-parse", `${base}^{tree}`);
    const environment = { GIT_INDEX_FILE: join(fixture.dir, ".git", "tree.index") };
    fixture.gitWithEnv(environment, "read-tree", base);
    fixture.gitWithEnv(
      environment,
      "update-index",
      "--add",
      "--cacheinfo",
      `160000,${base},vendor/module`,
    );
    const expectedScratch = fixture.gitWithEnv(environment, "write-tree");
    const expectedEmpty = fixture.writeObject("tree", new Uint8Array(0));
    const workspace = makeRepo("/");
    await importFixture(fixture, workspace.repo.checkout);
    readTree(workspace.repo, workspace.worktree, { tree: base });
    const beforeControl = controlState(workspace);
    const beforeWorktree = worktreeState(workspace);

    expect(writeTree(workspace.repo)).toBe(baseTree);
    workspace.repo.store.withScratchIndex("write-tree", (scratch) => {
      readTree(workspace.repo, workspace.worktree, { tree: base }, scratch);
      scratch.indexApply((sink) => {
        sink.put(indexed("vendor/module", base, 0o160000));
      });
      expect(writeTree(workspace.repo, scratch)).toBe(expectedScratch);
      readTree(workspace.repo, workspace.worktree, { empty: true }, scratch);
      expect(writeTree(workspace.repo, scratch)).toBe(expectedEmpty);
    });

    expect(controlState(workspace)).toEqual(beforeControl);
    expect(worktreeState(workspace)).toEqual(beforeWorktree);
  });

  it("rejects every unmerged stage before writing a tree object", () => {
    const workspace = makeRepo("/");
    const ancestor = workspace.repo.store.write("blob", utf8.encode("ancestor\n"));
    const ours = workspace.repo.store.write("blob", utf8.encode("ours\n"));
    const theirs = workspace.repo.store.write("blob", utf8.encode("theirs\n"));
    const beforeObjects = workspace.repo.store.objectCount();

    expect(() =>
      workspace.repo.store.withScratchIndex("unmerged-tree", (scratch) => {
        scratch.indexReplace([
          indexed("conflict.txt", ancestor, 0o100644, 1),
          indexed("conflict.txt", ours, 0o100644, 2),
          indexed("conflict.txt", theirs, 0o100644, 3),
        ]);
        writeTree(workspace.repo, scratch);
      }),
    ).toThrowError(expect.objectContaining({ code: "EUNMERGED" }));

    expect(workspace.repo.store.objectCount()).toBe(beforeObjects);
    expect(workspace.database.db.scalar<number>("SELECT count(*) FROM git_scratch_indexes")).toBe(
      0,
    );

    let advancedPastConflict = false;
    const conflictRows = function* (): Generator<IndexEntry> {
      yield indexed("conflict.txt", ancestor, 0o100644, 1);
      advancedPastConflict = true;
      throw new Error("write-tree scanned past the first conflict");
    };
    expect(() => writeTree(workspace.repo, readOnlyIndex(conflictRows))).toThrowError(
      expect.objectContaining({ code: "EUNMERGED" }),
    );
    expect(advancedPastConflict).toBe(false);
    expect(workspace.repo.store.objectCount()).toBe(beforeObjects);
  });

  it("rejects missing file objects while allowing gitlinks and existing wrong types", () => {
    const workspace = makeRepo("/");
    const missing = "f".repeat(40);
    const beforeObjects = workspace.repo.store.objectCount();

    expect(() =>
      writeTree(
        workspace.repo,
        readOnlyIndex(() => [indexed("missing.txt", missing)].values()),
      ),
    ).toThrowError(expect.objectContaining({ code: "ENOTFOUND" }));
    expect(workspace.repo.store.objectCount()).toBe(beforeObjects);

    const gitlinkTree = writeTree(
      workspace.repo,
      readOnlyIndex(() => [indexed("vendor/module", missing, 0o160000)].values()),
    );
    expect(workspace.repo.resolveTreePath(gitlinkTree, "vendor/module")).toEqual({
      mode: "160000",
      name: "module",
      oid: missing,
    });

    const existingTree = workspace.repo.store.write("tree", new Uint8Array(0));
    const wrongTypeTree = writeTree(
      workspace.repo,
      readOnlyIndex(() => [indexed("tree-as-file", existingTree)].values()),
    );
    expect(workspace.repo.readTree(wrongTypeTree)).toEqual([
      { mode: "100644", name: "tree-as-file", oid: existingTree },
    ]);
  });

  it("preflights corrupt and first-over-limit indexes without partial objects", () => {
    const workspace = makeRepo("/");
    const blob = workspace.repo.store.write("blob", new Uint8Array(0));
    const suffix = "x".repeat(500);
    const cases: Array<() => IterableIterator<IndexEntry>> = [
      () => [indexed("b", blob), indexed("a", blob)].values(),
      () => [indexed("bad-mode", blob, 0o100600)].values(),
      () => [indexed("bad-oid", "z".repeat(40))].values(),
      function* () {
        for (let index = 0; index <= MAX_TREE_BUILD_LEAF_ENTRIES; index++) {
          yield indexed(`f${index.toString().padStart(5, "0")}`, blob);
        }
      },
      function* () {
        const count = Math.ceil(MAX_TREE_BUILD_TOTAL_PATH_BYTES / (suffix.length + 7)) + 1;
        for (let index = 0; index < count; index++) {
          yield indexed(`${index.toString().padStart(6, "0")}-${suffix}`, blob);
        }
      },
      function* () {
        for (let index = 0; index < MAX_TREE_BUILD_OBJECTS; index++) {
          const ordinal = index.toString().padStart(4, "0");
          yield indexed(`d${ordinal}/f${ordinal}`, blob);
        }
      },
    ];

    for (const open of cases) {
      const beforeObjects = workspace.repo.store.objectCount();
      const beforeStatements = workspace.storage.statementCount;
      expect(() => writeTree(workspace.repo, readOnlyIndex(open))).toThrow();
      expect(workspace.repo.store.objectCount()).toBe(beforeObjects);
      expect(workspace.storage.statementCount - beforeStatements).toBeLessThan(1_000);
    }
  });

  it("materializes the maximal admitted tree-object shape below the SQL gate", () => {
    const workspace = makeRepo("/");
    const blob = workspace.repo.store.write("blob", new Uint8Array(0));
    const suffix = "x".repeat(900);
    const rows = function* (): Generator<IndexEntry> {
      for (let index = 0; index < MAX_TREE_BUILD_OBJECTS - 1; index++) {
        const ordinal = index.toString().padStart(4, "0");
        yield indexed(`d${ordinal}/f${ordinal}-${suffix}`, blob);
      }
    };
    const beforeControl = controlState(workspace);
    const beforeObjects = workspace.repo.store.objectCount();
    const beforeStatements = workspace.storage.statementCount;

    const oid = writeTree(workspace.repo, readOnlyIndex(rows));
    const statements = workspace.storage.statementCount - beforeStatements;

    expect(workspace.repo.store.read(oid)?.type).toBe("tree");
    expect(workspace.repo.store.objectCount() - beforeObjects).toBe(MAX_TREE_BUILD_OBJECTS);
    expect(statements).toBeLessThan(1_000);
    expect(controlState(workspace)).toEqual(beforeControl);
    expect(worktreeState(workspace)).toEqual([]);
  });

  it("matches a Git alternate-index snapshot without changing checkout state", async () => {
    const fixture = newFixture();
    fixture
      .write("changed.txt", "base\n")
      .write("removed.txt", "removed\n")
      .writeExecutable("bin/run", "#!/bin/sh\n")
      .symlink("changed.txt", "link");
    const base = fixture.commit("base");
    const baseTree = fixture.git("rev-parse", `${base}^{tree}`);
    fixture.git("tag", "-a", "base-treeish", "-m", "base tree-ish", base);
    const workspace = makeRepo("/");
    await importFixture(fixture, workspace.repo.checkout);
    checkoutTree(workspace.repo, workspace.worktree, baseTree);
    expect(
      resealIndexTracker(workspace.database.db, workspace.repo.checkout.checkoutId, baseTree, []),
    ).toBe(true);
    workspace.tick(1_000);

    writeWorkFile(workspace, "/changed.txt", "changed\n");
    fixture.write("changed.txt", "changed\n");
    workspace.worktree.unlink("/removed.txt");
    fixture.remove("removed.txt");
    writeWorkFile(workspace, "/new.txt", "new\n");
    fixture.write("new.txt", "new\n");

    const environment = { GIT_INDEX_FILE: join(fixture.dir, ".git", "snapshot.index") };
    fixture.gitWithEnv(environment, "read-tree", "base-treeish");
    fixture.gitWithEnv(environment, "add", "-A");
    const expected = outputLines(fixture.gitWithEnv(environment, "ls-files", "--stage"));
    const beforeControl = controlState(workspace);
    const beforeWorktree = worktreeState(workspace);
    let selectedPathCalls = 0;
    const context: Pick<GitContext, "selectedPaths"> = {
      selectedPaths: {
        select() {
          selectedPathCalls++;
          throw new Error("scratch staging used the checkout-only selected-path source");
        },
      },
    };

    workspace.repo.store.withScratchIndex("snapshot", (scratch) => {
      readTree(workspace.repo, workspace.worktree, { tree: "base-treeish" }, scratch);
      add(workspace.repo, workspace.worktree, { paths: ["changed.txt"] }, context, scratch);
      add(workspace.repo, workspace.worktree, { paths: [], all: true }, context, scratch);
      expect(indexLines(scratch)).toEqual(expected);
    });

    expect(selectedPathCalls).toBe(0);
    expect(controlState(workspace)).toEqual(beforeControl);
    expect(worktreeState(workspace)).toEqual(beforeWorktree);
  });

  it("uses the scratch index for reset-with-update structural transitions", async () => {
    const fixture = newFixture();
    fixture
      .write("flip", "regular\n")
      .symlink("old-target.txt", "symlink-to-file")
      .write("gone.txt", "gone\n")
      .write("directory-to-file/child.txt", "child\n")
      .write("file-to-directory", "leaf\n");
    const base = fixture.commit("base");
    const baseTree = fixture.git("rev-parse", `${base}^{tree}`);
    fixture
      .remove("flip")
      .symlink("target.txt", "flip")
      .remove("gone.txt")
      .remove("directory-to-file")
      .write("directory-to-file", "replacement\n")
      .remove("file-to-directory")
      .write("file-to-directory/child.txt", "nested\n")
      .write("blocked-directory/child.txt", "unblocked\n")
      .write("blocked-file", "replacement file\n");
    unlinkSync(join(fixture.dir, "symlink-to-file"));
    fixture.writeExecutable("symlink-to-file", "#!/bin/sh\n");
    const target = fixture.commit("target");
    const targetTree = fixture.git("rev-parse", `${target}^{tree}`);
    expect(fixture.git("ls-tree", target, "symlink-to-file")).toContain("100755 blob");
    fixture.git("read-tree", "--reset", "-u", base);
    fixture.write("blocked-directory", "blocking file\n");
    fixture.write("blocked-file/untracked.txt", "blocking directory\n");
    fixture.git("read-tree", "--reset", "-u", target);
    const expected = outputLines(fixture.git("ls-files", "--stage"));
    const expectedWorktree = nativeWorktreeState(fixture.dir);
    const workspace = makeRepo("/");
    await importFixture(fixture, workspace.repo.checkout);
    checkoutTree(workspace.repo, workspace.worktree, baseTree);
    expect(
      resealIndexTracker(workspace.database.db, workspace.repo.checkout.checkoutId, baseTree, []),
    ).toBe(true);
    writeWorkFile(workspace, "/blocked-directory", "blocking file\n");
    writeWorkFile(workspace, "/blocked-file/untracked.txt", "blocking directory\n");
    const beforeControl = controlState(workspace);

    workspace.repo.store.withScratchIndex("update", (scratch) => {
      readTree(workspace.repo, workspace.worktree, { tree: base }, scratch);
      readTree(workspace.repo, workspace.worktree, { tree: target, updateWorktree: true }, scratch);
      expect(indexLines(scratch)).toEqual(expected);
    });

    expect([...workspace.repo.checkout.indexScan()]).toEqual(beforeControl.index);
    expect(workspace.repo.checkout.head()).toBe(beforeControl.head);
    expect(workspace.repo.store.listRefs()).toEqual(beforeControl.refs);
    expect(workspace.repo.reflog("HEAD")).toEqual(beforeControl.reflogs[0]?.entries);
    expect(worktreeState(workspace)).toEqual(expectedWorktree);
    expect(
      readIndexTrackerState(workspace.database.db, workspace.repo.checkout.checkoutId),
    ).toEqual(beforeControl.tracker);
    const trackerDirty = [
      ...iterateIndexTrackerDirty(workspace.database.db, workspace.repo.checkout.checkoutId),
    ];
    expect(trackerDirty.length).toBeGreaterThan(beforeControl.trackerDirty.length);
    expect(trackerDirty.every((entry) => (entry.flags & INDEX_DIRTY) === 0)).toBe(true);
    expect(trackerDirty.every((entry) => (entry.flags & WORKTREE_DIRTY) !== 0)).toBe(true);
    expect(workspace.worktree.stat("/gone.txt")).toBeNull();
    expect(workspace.worktree.stat("/flip")?.type).toBe("symlink");
    expect(workspace.worktree.readlink("/flip")).toBe("target.txt");
    expect(workspace.worktree.stat("/symlink-to-file")).toMatchObject({
      type: "file",
      mode: 0o100755,
    });
    expect(utf8Decoder.decode(workspace.worktree.readFile("/symlink-to-file"))).toBe("#!/bin/sh\n");
    expect(utf8Decoder.decode(workspace.worktree.readFile("/directory-to-file"))).toBe(
      "replacement\n",
    );
    expect(workspace.worktree.stat("/file-to-directory")?.type).toBe("dir");
    expect(utf8Decoder.decode(workspace.worktree.readFile("/file-to-directory/child.txt"))).toBe(
      "nested\n",
    );
    expect(workspace.worktree.stat("/blocked-directory")?.type).toBe("dir");
    expect(utf8Decoder.decode(workspace.worktree.readFile("/blocked-directory/child.txt"))).toBe(
      "unblocked\n",
    );
    expect(workspace.worktree.stat("/blocked-file")?.type).toBe("file");
    expect(utf8Decoder.decode(workspace.worktree.readFile("/blocked-file"))).toBe(
      "replacement file\n",
    );
    expect(workspace.repo.readCommit(target).tree).toBe(targetTree);
  });

  it("poisons a scratch session after a caught late read-tree failure", () => {
    const workspace = makeRepo("/");
    const blob = workspace.repo.store.write("blob", utf8.encode("content\n"));
    const target = workspace.repo.store.write(
      "tree",
      serializeTree([
        ...Array.from({ length: 1_000 }, (_, index) => ({
          mode: MODE_FILE,
          name: `f${index.toString().padStart(5, "0")}.txt`,
          oid: blob,
        })),
        { mode: MODE_FILE, name: "z-missing.txt", oid: "f".repeat(40) },
      ]),
    );
    const beforeControl = controlState(workspace);
    const beforeWorktree = worktreeState(workspace);
    let caughtCode = "";

    expect(() =>
      workspace.repo.store.withScratchIndex("late-failure", (scratch) => {
        try {
          readTree(
            workspace.repo,
            workspace.worktree,
            { tree: target, updateWorktree: true },
            scratch,
          );
        } catch (error) {
          if (!(error instanceof GitError)) throw error;
          caughtCode = error.code;
        }
        expect(workspace.worktree.scan("/", { filesOnly: true, limit: 1 })).toHaveLength(1);
      }),
    ).toThrowError(expect.objectContaining({ code: "ENOTFOUND" }));

    expect(caughtCode).toBe("ENOTFOUND");
    expect(controlState(workspace)).toEqual(beforeControl);
    expect(worktreeState(workspace)).toEqual(beforeWorktree);
    expect(workspace.database.db.scalar<number>("SELECT count(*) FROM git_scratch_indexes")).toBe(
      0,
    );
    expect(
      workspace.database.db.scalar<number>("SELECT count(*) FROM git_scratch_index_entries"),
    ).toBe(0);
  });

  it("fails closed at the read-tree row and checkout-byte limits", () => {
    const workspace = makeRepo("/");
    const blob = workspace.repo.store.write("blob", new Uint8Array(0));
    const wideTree = workspace.repo.store.write(
      "tree",
      serializeTree(
        Array.from({ length: 50_001 }, (_, index) => ({
          mode: MODE_FILE,
          name: `f${index.toString().padStart(5, "0")}.txt`,
          oid: blob,
        })),
      ),
    );
    const beforeControl = controlState(workspace);
    let rowError = "";
    const beforeRowStatements = workspace.storage.statementCount;

    expect(() =>
      workspace.repo.store.withScratchIndex("wide-tree", (scratch) => {
        try {
          readTree(workspace.repo, workspace.worktree, { tree: wideTree }, scratch);
        } catch (error) {
          if (!(error instanceof GitError)) throw error;
          rowError = error.message;
        }
        expect(scratch.indexScan({ pageSize: 1 }).next().done).toBe(false);
      }),
    ).toThrowError(expect.objectContaining({ code: "E2BIG" }));
    expect(rowError).toContain("50000 rows");
    expect(workspace.storage.statementCount - beforeRowStatements).toBeLessThan(1_000);

    const content = utf8.encode("five");
    const contentOid = workspace.repo.store.write("blob", content);
    const smallTree = workspace.repo.store.write(
      "tree",
      serializeTree([{ mode: MODE_FILE, name: "five.txt", oid: contentOid }]),
    );
    expect(() =>
      workspace.repo.store.db.transactionSync(() =>
        checkoutTree(workspace.repo, workspace.worktree, smallTree, {
          restoreStructure: true,
          maxSourceRowsPerPass: 50_000,
          maxWorktreeRowsPerPass: 50_000,
          maxWriteBytes: content.length - 1,
        }),
      ),
    ).toThrowError(expect.objectContaining({ code: "E2BIG" }));

    expect(controlState(workspace)).toEqual(beforeControl);
    expect(worktreeState(workspace)).toEqual([]);
    expect(workspace.database.db.scalar<number>("SELECT count(*) FROM git_scratch_indexes")).toBe(
      0,
    );
    expect(
      workspace.database.db.scalar<number>("SELECT count(*) FROM git_scratch_index_entries"),
    ).toBe(0);
  });

  it("fails closed at the add row and hashing limits", () => {
    const workspace = makeRepo("/");
    const blob = workspace.repo.store.write("blob", new Uint8Array(0));
    const contentId = new Uint8Array([1, 2, 3, 4]);
    workspace.repo.store.upsertBlobIds([{ contentId, oid: blob }]);
    const beforeControl = controlState(workspace);

    let rowError = "";
    const beforeRowStatements = workspace.storage.statementCount;
    expect(() =>
      workspace.repo.store.withScratchIndex("row-limit", (scratch) => {
        try {
          add(
            workspace.repo,
            syntheticWorktree(workspace.worktree, 50_001, contentId),
            { paths: [], all: true, force: true },
            undefined,
            scratch,
          );
        } catch (error) {
          if (!(error instanceof GitError)) throw error;
          rowError = error.message;
        }
        expect(scratch.indexScan({ pageSize: 1 }).next().done).toBe(false);
      }),
    ).toThrowError(expect.objectContaining({ code: "E2BIG" }));
    expect(rowError).toContain("50000 rows");
    expect(workspace.storage.statementCount - beforeRowStatements).toBeLessThan(1_000);

    let directoryError = "";
    const beforeDirectoryStatements = workspace.storage.statementCount;
    expect(() =>
      workspace.repo.store.withScratchIndex("directory-row-limit", (scratch) => {
        try {
          add(
            workspace.repo,
            syntheticDirectoryWorktree(workspace.worktree, 50_001),
            { paths: [], all: true, force: true },
            undefined,
            scratch,
          );
        } catch (error) {
          if (!(error instanceof GitError)) throw error;
          directoryError = error.message;
        }
      }),
    ).toThrowError(expect.objectContaining({ code: "E2BIG" }));
    expect(directoryError).toContain("50000 rows");
    expect(workspace.storage.statementCount - beforeDirectoryStatements).toBeLessThan(1_000);

    const scalarSpecs = Array.from(
      { length: 129 },
      (_, index) => `missing-${index.toString().padStart(3, "0")}`,
    );
    let scalarError = "";
    const beforeScalarStatements = workspace.storage.statementCount;
    expect(() =>
      workspace.repo.store.withScratchIndex("scalar-path-limit", (scratch) => {
        try {
          add(
            workspace.repo,
            workspace.worktree,
            { paths: scalarSpecs, force: true },
            undefined,
            scratch,
          );
        } catch (error) {
          if (!(error instanceof GitError)) throw error;
          scalarError = error.message;
        }
      }),
    ).toThrowError(expect.objectContaining({ code: "E2BIG" }));
    expect(scalarError).toContain("128 paths");
    expect(workspace.storage.statementCount - beforeScalarStatements).toBeLessThan(1_000);

    let byteError = "";
    expect(() =>
      workspace.repo.store.withScratchIndex("byte-limit", (scratch) => {
        try {
          add(
            workspace.repo,
            syntheticWorktree(workspace.worktree, 1, null, 64 * 1024 * 1024 + 1),
            { paths: [], all: true, force: true },
            undefined,
            scratch,
          );
        } catch (error) {
          if (!(error instanceof GitError)) throw error;
          byteError = error.message;
        }
      }),
    ).toThrowError(expect.objectContaining({ code: "E2BIG" }));
    expect(byteError).toContain(`${64 * 1024 * 1024} bytes`);

    let rangeError = "";
    expect(() =>
      workspace.repo.store.withScratchIndex("range-limit", (scratch) => {
        try {
          add(
            workspace.repo,
            syntheticWorktree(workspace.worktree, 1, null, 64 * 64 * 1024 + 1),
            { paths: [], all: true, force: true },
            undefined,
            scratch,
          );
        } catch (error) {
          if (!(error instanceof GitError)) throw error;
          rangeError = error.message;
        }
      }),
    ).toThrowError(expect.objectContaining({ code: "E2BIG" }));
    expect(rangeError).toContain("64 range reads");

    expect(controlState(workspace)).toEqual(beforeControl);
    expect(workspace.database.db.scalar<number>("SELECT count(*) FROM git_scratch_indexes")).toBe(
      0,
    );
    expect(
      workspace.database.db.scalar<number>("SELECT count(*) FROM git_scratch_index_entries"),
    ).toBe(0);
  });

  it("prunes checkout directories with one bounded bulk removal", () => {
    const workspace = makeRepo("/");
    const bytes = utf8.encode("tracked\n");
    const oid = workspace.repo.store.write("blob", bytes);
    const paths = Array.from(
      { length: 200 },
      (_, index) => `gone-${index.toString().padStart(3, "0")}/tracked.txt`,
    );
    paths.push("keep/tracked.txt");
    workspace.worktree.writeFiles(paths.map((path) => ({ path: `/${path}`, bytes })));
    workspace.worktree.makeDirectories(["/keep/untracked-empty"]);
    let recursiveRemovals = 0;
    let rmdirCalls = 0;
    const counted: Worktree = {
      ...workspace.worktree,
      removeFiles(removePaths, options) {
        if (options?.recursive === true) recursiveRemovals++;
        workspace.worktree.removeFiles(removePaths, options);
      },
      rmdir(path) {
        rmdirCalls++;
        workspace.worktree.rmdir(path);
      },
    };

    workspace.repo.store.withScratchIndex("directory-prune", (scratch) => {
      scratch.indexReplace(
        paths.map((path) => ({
          path,
          stage: 0,
          mode: 0o100644,
          oid,
          size: bytes.length,
          mtime: null,
          ino: null,
        })),
      );
      const beforeStatements = workspace.storage.statementCount;
      checkoutTree(
        workspace.repo,
        counted,
        null,
        {
          maxSourceRowsPerPass: 50_000,
          maxWorktreeRowsPerPass: 50_000,
          maxWriteBytes: 64 * 1024 * 1024,
        },
        scratch,
      );
      expect(workspace.storage.statementCount - beforeStatements).toBeLessThan(1_000);
      expect([...scratch.indexScan()]).toEqual([]);
    });

    expect(recursiveRemovals).toBe(1);
    expect(rmdirCalls).toBe(0);
    expect(workspace.worktree.stat("/gone-000")).toBeNull();
    expect(workspace.worktree.stat("/gone-199")).toBeNull();
    expect(workspace.worktree.stat("/keep")?.type).toBe("dir");
    expect(workspace.worktree.stat("/keep/untracked-empty")?.type).toBe("dir");
  });

  it("batches checkout directory-prune bindings below the platform ceiling", () => {
    const workspace = makeRepo("/");
    const oid = workspace.repo.store.write("blob", new Uint8Array(0));
    const suffix = "x".repeat(200);
    const directories = Array.from(
      { length: 6_000 },
      (_, index) => `d${index.toString().padStart(5, "0")}-${suffix}`,
    );
    const recursiveBatches: string[][] = [];
    const synthetic: Worktree = {
      ...workspace.worktree,
      scan(_root, options): ScanEntry[] {
        const after = options.after;
        const start = after === undefined ? 0 : Number.parseInt(after.slice(2, 7), 10) + 1;
        const rows: ScanEntry[] = [];
        for (
          let index = start;
          index < directories.length && rows.length < options.limit;
          index++
        ) {
          const directory = directories[index];
          if (directory === undefined) continue;
          rows.push({
            path: `/${directory}`,
            type: "dir",
            mode: 0o40755,
            size: 0,
            mtime: 1,
            ino: index + 2,
            nlink: 1,
            rev: 1,
            target: null,
            contentId: null,
          });
        }
        return rows;
      },
      removeFiles(paths, options) {
        if (options?.recursive === true) recursiveBatches.push([...paths]);
      },
    };

    workspace.repo.store.withScratchIndex("binding-batches", (scratch) => {
      scratch.indexReplace(
        directories.map((directory) => ({
          path: `${directory}/tracked.txt`,
          stage: 0,
          mode: 0o100644,
          oid,
          size: 0,
          mtime: null,
          ino: null,
        })),
      );
      const beforeStatements = workspace.storage.statementCount;
      checkoutTree(
        workspace.repo,
        synthetic,
        null,
        {
          maxSourceRowsPerPass: 50_000,
          maxWorktreeRowsPerPass: 50_000,
          maxWriteBytes: 64 * 1024 * 1024,
        },
        scratch,
      );
      expect(workspace.storage.statementCount - beforeStatements).toBeLessThan(1_000);
    });

    expect(recursiveBatches.length).toBeGreaterThan(1);
    expect(recursiveBatches.length).toBeLessThanOrEqual(16);
    for (const batch of recursiveBatches) {
      expect(utf8.encode(JSON.stringify(batch)).byteLength).toBeLessThanOrEqual(1_000_000);
    }
  });

  it("stages a 24,252-row scratch index through 513-row pages", () => {
    const workspace = makeRepo("/");
    const original = utf8.encode("original\n");
    const changed = utf8.encode("changed\n");
    const originalOid = workspace.repo.store.write("blob", original);
    const paths = Array.from(
      { length: 24_252 },
      (_, index) => `f${index.toString().padStart(5, "0")}.txt`,
    );
    const selected = paths.slice(0, 100);
    workspace.worktree.writeFiles(selected.map((path) => ({ path: `/${path}`, bytes: changed })));
    const rows = function* (): Generator<IndexEntry> {
      for (const path of paths) {
        yield {
          path,
          stage: 0,
          mode: 0o100644,
          oid: originalOid,
          size: original.length,
          mtime: null,
          ino: null,
        };
      }
    };
    const context: Pick<GitContext, "selectedPaths"> = {
      selectedPaths: {
        select() {
          throw new Error("scratch staging used the checkout-only selected-path source");
        },
      },
    };

    workspace.repo.store.withScratchIndex("scale", (scratch) => {
      scratch.indexReplace(rows());
      const paged = pageIndex(scratch, 513);
      const beforeStatements = workspace.storage.statementCount;
      add(workspace.repo, workspace.worktree, { paths: selected }, context, paged);
      const statements = workspace.storage.statementCount - beforeStatements;
      const changedOid = workspace.repo.store.write("blob", changed);
      expect(statements).toBeLessThan(1_000);
      expect(
        selected.every((path) =>
          [...paged.indexScan({ prefix: path })].some((entry) => entry.oid === changedOid),
        ),
      ).toBe(true);
      expect([...paged.indexScan({ prefix: paths[100] })][0]?.oid).toBe(originalOid);
    });
  });

  it("clears a selected index and rejects contradictory read-tree options", () => {
    const workspace = makeRepo("/");
    const oid = workspace.repo.store.write("blob", utf8.encode("entry\n"));

    workspace.repo.store.withScratchIndex("empty", (scratch) => {
      scratch.indexReplace([
        {
          path: "entry.txt",
          stage: 0,
          mode: 0o100644,
          oid,
          size: null,
          mtime: null,
          ino: null,
        },
      ]);
      readTree(workspace.repo, workspace.worktree, { empty: true }, scratch);
      expect([...scratch.indexScan()]).toEqual([]);

      for (const options of [
        {},
        { empty: true, tree: "HEAD" },
        { empty: true, updateWorktree: true },
      ]) {
        expect(() =>
          Reflect.apply(readTree, undefined, [
            workspace.repo,
            workspace.worktree,
            options,
            scratch,
          ]),
        ).toThrow(expect.objectContaining({ code: "EINVAL" }));
      }
    });
  });
});
