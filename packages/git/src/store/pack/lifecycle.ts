// Derived from dgit (MIT, Copyright (c) 2026 Divy Srivastava),
// https://github.com/littledivy/dgit — the three-phase ingest, the rotating offset window, the deferred-delta table and the iterative delta-chain walk all follow dgit's src/git/packstore.ts.

import type { SqlDatabase } from "@kompjutr/sqlite";
import { PackDeletion } from "./lifecycle/lifecycle-delete.js";
import { PackIngestLifecycleControl } from "./lifecycle/lifecycle-ingest.js";
import { PackMembershipReader } from "./lifecycle/lifecycle-membership.js";
import type {
  CompletePackedEntry,
  ExpectedPackMembership,
  PackIngestLease,
  PackIngestLifecycle,
  PackSharedState,
} from "./shared.js";

export class PackLifecycle {
  readonly #deletion: PackDeletion;
  readonly #ingest: PackIngestLifecycleControl;
  readonly #membership: PackMembershipReader;

  constructor(db: SqlDatabase, repoId: number, sharedState: PackSharedState) {
    this.#deletion = new PackDeletion(db, repoId, sharedState);
    this.#ingest = new PackIngestLifecycleControl(db, repoId, sharedState, this.#deletion);
    this.#membership = new PackMembershipReader(db, repoId);
  }

  completePackedEntry(oid: string): CompletePackedEntry | null {
    return this.#membership.completePackedEntry(oid);
  }

  deleteCompletePacks(packIds: readonly number[]): number {
    return this.#deletion.deleteCompletePacks(packIds);
  }

  reservePending(
    nowMs: number,
    lifecycle: PackIngestLifecycle | undefined,
  ): { packId: number; lease: PackIngestLease; reclaimed: number } {
    return this.#ingest.reservePending(nowMs, lifecycle);
  }

  renewIngestLease(lease: PackIngestLease, now: () => number): void {
    this.#ingest.renewIngestLease(lease, now);
  }

  releaseIngestLease(lease: PackIngestLease, required: boolean, db?: SqlDatabase): void {
    if (db === undefined) this.#ingest.releaseIngestLease(lease, required);
    else this.#ingest.releaseIngestLease(lease, required, db);
  }

  auditPublishedMembership(packId: number, expected: ExpectedPackMembership): void {
    this.#ingest.auditPublishedMembership(packId, expected);
  }
}
