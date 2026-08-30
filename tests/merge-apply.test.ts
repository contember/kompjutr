import { describe, expect, it } from "vitest";

import { fromHex, utf8, utf8Decoder } from "../src/core/bytes.js";
import { hashObject } from "../src/core/objects.js";
import {
  abortProjectedMerge,
  applyProjectedMerge,
  type MergeApplyMetadata,
} from "../src/core/ops/merge-apply.js";
import type { ProjectedMergeEntry } from "../src/core/ops/merge-projection.js";
import type { MergeJournal, MergeTouchedPath } from "../src/core/ops/merge-state.js";
import type { Repository } from "../src/core/repository.js";
import type { Worktree } from "../src/core/worktree.js";
import type { ScanEntry } from "../src/fs/types.js";
import { MAX_OPERATION_MEMORY_BYTES } from "../src/memory.js";
import { PACK_BLOB_BATCH_TARGET_BYTES } from "../src/sqlite/store.js";
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
  workspace.repo.checkout.indexPut({
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

function readyApplyFixture(): {
  workspace: TestRepository;
  entries: readonly ProjectedMergeEntry[];
  applyMetadata: MergeApplyMetadata;
} {
  const workspace = makeRepo();
  seedFile(workspace, "owned.txt", "old\n");
  const next = blob(workspace.repo, "next\n");
  return {
    workspace,
    entries: [
      {
        path: "owned.txt",
        logicalPath: "owned.txt",
        purpose: "primary",
        stageZero: next,
        stages: null,
        worktree: next,
        content: null,
      },
    ],
    applyMetadata: metadata(workspace.repo, "no-commit"),
  };
}

function readyAbortFixture(): ReturnType<typeof readyApplyFixture> & { journal: MergeJournal } {
  const fixture = readyApplyFixture();
  const result = fixture.workspace.repo.store.db.transactionSync(() =>
    applyProjectedMerge(
      fixture.workspace.repo,
      fixture.workspace.worktree,
      fixture.entries,
      fixture.applyMetadata,
    ),
  );
  if (result.journal === null) throw new Error("ready merge omitted its journal");
  return { ...fixture, journal: result.journal };
}

describe("projected merge apply", () => {
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

    expect(result).toEqual({ outcome: "clean", journal: null });
    expect(workspace.repo.has(oldOid)).toBe(false);
    expect(textAt(workspace, "clean.txt")).toBe("next\n");
  });

  it("applies a small projected merge", () => {
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
      applyProjectedMerge(workspace.repo, workspace.worktree, entries, metadata(workspace.repo)),
    );

    expect(result).toEqual({ outcome: "clean", journal: null });
    expect(textAt(workspace, "small.txt")).toBe("next\n");
  });

  it("reads one valid merge blob above the batching target as a singleton", () => {
    const workspace = makeRepo();
    seedFile(workspace, "large.bin", "old\n");
    const content = new Uint8Array(PACK_BLOB_BATCH_TARGET_BYTES + 1).fill(0x61);
    const next = { mode: "100644", oid: workspace.repo.store.write("blob", content) };
    const entries: readonly ProjectedMergeEntry[] = [
      {
        path: "large.bin",
        logicalPath: "large.bin",
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

    expect(result).toEqual({ outcome: "clean", journal: null });
    expect(workspace.worktree.readFile("/large.bin")).toEqual(content);
    workspace.repo.store.memory.assertIdle();
  });

  it("applies content one byte past the former standalone ceiling", () => {
    const workspace = makeRepo();
    const entries: ProjectedMergeEntry[] = [];
    let remaining = 32 * 1024 * 1024 + 1;
    for (let ordinal = 0; remaining > 0; ordinal++) {
      const content = new Uint8Array(Math.min(1024 * 1024, remaining));
      content[0] = ordinal;
      const oid = hashObject("blob", content);
      const identity = { mode: "100644", oid };
      const path = `large-${ordinal.toString().padStart(2, "0")}.bin`;
      entries.push({
        path,
        logicalPath: path,
        purpose: "primary",
        stageZero: identity,
        stages: null,
        worktree: identity,
        content,
      });
      remaining -= content.byteLength;
    }

    const result = workspace.repo.store.db.transactionSync(() =>
      applyProjectedMerge(workspace.repo, workspace.worktree, entries, metadata(workspace.repo)),
    );

    expect(result).toEqual({ outcome: "clean", journal: null });
    expect(entries).toHaveLength(33);
    expect(workspace.worktree.stat("/large-00.bin")?.size).toBe(1024 * 1024);
    expect(workspace.worktree.stat("/large-32.bin")?.size).toBe(1);
    workspace.repo.store.memory.assertIdle();
  });

  it("charges caller-owned retained results and releases exact and failed aggregates", () => {
    const measured = readyApplyFixture();
    const measuredOwner = measured.workspace.repo.store.reserveMemory();
    const measuredResult = measured.workspace.repo.store.db.transactionSync(() =>
      applyProjectedMerge(
        measured.workspace.repo,
        measured.workspace.worktree,
        measured.entries,
        measured.applyMetadata,
        measuredOwner,
      ),
    );
    expect(measuredResult.outcome).toBe("ready");
    expect(measuredResult.journal).not.toBeNull();
    const operationBytes = measuredOwner.highWaterBytes;
    expect(operationBytes).toBeGreaterThan(measuredOwner.currentBytes);
    expect(measuredOwner.currentBytes).toBeGreaterThan(0);
    measuredOwner.dispose();
    measured.workspace.repo.store.memory.assertIdle();

    const exact = readyApplyFixture();
    const exactOwner = exact.workspace.repo.store.reserveMemory();
    exactOwner.set("other", MAX_OPERATION_MEMORY_BYTES - operationBytes);
    const exactReadBlobs = exact.workspace.repo.readBlobs.bind(exact.workspace.repo);
    const exactReadFiles = exact.workspace.worktree.readFiles.bind(exact.workspace.worktree);
    const exactIndexApply = exact.workspace.repo.checkout.indexApply.bind(
      exact.workspace.repo.checkout,
    );
    let exactPayloadReads = 0;
    let exactSnapshotReads = 0;
    let exactIndexApplies = 0;
    exact.workspace.repo.readBlobs = (oids, options) => {
      exactPayloadReads++;
      return exactReadBlobs(oids, options);
    };
    exact.workspace.worktree.readFiles = (paths, options) => {
      exactSnapshotReads++;
      return exactReadFiles(paths, options);
    };
    exact.workspace.repo.checkout.indexApply = (body, options) => {
      exactIndexApplies++;
      return exactIndexApply(body, options);
    };
    try {
      const result = exact.workspace.repo.store.db.transactionSync(() =>
        applyProjectedMerge(
          exact.workspace.repo,
          exact.workspace.worktree,
          exact.entries,
          exact.applyMetadata,
          exactOwner,
        ),
      );
      expect(result.outcome).toBe("ready");
      expect(exact.workspace.repo.store.memory.highWaterBytes).toBe(MAX_OPERATION_MEMORY_BYTES);
      expect(exactPayloadReads).toBeGreaterThan(0);
      expect(exactSnapshotReads).toBeGreaterThan(0);
      expect(exactIndexApplies).toBeGreaterThan(0);
    } finally {
      exactOwner.dispose();
    }
    exact.workspace.repo.store.memory.assertIdle();

    const excess = readyApplyFixture();
    const excessOwner = excess.workspace.repo.store.reserveMemory();
    excessOwner.set("other", MAX_OPERATION_MEMORY_BYTES - operationBytes + 1);
    const excessReadBlobs = excess.workspace.repo.readBlobs.bind(excess.workspace.repo);
    const excessReadFiles = excess.workspace.worktree.readFiles.bind(excess.workspace.worktree);
    const excessIndexApply = excess.workspace.repo.checkout.indexApply.bind(
      excess.workspace.repo.checkout,
    );
    let excessPayloadReads = 0;
    let excessSnapshotReads = 0;
    let excessIndexApplies = 0;
    excess.workspace.repo.readBlobs = (oids, options) => {
      excessPayloadReads++;
      return excessReadBlobs(oids, options);
    };
    excess.workspace.worktree.readFiles = (paths, options) => {
      excessSnapshotReads++;
      return excessReadFiles(paths, options);
    };
    excess.workspace.repo.checkout.indexApply = (body, options) => {
      excessIndexApplies++;
      return excessIndexApply(body, options);
    };
    try {
      expect(() =>
        excess.workspace.repo.store.db.transactionSync(() =>
          applyProjectedMerge(
            excess.workspace.repo,
            excess.workspace.worktree,
            excess.entries,
            excess.applyMetadata,
            excessOwner,
          ),
        ),
      ).toThrow(expect.objectContaining({ code: "E2BIG" }));
      expect(excessPayloadReads).toBe(0);
      expect(excessSnapshotReads).toBe(0);
      expect(excessIndexApplies).toBe(0);
      expect(excess.workspace.repo.checkout.readMergeState()).toBeNull();
      expect(textAt(excess.workspace, "owned.txt")).toBe("old\n");
    } finally {
      excessOwner.dispose();
    }
    excess.workspace.repo.store.memory.assertIdle();
  });

  it("admits restore payloads before reading and rolls back exact aggregate excess", () => {
    const measured = readyAbortFixture();
    const calibration = measured.workspace.repo.store.reserveMemory();
    calibration.set("other", MAX_OPERATION_MEMORY_BYTES / 2);
    const measuredOwner = measured.workspace.repo.store.reserveMemory();
    measuredOwner.set("other", measured.journal.retainedBytes);
    const measuredReadBlobs = measured.workspace.repo.readBlobs.bind(measured.workspace.repo);
    let readAdmissionBytes = 0;
    measured.workspace.repo.readBlobs = (oids, options) => {
      readAdmissionBytes = Math.max(
        readAdmissionBytes,
        measuredOwner.highWaterBytes - measured.journal.retainedBytes,
      );
      return measuredReadBlobs(oids, options);
    };
    measured.workspace.repo.store.db.transactionSync(() =>
      abortProjectedMerge(
        measured.workspace.repo,
        measured.workspace.worktree,
        measured.journal,
        measuredOwner,
      ),
    );
    const transientBytes =
      measured.workspace.repo.store.memory.highWaterBytes -
      calibration.currentBytes -
      measuredOwner.currentBytes;
    expect(transientBytes).toBeGreaterThan(0);
    expect(readAdmissionBytes).toBeGreaterThan(0);
    measuredOwner.dispose();
    calibration.dispose();
    measured.workspace.repo.store.memory.assertIdle();

    const exact = readyAbortFixture();
    const exactOwner = exact.workspace.repo.store.reserveMemory();
    exactOwner.set("other", MAX_OPERATION_MEMORY_BYTES - transientBytes);
    const exactReadBlobs = exact.workspace.repo.readBlobs.bind(exact.workspace.repo);
    const exactWriteFiles = exact.workspace.worktree.writeFiles.bind(exact.workspace.worktree);
    const exactIndexApply = exact.workspace.repo.checkout.indexApply.bind(
      exact.workspace.repo.checkout,
    );
    let exactPayloadReads = 0;
    let exactRestoreWrites = 0;
    let exactIndexRestores = 0;
    exact.workspace.repo.readBlobs = (oids, options) => {
      exactPayloadReads++;
      return exactReadBlobs(oids, options);
    };
    exact.workspace.worktree.writeFiles = (entries, options) => {
      exactRestoreWrites++;
      return exactWriteFiles(entries, options);
    };
    exact.workspace.repo.checkout.indexApply = (body, options) => {
      exactIndexRestores++;
      return exactIndexApply(body, options);
    };
    try {
      exact.workspace.repo.store.db.transactionSync(() =>
        abortProjectedMerge(
          exact.workspace.repo,
          exact.workspace.worktree,
          exact.journal,
          exactOwner,
        ),
      );
      expect(exactPayloadReads).toBeGreaterThan(0);
      expect(exactRestoreWrites).toBeGreaterThan(0);
      expect(exactIndexRestores).toBeGreaterThan(0);
      expect(exact.workspace.repo.store.memory.highWaterBytes).toBe(MAX_OPERATION_MEMORY_BYTES);
    } finally {
      exactOwner.dispose();
    }
    exact.workspace.repo.store.memory.assertIdle();

    const excess = readyAbortFixture();
    const excessOwner = excess.workspace.repo.store.reserveMemory();
    excessOwner.set("other", MAX_OPERATION_MEMORY_BYTES - readAdmissionBytes + 1);
    const excessReadBlobs = excess.workspace.repo.readBlobs.bind(excess.workspace.repo);
    const excessWriteFiles = excess.workspace.worktree.writeFiles.bind(excess.workspace.worktree);
    const excessIndexApply = excess.workspace.repo.checkout.indexApply.bind(
      excess.workspace.repo.checkout,
    );
    let excessPayloadReads = 0;
    let excessRestoreWrites = 0;
    let excessIndexRestores = 0;
    excess.workspace.repo.readBlobs = (oids, options) => {
      excessPayloadReads++;
      return excessReadBlobs(oids, options);
    };
    excess.workspace.worktree.writeFiles = (entries, options) => {
      excessRestoreWrites++;
      return excessWriteFiles(entries, options);
    };
    excess.workspace.repo.checkout.indexApply = (body, options) => {
      excessIndexRestores++;
      return excessIndexApply(body, options);
    };
    try {
      expect(() =>
        excess.workspace.repo.store.db.transactionSync(() =>
          abortProjectedMerge(
            excess.workspace.repo,
            excess.workspace.worktree,
            excess.journal,
            excessOwner,
          ),
        ),
      ).toThrow(expect.objectContaining({ code: "E2BIG" }));
      expect(excessPayloadReads).toBe(0);
      expect(excessRestoreWrites).toBe(0);
      expect(excessIndexRestores).toBe(0);
      expect(textAt(excess.workspace, "owned.txt")).toBe("next\n");
    } finally {
      excessOwner.dispose();
    }
    expect(excess.workspace.repo.checkout.readMergeState()).not.toBeNull();
    excess.workspace.repo.store.memory.assertIdle();
  });

  it("applies the operation that the former exhausted prior budget rejected", () => {
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

    const result = workspace.repo.store.db.transactionSync(() =>
      applyProjectedMerge(workspace.repo, workspace.worktree, entries, metadata(workspace.repo)),
    );
    expect(result).toEqual({ outcome: "clean", journal: null });
    expect(textAt(workspace, "guarded.txt")).toBe("next\n");
    expect(workspace.repo.checkout.indexGet("guarded.txt")).toMatchObject({
      stage: 0,
      oid: next.oid,
    });
    expect(workspace.repo.checkout.readMergeState()).toBeNull();
  });

  it("continues a worktree snapshot scan past fifty full pages", () => {
    const workspace = makeRepo();
    const next = blob(workspace.repo, "next\n");
    const entries: readonly ProjectedMergeEntry[] = [
      {
        path: "z.txt",
        logicalPath: "z.txt",
        purpose: "primary",
        stageZero: next,
        stages: null,
        worktree: next,
        content: null,
      },
    ];
    let scanCalls = 0;
    const scan = (_root: string, options: { limit: number }): ScanEntry[] => {
      scanCalls++;
      if (scanCalls > 50) return [];
      const first = (scanCalls - 1) * options.limit;
      return Array.from({ length: options.limit }, (_, offset) => ({
        path: `/a-${(first + offset).toString().padStart(5, "0")}`,
        type: "file",
        mode: 0o100644,
        size: 0,
        mtime: 0,
        ino: first + offset + 1,
        nlink: 1,
        rev: 1,
        target: null,
        contentId: null,
      }));
    };
    const fallbackWorktree: Worktree = { ...workspace.worktree, scan };

    const result = workspace.repo.store.db.transactionSync(() =>
      applyProjectedMerge(workspace.repo, fallbackWorktree, entries, metadata(workspace.repo)),
    );

    expect(scanCalls).toBe(51);
    expect(result).toEqual({ outcome: "clean", journal: null });
    expect(textAt(workspace, "z.txt")).toBe("next\n");
  });

  it("rejects a worktree snapshot cursor that does not advance", () => {
    const workspace = makeRepo();
    const next = blob(workspace.repo, "next\n");
    const entries: readonly ProjectedMergeEntry[] = [
      {
        path: "z.txt",
        logicalPath: "z.txt",
        purpose: "primary",
        stageZero: next,
        stages: null,
        worktree: next,
        content: null,
      },
    ];
    const page = Array.from(
      { length: 1_000 },
      (_, ordinal): ScanEntry => ({
        path: `/a-${ordinal.toString().padStart(4, "0")}`,
        type: "file",
        mode: 0o100644,
        size: 0,
        mtime: 0,
        ino: ordinal + 1,
        nlink: 1,
        rev: 1,
        target: null,
        contentId: null,
      }),
    );
    const fallbackWorktree: Worktree = {
      ...workspace.worktree,
      scan: () => page,
    };

    expect(() =>
      workspace.repo.store.db.transactionSync(() =>
        applyProjectedMerge(workspace.repo, fallbackWorktree, entries, metadata(workspace.repo)),
      ),
    ).toThrow(expect.objectContaining({ code: "ECORRUPT" }));
    expect(workspace.repo.checkout.readMergeState()).toBeNull();
    expect(textAt(workspace, "z.txt")).toBeNull();
  });

  it("continues an index snapshot scan past fifty thousand rows", () => {
    const workspace = makeRepo();
    const next = blob(workspace.repo, "next\n");
    const entries: readonly ProjectedMergeEntry[] = [
      {
        path: "z.txt",
        logicalPath: "z.txt",
        purpose: "primary",
        stageZero: next,
        stages: null,
        worktree: next,
        content: null,
      },
    ];
    workspace.repo.checkout.indexScan = function* () {
      for (let ordinal = 0; ordinal <= 50_000; ordinal++) {
        yield {
          path: `a-${ordinal.toString().padStart(5, "0")}`,
          stage: 0,
          mode: 0o100644,
          oid: "1".repeat(40),
          size: null,
          mtime: null,
          ino: null,
          rev: null,
        };
      }
    };

    const result = workspace.repo.store.db.transactionSync(() =>
      applyProjectedMerge(
        workspace.repo,
        workspace.worktree,
        entries,
        metadata(workspace.repo, "no-commit"),
      ),
    );

    expect(result.outcome).toBe("ready");
    expect(result.journal?.touched).toHaveLength(1);
    expect(workspace.repo.checkout.indexGet("z.txt")).toMatchObject({ oid: next.oid });
  });

  it("snapshots and restores files past the former read-call caps", () => {
    const workspace = makeRepo();
    const entries: ProjectedMergeEntry[] = [];
    for (let ordinal = 0; ordinal < 9; ordinal++) {
      const path = `file-${ordinal}`;
      seedFile(workspace, path, `old-${ordinal}\n`);
      const next = blob(workspace.repo, `next-${ordinal}\n`);
      entries.push({
        path,
        logicalPath: path,
        purpose: "primary",
        stageZero: next,
        stages: null,
        worktree: next,
        content: null,
      });
    }
    const readFiles = workspace.worktree.readFiles.bind(workspace.worktree);
    let snapshotReads = 0;
    workspace.worktree.readFiles = (paths, options) => {
      const first = paths[0];
      if (first === undefined) throw new Error("test snapshot batch is empty");
      snapshotReads++;
      const batch = readFiles([first], options);
      return { files: batch.files, remaining: [...batch.remaining, ...paths.slice(1)] };
    };
    const readBlobs = workspace.repo.readBlobs.bind(workspace.repo);
    let blobReads = 0;
    workspace.repo.readBlobs = (oids, options) => {
      const first = oids[0];
      if (first === undefined) throw new Error("test blob batch is empty");
      blobReads++;
      const batch = readBlobs([first], options);
      return {
        blobs: batch.blobs,
        remaining: [...batch.remaining, ...oids.slice(1)],
        bytes: batch.bytes,
      };
    };

    const result = workspace.repo.store.db.transactionSync(() =>
      applyProjectedMerge(
        workspace.repo,
        workspace.worktree,
        entries,
        metadata(workspace.repo, "no-commit"),
      ),
    );
    const journal = result.journal;
    if (journal === null) throw new Error("ready merge omitted its journal");
    expect(snapshotReads).toBe(9);
    expect(blobReads).toBe(9);
    const restoreStart = blobReads;
    workspace.repo.store.db.transactionSync(() =>
      abortProjectedMerge(workspace.repo, workspace.worktree, journal),
    );

    expect(blobReads - restoreStart).toBe(9);
    for (let ordinal = 0; ordinal < 9; ordinal++) {
      expect(textAt(workspace, `file-${ordinal}`)).toBe(`old-${ordinal}\n`);
    }
    expect(workspace.repo.checkout.readMergeState()).toBeNull();
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
    expect(workspace.repo.checkout.readMergeState()).toBeNull();
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
    expect(workspace.repo.checkout.indexGet("a.txt")?.oid).toBe(newA.oid);
    expect(workspace.repo.checkout.indexGet("added.txt")?.oid).toBe(added.oid);
    expect(workspace.repo.checkout.indexGet("deleted.txt")).toBeNull();

    const journal = workspace.repo.checkout.requireMergeState();
    workspace.repo.store.db.transactionSync(() =>
      abortProjectedMerge(workspace.repo, workspace.worktree, journal),
    );

    expect(workspace.repo.checkout.readMergeState()).toBeNull();
    expect(textAt(workspace, "a.txt")).toBe("old\n");
    expect(textAt(workspace, "added.txt")).toBeNull();
    expect(textAt(workspace, "deleted.txt")).toBe("keep me\n");
    expect(workspace.repo.checkout.indexGet("a.txt")?.oid).toBe(oldA);
    expect(workspace.repo.checkout.indexGet("deleted.txt")?.oid).toBe(oldDeleted);
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
    expect(workspace.repo.checkout.indexGet("binary.dat", 0)).toBeNull();
    expect(workspace.repo.checkout.indexGet("binary.dat", 1)?.oid).toBe(base.oid);
    expect(workspace.repo.checkout.indexGet("binary.dat", 2)?.oid).toBe(current.oid);
    expect(workspace.repo.checkout.indexGet("binary.dat", 3)?.oid).toBe(incoming.oid);
    expect(textAt(workspace, "binary.dat")).toBe("current\0bytes");
    expect(workspace.repo.checkout.requireMergeState().state.phase).toBe("conflicted");
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
    expect(workspace.repo.checkout.indexGet("x")).toBeNull();
    expect(workspace.repo.checkout.indexGet("x/y")?.oid).toBe(incoming.oid);
    expect(workspace.repo.checkout.indexGet("x~HEAD", 2)?.oid).toBe(current.oid);
    expect(workspace.repo.checkout.requireMergeState().touched.map((entry) => entry.path)).toEqual([
      "x",
      "x/y",
      "x~HEAD",
    ]);

    const journal = workspace.repo.checkout.requireMergeState();
    workspace.repo.store.db.transactionSync(() =>
      abortProjectedMerge(workspace.repo, workspace.worktree, journal),
    );
    expect(textAt(workspace, "x")).toBe("current file\n");
    expect(workspace.worktree.stat("/x/y")).toBeNull();
    expect(workspace.worktree.stat("/x~HEAD")).toBeNull();
    expect(workspace.repo.checkout.indexGet("x")?.oid).toBe(current.oid);
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
    const journal = workspace.repo.checkout.requireMergeState();

    expect(() =>
      workspace.repo.store.db.transactionSync(() =>
        abortProjectedMerge(workspace.repo, workspace.worktree, journal),
      ),
    ).toThrow(expect.objectContaining({ code: "ECHECKOUTFAIL" }));
    expect(textAt(workspace, "x/outside.txt")).toBe("outside\n");
    expect(workspace.repo.checkout.readMergeState()).not.toBeNull();
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
    const journal = workspace.repo.checkout.requireMergeState();
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
    expect(workspace.repo.checkout.readMergeState()).not.toBeNull();
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
      const journal = workspace.repo.checkout.requireMergeState();
      expect(journal.touched.map((entry) => entry.path)).toEqual(["d", "d/f.txt"]);

      workspace.repo.store.db.transactionSync(() =>
        abortProjectedMerge(workspace.repo, workspace.worktree, journal),
      );
      expect(workspace.worktree.stat("/d/f.txt")).toBeNull();
      expect(workspace.worktree.stat("/d")?.type ?? null).toBe(preExisting ? "dir" : null);
    }
  });
});
