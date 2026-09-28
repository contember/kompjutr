import { mkdirSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";
import { utf8 } from "../packages/git/src/common/bytes.js";
import {
  MODE_FILE,
  MODE_TREE,
  serializeCommit,
  serializeTree,
} from "../packages/git/src/common/objects.js";
import { comparePaths } from "../packages/git/src/common/streams.js";
import { checkoutTree } from "../packages/git/src/ops/checkout/checkout.js";
import { Repository } from "../packages/git/src/ops/repository/repository.js";
import { reset } from "../packages/git/src/ops/staging/staging-reset.js";
import type { Worktree } from "../packages/git/src/ops/worktree/worktree.js";
import type { IndexEntry } from "../packages/git/src/store/index.js";
import { makeRepo, type TestRepository } from "./helpers/workspace.js";
import { localFixture } from "./local/helpers.js";

const EMPTY = new Uint8Array(0);
const PERSON = { name: "Bounds", email: "bounds@example.com", timestamp: 1, timezoneOffset: 0 };

function indexed(path: string, oid: string, stage = 0): IndexEntry {
  return { path, stage, mode: 0o100644, oid, size: 0, mtime: null, ino: null };
}

function indexState(workspace: TestRepository): string[] {
  return [...workspace.repo.checkout.indexScan()].map(
    (entry) => `${entry.stage} ${entry.oid} ${entry.path}`,
  );
}

function worktreeState(workspace: TestRepository): string[] {
  return workspace.worktree
    .scan("/", { limit: 100_000 })
    .map((entry) => `${entry.type} ${entry.path}`);
}

/** Write one nested tree per path, so each path keeps every segment it names. */
function nestedTree(workspace: TestRepository, paths: readonly string[], blob: string): string {
  const store = workspace.repo.store;
  const top = paths.map((path) => {
    const segments = path.split("/");
    let oid = blob;
    let mode = MODE_FILE;
    for (let depth = segments.length - 1; depth > 0; depth--) {
      const name = segments[depth];
      if (name === undefined) throw new Error("nested tree lost a segment");
      oid = store.write("tree", serializeTree([{ mode, name, oid }]));
      mode = MODE_TREE;
    }
    const name = segments[0];
    if (name === undefined) throw new Error("nested tree lost its top segment");
    return { mode, name, oid };
  });
  return store.write("tree", serializeTree(top));
}

describe("checkout count caps", () => {
  it("refuses the 10,001st conflict path before any mutation", () => {
    const workspace = makeRepo("/");
    const blob = workspace.repo.store.write("blob", EMPTY);
    const conflicts = Array.from(
      { length: 10_001 },
      (_, index) => `c${index.toString().padStart(5, "0")}`,
    );
    workspace.repo.checkout.indexReplace(
      conflicts.flatMap((path) => [indexed(path, blob, 2), indexed(path, blob, 3)]),
    );
    workspace.worktree.writeFiles([
      { path: "/c00000", bytes: utf8.encode("ours\n") },
      { path: "/c10000", bytes: utf8.encode("ours\n") },
    ]);
    const beforeIndex = indexState(workspace);
    const beforeWorktree = worktreeState(workspace);

    expect(() =>
      workspace.repo.store.db.transactionSync(() =>
        checkoutTree(workspace.repo, workspace.worktree, null, {
          discardUnmerged: true,
          restoreStructure: true,
        }),
      ),
    ).toThrowError(
      expect.objectContaining({ code: "E2BIG", message: expect.stringContaining("10000 paths") }),
    );

    expect(indexState(workspace)).toEqual(beforeIndex);
    expect(worktreeState(workspace)).toEqual(beforeWorktree);
  });

  it("discards 10,000 conflicts whose paths are about 1 KiB each", () => {
    const workspace = makeRepo("/");
    const blob = workspace.repo.store.write("blob", EMPTY);
    const stem = "x".repeat(1_018);
    const conflicts = Array.from(
      { length: 10_000 },
      (_, index) => `c${index.toString().padStart(5, "0")}${stem}`,
    );
    workspace.repo.checkout.indexReplace(
      conflicts.flatMap((path) => [indexed(path, blob, 2), indexed(path, blob, 3)]),
    );
    workspace.worktree.writeFiles([
      { path: `/${conflicts[0]}`, bytes: utf8.encode("ours\n") },
      { path: `/${conflicts[9_999]}`, bytes: utf8.encode("ours\n") },
    ]);

    workspace.repo.store.db.transactionSync(() =>
      checkoutTree(workspace.repo, workspace.worktree, null, {
        discardUnmerged: true,
        restoreStructure: true,
      }),
    );

    expect(indexState(workspace)).toEqual([]);
    expect(worktreeState(workspace)).toEqual([]);
  });

  it("prunes 20 files of 8 KiB paths under distinct top directories", () => {
    const workspace = makeRepo("/");
    const blob = workspace.repo.store.write("blob", utf8.encode("deep\n"));
    const paths = Array.from({ length: 20 }, (_, file) =>
      Array.from(
        { length: 127 },
        (_, depth) =>
          `${file.toString().padStart(2, "0")}-${depth.toString().padStart(3, "0")}-${"s".repeat(56)}`,
      ).join("/"),
    );
    for (const path of paths) {
      expect(utf8.encode(path).length).toBeGreaterThan(8_000);
      expect(utf8.encode(path).length).toBeLessThanOrEqual(8_192);
    }
    const tree = nestedTree(workspace, paths, blob);
    workspace.repo.store.db.transactionSync(() =>
      checkoutTree(workspace.repo, workspace.worktree, tree),
    );
    expect(indexState(workspace)).toHaveLength(20);

    workspace.repo.store.db.transactionSync(() =>
      checkoutTree(workspace.repo, workspace.worktree, null),
    );

    expect(indexState(workspace)).toEqual([]);
    expect(worktreeState(workspace)).toEqual([]);
  });

  it("rolls back streamed removals when the 50,001st prune directory refuses", () => {
    const workspace = makeRepo("/");
    const blob = workspace.repo.store.write("blob", EMPTY);
    const fixture = pruneOverflowFixture();
    workspace.worktree.writeFiles(
      fixture.shallow.map((path) => ({ path: `/${path}`, bytes: EMPTY })),
    );
    workspace.repo.checkout.indexReplace(
      [...fixture.shallow, ...fixture.deep].map((path) => indexed(path, blob)),
    );
    const beforeIndex = indexState(workspace);
    const beforeWorktree = worktreeState(workspace);
    let removedBeforeRefusal = 0;
    const counting: Worktree = {
      ...workspace.worktree,
      removeFiles(paths, options) {
        removedBeforeRefusal += paths.length;
        workspace.worktree.removeFiles(paths, options);
      },
    };

    expect(() =>
      workspace.repo.store.db.transactionSync(() => checkoutTree(workspace.repo, counting, null)),
    ).toThrowError(
      expect.objectContaining({ code: "E2BIG", message: expect.stringContaining("50000 paths") }),
    );

    expect(removedBeforeRefusal).toBeGreaterThan(0);
    expect(indexState(workspace)).toEqual(beforeIndex);
    expect(worktreeState(workspace)).toEqual(beforeWorktree);
  });
});

/**
 * Shallow files fill more than one removal window before the deep, index-only
 * rows cross the 50,000-directory prune cap.
 */
function pruneOverflowFixture(): { shallow: string[]; deep: string[] } {
  const shallow = Array.from(
    { length: 6_000 },
    (_, index) => `a/${index.toString().padStart(4, "0")}${"n".repeat(196)}`,
  );
  const segments = Array.from(
    { length: 125 },
    (_, depth) => `s${depth.toString().padStart(3, "0")}`,
  );
  const deep = Array.from(
    { length: 400 },
    (_, index) => `b/f${index.toString().padStart(3, "0")}/${segments.join("/")}/leaf`,
  );
  return { shallow, deep };
}

describe("streamed checkout removals", () => {
  it("checks out 1,100 near-8 KiB paths to the empty tree", () => {
    const workspace = makeRepo("/");
    const blob = workspace.repo.store.write("blob", EMPTY);
    const tree = workspace.repo.store.write(
      "tree",
      serializeTree(
        Array.from({ length: 1_100 }, (_, index) => ({
          mode: MODE_FILE,
          name: `${index.toString().padStart(5, "0")}${"x".repeat(8_000)}`,
          oid: blob,
        })),
      ),
    );
    workspace.repo.store.db.transactionSync(() =>
      checkoutTree(workspace.repo, workspace.worktree, tree),
    );
    expect(indexState(workspace)).toHaveLength(1_100);

    workspace.repo.store.db.transactionSync(() =>
      checkoutTree(workspace.repo, workspace.worktree, null),
    );

    expect(indexState(workspace)).toEqual([]);
    expect(worktreeState(workspace)).toEqual([]);
  });

  it("checks out 80,000 paths of 64 characters in 1,000 directories to the empty tree", () => {
    const workspace = makeRepo("/");
    const blob = workspace.repo.store.write("blob", utf8.encode("s"));
    const leaves = workspace.repo.store.write(
      "tree",
      serializeTree(
        Array.from({ length: 80 }, (_, index) => ({
          mode: MODE_FILE,
          name: `f${index.toString().padStart(2, "0")}-`.padEnd(59, "p"),
          oid: blob,
        })),
      ),
    );
    const tree = workspace.repo.store.write(
      "tree",
      serializeTree(
        Array.from({ length: 1_000 }, (_, index) => ({
          mode: MODE_TREE,
          name: `d${index.toString().padStart(3, "0")}`,
          oid: leaves,
        })),
      ),
    );
    workspace.repo.store.db.transactionSync(() =>
      checkoutTree(workspace.repo, workspace.worktree, tree),
    );
    const paths = [...workspace.repo.checkout.indexScan()].map((entry) => entry.path);
    expect(paths).toHaveLength(80_000);
    expect(paths.every((path) => path.length === 64)).toBe(true);

    const before = workspace.storage.statementCount;
    workspace.repo.store.db.transactionSync(() =>
      checkoutTree(workspace.repo, workspace.worktree, null),
    );

    expect(workspace.storage.statementCount - before).toBeLessThan(1_000);
    expect(workspace.repo.checkout.indexScan().next().done).toBe(true);
    expect(workspace.worktree.scan("/", { limit: 1 })).toEqual([]);
  });

  it("caps hard-reset structural state at 50,000 paths and rolls back the conflict discard", () => {
    const leafChildren = (count: number) =>
      Array.from(
        { length: count },
        (_, index) => `x/${index.toString().padStart(5, "0")}${"c".repeat(195)}`,
      );
    const hardResetFixture = (children: readonly string[]) => {
      const workspace = makeRepo("/");
      const blob = workspace.repo.store.write("blob", utf8.encode("keep\n"));
      const tree = workspace.repo.store.write(
        "tree",
        serializeTree([{ mode: MODE_FILE, name: "keep.txt", oid: blob }]),
      );
      const commit = workspace.repo.store.write(
        "commit",
        serializeCommit({
          tree,
          parent: [],
          author: PERSON,
          committer: PERSON,
          message: "keep\n",
        }),
      );
      workspace.repo.checkout.indexReplace([
        indexed("conflict.txt", blob, 2),
        indexed("conflict.txt", blob, 3),
        ...children.map((path) => indexed(path, blob)),
      ]);
      workspace.worktree.writeFiles([
        { path: "/conflict.txt", bytes: utf8.encode("ours\n") },
        { path: "/x", bytes: utf8.encode("leaf\n") },
      ]);
      return { workspace, commit };
    };

    const atCap = hardResetFixture(leafChildren(49_999));
    reset(atCap.workspace.context, atCap.workspace.repo, atCap.workspace.worktree, {
      hard: true,
      ref: atCap.commit,
    });
    expect([...atCap.workspace.repo.checkout.indexScan()].map((entry) => entry.path)).toEqual([
      "keep.txt",
    ]);
    expect(atCap.workspace.worktree.stat("/x")?.type).toBe("file");

    const over = hardResetFixture(leafChildren(50_000));
    const beforeIndex = indexState(over.workspace);
    const beforeWorktree = worktreeState(over.workspace);
    const beforeHead = over.workspace.repo.head();
    expect(() =>
      reset(over.workspace.context, over.workspace.repo, over.workspace.worktree, {
        hard: true,
        ref: over.commit,
      }),
    ).toThrowError(
      expect.objectContaining({
        code: "E2BIG",
        message: expect.stringContaining("structural state exceeds 50000 paths"),
      }),
    );

    expect(over.workspace.repo.head()).toEqual(beforeHead);
    expect(indexState(over.workspace)).toEqual(beforeIndex);
    expect(worktreeState(over.workspace)).toEqual(beforeWorktree);
  });

  it("restores the local disk and index after a mid-stream prune refusal", async () => {
    const fixture = localFixture();
    let backups = 0;
    const workspace = fixture.workspace({
      recoveryCheckpoint(checkpoint) {
        if (checkpoint === "backup-moved") backups++;
      },
    });
    try {
      await workspace.git.init();
      const checkout = workspace.gitDatabase.findCheckout("/");
      if (checkout === null) throw new Error("repository is missing");
      const repository = new Repository(workspace.gitDatabase.openCheckout(checkout));
      const blob = repository.store.write("blob", EMPTY);
      const rows = pruneOverflowFixture();
      mkdirSync(join(fixture.root, "a"));
      for (const path of rows.shallow) writeFileSync(join(fixture.root, path), "");
      repository.checkout.indexReplace(
        [...rows.shallow, ...rows.deep].map((path) => indexed(path, blob)),
      );
      const beforeIndex = [...repository.checkout.indexScan()].map((entry) => entry.path);

      expect(() =>
        workspace.database.transactionSync(() => checkoutTree(repository, workspace.drive, null)),
      ).toThrowError(
        expect.objectContaining({ code: "E2BIG", message: expect.stringContaining("50000 paths") }),
      );

      expect(backups).toBeGreaterThan(0);
      expect(readdirSync(join(fixture.root, "a")).sort(comparePaths)).toEqual(
        rows.shallow.map((path) => path.slice("a/".length)),
      );
      expect(readdirSync(fixture.root)).toEqual(["a"]);
      expect([...repository.checkout.indexScan()].map((entry) => entry.path)).toEqual(beforeIndex);
    } finally {
      workspace.close();
      fixture.dispose();
    }
  });
});
