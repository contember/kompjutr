import type { SqlDatabase } from "../../db/db.js";
import { isOid } from "../common/bytes.js";
import { CorruptError, GitError } from "../common/errors.js";
import { expectText, RowShape, text } from "../common/rows.js";
import { comparePaths } from "../common/streams.js";
import { nextPrefix } from "./config.js";
import type {
  CheckoutRow,
  RefLogMetadata,
  RefMutation,
  RefMutationExpected,
  RefRow,
} from "./contracts.js";
import { jsonPages } from "./json-pages.js";
import { requireSafeId } from "./lifecycle.js";
import { rawSymbolicTarget, requireRawRefTarget, requireRefName } from "./ref-validation.js";
import {
  type CheckoutRefLogEvent,
  type Clock,
  REFLOG_RETENTION_SECONDS,
  type RefLogEvent,
  type RefLogWriter,
  requireSafeRefLogInteger,
  validateRefLogMetadata,
} from "./reflog.js";
import { MAX_REFLOG_ORDINAL, MAX_REFLOG_STATE_ROWS } from "./reflog-schema.js";

export const MAX_REF_MUTATION_INPUTS = 100_000;

export interface NormalizedRefMutation {
  puts: Map<string, string>;
  deletes: Set<string>;
  head: string | undefined;
  expected: RefMutationExpected | undefined;
}

export interface RefMutationRevisionState {
  readonly trackingRefRevisionCount: number;
  readonly fetchNamespacePresent: boolean;
}

export interface RefMutationRevisions {
  readRefMutationRevisionState(): RefMutationRevisionState;
  bumpTrackingRefRevisions(changedNames: ReadonlySet<string>): void;
  bumpFetchNamespaceRevisions(changedNames: ReadonlySet<string>): void;
}

export interface HeadOwner {
  readonly checkoutId: number;
  readRefMutationHeads(): CheckoutRow[];
  findAttachedBranchOwner(head: string): CheckoutRow | null;
  updateRefMutationHead(expectedHead: string, newHead: string): void;
  appendCheckoutRefLogs(events: readonly CheckoutRefLogEvent[]): void;
  pruneExpiredCheckoutRefLogs(cutoff: number): void;
  pruneRetainedCheckoutRefLogs(events: readonly CheckoutRefLogEvent[]): void;
}

export interface RefTableOptions {
  readonly revisions: RefMutationRevisions;
  readonly advanceCheckoutRevision: (expectedRevision: number) => void;
  readonly bumpMaintenanceRootEpoch: () => void;
  readonly reflogWriter: RefLogWriter;
  readonly clock: Clock;
}

export interface RefMutationOwner {
  mutateRefs(mutation: RefMutation, metadata: RefLogMetadata): boolean;
}

export function mutateRefsOwned(
  store: RefMutationOwner,
  mutation: RefMutation,
  metadata: RefLogMetadata,
): boolean {
  return store.mutateRefs(mutation, metadata);
}

const REF_ROW = new RowShape({ name: text(), target: text() });

function requireRefGeneration(value: unknown, label: string, minimum: number): number {
  if (
    typeof value !== "number" ||
    !Number.isSafeInteger(value) ||
    value < minimum ||
    value > Number.MAX_SAFE_INTEGER
  ) {
    throw new CorruptError(`${label} is invalid`);
  }
  return value;
}

export function normalizeRefMutation(mutation: RefMutation): NormalizedRefMutation {
  const puts = new Map<string, string>();
  const deletes = new Set<string>();
  let inputs = 0;
  const countInput = (): void => {
    inputs++;
    if (inputs > MAX_REF_MUTATION_INPUTS) {
      throw new GitError("E2BIG", "ref mutation exceeds its retained input count bound");
    }
  };
  for (const value of mutation.deletes ?? []) {
    const name = requireRefName(value, "deleted ref name", "input");
    countInput();
    deletes.add(name);
  }
  for (const row of mutation.puts ?? []) {
    if (typeof row !== "object" || row === null) {
      throw new GitError("EINVAL", "ref update row is invalid");
    }
    const name = requireRefName(row.name, "updated ref name", "input");
    const target = requireRawRefTarget(row.target, "updated ref target", "input");
    countInput();
    puts.set(name, target);
  }
  const head =
    mutation.head === undefined
      ? undefined
      : requireRawRefTarget(mutation.head, "HEAD target", "input");
  if (head !== undefined) countInput();
  let expected: RefMutationExpected | undefined;
  if (mutation.expected !== undefined) {
    const name = requireRefName(mutation.expected.name, "conditional ref name", "input");
    const target =
      mutation.expected.target === null
        ? null
        : requireRawRefTarget(mutation.expected.target, "expected ref target", "input");
    countInput();
    expected = { name, target };
    if (puts.has(name) === deletes.has(name)) {
      throw new GitError(
        "EINVAL",
        "conditional ref update must include exactly one destination put or delete",
      );
    }
  }
  return { puts, deletes, head, expected };
}

export function resolveRawRef(
  raw: string | null,
  lookup: (name: string) => string | null,
): string | null {
  let value = raw;
  const seen = new Set<string>();
  for (let hops = 0; hops < 8; hops++) {
    if (value === null) return null;
    if (isOid(value)) return value;
    const target = rawSymbolicTarget(value);
    if (target === null) throw new CorruptError("stored ref target has an invalid shape");
    if (seen.has(target)) return null;
    seen.add(target);
    value = lookup(target);
  }
  return null;
}

export class RefTable {
  constructor(
    private readonly db: SqlDatabase,
    private readonly repoId: number,
    private readonly options: RefTableOptions,
  ) {}

  /** Raw ref value: an oid, or "ref: <name>" for a symbolic ref. */
  getRef(name: string, storedTargetLabel = `stored target of ${name}`): string | null {
    const checkedName = requireRefName(name, "ref name", "input");
    const row = this.db.one<Record<string, unknown>>(
      "SELECT target FROM git_refs WHERE repo_id = ? AND name = ?",
      this.repoId,
      checkedName,
    );
    return row === undefined ? null : expectText(row.target, storedTargetLabel);
  }

  setRef(headOwner: HeadOwner, name: string, target: string): void {
    this.mutateRefs(
      headOwner,
      { puts: [{ name, target }] },
      this.#genericRefLogMetadata("ref update"),
    );
  }

  /** Move one direct ref only if it still contains the caller's observed OID. */
  updateRefExpected(
    headOwner: HeadOwner,
    name: string,
    expectedOid: string,
    targetOid: string,
  ): void {
    if (name === "HEAD" || !isOid(expectedOid) || !isOid(targetOid)) {
      throw new GitError("EINVAL", "conditional ref update requires a direct ref and full OIDs");
    }
    this.mutateRefs(
      headOwner,
      {
        puts: [{ name, target: targetOid }],
        expected: { name, target: expectedOid },
      },
      this.#genericRefLogMetadata("conditional ref update"),
    );
  }

  deleteRef(headOwner: HeadOwner, name: string): void {
    this.mutateRefs(headOwner, { deletes: [name] }, this.#genericRefLogMetadata("ref delete"));
  }

  /** Apply bounded ref deletions and updates atomically. */
  updateRefs(headOwner: HeadOwner, puts: Iterable<RefRow>, deletes: Iterable<string> = []): void {
    this.mutateRefs(headOwner, { puts, deletes }, this.#genericRefLogMetadata("ref batch update"));
  }

  /** Apply current ref state and its bounded history through one atomic seam. */
  mutateRefs(headOwner: HeadOwner, mutation: RefMutation, metadata: RefLogMetadata): boolean {
    const normalized = normalizeRefMutation(mutation);
    const checkedMetadata = validateRefLogMetadata(metadata);
    return this.mutateNormalized(headOwner, normalized, checkedMetadata);
  }

  mutateNormalized(
    headOwner: HeadOwner,
    normalized: NormalizedRefMutation,
    checkedMetadata: RefLogMetadata,
  ): boolean {
    return this.#mutateRefs(headOwner, normalized, checkedMetadata);
  }

  #mutateRefs(
    headOwner: HeadOwner,
    normalized: NormalizedRefMutation,
    checkedMetadata: RefLogMetadata,
  ): boolean {
    return this.db.transactionSync(() => {
      const header = this.db.one<{
        repo_id: unknown;
        next_ordinal: unknown;
        checkout_revision: unknown;
      }>(
        `SELECT repository.id AS repo_id, state.next_ordinal,
                 repository.checkout_revision
            FROM git_repositories repository
            JOIN git_reflog_state state ON state.repo_id = repository.id
           WHERE repository.id = ?`,
        this.repoId,
      );
      if (header === undefined) throw new CorruptError("repository is missing its reflog state");
      if (requireSafeId(header.repo_id, "reflog repository id") !== this.repoId) {
        throw new CorruptError("reflog header crossed a checkout boundary");
      }
      const nextOrdinal = requireSafeRefLogInteger(
        header.next_ordinal,
        "reflog next ordinal",
        0,
        MAX_REFLOG_ORDINAL,
      );
      const checkoutRevision = requireRefGeneration(
        header.checkout_revision,
        "stored checkout revision",
        0,
      );
      const revisionState = this.options.revisions.readRefMutationRevisionState();

      const checkouts = headOwner.readRefMutationHeads();
      let selected: CheckoutRow | null = null;
      for (const checkout of checkouts) {
        if (checkout.repoId !== this.repoId) {
          throw new CorruptError("reflog checkout scan crossed repositories");
        }
        if (checkout.id === headOwner.checkoutId) selected = checkout;
      }
      if (selected === null) {
        throw new CorruptError("selected checkout disappeared during ref mutation");
      }
      const oldHead = selected.head;

      const before = new Map<string, string>();
      let rows = 0;
      for (const { name, target } of this.#iterateStoredRefs()) {
        rows++;
        if (rows > MAX_REFLOG_STATE_ROWS) {
          throw new GitError("E2BIG", "repository ref state exceeds its structural row bound");
        }
        before.set(name, target);
      }

      const beforeTarget = (name: string): string | null => before.get(name) ?? null;
      if (
        normalized.expected !== undefined &&
        beforeTarget(normalized.expected.name) !== normalized.expected.target
      ) {
        throw new GitError(
          "ESTALEHEAD",
          `ref ${normalized.expected.name} changed before conditional update`,
        );
      }

      const afterTarget = (name: string): string | null => {
        const put = normalized.puts.get(name);
        if (put !== undefined) return put;
        if (normalized.deletes.has(name)) return null;
        return beforeTarget(name);
      };
      const newHead = normalized.head ?? oldHead;
      const newAttachedBranch = rawSymbolicTarget(newHead);
      if (newHead !== oldHead) {
        const owner = headOwner.findAttachedBranchOwner(newHead);
        if (owner !== null) {
          throw new GitError(
            "EBRANCHINUSE",
            `branch ${newAttachedBranch} is already attached to checkout ${owner.root}`,
          );
        }
      }

      const changedNames = new Set<string>();
      for (const name of normalized.deletes) {
        const oldRaw = beforeTarget(name);
        const newRaw = afterTarget(name);
        if (oldRaw !== newRaw && !changedNames.has(name)) changedNames.add(name);
      }
      for (const name of normalized.puts.keys()) {
        const oldRaw = beforeTarget(name);
        const newRaw = afterTarget(name);
        if (oldRaw !== newRaw && !changedNames.has(name)) changedNames.add(name);
      }
      const orderedNames = [...changedNames].sort(comparePaths);
      const pendingDirect: Omit<RefLogEvent, "ordinal">[] = [];
      for (const name of orderedNames) {
        const oldRaw = beforeTarget(name);
        const newRaw = afterTarget(name);
        pendingDirect.push({
          refName: name,
          oldRaw,
          newRaw,
          oldOid: resolveRawRef(oldRaw, beforeTarget),
          newOid: resolveRawRef(newRaw, afterTarget),
          actorName: checkedMetadata.actor?.name ?? null,
          actorEmail: checkedMetadata.actor?.email ?? null,
          timestamp: checkedMetadata.timestamp,
          timezoneOffset: checkedMetadata.timezoneOffset,
          reason: checkedMetadata.reason,
        });
      }
      const pendingHeads: { checkoutId: number; event: Omit<RefLogEvent, "ordinal"> }[] = [];
      for (const checkout of checkouts) {
        const checkoutNewHead = checkout.id === headOwner.checkoutId ? newHead : checkout.head;
        const attached = rawSymbolicTarget(checkout.head);
        const causalHeadChange = attached?.startsWith("refs/heads/") && changedNames.has(attached);
        const oldHeadOid = resolveRawRef(checkout.head, beforeTarget);
        const newHeadOid = resolveRawRef(checkoutNewHead, afterTarget);
        if (checkout.head !== checkoutNewHead || oldHeadOid !== newHeadOid || causalHeadChange) {
          pendingHeads.push({
            checkoutId: checkout.id,
            event: {
              refName: "HEAD",
              oldRaw: checkout.head,
              newRaw: checkoutNewHead,
              oldOid: oldHeadOid,
              newOid: newHeadOid,
              actorName: checkedMetadata.actor?.name ?? null,
              actorEmail: checkedMetadata.actor?.email ?? null,
              timestamp: checkedMetadata.timestamp,
              timezoneOffset: checkedMetadata.timezoneOffset,
              reason: checkedMetadata.reason,
            },
          });
        }
      }
      const eventCount = pendingDirect.length + pendingHeads.length;
      if (eventCount === 0) return false;
      if (eventCount > MAX_REFLOG_ORDINAL - nextOrdinal) {
        throw new GitError("E2BIG", "repository reflog ordinal is exhausted");
      }

      const events: RefLogEvent[] = pendingDirect.map((event, index) => ({
        ...event,
        ordinal: nextOrdinal + index + 1,
      }));
      const checkoutEvents: CheckoutRefLogEvent[] = pendingHeads.map((pending, index) => ({
        ...pending.event,
        checkoutId: pending.checkoutId,
        ordinal: nextOrdinal + events.length + index + 1,
      }));
      const deleted = events.filter((event) => event.newRaw === null).map((event) => event.refName);
      const put: RefRow[] = [];
      for (const event of events) {
        if (event.newRaw !== null) put.push({ name: event.refName, target: event.newRaw });
      }
      for (const page of jsonPages(deleted, "ref deletion")) {
        this.db.run(
          `DELETE FROM git_refs
            WHERE repo_id = ? AND name IN (SELECT value FROM json_each(?))`,
          this.repoId,
          page,
        );
      }
      for (const page of jsonPages(put, "ref update")) {
        this.db.run(
          `INSERT INTO git_refs (repo_id, name, target)
           SELECT ?, json_extract(value, '$.name'), json_extract(value, '$.target')
             FROM json_each(?)
            WHERE true
           ON CONFLICT(repo_id, name) DO UPDATE SET target = excluded.target`,
          this.repoId,
          page,
        );
      }
      if (newHead !== oldHead) {
        headOwner.updateRefMutationHead(oldHead, newHead);
        this.options.advanceCheckoutRevision(checkoutRevision);
      }
      this.options.reflogWriter.append(events);
      headOwner.appendCheckoutRefLogs(checkoutEvents);
      const finalOrdinal = nextOrdinal + eventCount;
      this.options.reflogWriter.advance(nextOrdinal, finalOrdinal);

      const cutoff = Math.max(0, checkedMetadata.timestamp - REFLOG_RETENTION_SECONDS);
      this.options.reflogWriter.pruneExpired(cutoff);
      headOwner.pruneExpiredCheckoutRefLogs(cutoff);
      this.options.reflogWriter.pruneRetained(events);
      headOwner.pruneRetainedCheckoutRefLogs(checkoutEvents);
      if (revisionState.trackingRefRevisionCount > 0) {
        this.options.revisions.bumpTrackingRefRevisions(changedNames);
      }
      if (revisionState.fetchNamespacePresent) {
        this.options.revisions.bumpFetchNamespaceRevisions(changedNames);
      }
      this.options.bumpMaintenanceRootEpoch();
      return true;
    });
  }

  *#iterateStoredRefs(): Generator<RefRow> {
    let rows = 0;
    for (const row of this.db.iterate(
      `SELECT name, target FROM git_refs
          WHERE repo_id = ?
          ORDER BY name
          LIMIT ${MAX_REFLOG_STATE_ROWS + 1}`,
      this.repoId,
    )) {
      rows++;
      if (rows > MAX_REFLOG_STATE_ROWS) {
        throw new GitError("E2BIG", "repository ref state exceeds its retained row bound");
      }
      yield REF_ROW.decode(row);
    }
  }

  listRefs(prefix = ""): RefRow[] {
    let upper: string | undefined;
    if (prefix !== "") upper = nextPrefix(prefix);
    const result: RefRow[] = [];
    const sql =
      prefix === ""
        ? `SELECT name, target FROM git_refs WHERE repo_id = ? ORDER BY name
             LIMIT ${MAX_REFLOG_STATE_ROWS + 1}`
        : `SELECT name, target FROM git_refs
            WHERE repo_id = ? AND name >= ? AND name < ? ORDER BY name
            LIMIT ${MAX_REFLOG_STATE_ROWS + 1}`;
    for (const row of this.db.iterate(
      sql,
      this.repoId,
      ...(upper === undefined ? [] : [prefix, upper]),
    )) {
      if (result.length >= MAX_REFLOG_STATE_ROWS) {
        throw new GitError("E2BIG", "repository ref state exceeds 100,000 rows");
      }
      result.push(REF_ROW.decode(row));
    }
    return result;
  }

  /** Stream all raw refs without materializing repository ref state. */
  *iterateRefs(): Generator<RefRow> {
    yield* this.#iterateStoredRefs();
  }

  #genericRefLogMetadata(reason: string): RefLogMetadata {
    const now = this.options.clock();
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
}
