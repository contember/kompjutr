import type { SqlDatabase } from "@kompjutr/sqlite";
import { CorruptError, GitError } from "../../common/errors.js";
import { expectText } from "../../common/rows.js";
import type {
  CheckoutRow,
  FetchPublicationPlan,
  FetchPublicationToken,
  RefLogEntry,
  RefLogMetadata,
  RefLogReadOptions,
  RefMutation,
  RefRow,
  TrackingRefPublicationToken,
} from "../core/contracts.js";
import {
  isAttachedBranchUniqueConstraint,
  requireStoredCheckoutRow,
} from "../database/lifecycle.js";
import { rawSymbolicTarget, requireRefName } from "../refs/ref-validation.js";
import { readRefLog } from "../refs/reflog.js";
import type { HeadOwner } from "../refs/refs.js";
import { RepositoryHeads } from "../refs/repository-heads.js";
import { type SharedRepoStore, sharedRepoStoreMutations } from "../repository/shared.js";

export interface CheckoutRefStoreOptions {
  readonly database: SqlDatabase;
  readonly shared: SharedRepoStore;
  readonly repoId: number;
  readonly checkoutId: number;
  readonly now: () => number;
  readonly requireActive: () => void;
}

export class CheckoutRefStore {
  readonly #database: SqlDatabase;
  readonly #shared: SharedRepoStore;
  readonly #repoId: number;
  readonly #checkoutId: number;
  readonly #now: () => number;
  readonly #requireActive: () => void;
  readonly headOwner: HeadOwner;

  constructor(options: CheckoutRefStoreOptions) {
    this.#database = options.database;
    this.#shared = options.shared;
    this.#repoId = options.repoId;
    this.#checkoutId = options.checkoutId;
    this.#now = options.now;
    this.#requireActive = options.requireActive;
    const heads = new RepositoryHeads(options.database, options.repoId, options.requireActive);
    this.headOwner = {
      kind: "checkout",
      checkoutId: this.#checkoutId,
      readRefMutationHeads: () => heads.readRefMutationHeads(),
      findAttachedBranchOwner: (head) => this.#findAttachedBranchOwner(head),
      updateRefMutationHead: (expectedHead, newHead) =>
        this.#updateRefMutationHead(expectedHead, newHead),
      appendCheckoutRefLogs: (events) => heads.appendCheckoutRefLogs(events),
      pruneExpiredCheckoutRefLogs: (cutoff) => heads.pruneExpiredCheckoutRefLogs(cutoff),
      pruneRetainedCheckoutRefLogs: (events) => heads.pruneRetainedCheckoutRefLogs(events),
    };
  }

  #db(): SqlDatabase {
    this.#requireActive();
    return this.#database;
  }

  #activeShared(): SharedRepoStore {
    this.#requireActive();
    return this.#shared;
  }

  getRef(name: string): string | null {
    const checkedName = requireRefName(name, "ref name", "input", true);
    return checkedName === "HEAD" ? this.head() : this.#activeShared().getRef(checkedName);
  }

  setRefOwned(name: string, target: string): void {
    if (name === "HEAD") {
      this.setHeadOwned(target);
      return;
    }
    sharedRepoStoreMutations(this.#activeShared()).setRefOwned(name, target);
  }

  updateRefExpectedOwned(name: string, expectedOid: string, targetOid: string): void {
    sharedRepoStoreMutations(this.#activeShared()).updateRefExpectedOwned(
      name,
      expectedOid,
      targetOid,
    );
  }

  deleteRefOwned(name: string): void {
    if (name === "HEAD") {
      this.mutateRefsOwned({ deletes: [name] }, this.genericRefLogMetadata("ref delete"));
      return;
    }
    sharedRepoStoreMutations(this.#activeShared()).deleteRefOwned(name);
  }

  updateRefsOwned(puts: Iterable<RefRow>, deletes: Iterable<string> = []): void {
    sharedRepoStoreMutations(this.#activeShared()).updateRefsOwned(puts, deletes);
  }

  beginTrackingRefPublication(
    trackingPrefix: string,
    refName: string,
  ): TrackingRefPublicationToken {
    return this.#activeShared().beginTrackingRefPublication(trackingPrefix, refName);
  }

  publishTrackingRefOwned(
    token: TrackingRefPublicationToken,
    target: string | null,
    metadata: RefLogMetadata,
  ): boolean {
    return sharedRepoStoreMutations(this.#activeShared()).publishTrackingRefOwned(
      token,
      target,
      metadata,
    );
  }

  beginFetchPublication(
    trackingPrefix: string,
    candidateExactRefs: Iterable<string> = [],
  ): FetchPublicationToken {
    return this.#activeShared().beginFetchPublication(trackingPrefix, candidateExactRefs);
  }

  publishFetchRefsOwned(
    token: FetchPublicationToken,
    plan: FetchPublicationPlan,
    metadata: RefLogMetadata,
  ): boolean {
    return sharedRepoStoreMutations(this.#activeShared()).publishFetchRefsOwned(
      token,
      plan,
      metadata,
    );
  }

  mutateRefsOwned(mutation: RefMutation, metadata: RefLogMetadata): boolean {
    this.#requireActive();
    return sharedRepoStoreMutations(this.#shared).mutateRefsOwned(
      this.headOwner,
      mutation,
      metadata,
    );
  }

  listRefs(prefix = ""): RefRow[] {
    return this.#activeShared().listRefs(prefix);
  }

  *iterateRefs(): Generator<RefRow> {
    yield* this.#activeShared().iterateRefs();
  }

  head(): string {
    const row = this.#db().one<Record<string, unknown>>(
      "SELECT head FROM git_checkouts WHERE id = ? AND repo_id = ?",
      this.#checkoutId,
      this.#repoId,
    );
    if (row === undefined) throw new CorruptError("checkout HEAD row is missing");
    return expectText(row.head, "stored HEAD target");
  }

  setHeadOwned(value: string): void {
    this.mutateRefsOwned({ head: value }, this.genericRefLogMetadata("HEAD update"));
  }

  reflog(refName: string, options: RefLogReadOptions = {}): RefLogEntry[] {
    return readRefLog(this.#db(), this.#repoId, this.#checkoutId, this.#now, refName, options);
  }

  genericRefLogMetadata(reason: string): RefLogMetadata {
    const now = this.#now();
    if (!Number.isSafeInteger(now) || now < 0) {
      throw new GitError("EINVAL", "Git store clock must return non-negative integer milliseconds");
    }
    return {
      actor: null,
      reason,
      timestamp: Math.floor(now / 1_000),
      timezoneOffset: 0,
    };
  }

  #findAttachedBranchOwner(head: string): CheckoutRow | null {
    const attached = rawSymbolicTarget(head);
    if (attached?.startsWith("refs/heads/") !== true) return null;
    const owner = this.#db().one<Record<string, unknown>>(
      `SELECT id AS checkout_id, repo_id, root, head, is_primary
         FROM git_checkouts
        WHERE repo_id = ? AND head = ? AND id != ?
        LIMIT 1`,
      this.#repoId,
      head,
      this.#checkoutId,
    );
    if (owner === undefined) return null;
    const checkedOwner = requireStoredCheckoutRow(owner);
    if (checkedOwner.repoId !== this.#repoId || checkedOwner.head !== head) {
      throw new CorruptError("attached branch ownership crossed a repository boundary");
    }
    return checkedOwner;
  }

  #updateRefMutationHead(expectedHead: string, newHead: string): void {
    let updated: Record<string, unknown> | undefined;
    try {
      updated = this.#db().one<Record<string, unknown>>(
        `UPDATE git_checkouts SET head = ?
          WHERE id = ? AND repo_id = ? AND head = ?
          RETURNING id AS checkout_id, repo_id, root, head, is_primary`,
        newHead,
        this.#checkoutId,
        this.#repoId,
        expectedHead,
      );
    } catch (error) {
      if (isAttachedBranchUniqueConstraint(error)) {
        const owner = this.#findAttachedBranchOwner(newHead);
        if (owner !== null) {
          throw new GitError(
            "EBRANCHINUSE",
            `branch ${rawSymbolicTarget(newHead)} is already attached to checkout ${owner.root}`,
            { cause: error },
          );
        }
      }
      throw error;
    }
    if (updated === undefined) {
      throw new CorruptError("selected checkout HEAD changed during ref mutation");
    }
    const checked = requireStoredCheckoutRow(updated);
    if (checked.id !== this.#checkoutId || checked.repoId !== this.#repoId) {
      throw new CorruptError("HEAD update crossed a checkout boundary");
    }
  }
}
