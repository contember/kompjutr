import { describe, expect, it } from "vitest";
import { utf8 } from "../packages/git/src/common/bytes.js";
import { hashObject, serializeCommit, serializeTree } from "../packages/git/src/common/objects.js";
import {
  MAX_OPERATION_STEPS,
  type OperationStepMetadata,
  operationStepsForState,
  type RebaseStateMetadata,
  type ReplayStateMetadata,
} from "../packages/git/src/ops/core/operation-state.js";
import type { MergeTouchedPath } from "../packages/git/src/ops/merge/merge-state.js";
import { checkoutStoreMutations } from "../packages/git/src/store/core/checkout-mutations-registry.js";
import { readOperationStateOwned, SqliteGitDatabase } from "../packages/git/src/store/index.js";
import { INTEGRATION_PAGE_ROWS } from "../packages/git/src/store/operations/integration-workspace/storage.js";
import {
  iterateOperationTouched,
  readOperationHeader,
} from "../packages/git/src/store/operations/operation-journal-read.js";
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
const THIRD_BYTES = serializeCommit({
  tree: TREE,
  parent: [SOURCE],
  author: PERSON,
  committer: PERSON,
  message: "third\n",
});
const THIRD = hashObject("commit", THIRD_BYTES);
const RESULT_ONE_BYTES = serializeCommit({
  tree: TREE,
  parent: [SECOND],
  author: PERSON,
  committer: PERSON,
  message: "rewritten source\n",
});
const RESULT_ONE = hashObject("commit", RESULT_ONE_BYTES);
const RESULT_TWO_BYTES = serializeCommit({
  tree: TREE,
  parent: [RESULT_ONE],
  author: PERSON,
  committer: PERSON,
  message: "rewritten third\n",
});
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

function rebase(overrides: Partial<RebaseStateMetadata> = {}): RebaseStateMetadata {
  return {
    kind: "rebase",
    originalHeadRef: "refs/heads/main",
    originalHeadOid: THIRD,
    phase: "running",
    upstreamOid: SECOND,
    baseOid: ORIGINAL,
    currentParentOid: SECOND,
    currentStep: 0,
    currentLabel: "HEAD",
    incomingLabel: SOURCE.slice(0, 7),
    message: "source\n",
    author: null,
    committer: null,
    ...overrides,
  };
}

function rebaseSteps(): readonly OperationStepMetadata[] {
  return [
    {
      sourceOid: SOURCE,
      selectedParentOid: ORIGINAL,
      mainline: null,
      outcome: "pending",
      resultOid: null,
    },
    {
      sourceOid: THIRD,
      selectedParentOid: SOURCE,
      mainline: null,
      outcome: "pending",
      resultOid: null,
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
  store.write("commit", SOURCE_BYTES);
  store.write("commit", SECOND_BYTES);
  store.write("commit", THIRD_BYTES);
  store.write("commit", RESULT_ONE_BYTES);
  store.write("commit", RESULT_TWO_BYTES);
  store.write("blob", FILE_BYTES);
  return { db, database, repository, store };
}

describe("durable operation journal", () => {
  it("writes a repeatable 1001-path source and reads it after cold reopen", () => {
    const { db, repository, store } = open();
    const state = replay("cherry-pick", { phase: "conflicted", emptyReason: null });
    const source = {
      length: 1001,
      *[Symbol.iterator](): Generator<MergeTouchedPath> {
        for (let index = 0; index < this.length; index++) {
          const path = `${"long-".repeat(300)}${String(index).padStart(4, "0")}`;
          yield {
            path,
            logicalPath: path,
            purpose: "primary",
            index: { stage: 0, mode: 0o100644, oid: FILE, size: 7, mtime: 1, ino: 2, rev: 3 },
            worktree: { kind: "file", mode: 0o100644, oid: FILE, revision: 4 },
          };
        }
      },
    };
    checkoutStoreMutations(store).writeOperationStateOwned(state, source);
    const cold = new SqliteGitDatabase(db).openCheckout(repository);
    const header = readOperationHeader(db, cold.checkoutId);
    expect(header?.touchedCount).toBe(1001);
    expect([...iterateOperationTouched(db, cold.checkoutId)]).toEqual([...source]);
    expect(cold.requireOperationState("cherry-pick").touched).toEqual([...source]);
  });

  it("round-trips trusted replay metadata through a cold reopen", () => {
    const kinds: readonly ("cherry-pick" | "revert")[] = ["cherry-pick", "revert"];
    for (const kind of kinds) {
      const { db, repository, store } = open();
      const state = replay(kind);
      const steps = operationStepsForState(state);
      store.writeOperationState(state, []);

      const cold = new SqliteGitDatabase(db).openCheckout(repository).requireOperationState(kind);

      expect(cold).toEqual({
        kind,
        state,
        steps,
        touched: [],
        replayed: 0,
        skipped: 0,
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
  });

  it("moves a conflicted replay to empty with one conditional transition", () => {
    const { store } = open();
    store.writeOperationState(
      replay("cherry-pick", { phase: "conflicted", emptyReason: null }),
      touched(),
    );

    checkoutStoreMutations(store).markReplayEmptyOwned("cherry-pick", "result");

    const journal = store.requireOperationState("cherry-pick");
    expect(journal.state).toMatchObject({ phase: "empty", emptyReason: "result" });
    expect(journal.touched).toEqual([]);
    expect(() =>
      checkoutStoreMutations(store).markReplayEmptyOwned("cherry-pick", "result"),
    ).toThrowError(expect.objectContaining({ code: "EOPMISMATCH" }));
  });

  it("keeps replay plans immutable while advancing one row per step", () => {
    const { db, repository, store } = open();
    const steps = rebaseSteps();
    store.writeOperationJournal(rebase(), steps, []);

    checkoutStoreMutations(store).suspendRebaseOwned(0, touched());
    let journal = store.requireOperationState("rebase");
    expect(journal.state).toMatchObject({ phase: "conflicted", currentStep: 0 });
    expect(journal.steps).toEqual(steps);

    checkoutStoreMutations(store).advanceRebaseOwned(
      "conflicted",
      0,
      "applied",
      RESULT_ONE,
      RESULT_ONE,
      null,
    );
    journal = store.requireOperationState("rebase");
    expect(journal.state).toMatchObject({
      phase: "running",
      currentStep: 1,
      currentParentOid: RESULT_ONE,
    });
    expect(journal.steps).toEqual([
      { ...steps[0]!, outcome: "applied", resultOid: RESULT_ONE },
      steps[1],
    ]);
    expect(journal).toMatchObject({ replayed: 1, skipped: 0, touched: [] });

    checkoutStoreMutations(store).advanceRebaseOwned(
      "running",
      1,
      "skipped",
      null,
      RESULT_ONE,
      null,
    );
    const cold = new SqliteGitDatabase(db).openCheckout(repository).requireOperationState("rebase");
    expect(cold.state).toMatchObject({ currentStep: 2, currentParentOid: RESULT_ONE });
    expect(cold.steps[0]).toEqual({
      ...steps[0],
      outcome: "applied",
      resultOid: RESULT_ONE,
    });
    expect(cold.steps[1]).toEqual({ ...steps[1], outcome: "skipped" });
    expect(cold).toMatchObject({ replayed: 1, skipped: 1 });
    expect(() =>
      checkoutStoreMutations(store).advanceRebaseOwned(
        "running",
        1,
        "skipped",
        null,
        RESULT_ONE,
        null,
      ),
    ).toThrowError(expect.objectContaining({ code: "EOPMISMATCH" }));
  });

  it("keeps structural limits while large conflict snapshots round-trip", () => {
    const step = rebaseSteps()[0]!;
    const tooManySteps = Array.from({ length: MAX_OPERATION_STEPS + 1 }, () => step);
    expect(() => open().store.writeOperationJournal(rebase(), tooManySteps, [])).toThrowError(
      expect.objectContaining({ code: "E2BIG" }),
    );
    const state = replay("cherry-pick", { message: "large journal\n" });
    const largeTouched = Array.from({ length: 1_000 }, (_, ordinal): MergeTouchedPath => {
      const path = `${ordinal.toString().padStart(4, "0")}/${"x".repeat(2_100)}`;
      return {
        path,
        logicalPath: path,
        purpose: "primary",
        index: null,
        worktree: { kind: "absent" },
      };
    });
    const written = open();
    written.store.writeOperationState(state, largeTouched);
    const cold = new SqliteGitDatabase(written.db).openCheckout(written.repository);
    expect(cold.requireOperationState("cherry-pick")).toMatchObject({
      touched: largeTouched,
    });
    expect(readOperationStateOwned(cold)).toMatchObject({ touched: largeTouched });
  });

  it("writes a full-length rebase journal without reading its commit objects", () => {
    const { db, store } = open();
    const steps: OperationStepMetadata[] = [];
    let parentOid = ORIGINAL;
    store.writeObjects((batch) => {
      for (let ordinal = 0; ordinal < MAX_OPERATION_STEPS; ordinal++) {
        const data = serializeCommit({
          tree: TREE,
          parent: [parentOid],
          author: PERSON,
          committer: PERSON,
          message: `step ${ordinal}\n`,
        });
        const sourceOid = batch.write("commit", data);
        steps.push({
          sourceOid,
          selectedParentOid: parentOid,
          mainline: null,
          outcome: "pending",
          resultOid: null,
        });
        parentOid = sourceOid;
      }
    });
    const state = rebase({ originalHeadOid: parentOid });
    const histogram = new Map<string, number>();
    db.storage.histogram = histogram;

    store.writeOperationJournal(state, steps, []);

    const objectReads = [...histogram].filter(
      ([query]) => query.includes("git_objects") || query.includes("git_pack_objects"),
    );
    expect(objectReads).toEqual([]);
    const coldDatabase = new SqliteGitDatabase(db);
    const coldRow = coldDatabase.checkoutAt("/repo");
    if (coldRow === null) throw new Error("cold checkout disappeared");
    const cold = coldDatabase.openCheckout(coldRow);
    expect(cold.requireOperationState("rebase").steps).toHaveLength(MAX_OPERATION_STEPS);
  });
});

describe("operation journal keyset paging", () => {
  // Journal paths stop at 2,200 bytes, so only JSON escaping can inflate a row
  // enough for the byte cap to land below the row limit: each U+0001 costs six.
  const ESCAPED_PADDING = 2_150;

  function journalWith(count: number, padding = 0) {
    const touchedPaths = Array.from({ length: count }, (_, index): MergeTouchedPath => {
      const path = `${"\u0001".repeat(padding)}file-${String(index).padStart(5, "0")}`;
      return {
        path,
        logicalPath: path,
        purpose: "primary",
        index: null,
        worktree: { kind: "absent" },
      };
    });
    const written = open();
    written.store.writeOperationState(
      replay("cherry-pick", { phase: "conflicted", emptyReason: null }),
      touchedPaths,
    );
    return { ...written, paths: touchedPaths.map((entry) => entry.path) };
  }

  function traverse(db: TestDatabase, checkoutId: number): { paths: string[]; statements: number } {
    db.storage.resetCounters();
    const paths = [...iterateOperationTouched(db, checkoutId)].map((entry) => entry.path);
    return { paths, statements: db.storage.statementCount };
  }

  it("ends on a short final page without an empty keyset query", () => {
    const { db, store, paths } = journalWith(INTEGRATION_PAGE_ROWS + 44);
    const read = traverse(db, store.checkoutId);
    expect(read.paths).toEqual(paths);
    expect(read.statements).toBe(2);
  });

  it("keeps probing after a final page that fills the row limit exactly", () => {
    const { db, store, paths } = journalWith(INTEGRATION_PAGE_ROWS * 2);
    const read = traverse(db, store.checkoutId);
    expect(read.paths).toEqual(paths);
    expect(read.statements).toBe(3);
  });

  it("follows a page the byte cap truncated below the row limit", () => {
    const { db, store, paths } = journalWith(100, ESCAPED_PADDING);
    const read = traverse(db, store.checkoutId);
    expect(read.paths).toEqual(paths);
    // The first page stops on bytes with about 58 of 256 rows, which proves
    // nothing about what follows, so the rest needs a second query.
    expect(read.statements).toBe(2);
  });
});
