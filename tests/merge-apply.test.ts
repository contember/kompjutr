import { describe, expect, it } from "vitest";

import { fromHex, utf8, utf8Decoder } from "../src/core/bytes.js";
import { hashObject } from "../src/core/objects.js";
import {
  abortProjectedMerge,
  applyProjectedMerge,
  calculateOperationRestoreSqlStatements,
  MAX_MERGE_APPLY_PRIOR_SQL_STATEMENTS,
  MAX_MERGE_APPLY_SQL_STATEMENTS,
  type MergeApplyMetadata,
} from "../src/core/ops/merge-apply.js";
import type { ProjectedMergeEntry } from "../src/core/ops/merge-projection.js";
import type { MergeJournal, MergeTouchedPath } from "../src/core/ops/merge-state.js";
import type { Repository } from "../src/core/repository.js";
import { makeRepo, type TestRepository } from "./helpers/workspace.js";

function commit(repo: Repository, digit: string): string {
  return repo.store.write("commit", utf8.encode(`tree ${digit.repeat(40)}\n\ncommit ${digit}\n`));
}

function metadata(repo: Repository, mode: "commit" | "no-commit" = "commit"): MergeApplyMetadata {
  const current = commit(repo, "1");
  const incoming = commit(repo, "2");
  return {
    originalHeadRef: "refs/heads/main",
    originalHeadOid: current,
    currentParentOid: current,
    incomingParentOid: incoming,
    mode,
    mergeOrigin: "merge",
    currentLabel: "HEAD",
    incomingLabel: "topic",
    message: "Merge branch 'topic'\n",
    author: null,
    committer: null,
  };
}

function blob(repo: Repository, text: string): { mode: string; oid: string } {
  return { mode: "100644", oid: repo.store.write("blob", utf8.encode(text)) };
}

function seedFile(workspace: TestRepository, path: string, text: string): string {
  const identity = blob(workspace.repo, text);
  workspace.worktree.writeFiles([
    {
      path: `/${path}`,
      bytes: utf8.encode(text),
      contentId: fromHex(identity.oid),
    },
  ]);
  const stat = workspace.worktree.stat(`/${path}`);
  if (stat === null) throw new Error(`failed to seed ${path}`);
  workspace.repo.store.indexPut({
    path,
    stage: 0,
    mode: 0o100644,
    oid: identity.oid,
    size: stat.size,
    mtime: stat.mtime,
    ino: stat.ino,
    rev: stat.rev,
  });
  return identity.oid;
}

function textAt(workspace: TestRepository, path: string): string | null {
  const stat = workspace.worktree.stat(`/${path}`);
  return stat === null ? null : utf8Decoder.decode(workspace.worktree.readFile(`/${path}`));
}

describe("projected merge apply", () => {
  it("accepts recovery statement 999 and rejects statement 1000 exactly", () => {
    const emptyTail = {
      worktreeScanPages: 0,
      blobReadCalls: 0,
      worktreeWriteCalls: 0,
      worktreeWriteBytes: 0,
      indexMutations: 0,
      hasRemovals: false,
      clearState: false,
    };
    const tail = calculateOperationRestoreSqlStatements(0, emptyTail).applySqlStatements;
    expect(calculateOperationRestoreSqlStatements(999 - tail, emptyTail).totalSqlStatements).toBe(
      999,
    );
    expect(calculateOperationRestoreSqlStatements(1_000 - tail, emptyTail).totalSqlStatements).toBe(
      1_000,
    );
  });

  it("reserves a bounded apply share of the whole-operation SQL limit", () => {
    expect(MAX_MERGE_APPLY_SQL_STATEMENTS).toBe(831);
    expect(MAX_MERGE_APPLY_PRIOR_SQL_STATEMENTS).toBe(168);
    expect(MAX_MERGE_APPLY_PRIOR_SQL_STATEMENTS + MAX_MERGE_APPLY_SQL_STATEMENTS).toBe(999);
    expect(MAX_MERGE_APPLY_SQL_STATEMENTS).toBeLessThan(1_000);
  });

  it("does not retain rollback blobs for a clean commit-mode outcome", () => {
    const workspace = makeRepo();
    const oldBytes = utf8.encode("unretained original\n");
    const oldOid = hashObject("blob", oldBytes);
    workspace.worktree.writeFiles([{ path: "/clean.txt", bytes: oldBytes }]);
    const next = blob(workspace.repo, "next\n");
    const entries: readonly ProjectedMergeEntry[] = [
      {
        path: "clean.txt",
        logicalPath: "clean.txt",
        purpose: "primary",
        stageZero: next,
        stages: null,
        worktree: next,
        content: null,
      },
    ];

    const result = workspace.repo.store.db.transactionSync(() =>
      applyProjectedMerge(workspace.repo, workspace.worktree, entries, metadata(workspace.repo)),
    );

    expect(result).toEqual({ outcome: "clean", journal: null, sqlStatements: 29 });
    expect(workspace.repo.has(oldOid)).toBe(false);
    expect(textAt(workspace, "clean.txt")).toBe("next\n");
  });

  it("composes a small apply with prior virtual-base work", () => {
    const workspace = makeRepo();
    workspace.worktree.writeFiles([{ path: "/small.txt", bytes: utf8.encode("old\n") }]);
    const next = blob(workspace.repo, "next\n");
    const entries: readonly ProjectedMergeEntry[] = [
      {
        path: "small.txt",
        logicalPath: "small.txt",
        purpose: "primary",
        stageZero: next,
        stages: null,
        worktree: next,
        content: null,
      },
    ];

    const result = workspace.repo.store.db.transactionSync(() =>
      applyProjectedMerge(workspace.repo, workspace.worktree, entries, metadata(workspace.repo), {
        priorSqlStatements: 279,
      }),
    );

    expect(279 + result.sqlStatements).toBeLessThan(1_000);
    expect(textAt(workspace, "small.txt")).toBe("next\n");
  });

  it("rejects an exhausted prior budget before writing the worktree or index", () => {
    const workspace = makeRepo();
    workspace.worktree.writeFiles([{ path: "/guarded.txt", bytes: utf8.encode("old\n") }]);
    const next = blob(workspace.repo, "next\n");
    const entries: readonly ProjectedMergeEntry[] = [
      {
        path: "guarded.txt",
        logicalPath: "guarded.txt",
        purpose: "primary",
        stageZero: next,
        stages: null,
        worktree: next,
        content: null,
      },
    ];

    expect(() =>
      workspace.repo.store.db.transactionSync(() =>
        applyProjectedMerge(workspace.repo, workspace.worktree, entries, metadata(workspace.repo), {
          priorSqlStatements: 999,
        }),
      ),
    ).toThrow(expect.objectContaining({ code: "E2BIG" }));
    expect(textAt(workspace, "guarded.txt")).toBe("old\n");
    expect(workspace.repo.store.indexGet("guarded.txt")).toBeNull();
    expect(workspace.repo.store.readMergeState()).toBeNull();
  });

  it("bounds structural ancestors while they are retained", () => {
    const workspace = makeRepo();
    const path = `${"a/".repeat(1_000)}z`;
    const entries: readonly ProjectedMergeEntry[] = [
      {
        path,
        logicalPath: path,
        purpose: "primary",
        stageZero: null,
        stages: null,
        worktree: null,
        content: null,
      },
    ];

    expect(() =>
      applyProjectedMerge(
        workspace.repo,
        workspace.worktree,
        entries,
        metadata(workspace.repo, "no-commit"),
      ),
    ).toThrowError(expect.objectContaining({ code: "E2BIG" }));
    expect(workspace.repo.store.readMergeState()).toBeNull();
  });

  it("applies clean text, add, and delete entries and durably restores them", () => {
    const workspace = makeRepo();
    const oldA = seedFile(workspace, "a.txt", "old\n");
    const oldDeleted = seedFile(workspace, "deleted.txt", "keep me\n");
    const newA = blob(workspace.repo, "merged\n");
    const added = blob(workspace.repo, "added\n");
    const entries: readonly ProjectedMergeEntry[] = [
      {
        path: "a.txt",
        logicalPath: "a.txt",
        purpose: "primary",
        stageZero: newA,
        stages: null,
        worktree: newA,
        content: utf8.encode("merged\n"),
      },
      {
        path: "added.txt",
        logicalPath: "added.txt",
        purpose: "primary",
        stageZero: added,
        stages: null,
        worktree: added,
        content: null,
      },
      {
        path: "deleted.txt",
        logicalPath: "deleted.txt",
        purpose: "primary",
        stageZero: null,
        stages: null,
        worktree: null,
        content: null,
      },
    ];

    const result = workspace.repo.store.db.transactionSync(() =>
      applyProjectedMerge(
        workspace.repo,
        workspace.worktree,
        entries,
        metadata(workspace.repo, "no-commit"),
      ),
    );

    expect(result.outcome).toBe("ready");
    expect(result.journal?.state.phase).toBe("ready");
    expect(textAt(workspace, "a.txt")).toBe("merged\n");
    expect(textAt(workspace, "added.txt")).toBe("added\n");
    expect(textAt(workspace, "deleted.txt")).toBeNull();
    expect(workspace.repo.store.indexGet("a.txt")?.oid).toBe(newA.oid);
    expect(workspace.repo.store.indexGet("added.txt")?.oid).toBe(added.oid);
    expect(workspace.repo.store.indexGet("deleted.txt")).toBeNull();

    const journal = workspace.repo.store.requireMergeState();
    workspace.repo.store.db.transactionSync(() =>
      abortProjectedMerge(workspace.repo, workspace.worktree, journal),
    );

    expect(workspace.repo.store.readMergeState()).toBeNull();
    expect(textAt(workspace, "a.txt")).toBe("old\n");
    expect(textAt(workspace, "added.txt")).toBeNull();
    expect(textAt(workspace, "deleted.txt")).toBe("keep me\n");
    expect(workspace.repo.store.indexGet("a.txt")?.oid).toBe(oldA);
    expect(workspace.repo.store.indexGet("deleted.txt")?.oid).toBe(oldDeleted);
  });

  it("writes binary conflict content and replaces stage zero with stages 1, 2, and 3", () => {
    const workspace = makeRepo();
    seedFile(workspace, "binary.dat", "current\0bytes");
    const base = blob(workspace.repo, "base\0bytes");
    const current = blob(workspace.repo, "current\0bytes");
    const incoming = blob(workspace.repo, "incoming\0bytes");
    const entries: readonly ProjectedMergeEntry[] = [
      {
        path: "binary.dat",
        logicalPath: "binary.dat",
        purpose: "primary",
        stageZero: null,
        stages: { base, current, incoming },
        worktree: current,
        content: utf8.encode("current\0bytes"),
      },
    ];

    const result = workspace.repo.store.db.transactionSync(() =>
      applyProjectedMerge(workspace.repo, workspace.worktree, entries, metadata(workspace.repo)),
    );

    expect(result.outcome).toBe("conflicted");
    expect(workspace.repo.store.indexGet("binary.dat", 0)).toBeNull();
    expect(workspace.repo.store.indexGet("binary.dat", 1)?.oid).toBe(base.oid);
    expect(workspace.repo.store.indexGet("binary.dat", 2)?.oid).toBe(current.oid);
    expect(workspace.repo.store.indexGet("binary.dat", 3)?.oid).toBe(incoming.oid);
    expect(textAt(workspace, "binary.dat")).toBe("current\0bytes");
    expect(workspace.repo.store.requireMergeState().state.phase).toBe("conflicted");
  });

  it("applies and aborts a current-file/incoming-directory projection", () => {
    const workspace = makeRepo();
    const current = blob(workspace.repo, "current file\n");
    seedFile(workspace, "x", "current file\n");
    const incoming = blob(workspace.repo, "incoming child\n");
    const entries: readonly ProjectedMergeEntry[] = [
      {
        path: "x/y",
        logicalPath: "x/y",
        purpose: "primary",
        stageZero: incoming,
        stages: null,
        worktree: incoming,
        content: null,
      },
      {
        path: "x~HEAD",
        logicalPath: "x",
        purpose: "current-relocation",
        stageZero: null,
        stages: { base: null, current, incoming: null },
        worktree: current,
        content: null,
      },
    ];

    workspace.repo.store.db.transactionSync(() =>
      applyProjectedMerge(workspace.repo, workspace.worktree, entries, metadata(workspace.repo)),
    );

    expect(workspace.worktree.stat("/x")?.type).toBe("dir");
    expect(textAt(workspace, "x/y")).toBe("incoming child\n");
    expect(textAt(workspace, "x~HEAD")).toBe("current file\n");
    expect(workspace.repo.store.indexGet("x")).toBeNull();
    expect(workspace.repo.store.indexGet("x/y")?.oid).toBe(incoming.oid);
    expect(workspace.repo.store.indexGet("x~HEAD", 2)?.oid).toBe(current.oid);
    expect(workspace.repo.store.requireMergeState().touched.map((entry) => entry.path)).toEqual([
      "x",
      "x/y",
      "x~HEAD",
    ]);

    const journal = workspace.repo.store.requireMergeState();
    workspace.repo.store.db.transactionSync(() =>
      abortProjectedMerge(workspace.repo, workspace.worktree, journal),
    );
    expect(textAt(workspace, "x")).toBe("current file\n");
    expect(workspace.worktree.stat("/x/y")).toBeNull();
    expect(workspace.worktree.stat("/x~HEAD")).toBeNull();
    expect(workspace.repo.store.indexGet("x")?.oid).toBe(current.oid);
  });

  it("refuses abort when restoring a file would remove an outside path", () => {
    const workspace = makeRepo();
    const current = blob(workspace.repo, "current file\n");
    seedFile(workspace, "x", "current file\n");
    const incoming = blob(workspace.repo, "incoming child\n");
    const entries: readonly ProjectedMergeEntry[] = [
      {
        path: "x/y",
        logicalPath: "x/y",
        purpose: "primary",
        stageZero: incoming,
        stages: null,
        worktree: incoming,
        content: null,
      },
      {
        path: "x~HEAD",
        logicalPath: "x",
        purpose: "current-relocation",
        stageZero: null,
        stages: { base: null, current, incoming: null },
        worktree: current,
        content: null,
      },
    ];
    workspace.repo.store.db.transactionSync(() =>
      applyProjectedMerge(workspace.repo, workspace.worktree, entries, metadata(workspace.repo)),
    );
    workspace.worktree.writeFiles([{ path: "/x/outside.txt", bytes: utf8.encode("outside\n") }]);
    const journal = workspace.repo.store.requireMergeState();

    expect(() =>
      workspace.repo.store.db.transactionSync(() =>
        abortProjectedMerge(workspace.repo, workspace.worktree, journal),
      ),
    ).toThrow(expect.objectContaining({ code: "ECHECKOUTFAIL" }));
    expect(textAt(workspace, "x/outside.txt")).toBe("outside\n");
    expect(workspace.repo.store.readMergeState()).not.toBeNull();
  });

  it("validates snapshot objects before abort mutates a journal-owned path", () => {
    const workspace = makeRepo();
    seedFile(workspace, "a.txt", "old\n");
    const next = blob(workspace.repo, "next\n");
    const entries: readonly ProjectedMergeEntry[] = [
      {
        path: "a.txt",
        logicalPath: "a.txt",
        purpose: "primary",
        stageZero: next,
        stages: null,
        worktree: next,
        content: null,
      },
    ];
    workspace.repo.store.db.transactionSync(() =>
      applyProjectedMerge(
        workspace.repo,
        workspace.worktree,
        entries,
        metadata(workspace.repo, "no-commit"),
      ),
    );
    const journal = workspace.repo.store.requireMergeState();
    const touched = journal.touched.map(
      (entry): MergeTouchedPath =>
        entry.path === "a.txt"
          ? {
              ...entry,
              worktree: {
                kind: "file",
                mode: 0o100644,
                oid: "f".repeat(40),
                revision: 0,
              },
            }
          : entry,
    );
    const corrupt: MergeJournal = { ...journal, touched };

    expect(() =>
      workspace.repo.store.db.transactionSync(() =>
        abortProjectedMerge(workspace.repo, workspace.worktree, corrupt),
      ),
    ).toThrow(expect.objectContaining({ code: "ECORRUPT" }));
    expect(textAt(workspace, "a.txt")).toBe("next\n");
    expect(workspace.repo.store.readMergeState()).not.toBeNull();
  });

  it("removes a merge-created parent but preserves a pre-existing empty parent on abort", () => {
    for (const preExisting of [false, true]) {
      const workspace = makeRepo();
      if (preExisting) workspace.worktree.makeDirectories(["/d"]);
      const added = blob(workspace.repo, "added\n");
      const entries: readonly ProjectedMergeEntry[] = [
        {
          path: "d/f.txt",
          logicalPath: "d/f.txt",
          purpose: "primary",
          stageZero: added,
          stages: null,
          worktree: added,
          content: null,
        },
      ];
      workspace.repo.store.db.transactionSync(() =>
        applyProjectedMerge(
          workspace.repo,
          workspace.worktree,
          entries,
          metadata(workspace.repo, "no-commit"),
        ),
      );
      const journal = workspace.repo.store.requireMergeState();
      expect(journal.touched.map((entry) => entry.path)).toEqual(["d", "d/f.txt"]);

      workspace.repo.store.db.transactionSync(() =>
        abortProjectedMerge(workspace.repo, workspace.worktree, journal),
      );
      expect(workspace.worktree.stat("/d/f.txt")).toBeNull();
      expect(workspace.worktree.stat("/d")?.type ?? null).toBe(preExisting ? "dir" : null);
    }
  });
});
