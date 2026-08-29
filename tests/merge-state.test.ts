import { describe, expect, it } from "vitest";

import { utf8 } from "../src/core/bytes.js";
import { hasErrorCode } from "../src/core/errors.js";
import { hashObject, serializeCommit, serializeTree } from "../src/core/objects.js";
import {
  MAX_MERGE_MESSAGE_BYTES,
  MAX_MERGE_TOUCHED_PATHS,
  type MergeStateMetadata,
  type MergeTouchedPath,
  mergeJournalRetainedBytes,
} from "../src/core/ops/merge-state.js";
import { SqliteGitDatabase } from "../src/sqlite/store.js";
import { TestDatabase } from "./helpers/db.js";

const TREE_BYTES = serializeTree([]);
const TREE = hashObject("tree", TREE_BYTES);
const PERSON = {
  name: "Fixture",
  email: "fixture@example.com",
  timestamp: 1_700_000_000,
  timezoneOffset: 0,
};
const ORIGINAL_BYTES = serializeCommit({
  tree: TREE,
  parent: [],
  author: PERSON,
  committer: PERSON,
  message: "original\n",
});
const ORIGINAL = hashObject("commit", ORIGINAL_BYTES);
const INCOMING_BYTES = serializeCommit({
  tree: TREE,
  parent: [ORIGINAL],
  author: PERSON,
  committer: PERSON,
  message: "incoming\n",
});
const INCOMING = hashObject("commit", INCOMING_BYTES);
const FILE_BYTES = utf8.encode("content\n");
const FILE = hashObject("blob", FILE_BYTES);
const LINK_BYTES = utf8.encode("target");
const LINK = hashObject("blob", LINK_BYTES);

function metadata(overrides: Partial<MergeStateMetadata> = {}): MergeStateMetadata {
  return {
    originalHeadRef: "refs/heads/main",
    originalHeadOid: ORIGINAL,
    currentParentOid: ORIGINAL,
    incomingParentOid: INCOMING,
    phase: "conflicted",
    mode: "commit",
    mergeOrigin: "merge",
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
  const repository = database.createRepository("/repo", "ref: refs/heads/main");
  const store = database.openCheckout(repository);
  store.write("tree", TREE_BYTES);
  store.write("commit", ORIGINAL_BYTES);
  store.write("commit", INCOMING_BYTES);
  store.write("blob", FILE_BYTES);
  store.write("blob", LINK_BYTES);
  return { db, database, repository, store };
}

describe("durable merge journal", () => {
  it("round-trips metadata and ordered touched paths through a cold reopen", () => {
    const { db, repository, store } = open();
    const state = metadata();
    const paths = touched();
    db.storage.resetCounters();

    store.writeMergeState(state, paths);

    expect(db.storage.statementCount).toBeLessThan(1_000);
    const coldDatabase = new SqliteGitDatabase(db);
    const cold = coldDatabase.openCheckout(repository);
    db.storage.resetCounters();
    expect(cold.requireMergeState()).toEqual({
      state,
      touched: paths,
      retainedBytes: mergeJournalRetainedBytes(state, paths),
    });
    expect(db.storage.statementCount).toBeLessThan(1_000);
  });

  it("requires a valid authenticated merge origin in DDL and cold reads", () => {
    const ddl = open();
    ddl.store.writeMergeState(metadata(), touched());
    expect(() =>
      ddl.db.run("UPDATE git_operation_state SET merge_origin = 'fetch' WHERE checkout_id = 1"),
    ).toThrow();

    const tampered = open();
    tampered.store.writeMergeState(metadata(), touched());
    tampered.db.run("UPDATE git_operation_state SET merge_origin = 'pull' WHERE checkout_id = 1");
    expect(() => tampered.store.readMergeState()).toThrowError(
      expect.objectContaining({ code: "ECORRUPT" }),
    );

    const invalid = open();
    invalid.store.writeMergeState(metadata(), touched());
    invalid.db.run("PRAGMA ignore_check_constraints = ON");
    invalid.db.run("UPDATE git_operation_state SET merge_origin = 'fetch' WHERE checkout_id = 1");
    invalid.db.run("PRAGMA ignore_check_constraints = OFF");
    expect(() => invalid.store.readMergeState()).toThrowError(
      expect.objectContaining({ code: "ECORRUPT" }),
    );
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

    expect(() => store.writeMergeState(metadata({ message: "second\n" }), touched())).toThrowError(
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
    db.run("PRAGMA foreign_keys = OFF");
    db.run("DELETE FROM git_operation_state WHERE checkout_id = 1");
    db.run("PRAGMA foreign_keys = ON");
    expect(() => store.readMergeState()).toThrowError(
      expect.objectContaining({ code: "ECORRUPT" }),
    );
    expect(store.clearMergeState()).toBe(true);
    expect(store.readMergeState()).toBeNull();
  });

  it("removes every operation journal table when the repository is destroyed", () => {
    const { db, store } = open();
    store.writeMergeState(metadata(), touched());

    store.destroy();

    expect(db.scalar<number>("SELECT COUNT(*) FROM git_operation_state")).toBe(0);
    expect(db.scalar<number>("SELECT COUNT(*) FROM git_operation_steps")).toBe(0);
    expect(db.scalar<number>("SELECT COUNT(*) FROM git_operation_touched")).toBe(0);
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
      store.writeMergeState(
        metadata({ message: "x".repeat(MAX_MERGE_MESSAGE_BYTES + 1) }),
        touched(),
      ),
    ).toThrowError(expect.objectContaining({ code: "E2BIG" }));
    expect(db.scalar<number>("SELECT COUNT(*) FROM git_operation_state")).toBe(0);
    expect(db.scalar<number>("SELECT COUNT(*) FROM git_operation_touched")).toBe(0);
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
          db.run("UPDATE git_operation_state SET phase = 'applying' WHERE checkout_id = 1");
          db.run("PRAGMA ignore_check_constraints = OFF");
        },
        code: "ECORRUPT",
      },
      {
        name: "path order",
        corrupt: (db) => db.run("UPDATE git_operation_touched SET path = 'z' WHERE ordinal = 0"),
        code: "ECORRUPT",
      },
      {
        name: "revision",
        corrupt: (db) =>
          db.run("UPDATE git_operation_touched SET worktree_revision = -1 WHERE ordinal = 0"),
        code: "ECORRUPT",
      },
      {
        name: "count",
        corrupt: (db) =>
          db.run(
            "UPDATE git_operation_state SET touched_count = ? WHERE checkout_id = 1",
            MAX_MERGE_TOUCHED_PATHS + 1,
          ),
        code: "E2BIG",
      },
      {
        name: "retained bytes",
        corrupt: (db) =>
          db.run(
            "UPDATE git_operation_state SET retained_bytes = retained_bytes + 1 WHERE checkout_id = 1",
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

  it("rejects impossible metadata and empty conflicted journals", () => {
    const cases: readonly (() => void)[] = [
      () => open().store.writeMergeState(metadata({ currentLabel: "" }), touched()),
      () => open().store.writeMergeState(metadata({ incomingLabel: "" }), touched()),
      () => open().store.writeMergeState(metadata({ currentParentOid: INCOMING }), touched()),
      () => open().store.writeMergeState(metadata(), []),
    ];

    for (const operation of cases) {
      expect(operation).toThrowError(expect.objectContaining({ code: "ECORRUPT" }));
    }
  });

  it("guards oversized SQL text and blob values before they cross the read boundary", () => {
    const metadataCases: readonly string[] = ["message", "author_name"];
    for (const column of metadataCases) {
      const { db, store } = open();
      store.writeMergeState(metadata(), touched());
      db.run("PRAGMA ignore_check_constraints = ON");
      db.run(
        `UPDATE git_operation_state SET ${column} = zeroblob(?) WHERE checkout_id = 1`,
        MAX_MERGE_MESSAGE_BYTES + 1,
      );
      db.run("PRAGMA ignore_check_constraints = OFF");
      expect(() => store.readMergeState(), column).toThrowError(
        expect.objectContaining({ code: "ECORRUPT" }),
      );
    }

    const { db, store } = open();
    store.writeMergeState(metadata(), touched());
    db.run("UPDATE git_operation_touched SET path = zeroblob(4096) WHERE ordinal = 0");
    expect(() => store.readMergeState()).toThrowError(
      expect.objectContaining({ code: "ECORRUPT" }),
    );
  });

  it("requires authoritative complete objects with types matching every saved mode", () => {
    const missingOnWrite = open();
    expect(() =>
      missingOnWrite.store.writeMergeState(
        metadata({ incomingParentOid: "f".repeat(40) }),
        touched(),
      ),
    ).toThrowError(expect.objectContaining({ code: "ECORRUPT" }));
    expect(missingOnWrite.store.readMergeState()).toBeNull();

    const corruptions: readonly {
      name: string;
      corrupt: (db: TestDatabase) => void;
    }[] = [
      {
        name: "missing parent",
        corrupt: (db) =>
          db.run(
            "UPDATE git_operation_state SET incoming_parent_oid = ? WHERE checkout_id = 1",
            "f".repeat(40),
          ),
      },
      {
        name: "parent is a blob",
        corrupt: (db) =>
          db.run(
            "UPDATE git_operation_state SET incoming_parent_oid = ? WHERE checkout_id = 1",
            FILE,
          ),
      },
      {
        name: "index file is a commit",
        corrupt: (db) =>
          db.run("UPDATE git_operation_touched SET index_oid = ? WHERE path = 'a.txt'", INCOMING),
      },
      {
        name: "worktree symlink is a commit",
        corrupt: (db) =>
          db.run(
            "UPDATE git_operation_touched SET worktree_oid = ? WHERE path = 'node~HEAD'",
            INCOMING,
          ),
      },
      {
        name: "loose blob lost its only chunk",
        corrupt: (db) =>
          db.run("DELETE FROM git_object_chunks WHERE repo_id = 1 AND oid = ?", FILE),
      },
    ];

    for (const corruption of corruptions) {
      const { db, store } = open();
      store.writeMergeState(metadata(), touched());
      corruption.corrupt(db);
      expect(() => store.readMergeState(), corruption.name).toThrowError(
        expect.objectContaining({ code: "ECORRUPT" }),
      );
    }
  });
});
