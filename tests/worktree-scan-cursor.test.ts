import { describe, expect, it } from "vitest";
import type { ScanEntry, ScanOptions } from "../packages/do/src/fs/types.js";
import type { Worktree } from "../packages/git/src/ops/worktree/worktree.js";
import {
  WORKTREE_SCAN_PAGE,
  walkWorktreeEntriesStreamOwned,
} from "../packages/git/src/ops/worktree/worktree-io.js";
import { makeWorkspace } from "./helpers/workspace.js";

/**
 * A drive that pages the same rows forever would never let the walk terminate,
 * so the walk must reject it. An unbounded regression is an infinite
 * synchronous loop that no test timeout can interrupt, so every walk here also
 * carries `maxScanRows`: a miss then fails as E2BIG instead of hanging.
 */
const SCAN_ROW_CEILING = WORKTREE_SCAN_PAGE * 3;

function file(path: string): ScanEntry {
  return {
    path,
    type: "file",
    mode: 0o644,
    size: 0,
    mtime: 0,
    ino: 1,
    nlink: 1,
    rev: 1,
    target: null,
    contentId: null,
  };
}

function directory(path: string): ScanEntry {
  return { ...file(path), type: "dir", mode: 0o755 };
}

/** One full page whose tail sits inside the pruned directory `/d`. */
function prunedTailPage(): ScanEntry[] {
  const page: ScanEntry[] = [directory("/d")];
  for (let ordinal = 1; ordinal < WORKTREE_SCAN_PAGE; ordinal++) {
    page.push(file(`/d/f${String(ordinal).padStart(4, "0")}`));
  }
  return page;
}

/** A drive that honours `after` and answers every `afterSubtree` with `page`. */
function subtreeCursorDrive(inner: Worktree, page: ScanEntry[]): Worktree {
  const first = prunedTailPage();
  return new Proxy(inner, {
    get(target, property, receiver) {
      if (property === "scan") {
        return (_root: string, options: ScanOptions): ScanEntry[] => {
          if (options.afterSubtree !== undefined) return page;
          return options.after === undefined ? first : [];
        };
      }
      const value = Reflect.get(target, property, receiver);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
}

describe("worktree scan cursor", () => {
  it("fails a drive that ignores afterSubtree instead of paging the same rows forever", () => {
    const stubborn = subtreeCursorDrive(makeWorkspace().worktree, prunedTailPage());

    expect(() => [
      ...walkWorktreeEntriesStreamOwned(stubborn, "/", {
        pruneDirectory: (path) => path === "d",
        maxScanRows: SCAN_ROW_CEILING,
      }),
    ]).toThrowError(expect.objectContaining({ code: "ECORRUPT" }));
  }, 10_000);

  it("still walks past a pruned subtree when the drive honours afterSubtree", () => {
    const honest = subtreeCursorDrive(makeWorkspace().worktree, [file("/e.txt")]);

    const walked = [
      ...walkWorktreeEntriesStreamOwned(honest, "/", {
        pruneDirectory: (path) => path === "d",
        maxScanRows: SCAN_ROW_CEILING,
      }),
    ];

    expect(walked.map((entry) => entry.path)).toEqual(["e.txt"]);
  });
});
