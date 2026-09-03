import { describe, expect, it } from "vitest";

import { utf8 } from "../src/git/common/bytes.js";
import { hashObject, serializeCommit, serializeTree } from "../src/git/common/objects.js";
import {
  MAX_MERGE_MESSAGE_BYTES,
  MAX_MERGE_TOUCHED_PATHS,
  type MergeStateMetadata,
  type MergeTouchedPath,
} from "../src/git/ops/merge/merge-state.js";
import { SqliteGitDatabase } from "../src/git/store/index.js";
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
    });
    expect(db.storage.statementCount).toBeLessThan(1_000);
  });

  it("enforces merge-origin DDL and cold-reopens valid public writes", () => {
    const ddl = open();
    ddl.store.writeMergeState(metadata(), touched());
    expect(() =>
      ddl.db.run("UPDATE git_operation_state SET merge_origin = 'fetch' WHERE checkout_id = 1"),
    ).toThrow();

    const trusted = open();
    const state = metadata({ mergeOrigin: "pull" });
    trusted.store.writeMergeState(state, touched());
    const coldDatabase = new SqliteGitDatabase(trusted.db);
    const cold = coldDatabase.openCheckout(trusted.repository);
    expect(cold.requireMergeState()).toEqual({
      state,
      touched: touched(),
    });
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

  it("clears state and touched rows and rejects orphan touched rows", () => {
    const { db, store } = open();
    store.writeMergeState(metadata(), touched());

    expect(store.clearMergeState()).toBe(true);
    expect(store.readMergeState()).toBeNull();
    expect(db.scalar<number>("SELECT COUNT(*) FROM git_operation_state")).toBe(0);
    expect(db.scalar<number>("SELECT COUNT(*) FROM git_operation_touched")).toBe(0);
    expect(store.clearMergeState()).toBe(false);
    expect(() =>
      db.run(
        `INSERT INTO git_operation_touched
           (checkout_id, ordinal, path, logical_path, purpose, worktree_kind)
         VALUES (1, 0, 'orphan', 'orphan', 'primary', 'absent')`,
      ),
    ).toThrow();
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

  it("validates metadata and revisions before writing exact touched counts", () => {
    const invalidMetadata = open();
    expect(() =>
      invalidMetadata.store.writeMergeState(metadata({ phase: "ready" }), touched()),
    ).toThrowError(expect.objectContaining({ code: "ECORRUPT" }));
    expect(invalidMetadata.store.readMergeState()).toBeNull();

    const invalidRevision = touched().map(
      (entry): MergeTouchedPath =>
        entry.worktree.kind === "file"
          ? { ...entry, worktree: { ...entry.worktree, revision: -1 } }
          : entry,
    );
    const rejectedRevision = open();
    expect(() => rejectedRevision.store.writeMergeState(metadata(), invalidRevision)).toThrowError(
      expect.objectContaining({ code: "ECORRUPT" }),
    );
    expect(rejectedRevision.store.readMergeState()).toBeNull();

    const valid = open();
    const paths = touched();
    valid.store.writeMergeState(metadata(), paths);
    expect(
      valid.db.scalar<number>(
        "SELECT touched_count FROM git_operation_state WHERE checkout_id = 1",
      ),
    ).toBe(paths.length);
    expect(
      valid.db.scalar<number>("SELECT COUNT(*) FROM git_operation_touched WHERE checkout_id = 1"),
    ).toBe(paths.length);
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

  it("requires complete objects with matching types when the journal is created", () => {
    const cases: readonly {
      name: string;
      state: MergeStateMetadata;
      paths: readonly MergeTouchedPath[];
    }[] = [
      {
        name: "missing parent",
        state: metadata({ incomingParentOid: "f".repeat(40) }),
        paths: touched(),
      },
      {
        name: "parent is a blob",
        state: metadata({ incomingParentOid: FILE }),
        paths: touched(),
      },
      {
        name: "index file is a commit",
        state: metadata(),
        paths: touched().map(
          (entry): MergeTouchedPath =>
            entry.index === null ? entry : { ...entry, index: { ...entry.index, oid: INCOMING } },
        ),
      },
      {
        name: "worktree symlink is a commit",
        state: metadata(),
        paths: touched().map(
          (entry): MergeTouchedPath =>
            entry.worktree.kind === "symlink"
              ? { ...entry, worktree: { ...entry.worktree, oid: INCOMING } }
              : entry,
        ),
      },
    ];

    for (const testCase of cases) {
      const { db, store } = open();
      expect(
        () => store.writeMergeState(testCase.state, testCase.paths),
        testCase.name,
      ).toThrowError(expect.objectContaining({ code: "ECORRUPT" }));
      expect(store.readMergeState(), testCase.name).toBeNull();
      expect(
        db.scalar<number>("SELECT COUNT(*) FROM git_operation_touched WHERE checkout_id = 1"),
        testCase.name,
      ).toBe(0);
    }
  });
});
