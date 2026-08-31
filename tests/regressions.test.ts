import { describe, expect, it } from "vitest";
import { commit as commitOp } from "../src/git/ops/commit.js";
import { branch, checkout } from "../src/git/ops/refs.js";
import { add } from "../src/git/ops/staging.js";
import { dirtyPaths } from "../src/git/ops/worktree-io.js";
import {
  makeRepo,
  makeWorkspace,
  type TestRepository,
  writeWorkFile,
} from "./helpers/workspace.js";

function stage(ws: TestRepository, path: string): void {
  add(ws.repo, ws.worktree, { paths: [path] });
}

function commit(ws: TestRepository, message: string): void {
  ws.repo.store.configSet("user.name", "Fixture");
  ws.repo.store.configSet("user.email", "fixture@example.com");
  ws.tick(1000);
  commitOp(ws.context, ws.repo, { message });
}

describe("regressions", () => {
  it("reports a symlink as a symlink from readdir", () => {
    const ws = makeWorkspace();
    writeWorkFile(ws, "/target.txt", "x");
    ws.worktree.symlink("target.txt", "/link.txt");
    ws.worktree.makeDirectories(["/dir"]);
    expect(ws.worktree.readdir("/")).toEqual([
      { name: "dir", type: "dir" },
      { name: "link.txt", type: "symlink" },
      { name: "target.txt", type: "file" },
    ]);
  });

  it("does not hand back a destroyed repository's store, even at the same root", () => {
    const ws = makeWorkspace();
    const first = ws.database.createRepository("/", "ref: refs/heads/main");
    const storeA = ws.database.openCheckout(first);
    storeA.write("blob", new TextEncoder().encode("gone"));
    storeA.destroy();

    // Repository identities remain monotonic after destruction.
    const second = ws.database.createRepository("/", "ref: refs/heads/other");
    expect(second.repoId).toBeGreaterThan(first.repoId);
    const storeB = ws.database.openCheckout(second);
    expect(storeB).not.toBe(storeA);
    expect(storeB.objectCount()).toBe(0);
  });
});

describe("checkout refuses what git refuses", () => {
  function twoBranches() {
    const ws = makeRepo("/");
    writeWorkFile(ws, "/a.txt", "one\n");
    stage(ws, "a.txt");
    commit(ws, "first");
    branch(ws.context, ws.repo, { name: "topic" });
    writeWorkFile(ws, "/a.txt", "two\n");
    writeWorkFile(ws, "/new.txt", "added on main\n");
    stage(ws, "a.txt");
    stage(ws, "new.txt");
    commit(ws, "second");
    return ws;
  }

  it("refuses when a staged change would be lost, even with a clean worktree", () => {
    const ws = twoBranches();
    writeWorkFile(ws, "/a.txt", "staged only\n");
    stage(ws, "a.txt");
    // The working tree now matches the index exactly, so a worktree-vs-index
    // comparison sees nothing — but the staged change is still uncommitted.
    expect(dirtyPaths(ws.repo, ws.worktree)).toEqual([]);
    expect(() => checkout(ws.context, ws.repo, ws.worktree, { ref: "topic" })).toThrow(
      /local changes/,
    );
    checkout(ws.context, ws.repo, ws.worktree, { ref: "topic", force: true });
    expect(ws.repo.head().ref).toBe("refs/heads/topic");
  });

  it("refuses to write over an untracked file", () => {
    const ws = twoBranches();
    checkout(ws.context, ws.repo, ws.worktree, { ref: "topic" });
    // `new.txt` exists only on main; recreate it by hand and switch back.
    writeWorkFile(ws, "/new.txt", "mine, not git's\n");
    expect(() => checkout(ws.context, ws.repo, ws.worktree, { ref: "main" })).toThrow(
      /untracked working tree files/,
    );
    expect(new TextDecoder().decode(ws.worktree.readFile("/new.txt"))).toBe("mine, not git's\n");
  });
});
