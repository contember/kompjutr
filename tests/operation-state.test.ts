import { describe, expect, it } from "vitest";
import { utf8 } from "../src/git/common/bytes.js";
import { hashObject, serializeCommit, serializeTree } from "../src/git/common/objects.js";
import type { MergeTouchedPath } from "../src/git/ops/merge-state.js";
import {
  MAX_OPERATION_STEPS,
  type OperationStepMetadata,
  operationStepsForState,
  type RebaseStateMetadata,
  type ReplayStateMetadata,
} from "../src/git/ops/operation-state.js";
import { checkoutStoreMutations } from "../src/git/store/checkout.js";
import { readOperationStateOwned, SqliteGitDatabase } from "../src/git/store/index.js";
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
const WRONG_RESULT_BYTES = serializeCommit({
  tree: TREE,
  parent: [ORIGINAL],
  author: PERSON,
  committer: PERSON,
  message: "wrong parent\n",
});
const WRONG_RESULT = hashObject("commit", WRONG_RESULT_BYTES);
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
  store.write("commit", MERGE_BYTES);
  store.write("commit", THIRD_BYTES);
  store.write("commit", RESULT_ONE_BYTES);
  store.write("commit", RESULT_TWO_BYTES);
  store.write("commit", WRONG_RESULT_BYTES);
  store.write("blob", FILE_BYTES);
  return { db, database, repository, store };
}

describe("durable operation journal", () => {
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

  it("rejects cursor/outcome mismatches, invalid touched ownership, and bad topology", () => {
    const structural: readonly {
      state: RebaseStateMetadata;
      steps: readonly OperationStepMetadata[];
      paths: readonly MergeTouchedPath[];
    }[] = [
      { state: rebase({ currentStep: 1 }), steps: rebaseSteps(), paths: [] },
      {
        state: rebase(),
        steps: [{ ...rebaseSteps()[0]!, outcome: "skipped" }, rebaseSteps()[1]!],
        paths: [],
      },
      { state: rebase({ currentParentOid: RESULT_ONE }), steps: rebaseSteps(), paths: [] },
      { state: rebase({ phase: "conflicted" }), steps: rebaseSteps(), paths: [] },
      { state: rebase(), steps: rebaseSteps(), paths: touched() },
    ];
    for (const witness of structural) {
      const { store } = open();
      expect(() =>
        store.writeOperationJournal(witness.state, witness.steps, witness.paths),
      ).toThrowError(expect.objectContaining({ code: "ECORRUPT" }));
    }

    const swapped = [...rebaseSteps()].reverse();
    expect(() => open().store.writeOperationJournal(rebase(), swapped, [])).toThrowError(
      expect.objectContaining({ code: "ECORRUPT" }),
    );

    const wrongResultSteps: readonly OperationStepMetadata[] = [
      { ...rebaseSteps()[0]!, outcome: "applied", resultOid: WRONG_RESULT },
      rebaseSteps()[1]!,
    ];
    expect(() =>
      open().store.writeOperationJournal(
        rebase({ currentStep: 1, currentParentOid: WRONG_RESULT }),
        wrongResultSteps,
        [],
      ),
    ).toThrowError(expect.objectContaining({ code: "ECORRUPT" }));

    expect(() =>
      open().store.writeOperationJournal(rebase({ upstreamOid: FILE }), rebaseSteps(), []),
    ).toThrowError(expect.objectContaining({ code: "ECORRUPT" }));

    expect(() =>
      open().store.writeOperationJournal(rebase({ originalHeadOid: SOURCE }), rebaseSteps(), []),
    ).toThrowError(expect.objectContaining({ code: "ECORRUPT" }));
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

  it("pages exact-limit validation while cumulative commit bodies exceed 32 MiB", () => {
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
          message: `${"x".repeat(8_192)} step ${ordinal}\n`,
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

    expect(
      db.scalar<number>("SELECT sum(size) FROM git_objects WHERE repo_id = 1 AND type = 'commit'"),
    ).toBeGreaterThan(32 * 1024 * 1024);
    // Pages stay bounded by the batch cap (E2BIG above it); >= 2 proves paging ran.
    const metadataPages = [...histogram].reduce(
      (total, [query, count]) =>
        total + (query.startsWith("WITH wanted(ordinal, oid) AS MATERIALIZED") ? count : 0),
      0,
    );
    expect(metadataPages).toBeGreaterThanOrEqual(2);
    expect(store.requireOperationState("rebase").steps).toHaveLength(MAX_OPERATION_STEPS);

    const coldDatabase = new SqliteGitDatabase(db);
    const coldRow = coldDatabase.checkoutAt("/repo");
    if (coldRow === null) throw new Error("cold checkout disappeared");
    const cold = coldDatabase.openCheckout(coldRow);
    expect(cold.requireOperationState("rebase").steps).toHaveLength(MAX_OPERATION_STEPS);
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
      const { store } = open();
      expect(
        () => store.writeOperationState(witness.invalid, []),
        `${witness.name} write`,
      ).toThrowError(expect.objectContaining({ code: "ECORRUPT" }));
      store.writeOperationState(witness.valid, []);
      expect(store.readOperationState()).toMatchObject({
        state: witness.valid,
        steps: operationStepsForState(witness.valid),
      });
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
