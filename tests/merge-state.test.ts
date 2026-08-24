import { describe, expect, it } from "vitest";

import { hasErrorCode } from "../src/core/errors.js";
import {
  MAX_MERGE_MESSAGE_BYTES,
  MAX_MERGE_TOUCHED_PATHS,
  type MergeStateMetadata,
  type MergeTouchedPath,
  mergeJournalRetainedBytes,
} from "../src/core/ops/merge-state.js";
import { SqliteGitDatabase } from "../src/sqlite/store.js";
import { TestDatabase } from "./helpers/db.js";

const ORIGINAL = "1".repeat(40);
const INCOMING = "2".repeat(40);
const FILE = "3".repeat(40);
const LINK = "4".repeat(40);

function metadata(overrides: Partial<MergeStateMetadata> = {}): MergeStateMetadata {
  return {
    originalHeadRef: "refs/heads/main",
    originalHeadOid: ORIGINAL,
    currentParentOid: ORIGINAL,
    incomingParentOid: INCOMING,
    phase: "conflicted",
    mode: "commit",
    currentLabel: "HEAD",
    incomingLabel: "topic",
    message: "Merge topic\n",
    author: { name: "Author", email: "author@example.com" },
    committer: null,
    ...overrides,
  };
}

function touched(): readonly MergeTouchedPath[] {
  return [
    {
      path: "a.txt",
      logicalPath: "a.txt",
      purpose: "primary",
      index: {
        stage: 0,
        mode: 0o100644,
        oid: FILE,
        size: 7,
        mtime: 10,
        ino: 11,
        rev: 12,
      },
      worktree: { kind: "file", mode: 0o100644, oid: FILE, revision: 13 },
    },
    {
      path: "dir",
      logicalPath: "dir",
      purpose: "primary",
      index: null,
      worktree: { kind: "directory", mode: 0o040755, revision: 14 },
    },
    {
      path: "node~HEAD",
      logicalPath: "node",
      purpose: "current-relocation",
      index: null,
      worktree: { kind: "symlink", mode: 0o120777, oid: LINK, revision: 15 },
    },
    {
      path: "node~topic",
      logicalPath: "node",
      purpose: "incoming-relocation",
      index: null,
      worktree: { kind: "absent" },
    },
  ];
}

function open() {
  const db = new TestDatabase();
  const database = new SqliteGitDatabase(db);
  const repository = database.create("/repo", "ref: refs/heads/main");
  return { db, database, repository, store: database.open(repository) };
}

describe("durable merge journal", () => {
  it("round-trips metadata and ordered touched paths through a cold reopen", () => {
    const { db, repository, store } = open();
    const state = metadata();
    const paths = touched();
    db.storage.resetCounters();

    store.writeMergeState(state, paths);

    expect(db.storage.statementCount).toBeLessThan(10);
    const coldDatabase = new SqliteGitDatabase(db);
    const cold = coldDatabase.open(repository);
    db.storage.resetCounters();
    expect(cold.requireMergeState()).toEqual({
      state,
      touched: paths,
      retainedBytes: mergeJournalRetainedBytes(state, paths),
    });
    expect(db.storage.statementCount).toBe(2);
  });

  it("persists ready no-commit state and optional explicit identities", () => {
    const { store } = open();
    const state = metadata({
      phase: "ready",
      mode: "no-commit",
      author: null,
      committer: { name: "Committer", email: "committer@example.com" },
    });

    store.writeMergeState(state, []);

    expect(store.requireMergeState()).toEqual({
      state,
      touched: [],
      retainedBytes: mergeJournalRetainedBytes(state, []),
    });
  });

  it("enforces one active merge and stable missing-state guards", () => {
    const { store } = open();
    expect(() => store.requireMergeState()).toThrowError(
      expect.objectContaining({ code: "ENOMERGE" }),
    );
    expect(() => store.requireNoMergeState()).not.toThrow();
    store.writeMergeState(metadata(), touched());
    const before = store.requireMergeState();

    expect(() => store.writeMergeState(metadata({ message: "second\n" }), [])).toThrowError(
      expect.objectContaining({ code: "EMERGEACTIVE" }),
    );
    expect(() => store.requireNoMergeState()).toThrowError(
      expect.objectContaining({ code: "EMERGEACTIVE" }),
    );
    expect(store.requireMergeState()).toEqual(before);
  });

  it("clears state and touched rows, including corrupt orphan rows", () => {
    const { db, store } = open();
    store.writeMergeState(metadata(), touched());
    expect(store.clearMergeState()).toBe(true);
    expect(store.readMergeState()).toBeNull();
    expect(store.clearMergeState()).toBe(false);

    store.writeMergeState(metadata(), touched());
    db.run("DELETE FROM git_merge_state WHERE repo_id = 1");
    expect(() => store.readMergeState()).toThrowError(
      expect.objectContaining({ code: "ECORRUPT" }),
    );
    expect(store.clearMergeState()).toBe(true);
    expect(store.readMergeState()).toBeNull();
  });

  it("removes both merge tables when the repository is destroyed", () => {
    const { db, store } = open();
    store.writeMergeState(metadata(), touched());

    store.destroy();

    expect(db.scalar<number>("SELECT COUNT(*) FROM git_merge_state")).toBe(0);
    expect(db.scalar<number>("SELECT COUNT(*) FROM git_merge_touched")).toBe(0);
  });

  it("rejects invalid order and hard bounds before writing a state row", () => {
    const { db, store } = open();
    const reversed = [...touched()].reverse();
    expect(() => store.writeMergeState(metadata(), reversed)).toThrowError(
      expect.objectContaining({ code: "ECORRUPT" }),
    );

    const tooMany: MergeTouchedPath[] = [];
    for (let index = 0; index <= MAX_MERGE_TOUCHED_PATHS; index++) {
      const path = `p${index.toString().padStart(4, "0")}`;
      tooMany.push({
        path,
        logicalPath: path,
        purpose: "primary",
        index: null,
        worktree: { kind: "absent" },
      });
    }
    expect(() => store.writeMergeState(metadata(), tooMany)).toThrowError(
      expect.objectContaining({ code: "E2BIG" }),
    );
    expect(() =>
      store.writeMergeState(metadata({ message: "x".repeat(MAX_MERGE_MESSAGE_BYTES + 1) }), []),
    ).toThrowError(expect.objectContaining({ code: "E2BIG" }));
    expect(db.scalar<number>("SELECT COUNT(*) FROM git_merge_state")).toBe(0);
    expect(db.scalar<number>("SELECT COUNT(*) FROM git_merge_touched")).toBe(0);
  });

  it("fails closed on corrupt metadata, order, revisions, counts, and retained bytes", () => {
    const corruptions: readonly {
      name: string;
      corrupt: (db: TestDatabase) => void;
      code: string;
    }[] = [
      {
        name: "phase",
        corrupt: (db) => {
          db.run("PRAGMA ignore_check_constraints = ON");
          db.run("UPDATE git_merge_state SET phase = 'applying' WHERE repo_id = 1");
          db.run("PRAGMA ignore_check_constraints = OFF");
        },
        code: "ECORRUPT",
      },
      {
        name: "path order",
        corrupt: (db) => db.run("UPDATE git_merge_touched SET path = 'z' WHERE ordinal = 0"),
        code: "ECORRUPT",
      },
      {
        name: "revision",
        corrupt: (db) =>
          db.run("UPDATE git_merge_touched SET worktree_revision = -1 WHERE ordinal = 0"),
        code: "ECORRUPT",
      },
      {
        name: "count",
        corrupt: (db) =>
          db.run(
            "UPDATE git_merge_state SET touched_count = ? WHERE repo_id = 1",
            MAX_MERGE_TOUCHED_PATHS + 1,
          ),
        code: "E2BIG",
      },
      {
        name: "retained bytes",
        corrupt: (db) =>
          db.run(
            "UPDATE git_merge_state SET retained_bytes = retained_bytes + 1 WHERE repo_id = 1",
          ),
        code: "ECORRUPT",
      },
    ];

    for (const corruption of corruptions) {
      const { db, store } = open();
      store.writeMergeState(metadata(), touched());
      corruption.corrupt(db);
      try {
        store.readMergeState();
        throw new Error(`expected corrupt ${corruption.name} to fail`);
      } catch (error) {
        expect(hasErrorCode(error, corruption.code), corruption.name).toBe(true);
      }
    }
  });
});
