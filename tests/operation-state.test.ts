import { describe, expect, it } from "vitest";

import { utf8 } from "../src/core/bytes.js";
import { hashObject, serializeCommit, serializeTree } from "../src/core/objects.js";
import type { MergeTouchedPath } from "../src/core/ops/merge-state.js";
import {
  operationJournalIntegrityOid,
  operationJournalRetainedBytes,
  type ReplayStateMetadata,
} from "../src/core/ops/operation-state.js";
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
const SOURCE_BYTES = serializeCommit({
  tree: TREE,
  parent: [ORIGINAL],
  author: PERSON,
  committer: PERSON,
  message: "source\n",
});
const SOURCE = hashObject("commit", SOURCE_BYTES);
const SECOND_BYTES = serializeCommit({
  tree: TREE,
  parent: [],
  author: PERSON,
  committer: PERSON,
  message: "second root\n",
});
const SECOND = hashObject("commit", SECOND_BYTES);
const MERGE_BYTES = serializeCommit({
  tree: TREE,
  parent: [ORIGINAL, SECOND],
  author: PERSON,
  committer: PERSON,
  message: "merge\n",
});
const MERGE = hashObject("commit", MERGE_BYTES);
const FILE_BYTES = utf8.encode("before\n");
const FILE = hashObject("blob", FILE_BYTES);

function replay(
  kind: "cherry-pick" | "revert" = "cherry-pick",
  overrides: Partial<ReplayStateMetadata> = {},
): ReplayStateMetadata {
  return {
    kind,
    originalHeadRef: "refs/heads/main",
    originalHeadOid: ORIGINAL,
    phase: "empty",
    emptyReason: "result",
    sourceOid: SOURCE,
    selectedParentOid: ORIGINAL,
    mainline: null,
    currentLabel: "HEAD",
    incomingLabel: SOURCE.slice(0, 7),
    message: "source\n",
    author: null,
    committer: { name: "Committer", email: "committer@example.com" },
    ...overrides,
  };
}

function touched(): readonly MergeTouchedPath[] {
  return [
    {
      path: "file.txt",
      logicalPath: "file.txt",
      purpose: "primary",
      index: { stage: 0, mode: 0o100644, oid: FILE, size: 7, mtime: 1, ino: 2, rev: 3 },
      worktree: { kind: "file", mode: 0o100644, oid: FILE, revision: 4 },
    },
  ];
}

function open() {
  const db = new TestDatabase();
  const database = new SqliteGitDatabase(db);
  const repository = database.create("/repo", "ref: refs/heads/main");
  const store = database.open(repository);
  store.write("tree", TREE_BYTES);
  store.write("commit", ORIGINAL_BYTES);
  store.write("commit", SOURCE_BYTES);
  store.write("commit", SECOND_BYTES);
  store.write("commit", MERGE_BYTES);
  store.write("blob", FILE_BYTES);
  return { db, database, repository, store };
}

describe("durable operation journal", () => {
  it("round-trips replay metadata and integrity through a cold reopen", () => {
    const kinds: readonly ("cherry-pick" | "revert")[] = ["cherry-pick", "revert"];
    for (const kind of kinds) {
      const { db, repository, store } = open();
      const state = replay(kind);
      store.writeOperationState(state, []);

      const cold = new SqliteGitDatabase(db).open(repository).requireOperationState(kind);

      expect(cold).toEqual({
        kind,
        state,
        touched: [],
        retainedBytes: operationJournalRetainedBytes(state, []),
        integrityOid: operationJournalIntegrityOid(state, []),
      });
    }
  });

  it("enforces one active operation and stable typed state errors", () => {
    const { store } = open();
    expect(() => store.requireOperationState("cherry-pick")).toThrowError(
      expect.objectContaining({ code: "ENOCHERRYPICK" }),
    );
    expect(() => store.requireOperationState("revert")).toThrowError(
      expect.objectContaining({ code: "ENOREVERT" }),
    );
    store.writeOperationState(replay(), []);

    expect(() => store.requireNoOperationState()).toThrowError(
      expect.objectContaining({ code: "EOPACTIVE" }),
    );
    expect(() => store.requireOperationState("revert")).toThrowError(
      expect.objectContaining({ code: "EOPMISMATCH" }),
    );
    expect(() => store.requireMergeState()).toThrowError(
      expect.objectContaining({ code: "EOPMISMATCH" }),
    );
  });

  it("replaces only the authenticated operation metadata and retains snapshots", () => {
    const { store } = open();
    const conflicted = replay("cherry-pick", {
      phase: "conflicted",
      emptyReason: null,
    });
    const paths = touched();
    store.writeOperationState(conflicted, paths);
    const before = store.requireOperationState("cherry-pick");
    const empty = replay("cherry-pick", { phase: "empty", emptyReason: "result" });

    expect(() => store.replaceOperationState("f".repeat(40), empty)).toThrowError(
      expect.objectContaining({ code: "EOPMISMATCH" }),
    );
    store.replaceOperationState(before.integrityOid, empty);

    const after = store.requireOperationState("cherry-pick");
    expect(after.state).toEqual(empty);
    expect(after.touched).toEqual(paths);
    expect(after.integrityOid).not.toBe(before.integrityOid);
  });

  it("clears state and corrupt orphan rows generically", () => {
    const { db, store } = open();
    store.writeOperationState(
      replay("revert", { phase: "conflicted", emptyReason: null }),
      touched(),
    );
    db.run("DELETE FROM git_operation_state WHERE repo_id = 1");
    expect(() => store.readOperationState()).toThrowError(
      expect.objectContaining({ code: "ECORRUPT" }),
    );
    expect(store.clearOperationState()).toBe(true);
    expect(store.readOperationState()).toBeNull();
  });

  it("fails closed on invalid kind metadata, counts, integrity, and object types", () => {
    const corruptions: readonly ((db: TestDatabase) => void)[] = [
      (db) => {
        db.run("PRAGMA ignore_check_constraints = ON");
        db.run("UPDATE git_operation_state SET kind = 'pick' WHERE repo_id = 1");
        db.run("PRAGMA ignore_check_constraints = OFF");
      },
      (db) => db.run("UPDATE git_operation_state SET touched_count = 1 WHERE repo_id = 1"),
      (db) => db.run("UPDATE git_operation_state SET integrity_oid = ? WHERE repo_id = 1", FILE),
      (db) => db.run("UPDATE git_operation_state SET source_oid = ? WHERE repo_id = 1", FILE),
    ];
    for (const corrupt of corruptions) {
      const { db, store } = open();
      store.writeOperationState(replay(), []);
      corrupt(db);
      expect(() => store.readOperationState()).toThrowError(
        expect.objectContaining({ code: "ECORRUPT" }),
      );
    }
  });

  it("rejects authenticated replay selections that differ from source parents", () => {
    const cases: readonly {
      name: string;
      valid: ReplayStateMetadata;
      invalid: ReplayStateMetadata;
    }[] = [
      {
        name: "root with parent",
        valid: replay("cherry-pick", {
          sourceOid: ORIGINAL,
          selectedParentOid: null,
          mainline: null,
        }),
        invalid: replay("cherry-pick", {
          sourceOid: ORIGINAL,
          selectedParentOid: SOURCE,
          mainline: null,
        }),
      },
      {
        name: "single parent missing",
        valid: replay(),
        invalid: replay("cherry-pick", { selectedParentOid: null }),
      },
      {
        name: "single parent wrong",
        valid: replay(),
        invalid: replay("cherry-pick", { selectedParentOid: SECOND }),
      },
      {
        name: "merge mainline missing",
        valid: replay("revert", {
          sourceOid: MERGE,
          selectedParentOid: ORIGINAL,
          mainline: 1,
        }),
        invalid: replay("revert", {
          sourceOid: MERGE,
          selectedParentOid: ORIGINAL,
          mainline: null,
        }),
      },
      {
        name: "merge parent wrong",
        valid: replay("revert", {
          sourceOid: MERGE,
          selectedParentOid: ORIGINAL,
          mainline: 1,
        }),
        invalid: replay("revert", {
          sourceOid: MERGE,
          selectedParentOid: ORIGINAL,
          mainline: 2,
        }),
      },
    ];
    for (const witness of cases) {
      const { db, store } = open();
      expect(
        () => store.writeOperationState(witness.invalid, []),
        `${witness.name} write`,
      ).toThrowError(expect.objectContaining({ code: "ECORRUPT" }));
      store.writeOperationState(witness.valid, []);
      const current = store.readOperationState();
      if (current === null) throw new Error("expected operation journal");
      expect(
        () => store.replaceOperationState(current.integrityOid, witness.invalid),
        `${witness.name} replace`,
      ).toThrowError(expect.objectContaining({ code: "ECORRUPT" }));
      const retainedBytes = operationJournalRetainedBytes(witness.invalid, []);
      const integrityOid = operationJournalIntegrityOid(witness.invalid, []);
      db.run(
        `UPDATE git_operation_state
            SET source_oid = ?, selected_parent_oid = ?, mainline = ?,
                retained_bytes = ?, integrity_oid = ?
          WHERE repo_id = 1`,
        witness.invalid.sourceOid,
        witness.invalid.selectedParentOid,
        witness.invalid.mainline,
        retainedBytes,
        integrityOid,
      );

      expect(() => store.readOperationState(), witness.name).toThrowError(
        expect.objectContaining({ code: "ECORRUPT" }),
      );
    }
  });

  it("rejects impossible replay metadata before writing rows", () => {
    const cases: readonly ReplayStateMetadata[] = [
      replay("cherry-pick", { phase: "conflicted", emptyReason: "source" }),
      replay("cherry-pick", { phase: "empty", emptyReason: null }),
      replay("revert", { selectedParentOid: null, mainline: 1 }),
      replay("revert", { currentLabel: "" }),
    ];
    for (const state of cases) {
      const { db, store } = open();
      expect(() => store.writeOperationState(state, [])).toThrowError(
        expect.objectContaining({ code: "ECORRUPT" }),
      );
      expect(db.scalar<number>("SELECT COUNT(*) FROM git_operation_state")).toBe(0);
    }
  });
});
