import { CorruptError, hasErrorCode } from "../../common/errors.js";
import type { RawObject } from "../../common/objects.js";
import type { ObjectReadInfo } from "../core/contracts.js";
import { MAX_BLOB_BATCH_OIDS, type ObjectTable } from "../objects/objects.js";
import { PACK_BLOB_BATCH_TARGET_BYTES } from "../pack/packs.js";
import { type CommitCacheEntry, prepareCommitCache } from "../trees/commits.js";
import type { ExpectedOperationObject } from "./operation-journal-types.js";
import type {
  CherryPickJournal,
  OperationJournal,
  OperationStepMetadata,
  RebaseJournal,
  RevertJournal,
} from "./operations.js";

export interface OperationJournalValidationContext {
  repoId: number;
  objects: ObjectTable;
}

export function validateResultCommit(
  context: OperationJournalValidationContext,
  resultOid: string,
  expectedParent: string,
): void {
  let object: RawObject | undefined;
  try {
    const batch = context.objects.readObjects([resultOid], {
      budgetBytes: PACK_BLOB_BATCH_TARGET_BYTES,
    });
    object = batch.objects.get(resultOid);
  } catch (error) {
    if (hasErrorCode(error, "ENOTFOUND")) {
      throw new CorruptError("operation result references a missing object", { cause: error });
    }
    throw error;
  }
  if (object === undefined || object.type !== "commit") {
    throw new CorruptError("operation result is not a complete commit");
  }
  const result = prepareCommitCache({
    repoId: context.repoId,
    oid: resultOid,
    data: object.data,
  });
  if (result.commit.parent.length !== 1 || result.commit.parent[0] !== expectedParent) {
    throw new CorruptError("operation result has an invalid replay parent");
  }
}

export function validateOperationObjects(
  context: OperationJournalValidationContext,
  journal: OperationJournal,
): void {
  const expected = new Map<string, ExpectedOperationObject>();
  const objectSizes = new Map<string, number>();
  const add = (object: ExpectedOperationObject): void => {
    const previous = expected.get(object.oid);
    if (previous !== undefined && previous.type !== object.type) {
      throw new CorruptError(
        `operation journal object ${object.oid} has conflicting expected types`,
      );
    }
    if (previous === undefined) expected.set(object.oid, object);
  };
  add({ oid: journal.state.originalHeadOid, type: "commit", label: "original HEAD" });
  if (journal.state.kind === "merge") {
    add({ oid: journal.state.currentParentOid, type: "commit", label: "current parent" });
    add({ oid: journal.state.incomingParentOid, type: "commit", label: "incoming parent" });
  } else if (journal.state.kind === "rebase") {
    add({ oid: journal.state.upstreamOid, type: "commit", label: "upstream" });
    add({ oid: journal.state.baseOid, type: "commit", label: "base" });
    add({ oid: journal.state.currentParentOid, type: "commit", label: "current parent" });
  }
  for (const step of journal.steps) {
    add({ oid: step.sourceOid, type: "commit", label: "step source" });
    if (step.selectedParentOid !== null) {
      add({ oid: step.selectedParentOid, type: "commit", label: "step selected parent" });
    }
    if (step.resultOid !== null) {
      add({ oid: step.resultOid, type: "commit", label: "step result" });
    }
  }
  for (const entry of journal.touched) {
    if (entry.index !== null) {
      add({
        oid: entry.index.oid,
        type: entry.index.mode === 0o160000 ? "commit" : "blob",
        label: `saved index path ${entry.path}`,
      });
    }
    if (entry.worktree.kind === "file" || entry.worktree.kind === "symlink") {
      add({
        oid: entry.worktree.oid,
        type: "blob",
        label: `saved worktree path ${entry.path}`,
      });
    }
  }
  for (const page of objectPages(expected.keys())) {
    let info: ObjectReadInfo[];
    try {
      info = context.objects.objectInfo(page);
    } catch (error) {
      if (hasErrorCode(error, "ENOTFOUND")) {
        throw new CorruptError("operation journal references a missing object", { cause: error });
      }
      throw error;
    }
    for (const object of info) {
      const wanted = expected.get(object.oid);
      if (wanted === undefined || object.type !== wanted.type) {
        throw new CorruptError(
          `operation ${wanted?.label ?? "journal"} references ${object.type} object ${object.oid}`,
        );
      }
      objectSizes.set(object.oid, object.size);
    }
  }
  if (journal.kind !== "merge") validateReplayTopology(context, journal, objectSizes);
}

function* objectPages(oids: Iterable<string>): Generator<string[]> {
  let page: string[] = [];
  for (const oid of oids) {
    page.push(oid);
    if (page.length === MAX_BLOB_BATCH_OIDS) {
      yield page;
      page = [];
    }
  }
  if (page.length > 0) yield page;
}

function validateReplayTopology(
  context: OperationJournalValidationContext,
  journal: CherryPickJournal | RevertJournal | RebaseJournal,
  objectSizes: ReadonlyMap<string, number>,
): void {
  if (journal.kind !== "rebase") {
    const step = journal.steps[0];
    if (step === undefined) throw new CorruptError("one-commit replay lost its source step");
    validateOperationCommitBodies(
      context,
      [step.sourceOid],
      (_oid, source) => validateReplayParentSelection(step, source.commit.parent),
      objectSizes,
    );
    return;
  }
  let expectedSourceParent = journal.state.baseOid;
  let sourceOrdinal = 0;
  validateOperationCommitBodies(
    context,
    journal.steps.map((step) => step.sourceOid),
    (_oid, source) => {
      const step = journal.steps[sourceOrdinal++];
      if (
        step === undefined ||
        source.commit.parent.length !== 1 ||
        source.commit.parent[0] !== expectedSourceParent ||
        step.selectedParentOid !== expectedSourceParent ||
        step.mainline !== null
      ) {
        throw new CorruptError("rebase source steps are not an oldest-first linear sequence");
      }
      expectedSourceParent = step.sourceOid;
    },
    objectSizes,
  );
  if (expectedSourceParent !== journal.state.originalHeadOid) {
    throw new CorruptError("rebase source sequence does not end at the original HEAD");
  }
  let expectedResultParent = journal.state.upstreamOid;
  for (let ordinal = 0; ordinal < journal.state.currentStep; ordinal++) {
    const step = journal.steps[ordinal];
    if (step === undefined) throw new CorruptError("rebase completed prefix is sparse");
    if (step.outcome === "applied") {
      if (step.resultOid === null) throw new CorruptError("applied rebase step lost its result");
      validateResultCommit(context, step.resultOid, expectedResultParent);
      expectedResultParent = step.resultOid;
    }
  }
  if (expectedResultParent !== journal.state.currentParentOid) {
    throw new CorruptError("rebase result sequence differs from the current parent");
  }
}

function validateOperationCommitBodies(
  context: OperationJournalValidationContext,
  oids: readonly string[],
  visit: (oid: string, commit: CommitCacheEntry) => void,
  objectSizes: ReadonlyMap<string, number>,
): void {
  const seen = new Set<string>();
  for (let offset = 0; offset < oids.length; offset += MAX_BLOB_BATCH_OIDS) {
    let remaining = oids.slice(offset, offset + MAX_BLOB_BATCH_OIDS);
    for (const oid of remaining) {
      if (seen.has(oid)) throw new CorruptError("operation commit sequence contains a cycle");
      seen.add(oid);
      if (objectSizes.get(oid) === undefined) {
        throw new CorruptError(`operation commit ${oid} lost its validated size`);
      }
    }
    while (remaining.length > 0) {
      const batch = context.objects.readObjects(remaining, {
        budgetBytes: PACK_BLOB_BATCH_TARGET_BYTES,
      });
      if (batch.objects.size === 0 || batch.bytes <= 0) {
        throw new CorruptError("operation commit validation made no progress");
      }
      for (const [oid, object] of batch.objects) {
        if (object.type !== "commit") {
          throw new CorruptError("operation step did not produce a complete commit object");
        }
        visit(oid, prepareCommitCache({ repoId: context.repoId, oid, data: object.data }));
      }
      remaining = batch.remaining;
    }
  }
}

function validateReplayParentSelection(
  step: OperationStepMetadata,
  parents: readonly string[],
): void {
  if (parents.length === 0) {
    if (step.selectedParentOid !== null || step.mainline !== null) {
      throw new CorruptError("root replay source retained a selected parent or mainline");
    }
    return;
  }
  if (parents.length === 1) {
    if (step.selectedParentOid !== parents[0] || (step.mainline !== null && step.mainline !== 1)) {
      throw new CorruptError("single-parent replay selection differs from its source commit");
    }
    return;
  }
  if (
    step.mainline === null ||
    step.mainline > parents.length ||
    step.selectedParentOid !== parents[step.mainline - 1]
  ) {
    throw new CorruptError("merge replay selection differs from its source commit");
  }
}
