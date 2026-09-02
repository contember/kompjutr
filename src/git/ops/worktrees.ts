import { exactPathStatesOwned } from "../../fs/exact-path-states.js";
import {
  CorruptError,
  GitError,
  RefNotFoundError,
  UnsupportedOperationError,
} from "../common/errors.js";
import { normalizePath } from "../common/paths.js";
import { checkRefText, hasCanonicalRefSyntax } from "../common/ref-name.js";
import { sqliteGitDatabaseMutations, withGitMutationGuardOwned } from "../store/database.js";
import { type CheckoutRow, type CheckoutStore, listCheckoutsOwned } from "../store/index.js";
import { mutateRefsOwned } from "../store/refs.js";
import { checkoutTree } from "./checkout.js";
import type { ExactRootState, GitContext } from "./context.js";
import { operationRefLogMetadata } from "./ref-log.js";
import { Repository } from "./repository.js";
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

function worktreeError(code: string, message: string): GitError {
  return new GitError(code, message);
}

function shortBranchRef(name: string): string {
  if (typeof name !== "string" || name === "" || name.startsWith("refs/")) {
    throw worktreeError("EINVALIDREF", "invalid short branch name");
  }
  if (checkRefText(name).problem !== null) {
    throw worktreeError("EINVALIDREF", "invalid short branch name");
  }
  const full = `refs/heads/${name}`;
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

function addPlan(repo: Repository, target: WorktreeAddTarget): AddPlan {
  if (typeof target !== "object" || target === null) {
    throw worktreeError("EINVAL", "worktree target is invalid");
  }
  if (target.kind === "existing-branch") {
    const branch = shortBranchRef(target.name);
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
    const branch = shortBranchRef(target.name);
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
): undefined {
  requireAvailableRoot(context, checkout.root);
  const target = new Repository(checkout);
  if (plan.branch !== null) {
    const mutation = plan.createBranch
      ? {
          puts: [{ name: plan.branch, target: plan.commitOid }],
          head: `ref: ${plan.branch}`,
        }
      : { head: `ref: ${plan.branch}` };
    if (
      !mutateRefsOwned(
        target.checkout,
        mutation,
        operationRefLogMetadata(context, target, "checkout"),
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

function snapshot(context: GitContext, repo: Repository): WorktreeSnapshot {
  const source = context.exactRootStates;
  if (source === undefined) throw new UnsupportedOperationError("worktree listing");
  const rows = listCheckoutsOwned(context.database, repo.store.repoId);
  const roots = rows.map((row) => row.root);
  const ownedStates = exactPathStatesOwned(source, roots);
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
}

export function worktreeAdd(
  context: GitContext,
  repo: Repository,
  options: WorktreeAddOptions,
): WorktreeInfo {
  return withGitMutationGuardOwned(context.database, () =>
    worktreeAddOwned(context, repo, options),
  );
}

/** @internal Add a worktree while the caller owns the Git mutation guard. */
export function worktreeAddOwned(
  context: GitContext,
  repo: Repository,
  options: WorktreeAddOptions,
): WorktreeInfo {
  if (typeof options.root !== "string" || options.root === "") {
    throw worktreeError("EINVAL", "worktree root is required");
  }
  const root = normalizePath(options.root);
  const plan = addPlan(repo, options.target);
  const row = sqliteGitDatabaseMutations(context.database).createCheckoutOwned(
    repo.store.repoId,
    root,
    plan.commitOid,
    (checkout) => initializeCheckout(context, checkout, plan),
  );
  return info(row, "present");
}

export function worktreeList(context: GitContext, repo: Repository): readonly WorktreeInfo[] {
  const current = snapshot(context, repo);
  const result: WorktreeInfo[] = [];
  for (let index = 0; index < current.rows.length; index++) {
    const row = current.rows[index];
    const state = current.states[index];
    if (row === undefined || state === undefined) {
      throw new CorruptError("worktree state source returned an incomplete result");
    }
    result.push(info(row, state));
  }
  return Object.freeze(result);
}

export function worktreeRemove(
  context: GitContext,
  repo: Repository,
  options: WorktreeRemoveOptions,
): void {
  withGitMutationGuardOwned(context.database, () => worktreeRemoveOwned(context, repo, options));
}

/** @internal Remove a worktree while the caller owns the Git mutation guard. */
export function worktreeRemoveOwned(
  context: GitContext,
  repo: Repository,
  options: WorktreeRemoveOptions,
): void {
  if (typeof options.root !== "string" || options.root === "") {
    throw worktreeError("EINVAL", "worktree root is required");
  }
  const root = normalizePath(options.root);
  const row = context.database.checkoutAt(root);
  if (row === null || row.repoId !== repo.store.repoId) {
    throw worktreeError("EWORKTREENOTFOUND", `worktree is not registered: ${root}`);
  }
  if (row.isPrimary) {
    throw worktreeError("EPRIMARYWORKTREE", "the primary checkout cannot be removed");
  }
  const target = new Repository(context.database.openCheckout(row));
  sqliteGitDatabaseMutations(context.database).removeCheckoutOwned(row.id, () => {
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
}

export function worktreePrune(context: GitContext, repo: Repository): readonly WorktreeInfo[] {
  return withGitMutationGuardOwned(context.database, () => worktreePruneOwned(context, repo));
}

/** @internal Prune worktrees while the caller owns the Git mutation guard. */
export function worktreePruneOwned(context: GitContext, repo: Repository): readonly WorktreeInfo[] {
  const current = snapshot(context, repo);
  const checkoutIds: number[] = [];
  const selected = new Map<number, WorktreeInfo>();
  for (let index = 0; index < current.rows.length; index++) {
    const row = current.rows[index];
    const state = current.states[index];
    if (row === undefined || state === undefined) {
      throw new CorruptError("worktree state source returned an incomplete result");
    }
    if (state === "missing" && !row.isPrimary) {
      checkoutIds.push(row.id);
      selected.set(row.id, info(row, state));
    }
  }
  const removed = sqliteGitDatabaseMutations(context.database).removeCheckoutsOwned(
    repo.store.repoId,
    checkoutIds,
  );
  const result: WorktreeInfo[] = [];
  for (const row of removed) {
    const item = selected.get(row.id);
    if (item === undefined) {
      throw new CorruptError("worktree prune removed an unexpected checkout");
    }
    result.push(item);
  }
  return Object.freeze(result);
}
