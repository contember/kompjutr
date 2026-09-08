import {
  MAX_ROUTING_CHECKOUTS,
  MAX_ROUTING_CHECKOUTS_RETAINED_BYTES,
  MAX_ROUTING_ROOTS_UTF8_BYTES,
} from "@kompjutr/sqlite";
import { CorruptError, GitError } from "../../common/errors.js";
import type { CheckoutRow } from "../core/contracts.js";
import { utf8ByteLength } from "../core/json-pages.js";
import { MAX_CHECKOUTS_PER_REPOSITORY } from "../schema/schema.js";
import type { DatabaseRegistry } from "./database-registry.js";
import { checkoutRootInput, type DatabaseState } from "./database-state.js";
import {
  CHECKOUT_LIFECYCLE_CARDINALITY_SQL,
  CHECKOUT_LIST_ROW_FIXED_RETAINED_BYTES,
  requireCheckoutLifecycleCardinality,
  requireStoredCheckoutLifecycle,
  requireStoredCheckoutRow,
} from "./lifecycle.js";

export class DatabaseRouting {
  constructor(
    private readonly state: DatabaseState,
    private readonly registry: DatabaseRegistry,
  ) {}

  /** The checkout whose root is the nearest registered ancestor of `dir`. */
  findCheckout(dir: string): CheckoutRow | null {
    const path = checkoutRootInput(dir);
    const row = this.state.db.one<Record<string, unknown>>(
      `SELECT checkout.id AS checkout_id, checkout.repo_id, checkout.root,
                checkout.head,
                checkout.is_primary, repository.lifecycle,
                repository.clone_generation, repository.clone_expires_ms,
                ${CHECKOUT_LIFECYCLE_CARDINALITY_SQL}
           FROM git_checkouts checkout
           JOIN git_repositories repository ON repository.id = checkout.repo_id
          WHERE checkout.root = '/' OR checkout.root = ?
             OR substr(?, 1, length(checkout.root) + 1) = checkout.root || '/'
          ORDER BY length(CAST(checkout.root AS BLOB)) DESC, checkout.id DESC
          LIMIT 1`,
      path,
      path,
    );
    if (row === undefined) return null;
    const stored = requireStoredCheckoutLifecycle(row);
    requireCheckoutLifecycleCardinality(row, stored);
    return stored.lifecycle === "provisional"
      ? null
      : this.registry.rememberCheckout(stored.checkout);
  }

  checkoutAt(root: string): CheckoutRow | null {
    const checkedRoot = checkoutRootInput(root);
    const row = this.state.db.one<Record<string, unknown>>(
      `SELECT checkout.id AS checkout_id, checkout.repo_id, checkout.root,
                checkout.head,
                checkout.is_primary, repository.lifecycle,
                repository.clone_generation, repository.clone_expires_ms,
                ${CHECKOUT_LIFECYCLE_CARDINALITY_SQL}
           FROM git_checkouts checkout
           JOIN git_repositories repository ON repository.id = checkout.repo_id
          WHERE checkout.root = ?`,
      checkedRoot,
    );
    if (row === undefined) return null;
    const stored = requireStoredCheckoutLifecycle(row);
    requireCheckoutLifecycleCardinality(row, stored);
    return stored.lifecycle === "provisional"
      ? null
      : this.registry.rememberCheckout(stored.checkout);
  }

  listCheckouts(repoId: number): readonly CheckoutRow[] {
    if (!Number.isSafeInteger(repoId) || repoId < 1) {
      throw new GitError("EINVAL", "repository id must be a safe positive integer");
    }
    return this.listCheckoutsOwned(repoId);
  }

  listCheckoutsOwned(repoId: number): readonly CheckoutRow[] {
    if (!Number.isSafeInteger(repoId) || repoId < 1) {
      throw new GitError("EINVAL", "repository id must be a safe positive integer");
    }
    const rows: CheckoutRow[] = [];
    let primaryCount = 0;
    for (const raw of this.state.db.iterate(
      `SELECT id AS checkout_id, repo_id, root, head, is_primary
           FROM git_checkouts WHERE repo_id = ?
           ORDER BY root COLLATE BINARY LIMIT ${MAX_CHECKOUTS_PER_REPOSITORY + 1}`,
      repoId,
    )) {
      const row = requireStoredCheckoutRow(raw);
      if (row.repoId !== repoId) {
        throw new CorruptError("checkout listing crossed repository boundaries");
      }
      rows.push(this.registry.rememberCheckout(row));
      if (row.isPrimary) primaryCount++;
      if (rows.length > MAX_CHECKOUTS_PER_REPOSITORY) {
        throw new GitError("E2BIG", "checkout listing exceeds its retained bound");
      }
    }
    if (rows.length > 0 && primaryCount !== 1) {
      throw new CorruptError("repository must have exactly one primary checkout");
    }
    return Object.freeze(rows);
  }

  listRoutingCheckouts(): CheckoutRow[] {
    const rows: CheckoutRow[] = [];
    const primaryCounts = new Map<number, number>();
    const checkoutCounts = new Map<number, number>();
    let policyRetainedBytes = 0;
    let routingCount = 0;
    for (const raw of this.state.db.iterate(
      `SELECT checkout.id AS checkout_id, checkout.repo_id, checkout.root,
              checkout.head,
              checkout.is_primary, repository.lifecycle,
              repository.clone_generation, repository.clone_expires_ms,
              ${CHECKOUT_LIFECYCLE_CARDINALITY_SQL}
         FROM git_checkouts checkout
         JOIN git_repositories repository ON repository.id = checkout.repo_id
        ORDER BY checkout.root COLLATE BINARY LIMIT ${MAX_ROUTING_CHECKOUTS + 1}`,
    )) {
      const stored = requireStoredCheckoutLifecycle(raw);
      requireCheckoutLifecycleCardinality(raw, stored);
      const row = stored.checkout;
      routingCount++;
      policyRetainedBytes +=
        CHECKOUT_LIST_ROW_FIXED_RETAINED_BYTES +
        utf8ByteLength(row.root) +
        utf8ByteLength(row.head);
      if (policyRetainedBytes > MAX_ROUTING_CHECKOUTS_RETAINED_BYTES) {
        throw new GitError("E2BIG", "checkout routing exceeds its 16 MiB retained bound");
      }
      if (stored.lifecycle === "ready") rows.push(this.registry.rememberCheckout(row));
      const primaryCount = (primaryCounts.get(row.repoId) ?? 0) + (row.isPrimary ? 1 : 0);
      const checkoutCount = (checkoutCounts.get(row.repoId) ?? 0) + 1;
      if (checkoutCount > MAX_CHECKOUTS_PER_REPOSITORY) {
        throw new GitError("E2BIG", "repository checkout routing exceeds its retained bound");
      }
      primaryCounts.set(row.repoId, primaryCount);
      checkoutCounts.set(row.repoId, checkoutCount);
      if (routingCount > MAX_ROUTING_CHECKOUTS) {
        throw new GitError("E2BIG", "checkout routing exceeds its retained bound");
      }
    }
    for (const count of primaryCounts.values()) {
      if (count !== 1) throw new CorruptError("repository must have exactly one primary checkout");
    }
    return rows;
  }

  /** All routing roots, including provisional roots that block parent traversal. */
  listRoutingRoots(): string[] {
    const roots: string[] = [];
    const primaryCounts = new Map<number, number>();
    const checkoutCounts = new Map<number, number>();
    let policyRetainedBytes = 0;
    let rootUtf8Bytes = 0;
    for (const raw of this.state.db.iterate(
      `SELECT checkout.id AS checkout_id, checkout.repo_id, checkout.root,
              checkout.head,
              checkout.is_primary, repository.lifecycle,
              repository.clone_generation, repository.clone_expires_ms,
              ${CHECKOUT_LIFECYCLE_CARDINALITY_SQL}
         FROM git_checkouts checkout
         JOIN git_repositories repository ON repository.id = checkout.repo_id
        ORDER BY checkout.root COLLATE BINARY LIMIT ${MAX_ROUTING_CHECKOUTS + 1}`,
    )) {
      const stored = requireStoredCheckoutLifecycle(raw);
      requireCheckoutLifecycleCardinality(raw, stored);
      const row = stored.checkout;
      const primaryCount = (primaryCounts.get(row.repoId) ?? 0) + (row.isPrimary ? 1 : 0);
      const checkoutCount = (checkoutCounts.get(row.repoId) ?? 0) + 1;
      if (checkoutCount > MAX_CHECKOUTS_PER_REPOSITORY) {
        throw new GitError("E2BIG", "repository checkout routing exceeds its retained bound");
      }
      const rowRootBytes = utf8ByteLength(row.root);
      rootUtf8Bytes += rowRootBytes;
      if (rootUtf8Bytes > MAX_ROUTING_ROOTS_UTF8_BYTES) {
        throw new GitError("E2BIG", "checkout routing roots exceed their 6 MiB UTF-8 bound");
      }
      policyRetainedBytes +=
        CHECKOUT_LIST_ROW_FIXED_RETAINED_BYTES + rowRootBytes + utf8ByteLength(row.head);
      if (policyRetainedBytes > MAX_ROUTING_CHECKOUTS_RETAINED_BYTES) {
        throw new GitError("E2BIG", "checkout routing exceeds its 16 MiB retained bound");
      }
      primaryCounts.set(row.repoId, primaryCount);
      checkoutCounts.set(row.repoId, checkoutCount);
      roots.push(row.root);
      if (roots.length > MAX_ROUTING_CHECKOUTS) {
        throw new GitError("E2BIG", "checkout routing exceeds its retained bound");
      }
    }
    for (const count of primaryCounts.values()) {
      if (count !== 1) throw new CorruptError("repository must have exactly one primary checkout");
    }
    return roots;
  }
}
