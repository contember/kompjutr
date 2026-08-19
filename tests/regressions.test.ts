import { describe, expect, it } from "vitest";
import { makeWorkspace, writeWorkFile } from "./helpers/workspace.js";

describe("regressions", () => {
  it("reports a symlink as a symlink from readdir", () => {
    const ws = makeWorkspace();
    writeWorkFile(ws, "/target.txt", "x");
    ws.worktree.symlink("target.txt", "/link.txt");
    ws.worktree.mkdirp("/dir");
    expect(ws.worktree.readdir("/")).toEqual([
      { name: "dir", type: "directory" },
      { name: "link.txt", type: "symlink" },
      { name: "target.txt", type: "file" },
    ]);
  });

  it("does not hand back a destroyed repository's store, even at the same root", () => {
    const ws = makeWorkspace();
    const first = ws.database.create("/", "ref: refs/heads/main");
    const storeA = ws.database.open(first);
    storeA.write("blob", new TextEncoder().encode("gone"));
    storeA.destroy();

    // A failed clone frees the id; the next create reuses it.
    const second = ws.database.create("/", "ref: refs/heads/other");
    expect(second.id).toBe(first.id);
    const storeB = ws.database.open(second);
    expect(storeB).not.toBe(storeA);
    expect(storeB.objectCount()).toBe(0);
  });
});
