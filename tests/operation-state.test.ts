import { describe, expect, it } from "vitest";

import { utf8 } from "../src/core/bytes.js";
import { hashObject, serializeCommit, serializeTree } from "../src/core/objects.js";
import type { MergeTouchedPath } from "../src/core/ops/merge-state.js";
import { MAX_MERGE_STATE_BYTES } from "../src/core/ops/merge-state.js";
import {
  MAX_OPERATION_STEPS,
  type OperationStepMetadata,
  operationJournalIntegrityOid,
  operationJournalRetainedBytes,
  operationStepsForState,
  type RebaseStateMetadata,
  type ReplayStateMetadata,
} from "../src/core/ops/operation-state.js";
import { MAX_LOG_STATE_BYTES, SqliteGitDatabase } from "../src/sqlite/store.js";
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
const RESULT_TWO = hashObject("commit", RESULT_TWO_BYTES);
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
  it("round-trips replay metadata and integrity through a cold reopen", () => {
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
        retainedBytes: operationJournalRetainedBytes(state, [], steps),
        integrityOid: operationJournalIntegrityOid(state, [], steps),
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

  it("round-trips ordered rebase steps and advances them through whole-journal CAS", () => {
    const { db, repository, store } = open();
    const initialState = rebase();
    const initialSteps = rebaseSteps();
    store.writeOperationJournal(initialState, initialSteps, []);
    const initial = store.requireOperationState("rebase");

    expect(() =>
      store.replaceOperationJournal("f".repeat(40), initialState, initialSteps, []),
    ).toThrowError(expect.objectContaining({ code: "EOPMISMATCH" }));

    const appliedSteps: readonly OperationStepMetadata[] = [
      { ...initialSteps[0]!, outcome: "applied", resultOid: RESULT_ONE },
      initialSteps[1]!,
    ];
    const appliedState = rebase({ currentStep: 1, currentParentOid: RESULT_ONE });
    store.replaceOperationJournal(initial.integrityOid, appliedState, appliedSteps, []);
    const applied = store.requireOperationState("rebase");
    expect(applied.steps).toEqual(appliedSteps);

    const completedSteps: readonly OperationStepMetadata[] = [
      appliedSteps[0]!,
      { ...appliedSteps[1]!, outcome: "skipped" },
    ];
    const completedState = rebase({ currentStep: 2, currentParentOid: RESULT_ONE });
    store.replaceOperationJournal(applied.integrityOid, completedState, completedSteps, []);

    const cold = new SqliteGitDatabase(db).openCheckout(repository).requireOperationState("rebase");
    expect(cold.state).toEqual(completedState);
    expect(cold.steps).toEqual(completedSteps);
    expect(cold.touched).toEqual([]);
  });

  it("permits only one contiguous rebase step or one conflict suspension per CAS", () => {
    {
      const { store } = open();
      const initialState = rebase();
      const initialSteps = rebaseSteps();
      store.writeOperationJournal(initialState, initialSteps, []);
      const initial = store.requireOperationState("rebase");
      const conflictedState = rebase({ phase: "conflicted" });
      store.replaceOperationJournal(initial.integrityOid, conflictedState, initialSteps, touched());
      const conflicted = store.requireOperationState("rebase");
      const appliedSteps: readonly OperationStepMetadata[] = [
        { ...initialSteps[0]!, outcome: "applied", resultOid: RESULT_ONE },
        initialSteps[1]!,
      ];
      store.replaceOperationJournal(
        conflicted.integrityOid,
        rebase({ currentStep: 1, currentParentOid: RESULT_ONE }),
        appliedSteps,
        [],
      );
      expect(store.requireOperationState("rebase").steps).toEqual(appliedSteps);
    }

    const illegal: readonly ((store: ReturnType<typeof open>["store"]) => void)[] = [
      (store) => {
        const current = store.requireOperationState("rebase");
        const steps: readonly OperationStepMetadata[] = [
          { ...rebaseSteps()[0]!, outcome: "applied", resultOid: RESULT_ONE },
          { ...rebaseSteps()[1]!, outcome: "skipped" },
        ];
        store.replaceOperationJournal(
          current.integrityOid,
          rebase({ currentStep: 2, currentParentOid: RESULT_ONE }),
          steps,
          [],
        );
      },
      (store) => {
        const current = store.requireOperationState("rebase");
        const steps: readonly OperationStepMetadata[] = [
          { ...rebaseSteps()[0]!, outcome: "applied", resultOid: RESULT_ONE },
          rebaseSteps()[1]!,
        ];
        store.replaceOperationJournal(
          current.integrityOid,
          rebase({ upstreamOid: ORIGINAL, currentStep: 1, currentParentOid: RESULT_ONE }),
          steps,
          [],
        );
      },
      (store) => {
        const current = store.requireOperationState("rebase");
        const steps: readonly OperationStepMetadata[] = [
          { ...rebaseSteps()[0]!, outcome: "applied", resultOid: RESULT_ONE },
          { ...rebaseSteps()[1]!, sourceOid: SOURCE, selectedParentOid: ORIGINAL },
        ];
        store.replaceOperationJournal(
          current.integrityOid,
          rebase({ currentStep: 1, currentParentOid: RESULT_ONE }),
          steps,
          [],
        );
      },
    ];
    for (const transition of illegal) {
      const { store } = open();
      store.writeOperationJournal(rebase(), rebaseSteps(), []);
      expect(() => transition(store)).toThrowError(
        expect.objectContaining({ code: "EOPMISMATCH" }),
      );
      expect(store.requireOperationState("rebase").state.currentStep).toBe(0);
    }

    {
      const { store } = open();
      const initialSteps = rebaseSteps();
      store.writeOperationJournal(rebase(), initialSteps, []);
      const initial = store.requireOperationState("rebase");
      const appliedSteps: readonly OperationStepMetadata[] = [
        { ...initialSteps[0]!, outcome: "applied", resultOid: RESULT_ONE },
        initialSteps[1]!,
      ];
      store.replaceOperationJournal(
        initial.integrityOid,
        rebase({ currentStep: 1, currentParentOid: RESULT_ONE }),
        appliedSteps,
        [],
      );
      const applied = store.requireOperationState("rebase");
      expect(() =>
        store.replaceOperationJournal(applied.integrityOid, rebase(), initialSteps, []),
      ).toThrowError(expect.objectContaining({ code: "EOPMISMATCH" }));

      const mutatedPrefix: readonly OperationStepMetadata[] = [
        { ...appliedSteps[0]!, resultOid: RESULT_TWO },
        { ...appliedSteps[1]!, outcome: "skipped" },
      ];
      expect(() =>
        store.replaceOperationJournal(
          applied.integrityOid,
          rebase({ currentStep: 2, currentParentOid: RESULT_TWO }),
          mutatedPrefix,
          [],
        ),
      ).toThrowError(expect.objectContaining({ code: "EOPMISMATCH" }));
    }
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

  it("rejects authenticated swapped sources and an applied result with the wrong parent", () => {
    {
      const { db, store } = open();
      const state = rebase();
      const steps = [...rebaseSteps()].reverse();
      store.writeOperationJournal(state, rebaseSteps(), []);
      for (let ordinal = 0; ordinal < steps.length; ordinal++) {
        const step = steps[ordinal];
        if (step === undefined) throw new Error("expected swapped step");
        db.run(
          `UPDATE git_operation_steps
              SET source_oid = ?, selected_parent_oid = ?, mainline = ?
            WHERE checkout_id = 1 AND ordinal = ?`,
          step.sourceOid,
          step.selectedParentOid,
          step.mainline,
          ordinal,
        );
      }
      db.run(
        "UPDATE git_operation_state SET retained_bytes = ?, integrity_oid = ? WHERE checkout_id = 1",
        operationJournalRetainedBytes(state, [], steps),
        operationJournalIntegrityOid(state, [], steps),
      );
      expect(() => store.readOperationState()).toThrowError(
        expect.objectContaining({ code: "ECORRUPT" }),
      );
    }

    {
      const { db, store } = open();
      const state = rebase({ currentStep: 1, currentParentOid: WRONG_RESULT });
      const steps: readonly OperationStepMetadata[] = [
        { ...rebaseSteps()[0]!, outcome: "applied", resultOid: WRONG_RESULT },
        rebaseSteps()[1]!,
      ];
      store.writeOperationJournal(rebase(), rebaseSteps(), []);
      db.run(
        `UPDATE git_operation_steps
            SET outcome = 'applied', result_oid = ?
          WHERE checkout_id = 1 AND ordinal = 0`,
        WRONG_RESULT,
      );
      db.run(
        `UPDATE git_operation_state
            SET current_step = 1, current_parent_oid = ?, retained_bytes = ?, integrity_oid = ?
          WHERE checkout_id = 1`,
        WRONG_RESULT,
        operationJournalRetainedBytes(state, [], steps),
        operationJournalIntegrityOid(state, [], steps),
      );
      expect(() => store.readOperationState()).toThrowError(
        expect.objectContaining({ code: "ECORRUPT" }),
      );
    }
  });

  it("accepts exact step and retained-byte limits and rejects the next unit", () => {
    const step = rebaseSteps()[0]!;
    const exactSteps = Array.from({ length: MAX_OPERATION_STEPS }, () => step);
    expect(operationJournalRetainedBytes(rebase(), [], exactSteps)).toBeLessThanOrEqual(
      MAX_MERGE_STATE_BYTES,
    );
    expect(() => operationJournalRetainedBytes(rebase(), [], [...exactSteps, step])).toThrowError(
      expect.objectContaining({ code: "E2BIG" }),
    );

    const entryCount = 500;
    let state = replay("cherry-pick", { message: "" });
    let remaining = 0;
    for (let adjustment = 0; adjustment < 4; adjustment++) {
      state = replay("cherry-pick", { message: "x".repeat(adjustment) });
      const base = operationJournalRetainedBytes(state, []);
      const minimumEntry: MergeTouchedPath = {
        path: "0000/x",
        logicalPath: "0000/x",
        purpose: "primary",
        index: null,
        worktree: { kind: "absent" },
      };
      const entryBytes = operationJournalRetainedBytes(state, [minimumEntry]) - base;
      remaining = MAX_MERGE_STATE_BYTES - base - entryBytes * entryCount;
      if (remaining >= 0 && remaining % 4 === 0) break;
    }
    expect(remaining).toBeGreaterThanOrEqual(0);
    expect(remaining % 4).toBe(0);
    let extraCharacters = remaining / 4;
    const exactTouched: MergeTouchedPath[] = [];
    for (let ordinal = 0; ordinal < entryCount; ordinal++) {
      const extra = Math.min(extraCharacters, 2_193);
      extraCharacters -= extra;
      const path = `${ordinal.toString().padStart(4, "0")}/${"x".repeat(extra + 1)}`;
      exactTouched.push({
        path,
        logicalPath: path,
        purpose: "primary",
        index: null,
        worktree: { kind: "absent" },
      });
    }
    expect(extraCharacters).toBe(0);
    expect(operationJournalRetainedBytes(state, exactTouched)).toBe(MAX_MERGE_STATE_BYTES);
    open().store.writeOperationState(state, exactTouched);

    const last = exactTouched[exactTouched.length - 1];
    if (last === undefined) throw new Error("expected retained-byte boundary fixture");
    const over = [
      ...exactTouched.slice(0, -1),
      { ...last, path: `${last.path}x`, logicalPath: `${last.logicalPath}x` },
    ];
    const { db, store } = open();
    expect(() => store.writeOperationState(state, over)).toThrowError(
      expect.objectContaining({ code: "E2BIG" }),
    );
    expect(db.scalar<number>("SELECT COUNT(*) FROM git_operation_state")).toBe(0);
  });

  it("pages exact-limit object validation and enforces 32 MiB across body pages", () => {
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
    const objectInfoCalls: number[] = [];
    const objectReadCalls: number[] = [];
    const objectInfo = store.objectInfo.bind(store);
    const readObjects = store.readObjects.bind(store);
    store.objectInfo = (oids) => {
      objectInfoCalls.push(oids.length);
      return objectInfo(oids);
    };
    store.readObjects = (oids, options) => {
      objectReadCalls.push(oids.length);
      return readObjects(oids, options);
    };

    store.writeOperationJournal(state, steps, []);

    expect(objectInfoCalls.length).toBeGreaterThanOrEqual(2);
    expect(Math.max(...objectInfoCalls)).toBe(4_096);
    expect(objectInfoCalls.every((count) => count <= 4_096)).toBe(true);
    expect(objectReadCalls.every((count) => count <= 4_096)).toBe(true);
    expect(store.requireOperationState("rebase").steps).toHaveLength(MAX_OPERATION_STEPS);
    store.clearOperationState();

    store.readObjects = (oids, options = {}) => {
      const selected = oids.slice(0, 455);
      const batch = readObjects(selected, options);
      return {
        objects: batch.objects,
        remaining: [...batch.remaining, ...oids.slice(selected.length)],
        bytes: options.budgetBytes ?? batch.bytes,
      };
    };
    expect(() => store.writeOperationJournal(state, steps, [])).toThrowError(
      expect.objectContaining({
        code: "E2BIG",
        message: `operation journal commit bodies exceed ${MAX_LOG_STATE_BYTES} bytes`,
      }),
    );
    expect(MAX_LOG_STATE_BYTES).toBe(33_554_432);
    expect(db.scalar<number>("SELECT COUNT(*) FROM git_operation_state")).toBe(0);
  });

  it("clears state and corrupt orphan rows generically", () => {
    const { db, store } = open();
    store.writeOperationState(
      replay("revert", { phase: "conflicted", emptyReason: null }),
      touched(),
    );
    db.run("PRAGMA foreign_keys = OFF");
    db.run("DELETE FROM git_operation_state WHERE checkout_id = 1");
    db.run("PRAGMA foreign_keys = ON");
    expect(() => store.readOperationState()).toThrowError(
      expect.objectContaining({ code: "ECORRUPT" }),
    );
    expect(store.clearOperationState()).toBe(true);
    expect(store.readOperationState()).toBeNull();
    expect(db.scalar<number>("SELECT COUNT(*) FROM git_operation_steps")).toBe(0);
    expect(db.scalar<number>("SELECT COUNT(*) FROM git_operation_touched")).toBe(0);
  });

  it("fails closed on invalid kind metadata, counts, integrity, and object types", () => {
    const corruptions: readonly ((db: TestDatabase) => void)[] = [
      (db) => {
        db.run("PRAGMA ignore_check_constraints = ON");
        db.run("UPDATE git_operation_state SET kind = 'pick' WHERE checkout_id = 1");
        db.run("PRAGMA ignore_check_constraints = OFF");
      },
      (db) => db.run("UPDATE git_operation_state SET touched_count = 1 WHERE checkout_id = 1"),
      (db) =>
        db.run("UPDATE git_operation_state SET integrity_oid = ? WHERE checkout_id = 1", FILE),
      (db) => db.run("UPDATE git_operation_steps SET source_oid = ? WHERE checkout_id = 1", FILE),
      (db) => {
        db.run("PRAGMA ignore_check_constraints = ON");
        db.run(
          "UPDATE git_operation_state SET current_step = zeroblob(4096) WHERE checkout_id = 1",
        );
        db.run("PRAGMA ignore_check_constraints = OFF");
      },
      (db) => {
        db.run("PRAGMA ignore_check_constraints = ON");
        db.run("UPDATE git_operation_state SET step_count = zeroblob(4096) WHERE checkout_id = 1");
        db.run("PRAGMA ignore_check_constraints = OFF");
      },
      (db) => {
        db.run("PRAGMA ignore_check_constraints = ON");
        db.run("UPDATE git_operation_steps SET ordinal = zeroblob(4096) WHERE checkout_id = 1");
        db.run("PRAGMA ignore_check_constraints = OFF");
      },
      (db) => {
        db.run("PRAGMA ignore_check_constraints = ON");
        db.run("UPDATE git_operation_steps SET mainline = zeroblob(4096) WHERE checkout_id = 1");
        db.run("PRAGMA ignore_check_constraints = OFF");
      },
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
      const steps = operationStepsForState(witness.invalid);
      const [step] = steps;
      if (step === undefined) throw new Error("expected replay step");
      const retainedBytes = operationJournalRetainedBytes(witness.invalid, [], steps);
      const integrityOid = operationJournalIntegrityOid(witness.invalid, [], steps);
      db.run(
        `UPDATE git_operation_steps
            SET source_oid = ?, selected_parent_oid = ?, mainline = ?
          WHERE checkout_id = 1 AND ordinal = 0`,
        step.sourceOid,
        step.selectedParentOid,
        step.mainline,
      );
      db.run(
        `UPDATE git_operation_state SET retained_bytes = ?, integrity_oid = ? WHERE checkout_id = 1`,
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
