import { describe, expect, it } from "vitest";
import { utf8 } from "../packages/git/src/common/bytes.js";
import { MODE_FILE, MODE_TREE, serializeTree } from "../packages/git/src/common/objects.js";
import { checkoutTree } from "../packages/git/src/ops/checkout/checkout.js";
import type { IndexEntry } from "../packages/git/src/store/index.js";
import { makeRepo, type TestRepository } from "./helpers/workspace.js";

const EMPTY = new Uint8Array(0);

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

  it("refuses the 50,001st prune directory and leaves the state unchanged", () => {
    const workspace = makeRepo("/");
    const blob = workspace.repo.store.write("blob", EMPTY);
    const directories = Array.from(
      { length: 50_001 },
      (_, index) => `d${index.toString().padStart(5, "0")}`,
    );
    workspace.repo.checkout.indexReplace(directories.map((path) => indexed(`${path}/f`, blob)));
    workspace.worktree.writeFiles([
      { path: "/d00000/f", bytes: EMPTY },
      { path: "/d50000/f", bytes: EMPTY },
    ]);
    const beforeIndex = indexState(workspace);
    const beforeWorktree = worktreeState(workspace);

    expect(() =>
      workspace.repo.store.db.transactionSync(() =>
        checkoutTree(workspace.repo, workspace.worktree, null),
      ),
    ).toThrowError(
      expect.objectContaining({ code: "E2BIG", message: expect.stringContaining("50000 paths") }),
    );

    expect(indexState(workspace)).toEqual(beforeIndex);
    expect(worktreeState(workspace)).toEqual(beforeWorktree);
  });
});
