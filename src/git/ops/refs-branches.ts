import { isOid } from "../common/bytes.js";
import { CorruptError, GitError } from "../common/errors.js";
import { checkRefText, hasCanonicalRefSyntax } from "../common/ref-name.js";
import { listCheckoutsOwned } from "../store/index.js";
import { mutateRefsOwned } from "../store/refs.js";
import { sharedRepoStoreMutations } from "../store/shared.js";
import { resolveBranchUpstream } from "./branch-upstream.js";
import type { GitContext } from "./context.js";
import { selectMergeBases } from "./merge-base.js";
import { operationRefLogMetadata } from "./ref-log.js";
import { type Repository, resolveHeadOwned } from "./repository.js";

const HEADS = "refs/heads/";
const TAGS = "refs/tags/";

export interface BranchOptions {
  name: string;
  /** Commit-ish the branch points at. Defaults to HEAD. */
  startPoint?: string;
  /**
   * Point HEAD at the new branch. The working tree is left where it is —
   * `switchBranch` is the spelling that moves both.
   */
  checkout?: boolean;
  force?: boolean;
}

export function branch(context: GitContext, repo: Repository, options: BranchOptions): void {
  branchOwned(context, repo, options);
}

function branchOwned(context: GitContext, repo: Repository, options: BranchOptions): void {
  const full = branchRef(options.name);
  const exists = refExists(repo, full);
  if (options.force !== true && exists) {
    throw new GitError("EBRANCHFAIL", `a branch named '${options.name}' already exists`);
  }
  // A branch names a commit, so an annotated tag start point is peeled.
  const oid = repo.peel(repo.revParse(options.startPoint ?? "HEAD"));
  repo.store.db.transactionSync(() => {
    const mutation =
      options.checkout === true
        ? { puts: [{ name: full, target: oid }], head: symbolicRef(full) }
        : { puts: [{ name: full, target: oid }] };
    mutateRefsOwned(
      repo.checkout,
      mutation,
      operationRefLogMetadata(context, repo, exists ? "branch: reset" : "branch: create"),
    );
  });
}

export interface BranchDeleteOptions {
  name: string;
  /** Delete even when the branch is not fully merged. */
  force?: boolean;
}

export interface BranchRenameOptions {
  /** Branch to rename. Defaults to the selected checkout's current branch. */
  oldName?: string;
  newName: string;
}

export function branchRename(
  context: GitContext,
  repo: Repository,
  options: BranchRenameOptions,
): void {
  branchRenameOwned(context, repo, options);
}

function branchRenameOwned(
  context: GitContext,
  repo: Repository,
  options: BranchRenameOptions,
): void {
  const runtimeOptions: unknown = options;
  const optionObject =
    typeof runtimeOptions === "object" && runtimeOptions !== null ? runtimeOptions : null;
  const newName = optionObject === null ? undefined : Reflect.get(optionObject, "newName");
  const oldName = optionObject === null ? undefined : Reflect.get(optionObject, "oldName");
  const destination = branchRenameRef(newName, "new branch name");
  const requestedSource =
    oldName === undefined ? null : branchRenameRef(oldName, "old branch name");
  const metadata = operationRefLogMetadata(context, repo, "branch: rename");

  repo.store.db.transactionSync(() => {
    repo.checkout.requireNoOperationState();
    const oldHead = repo.checkout.head();
    let source: string;
    if (requestedSource === null) {
      const selected = oldHead.startsWith("ref: ") ? oldHead.slice(5) : null;
      if (selected?.startsWith(HEADS) !== true) {
        throw new GitError("EBRANCHFAIL", "cannot rename branch from detached HEAD");
      }
      source = selected;
    } else {
      source = requestedSource;
    }

    const tip = repo.store.getRef(source);
    if (tip === null) {
      throw new GitError("EBRANCHFAIL", `branch '${source.slice(HEADS.length)}' not found`);
    }
    if (!isOid(tip)) {
      throw new CorruptError(`branch '${source.slice(HEADS.length)}' is not a direct ref`);
    }
    repo.readAuthenticatedCommit(tip);
    if (source === destination || repo.store.getRef(destination) !== null) {
      throw new GitError(
        "EBRANCHFAIL",
        `a branch named '${destination.slice(HEADS.length)}' already exists`,
      );
    }

    const sourceHead = symbolicRef(source);
    const checkoutOwner = listCheckoutsOwned(context.database, repo.store.repoId).find(
      (checkout) => checkout.head === sourceHead,
    );
    if (checkoutOwner !== undefined && checkoutOwner.id !== repo.checkout.checkoutId) {
      throw new GitError(
        "EBRANCHFAIL",
        `cannot rename branch '${source.slice(HEADS.length)}': it is checked out at ${checkoutOwner.root}`,
      );
    }

    const sourceConfig = branchConfigPrefix(source);
    const destinationConfig = branchConfigPrefix(destination);
    sharedRepoStoreMutations(repo.store).configMoveSectionOwned(sourceConfig, destinationConfig);
    mutateRefsOwned(
      repo.checkout,
      {
        puts: [{ name: destination, target: tip }],
        deletes: [source],
        head: oldHead === sourceHead ? symbolicRef(destination) : undefined,
        expected: { name: source, target: tip },
      },
      metadata,
    );
  });
}

function branchRenameRef(value: unknown, label: string): string {
  if (typeof value !== "string" || value === "") {
    throw new GitError("EINVAL", `${label} is required`);
  }
  const checked = checkRefText(value);
  if (checked.problem !== null) throw new GitError("EINVAL", `${label} is invalid`);
  const ref = `${HEADS}${value}`;
  if (!hasCanonicalRefSyntax(ref)) throw new GitError("EINVAL", `${label} is invalid`);
  return ref;
}

export function branchDelete(
  context: GitContext,
  repo: Repository,
  options: BranchDeleteOptions,
): void {
  branchDeleteOwned(context, repo, options);
}

function branchDeleteOwned(
  context: GitContext,
  repo: Repository,
  options: BranchDeleteOptions,
): void {
  const full = branchRef(options.name);
  repo.store.db.transactionSync(() => {
    const storedTip = repo.store.getRef(full);
    if (storedTip === null) {
      throw new GitError("EBRANCHFAIL", `branch '${options.name}' not found`);
    }
    if (!isOid(storedTip)) {
      throw new CorruptError(`branch '${options.name}' does not point to a commit`);
    }
    const tip = storedTip;
    repo.readCommit(tip);
    const attachedHead = symbolicRef(full);
    const attachedCheckout = listCheckoutsOwned(context.database, repo.store.repoId).find(
      (checkout) => checkout.head === attachedHead,
    );
    if (attachedCheckout !== undefined) {
      throw new GitError(
        "EBRANCHFAIL",
        `cannot delete branch '${options.name}': it is checked out at ${attachedCheckout.root}`,
      );
    }

    if (options.force !== true) {
      const upstream = resolveBranchUpstream(repo, full);
      const upstreamOid = upstream?.oid;
      const fallback =
        upstreamOid === null || upstreamOid === undefined ? resolveHeadOwned(repo).oid : null;
      const comparison = upstreamOid ?? fallback;
      if (comparison === null) {
        throw new GitError(
          "EBRANCHFAIL",
          `cannot delete branch '${options.name}': no comparison commit is available`,
        );
      }
      const selection = selectMergeBases(repo, { currentOid: comparison, incomingOid: tip });
      if (selection.kind === "shallow") {
        throw new GitError(
          "ESHALLOW",
          `cannot prove branch '${options.name}' is fully merged across a shallow boundary`,
        );
      }
      if (selection.kind !== "already-merged") {
        throw new GitError("EBRANCHFAIL", `branch '${options.name}' is not fully merged`);
      }
    }

    mutateRefsOwned(
      repo.checkout,
      { deletes: [full], expected: { name: full, target: tip } },
      operationRefLogMetadata(context, repo, "branch: delete"),
    );
  });
}

export function branchList(repo: Repository): string[] {
  return repo.branches().sort();
}

export interface CurrentBranchOptions {
  /** Return `refs/heads/<name>` instead of `<name>`. */
  fullname?: boolean;
}

/**
 * The short name by default. Computer's prose doc claims `fullname`
 * defaults to true, but its code hands the flag straight to
 * isomorphic-git, which defaults to false.
 */
export function currentBranch(
  repo: Repository,
  options: CurrentBranchOptions = {},
): string | undefined {
  const { ref } = resolveHeadOwned(repo);
  if (ref === null) return undefined;
  if (options.fullname === true || !ref.startsWith(HEADS)) return ref;
  return ref.slice(HEADS.length);
}

export interface TagOptions {
  name: string;
  /** Object to tag. Defaults to HEAD. */
  object?: string;
  force?: boolean;
}

/** Lightweight tags only: a ref row, no tag object. */
export function tag(context: GitContext, repo: Repository, options: TagOptions): void {
  tagOwned(context, repo, options);
}

function tagOwned(context: GitContext, repo: Repository, options: TagOptions): void {
  const full = tagRef(options.name);
  const exists = refExists(repo, full);
  if (options.force !== true && exists) {
    throw new GitError("ETAGFAIL", `tag '${options.name}' already exists`);
  }
  const target = repo.revParse(options.object ?? "HEAD");
  repo.typeOf(target);
  mutateRefsOwned(
    repo.checkout,
    { puts: [{ name: full, target }] },
    operationRefLogMetadata(context, repo, exists ? "tag: update" : "tag: create"),
  );
}

export interface TagDeleteOptions {
  name: string;
}

export function tagDelete(context: GitContext, repo: Repository, options: TagDeleteOptions): void {
  tagDeleteOwned(context, repo, options);
}

function tagDeleteOwned(context: GitContext, repo: Repository, options: TagDeleteOptions): void {
  const full = tagRef(options.name);
  if (repo.store.getRef(full) === null) {
    throw new GitError("ETAGFAIL", `tag '${options.name}' not found`);
  }
  mutateRefsOwned(
    repo.checkout,
    { deletes: [full] },
    operationRefLogMetadata(context, repo, "tag: delete"),
  );
}

export function tagList(repo: Repository): string[] {
  return repo.tags().sort();
}

function branchRef(name: string): string {
  if (name === "") throw new GitError("EBRANCHFAIL", "a branch name is required");
  return `${HEADS}${name}`;
}

function tagRef(name: string): string {
  if (name === "") throw new GitError("ETAGFAIL", "a tag name is required");
  return `${TAGS}${name}`;
}

function refExists(repo: Repository, name: string): boolean {
  const present = repo.store.db.scalar<unknown>(
    "SELECT 1 FROM git_refs WHERE repo_id = ? AND name = ? LIMIT 1",
    repo.store.repoId,
    name,
  );
  if (present === undefined) return false;
  if (present !== 1) throw new CorruptError("ref existence query returned invalid state");
  return true;
}

function symbolicRef(ref: string): string {
  return `ref: ${ref}`;
}

function branchConfigPrefix(ref: string): string {
  return `branch.${ref.slice(HEADS.length)}.`;
}
