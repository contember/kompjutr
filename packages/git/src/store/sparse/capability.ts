import type { SqlDatabase } from "@kompjutr/sqlite";
import type {
  CommitTreeSnapshotSource,
  SelectedPathSource,
  SparseWorkspaceSource,
} from "../core/contracts.js";

export interface SparseTrackerSeedEntry {
  path: string;
  flags: number;
}

/** Writes the sparse index tracker's baseline and dirty journal. */
export interface SparseIndexTracker {
  reseal(
    checkoutId: number,
    baselineTreeOid: string | null,
    entries: Iterable<SparseTrackerSeedEntry>,
  ): boolean;
  advanceBaseline(checkoutId: number, baselineTreeOid: string | null): boolean;
}

/**
 * Native sparse fast paths over one SQLite database; Git trusts their results.
 * `createGit` checks only that `database` is the Git store's. A capability not
 * built by `createSqliteSparseCapability`, or with replaced members, is host
 * code trusted as-is: wrong results are undefined behavior, like out-of-band
 * table mutation.
 */
export interface SparseCapability {
  database: SqlDatabase;
  tracker: SparseIndexTracker;
  workspace: SparseWorkspaceSource;
  selected: SelectedPathSource;
  commitTrees: CommitTreeSnapshotSource;
}
