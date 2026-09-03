import type { SqlDatabase } from "../../../db/db.js";
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
import { jsonPages } from "../core/json-pages.js";
import {
  isAttachedBranchUniqueConstraint,
  requireStoredCheckoutRow,
} from "../database/lifecycle.js";
import { rawSymbolicTarget, requireRefName } from "../refs/ref-validation.js";
import {
  activeRefLogOids,
  type CheckoutRefLogEvent,
  REFLOG_RETENTION_ROWS,
  readRefLog,
} from "../refs/reflog.js";
import type { HeadOwner } from "../refs/refs.js";
import { type SharedRepoStore, sharedRepoStoreMutations } from "../repository/shared.js";
import { MAX_CHECKOUTS_PER_REPOSITORY } from "../schema/schema.js";

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
    this.headOwner = {
      checkoutId: this.#checkoutId,
      readRefMutationHeads: () => this.#readRefMutationHeads(),
      findAttachedBranchOwner: (head) => this.#findAttachedBranchOwner(head),
      updateRefMutationHead: (expectedHead, newHead) =>
        this.#updateRefMutationHead(expectedHead, newHead),
      appendCheckoutRefLogs: (events) => this.#appendCheckoutRefLogs(events),
      pruneExpiredCheckoutRefLogs: (cutoff) => this.#pruneExpiredCheckoutRefLogs(cutoff),
      pruneRetainedCheckoutRefLogs: (events) => this.#pruneRetainedCheckoutRefLogs(events),
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

  *activeRefLogOids(): Generator<string> {
    yield* activeRefLogOids(this.#db(), this.#repoId, this.#checkoutId, this.#now);
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

  #readRefMutationHeads(): CheckoutRow[] {
    const checkouts: CheckoutRow[] = [];
    for (const raw of this.#db().iterate(
      `SELECT id AS checkout_id, repo_id, root, head, is_primary
         FROM git_checkouts WHERE repo_id = ? ORDER BY id
         LIMIT ${MAX_CHECKOUTS_PER_REPOSITORY + 1}`,
      this.#repoId,
    )) {
      checkouts.push(requireStoredCheckoutRow(raw));
      if (checkouts.length > MAX_CHECKOUTS_PER_REPOSITORY) {
        throw new GitError("E2BIG", "repository checkout state exceeds its retained bound");
      }
    }
    return checkouts;
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

  #appendCheckoutRefLogs(events: readonly CheckoutRefLogEvent[]): void {
    for (const page of jsonPages(events, "checkout reflog entry")) {
      this.#db().run(
        `INSERT INTO git_checkout_reflog_entries
           (checkout_id, repo_id, ordinal, old_raw, new_raw, old_oid, new_oid,
            actor_name, actor_email, timestamp, timezone, reason)
         SELECT json_extract(value, '$.checkoutId'), ?,
                json_extract(value, '$.ordinal'),
                json_extract(value, '$.oldRaw'),
                json_extract(value, '$.newRaw'),
                json_extract(value, '$.oldOid'),
                json_extract(value, '$.newOid'),
                json_extract(value, '$.actorName'),
                json_extract(value, '$.actorEmail'),
                json_extract(value, '$.timestamp'),
                json_extract(value, '$.timezoneOffset'),
                json_extract(value, '$.reason')
           FROM json_each(?)`,
        this.#repoId,
        page,
      );
    }
  }

  #pruneExpiredCheckoutRefLogs(cutoff: number): void {
    this.#db().run(
      "DELETE FROM git_checkout_reflog_entries WHERE repo_id = ? AND timestamp < ?",
      this.#repoId,
      cutoff,
    );
  }

  #pruneRetainedCheckoutRefLogs(events: readonly CheckoutRefLogEvent[]): void {
    const touchedCheckouts = events.map((event) => event.checkoutId);
    for (const page of jsonPages(touchedCheckouts, "checkout reflog retention")) {
      this.#db().run(
        `DELETE FROM git_checkout_reflog_entries AS entry
          WHERE entry.repo_id = ?
            AND entry.checkout_id IN (SELECT value FROM json_each(?))
            AND entry.ordinal < coalesce((
              SELECT retained.ordinal
                FROM git_checkout_reflog_entries retained
               WHERE retained.checkout_id = entry.checkout_id
               ORDER BY retained.ordinal DESC
               LIMIT 1 OFFSET ${REFLOG_RETENTION_ROWS - 1}
            ), 0)`,
        this.#repoId,
        page,
      );
    }
  }
}
