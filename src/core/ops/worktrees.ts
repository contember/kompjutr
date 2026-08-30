import { exactPathStatesOwned } from "../../fs/exact-path-states.js";
import type { MemoryReservation } from "../../memory.js";
import {
  type CheckoutRow,
  type CheckoutStore,
  createRefMutationMemoryOwner,
  listCheckoutsOwned,
  mutateRefsOwned,
  type RefMutationMemoryOwner,
} from "../../sqlite/store.js";
import type { ExactRootState, GitContext } from "../context.js";
import { CorruptError, GitError, RefNotFoundError, UnsupportedOperationError } from "../errors.js";
import { normalizePath } from "../paths.js";
import { checkRefText, hasCanonicalRefSyntax } from "../ref-name.js";
import { Repository } from "../repository.js";
import { retainedStringBytes } from "../retained.js";
import { checkoutTree } from "./checkout.js";
import { operationRefLogMetadata } from "./ref-log.js";
import { statusStream } from "./status.js";

export interface WorktreeInfo {
  readonly checkoutId: number;
  readonly root: string;
  readonly head: string;
  readonly isPrimary: boolean;
  readonly state: "present" | "missing";
}

export type WorktreeAddTarget =
  | { kind: "existing-branch"; name: string }
  | { kind: "new-branch"; name: string; startPoint?: string }
  | { kind: "detached"; startPoint?: string };

export interface WorktreeAddOptions {
  root: string;
  target: WorktreeAddTarget;
}

export interface WorktreeRemoveOptions {
  root: string;
  force?: boolean;
}

interface AddPlan {
  commitOid: string;
  treeOid: string;
  branch: string | null;
  createBranch: boolean;
}

interface WorktreeSnapshot {
  rows: readonly CheckoutRow[];
  states: readonly ExactRootState[];
}

const SNAPSHOT_FIXED_BYTES = 256;
const SNAPSHOT_ARRAY_BYTES = 64;
const SNAPSHOT_ARRAY_SLOT_BYTES = 8;
const SNAPSHOT_CHECKOUT_ROW_BYTES = 1_024;
const SNAPSHOT_INFO_BYTES = 256;
const SNAPSHOT_MAP_BYTES = 128;
const SNAPSHOT_MAP_ENTRY_BYTES = 64;
const NORMALIZE_ARRAY_BYTES = 64;
const NORMALIZE_ARRAY_SLOT_BYTES = 8;
const NORMALIZE_STRING_SLOT_BYTES = 8;

function retainedStringUnits(units: number): number {
  return 48 + units * 2;
}

function normalizeConstructionBytes(path: string): number {
  const absoluteUnits = path.length + (path.startsWith("/") ? 0 : 1);
  let splitItems = 1;
  for (let index = 0; index < path.length; index++) {
    if (path.charCodeAt(index) === 0x2f) splitItems++;
  }
  return (
    retainedStringBytes(path) +
    (path.startsWith("/") ? 0 : retainedStringUnits(absoluteUnits)) +
    2 * NORMALIZE_ARRAY_BYTES +
    splitItems * 2 * NORMALIZE_ARRAY_SLOT_BYTES +
    splitItems * 48 +
    absoluteUnits * 2 +
    retainedStringUnits(absoluteUnits) +
    retainedStringUnits(absoluteUnits + 1) +
    NORMALIZE_STRING_SLOT_BYTES
  );
}

function worktreeError(code: string, message: string): GitError {
  return new GitError(code, message);
}

function shortBranchRef(owner: WorktreePlanOwner, name: string): string {
  if (typeof name !== "string" || name === "" || name.startsWith("refs/")) {
    throw worktreeError("EINVALIDREF", "invalid short branch name");
  }
  if (checkRefText(name).problem !== null) {
    throw worktreeError("EINVALIDREF", "invalid short branch name");
  }
  const full = owner.construct("refs/heads/".length + name.length, () => `refs/heads/${name}`);
  if (!hasCanonicalRefSyntax(full)) {
    throw worktreeError("EINVALIDREF", "invalid short branch name");
  }
  return full;
}

function resolvedCommit(repo: Repository, expression: string): { oid: string; tree: string } {
  if (typeof expression !== "string") {
    throw worktreeError("EINVAL", "worktree start point must be a string");
  }
  const oid = repo.peel(repo.revParse(expression));
  return { oid, tree: repo.readCommit(oid).tree };
}

function addPlan(repo: Repository, target: WorktreeAddTarget, owner: WorktreePlanOwner): AddPlan {
  if (typeof target !== "object" || target === null) {
    throw worktreeError("EINVAL", "worktree target is invalid");
  }
  if (target.kind === "existing-branch") {
    const branch = shortBranchRef(owner, target.name);
    if (repo.store.getRef(branch) === null) throw new RefNotFoundError(branch);
    const resolved = resolvedCommit(repo, branch);
    return {
      commitOid: resolved.oid,
      treeOid: resolved.tree,
      branch,
      createBranch: false,
    };
  }
  if (target.kind === "new-branch") {
    const branch = shortBranchRef(owner, target.name);
    if (repo.store.getRef(branch) !== null) {
      throw worktreeError("EBRANCHFAIL", `branch already exists: ${target.name}`);
    }
    const resolved = resolvedCommit(repo, target.startPoint ?? "HEAD");
    return {
      commitOid: resolved.oid,
      treeOid: resolved.tree,
      branch,
      createBranch: true,
    };
  }
  if (target.kind === "detached") {
    const resolved = resolvedCommit(repo, target.startPoint ?? "HEAD");
    return {
      commitOid: resolved.oid,
      treeOid: resolved.tree,
      branch: null,
      createBranch: false,
    };
  }
  throw worktreeError("EINVAL", "worktree target is invalid");
}

function requireAvailableRoot(context: GitContext, root: string): void {
  const stat = context.worktree.stat(root);
  if (stat !== null && stat.type !== "dir") {
    throw worktreeError("EWORKTREEEXISTS", `worktree root is not an empty directory: ${root}`);
  }
  const real = context.worktree.realpath(root);
  if (real !== root) {
    throw worktreeError("EWORKTREEEXISTS", `worktree root is not an exact real path: ${root}`);
  }
  if (stat === null) {
    context.worktree.makeDirectories([root]);
    return;
  }
  if (context.worktree.scan(root, { limit: 1 }).length !== 0) {
    throw worktreeError("EWORKTREEEXISTS", `worktree root is not empty: ${root}`);
  }
}

function initializeCheckout(
  context: GitContext,
  checkout: CheckoutStore,
  plan: AddPlan,
  owner: WorktreePlanOwner,
): undefined {
  requireAvailableRoot(context, checkout.root);
  const target = new Repository(checkout);
  if (plan.branch !== null) {
    const mutation = plan.createBranch
      ? {
          puts: [{ name: plan.branch, target: plan.commitOid }],
          head: owner.construct(5 + plan.branch.length, () => `ref: ${plan.branch}`),
        }
      : { head: owner.construct(5 + plan.branch.length, () => `ref: ${plan.branch}`) };
    if (
      !mutateRefsOwned(
        target.checkout,
        mutation,
        operationRefLogMetadata(context, target, "checkout", {}, owner.mutationOwner),
        owner.mutationOwner,
      )
    ) {
      throw new CorruptError("worktree HEAD publication made no change");
    }
  }
  checkoutTree(target, context.worktree, plan.treeOid);
  if (context.indexTracker?.reseal(checkout.checkoutId, plan.treeOid, []) === false) {
    throw new CorruptError("worktree index tracker could not reseal the created checkout");
  }
  return undefined;
}

function info(row: CheckoutRow, state: ExactRootState): WorktreeInfo {
  return Object.freeze({
    checkoutId: row.id,
    root: row.root,
    head: row.head,
    isPrimary: row.isPrimary,
    state,
  });
}

function snapshot(
  context: GitContext,
  repo: Repository,
  reservation: MemoryReservation,
): WorktreeSnapshot {
  const source = context.exactRootStates;
  if (source === undefined) throw new UnsupportedOperationError("worktree listing");
  reservation.set("other", SNAPSHOT_FIXED_BYTES);
  const rows = listCheckoutsOwned(context.database, repo.store.repoId, reservation);
  const rootsMemory = reservation.scope();
  const statesMemory = reservation.scope();
  rootsMemory.set("other", SNAPSHOT_ARRAY_BYTES + rows.length * SNAPSHOT_ARRAY_SLOT_BYTES);
  statesMemory.set("other", SNAPSHOT_ARRAY_BYTES + rows.length * SNAPSHOT_ARRAY_SLOT_BYTES);
  const roots = rows.map((row) => row.root);
  try {
    const ownedStates = exactPathStatesOwned(source, roots, reservation);
    const states = ownedStates ?? source.states(roots);
    if (states.length !== rows.length) {
      throw new CorruptError("worktree state source returned an invalid result length");
    }
    for (const state of states) {
      if (state !== "present" && state !== "missing") {
        throw new CorruptError("worktree state source returned an invalid state");
      }
    }
    return { rows, states };
  } finally {
    rootsMemory.dispose();
  }
}

export function worktreeAdd(
  context: GitContext,
  repo: Repository,
  options: WorktreeAddOptions,
): WorktreeInfo {
  if (typeof options.root !== "string" || options.root === "") {
    throw worktreeError("EINVAL", "worktree root is required");
  }
  const owner = new WorktreePlanOwner(repo);
  try {
    const root = owner.normalize(options.root);
    const plan = addPlan(repo, options.target, owner);
    const row = context.database.createCheckout(
      repo.store.repoId,
      root,
      plan.commitOid,
      (checkout) => initializeCheckout(context, checkout, plan, owner),
    );
    return info(row, "present");
  } finally {
    owner.dispose();
  }
}

class WorktreePlanOwner {
  readonly mutationOwner: RefMutationMemoryOwner;
  #normalizationMemory: MemoryReservation | null = null;

  constructor(repo: Repository) {
    this.mutationOwner = createRefMutationMemoryOwner(repo.store);
  }

  construct<T extends string>(units: number, construct: () => T): T {
    return this.mutationOwner.construct(units, construct);
  }

  normalize(path: string): string {
    if (this.#normalizationMemory !== null) {
      throw new Error("worktree root normalization is already owned");
    }
    const memory = this.mutationOwner.memoryReservation().scope();
    memory.set("other", normalizeConstructionBytes(path));
    try {
      const normalized = normalizePath(path);
      memory.set("other", retainedStringBytes(normalized));
      this.#normalizationMemory = memory;
      return normalized;
    } catch (error) {
      memory.dispose();
      throw error;
    }
  }

  dispose(): void {
    this.#normalizationMemory?.dispose();
    this.#normalizationMemory = null;
    this.mutationOwner.dispose();
  }
}

export function worktreeList(context: GitContext, repo: Repository): readonly WorktreeInfo[] {
  const reservation = repo.store.reserveMemory();
  try {
    const current = snapshot(context, repo, reservation);
    let retainedBytes = SNAPSHOT_FIXED_BYTES + SNAPSHOT_ARRAY_BYTES;
    reservation.set("other", retainedBytes);
    const result: WorktreeInfo[] = [];
    for (let index = 0; index < current.rows.length; index++) {
      const row = current.rows[index];
      const state = current.states[index];
      if (row === undefined || state === undefined) {
        throw new CorruptError("worktree state source returned an incomplete result");
      }
      retainedBytes += SNAPSHOT_ARRAY_SLOT_BYTES + SNAPSHOT_INFO_BYTES;
      reservation.set("other", retainedBytes);
      result.push(info(row, state));
    }
    return Object.freeze(result);
  } finally {
    reservation.dispose();
  }
}

export function worktreeRemove(
  context: GitContext,
  repo: Repository,
  options: WorktreeRemoveOptions,
): void {
  if (typeof options.root !== "string" || options.root === "") {
    throw worktreeError("EINVAL", "worktree root is required");
  }
  const owner = new WorktreePlanOwner(repo);
  try {
    const root = owner.normalize(options.root);
    const row = context.database.checkoutAt(root);
    if (row === null || row.repoId !== repo.store.repoId) {
      throw worktreeError("EWORKTREENOTFOUND", `worktree is not registered: ${root}`);
    }
    if (row.isPrimary) {
      throw worktreeError("EPRIMARYWORKTREE", "the primary checkout cannot be removed");
    }
    const target = new Repository(context.database.openCheckout(row));
    context.database.removeCheckout(row.id, () => {
      if (options.force !== true) {
        const stream = statusStream(target, context.worktree, { untrackedFiles: "normal" });
        const first = stream.next();
        stream.return(undefined);
        if (!first.done) {
          throw worktreeError("EWORKTREEDIRTY", `worktree contains changes: ${root}`);
        }
      }
      context.worktree.removeFiles([root], { recursive: true });
      return undefined;
    });
  } finally {
    owner.dispose();
  }
}

export function worktreePrune(context: GitContext, repo: Repository): readonly WorktreeInfo[] {
  const reservation = repo.store.reserveMemory();
  try {
    const current = snapshot(context, repo, reservation);
    let retainedBytes = SNAPSHOT_FIXED_BYTES + 3 * SNAPSHOT_ARRAY_BYTES + SNAPSHOT_MAP_BYTES;
    reservation.set("other", retainedBytes);
    const checkoutIds: number[] = [];
    const selected = new Map<number, WorktreeInfo>();
    let removedRowsBytes = 0;
    for (let index = 0; index < current.rows.length; index++) {
      const row = current.rows[index];
      const state = current.states[index];
      if (row === undefined || state === undefined) {
        throw new CorruptError("worktree state source returned an incomplete result");
      }
      if (state === "missing" && !row.isPrimary) {
        retainedBytes += SNAPSHOT_ARRAY_SLOT_BYTES + SNAPSHOT_MAP_ENTRY_BYTES + SNAPSHOT_INFO_BYTES;
        removedRowsBytes +=
          SNAPSHOT_CHECKOUT_ROW_BYTES +
          retainedStringBytes(row.root) +
          retainedStringBytes(row.head) +
          2 * SNAPSHOT_ARRAY_SLOT_BYTES;
        reservation.set("other", retainedBytes);
        checkoutIds.push(row.id);
        selected.set(row.id, info(row, state));
      }
    }
    retainedBytes += removedRowsBytes;
    reservation.set("other", retainedBytes);
    const removed = context.database.removeCheckouts(repo.store.repoId, checkoutIds);
    const result: WorktreeInfo[] = [];
    for (const row of removed) {
      const item = selected.get(row.id);
      if (item === undefined) {
        throw new CorruptError("worktree prune removed an unexpected checkout");
      }
      result.push(item);
    }
    return Object.freeze(result);
  } finally {
    reservation.dispose();
  }
}
