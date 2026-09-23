import {
  iterateOperationTouchedOwned,
  readOperationHeaderOwned,
} from "../../store/operations/operation-journal.js";
import type { OperationTouchedSource } from "../../store/operations/operation-journal-types.js";
import { operationKindMismatch, operationNotActive } from "../core/operation-state.js";
import type { Repository } from "../repository/repository.js";
import type { MergeJournal } from "./merge-state.js";

export function requireMergeJournalOwned(repo: Repository): MergeJournal<OperationTouchedSource> {
  const journal = readOperationHeaderOwned(repo.checkout);
  if (journal === null) throw operationNotActive("merge");
  if (journal.state.kind !== "merge") throw operationKindMismatch("merge", journal.state.kind);
  const { kind: _kind, ...state } = journal.state;
  return {
    state,
    touched: {
      length: journal.touchedCount,
      [Symbol.iterator]: () => iterateOperationTouchedOwned(repo.checkout)[Symbol.iterator](),
    },
  };
}
