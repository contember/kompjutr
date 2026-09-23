import type { SqlDatabase } from "@kompjutr/sqlite";
import type { SparseCapability } from "../../store/sparse/capability.js";
import { advanceIndexTrackerBaseline, resealIndexTracker } from "../indexes/index-tracker.js";
import { createSqliteSelectedPathSource } from "./selection.js";
import { createSqliteCommitTreeSnapshotSource } from "./snapshot.js";
import { createSqliteSparseWorkspaceSource } from "./workspace.js";

/** Every native sparse fast path over one database; the index tracker must be initialized. */
export function createSqliteSparseCapability(db: SqlDatabase): SparseCapability {
  return {
    database: db,
    tracker: {
      reseal: (checkoutId, baselineTreeOid, entries) =>
        resealIndexTracker(db, checkoutId, baselineTreeOid, entries),
      advanceBaseline: (checkoutId, baselineTreeOid) =>
        advanceIndexTrackerBaseline(db, checkoutId, baselineTreeOid),
    },
    workspace: createSqliteSparseWorkspaceSource(db),
    selected: createSqliteSelectedPathSource(db),
    commitTrees: createSqliteCommitTreeSnapshotSource(db),
  };
}
