import { describe, expect, it } from "vitest";
import { SCAN_STREAM_PAGE } from "../packages/do/src/fs/store/scan/scan-stream.js";
import type { ScanEntry } from "../packages/do/src/fs/types.js";
import { hashObject } from "../packages/git/src/common/objects.js";
import type { Worktree } from "../packages/git/src/ops/worktree/worktree.js";
import {
  dirtyPaths,
  walkWorktreeEntriesStream,
} from "../packages/git/src/ops/worktree/worktree-io.js";
import { makeRepo, makeWorkspace } from "./helpers/workspace.js";

/** A drive whose stream yields every row twice. */
function repeatingDrive(inner: Worktree): Worktree {
  return {
    ...inner,
    *scanStream(root, options): Generator<ScanEntry> {
      for (const entry of inner.scanStream(root, options)) {
        yield entry;
        yield entry;
      }
    },
  };
}

/** One full page whose tail sits inside the directory `/d`, then `/e.txt`. */
function prunedTailWorkspace(): ReturnType<typeof makeWorkspace> {
  const workspace = makeWorkspace();
  const bytes = new TextEncoder().encode("x");
  const entries = [{ path: "/e.txt", bytes }];
  for (let ordinal = 1; ordinal <= SCAN_STREAM_PAGE; ordinal++) {
    entries.push({ path: `/d/f${String(ordinal).padStart(4, "0")}`, bytes });
  }
  workspace.worktree.writeFiles(entries);
  return workspace;
}

describe("worktree scan cursor", () => {
  it("restarts past a pruned subtree when a page ends inside it", () => {
    const workspace = prunedTailWorkspace();
    workspace.storage.resetCounters();

    const walked = [
      ...walkWorktreeEntriesStream(workspace.worktree, "/", {
        pruneDirectory: (path) => path === "d",
      }),
    ];

    expect(walked.map((entry) => entry.path)).toEqual(["e.txt"]);
    // realpath, the first page, and one page resumed past `/d`.
    expect(workspace.storage.statementCount).toBe(3);
  });

  it("resumes a drive stream strictly after the given path", () => {
    const workspace = prunedTailWorkspace();
    const root = workspace.worktree.realpath("/");

    const resumed = [
      ...workspace.worktree.scanStream(root, { filesOnly: true, after: "/d/f0999" }),
    ];

    expect(resumed.map((entry) => entry.path)).toEqual(["/d/f1000", "/e.txt"]);
  });

  it("fails closed when a drive repeats a row", () => {
    const workspace = makeRepo("/");
    const bytes = new TextEncoder().encode("x\n");
    workspace.worktree.writeFiles([{ path: "/a.txt", bytes }]);
    workspace.repo.checkout.indexPut({
      path: "a.txt",
      stage: 0,
      mode: 0o100644,
      oid: hashObject("blob", bytes),
      size: null,
      mtime: null,
      ino: null,
    });
    const repeating = repeatingDrive(workspace.worktree);

    expect(() => [...walkWorktreeEntriesStream(repeating, "/")]).toThrowError(
      expect.objectContaining({ code: "ECORRUPT" }),
    );
    expect(() => dirtyPaths(workspace.repo, repeating)).toThrowError(
      expect.objectContaining({ code: "ECORRUPT" }),
    );
  });
});
