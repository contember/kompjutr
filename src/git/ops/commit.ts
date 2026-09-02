// Recording a commit: the index becomes trees, the trees become a commit,
// and the ref HEAD points at moves to it.

import { GitError, hasErrorCode, MissingIdentityError } from "../common/errors.js";
import { type Commit, hashObject, type Person, serializeCommit } from "../common/objects.js";
import { indexScanOwned } from "../store/index.js";
import { writeObjectsOwned } from "../store/shared.js";
import { snapshotCommitTreeOwned } from "../store/sparse-workspace.js";
import type { GitContext, GitIdentity } from "./context.js";
import type { CommitResult } from "./kinds.js";
import { committerRefLogMetadata, type RefLogReason } from "./ref-log.js";
import {
  type Repository,
  type ResolvedHead,
  repositoryMutations,
  resolveHeadOwned,
} from "./repository.js";
import {
  buildTreeInBatch,
  planSparseTreeBuildFromSource,
  type SparseTreeBuildPlan,
  writeSparseTreePlanInBatch,
} from "./tree-build.js";

const EMPTY_TREE_OID = hashObject("tree", new Uint8Array());

/** Native commit options; Computer-compatible fields plus explicit empty-commit policy. */
export interface CommitOptions {
  message: string;
  author?: GitIdentity;
  committer?: GitIdentity;
  amend?: boolean;
  /** Permit an ordinary commit whose tree is identical to its first parent. */
  allowEmpty?: boolean;
  /** Read for GIT_AUTHOR_* / GIT_COMMITTER_*; never pulled from `process.env`. */
  env?: Record<string, string>;
}

export interface CommitIdentities {
  author: Person;
  committer: Person;
}

export interface IndexedCommitOptions {
  message: string;
  parent: readonly string[];
  identities: CommitIdentities;
  expectedHead: ResolvedHead;
  refLogReason: RefLogReason;
}

export interface UnpublishedCommitOptions {
  message: string;
  parent: readonly string[];
  identities: CommitIdentities;
}

export interface UnpublishedCommitResult {
  oid: string;
  tree: string;
}

type CommitMessage = { mode: "clean"; value: string } | { mode: "exact"; value: string };
type PublishedCommitContext = Pick<GitContext, "commitTrees" | "indexTracker">;

export function commit(
  context: GitContext,
  repo: Repository,
  options: CommitOptions,
): CommitResult {
  validatePublishedMessage(options.message);
  return repo.store.db.transactionSync(() => {
    if (repo.checkout.hasConflicts()) {
      throw new GitError("EUNMERGED", "cannot commit: the index has unmerged paths");
    }

    const head = resolveHeadOwned(repo);
    const amended = options.amend === true ? readAmended(repo, head) : undefined;
    const parent = amended !== undefined ? amended.parent : head.oid === null ? [] : [head.oid];
    const headTree =
      amended?.tree ?? (head.oid === null ? null : readCommitOwned(repo, head.oid).tree);
    const baselineTree =
      amended !== undefined ? undefined : headTree === null ? EMPTY_TREE_OID : headTree;
    const identities = resolveIdentity(context, repo, options, amended);
    const message = cleanPublishedMessage(options.message);
    const result = writeCommitObjects(
      repo,
      { parent, identities },
      { mode: "exact", value: message },
      context,
      headTree,
    );
    if (baselineTree !== undefined && options.allowEmpty !== true && result.tree === baselineTree) {
      throw new GitError("EEMPTYCOMMIT", "cannot commit: the index tree is unchanged");
    }
    const reason: RefLogReason =
      options.amend === true ? "commit (amend)" : head.oid === null ? "commit (initial)" : "commit";
    return publishCommitResult(
      repo,
      head,
      result,
      committerRefLogMetadata(identities.committer, reason),
      context,
    );
  });
}

/** Build the stage-zero index and move only the HEAD observed by the caller. */
export function commitIndex(
  repo: Repository,
  options: IndexedCommitOptions,
  context?: PublishedCommitContext,
): CommitResult {
  validatePublishedMessage(options.message);
  return repo.store.db.transactionSync(() => {
    const head = resolveHeadOwned(repo);
    if (head.ref !== options.expectedHead.ref || head.oid !== options.expectedHead.oid) {
      throw new GitError("ESTALEHEAD", "HEAD changed while the commit was being prepared");
    }
    const headTree = head.oid === null ? null : readCommitOwned(repo, head.oid).tree;
    return publishCommit(repo, options, context, headTree);
  });
}

/** Caller owns the transaction; this writes authoritative objects but never publishes a ref. */
export function writeUnpublishedCommit(
  repo: Repository,
  options: UnpublishedCommitOptions,
): UnpublishedCommitResult {
  return writeCommitObjects(repo, options, { mode: "exact", value: options.message });
}

/** Caller owns the transaction and has authenticated the explicit tree and parents. */
export function writeUnpublishedCommitFromTree(
  repo: Repository,
  tree: string,
  options: UnpublishedCommitOptions,
): string {
  return writeObjectsOwned(repo.store, (batch) =>
    writeSerializedCommit(batch.write, options, { mode: "exact", value: options.message }, tree),
  );
}

/** Materialize the stage-zero index through one shared object encoder. */
function writeCommitObjects(
  repo: Repository,
  options: Pick<UnpublishedCommitOptions, "parent" | "identities">,
  message: CommitMessage,
  context?: PublishedCommitContext,
  baselineTreeOid?: string | null,
): UnpublishedCommitResult {
  const sparse =
    context === undefined || baselineTreeOid === undefined
      ? null
      : sparseTreePlan(context, repo, baselineTreeOid);
  if (sparse !== null) {
    const tree = sparse.tree;
    return writeObjectsOwned(repo.store, (batch) => {
      writeSparseTreePlanInBatch(batch, sparse);
      return { oid: writeSerializedCommit(batch.write, options, message, tree), tree };
    });
  }
  // A paged scan, so the index never exists as one array alongside the build.
  return writeObjectsOwned(repo.store, (batch) => {
    const tree = buildTreeInBatch(batch, indexScanOwned(repo.checkout, { pageSize: 2048 }));
    const oid = writeSerializedCommit(batch.write, options, message, tree);
    return { oid, tree };
  });
}

function writeSerializedCommit(
  write: (type: "commit", data: Uint8Array) => string,
  options: Pick<UnpublishedCommitOptions, "parent" | "identities">,
  message: CommitMessage,
  tree: string,
): string {
  return write("commit", serializedCommit(options, message, tree));
}

function serializedCommit(
  options: Pick<UnpublishedCommitOptions, "parent" | "identities">,
  message: CommitMessage,
  tree: string,
): Uint8Array {
  return serializeCommit({
    tree,
    parent: [...options.parent],
    author: options.identities.author,
    committer: options.identities.committer,
    message: message.mode === "clean" ? cleanMessage(message.value) : message.value,
  });
}

function sparseTreePlan(
  context: PublishedCommitContext,
  repo: Repository,
  baselineTreeOid: string | null,
): Extract<SparseTreeBuildPlan, { available: true }> | null {
  const source = context.commitTrees;
  if (source === undefined) return null;
  try {
    const snapshot = snapshotCommitTreeOwned(source, {
      repoId: repo.store.repoId,
      checkoutId: repo.checkout.checkoutId,
      root: repo.root,
      baselineTreeOid,
    });
    if (!snapshot.available) return null;
    const plan = planSparseTreeBuildFromSource(repo.checkout.db, source, snapshot, baselineTreeOid);
    return plan.available ? plan : null;
  } catch (error) {
    if (hasErrorCode(error, "E2BIG")) return null;
    throw error;
  }
}

/** Caller owns the transaction and has already validated `expectedHead`. */
function publishCommit(
  repo: Repository,
  options: IndexedCommitOptions,
  context: PublishedCommitContext | undefined,
  baselineTreeOid: string | null,
): CommitResult {
  const message = cleanPublishedMessage(options.message);
  const result = writeCommitObjects(
    repo,
    options,
    { mode: "exact", value: message },
    context,
    baselineTreeOid,
  );
  return publishCommitResult(
    repo,
    options.expectedHead,
    result,
    committerRefLogMetadata(options.identities.committer, options.refLogReason),
    context,
  );
}

function publishCommitResult(
  repo: Repository,
  expectedHead: ResolvedHead,
  result: UnpublishedCommitResult,
  metadata: ReturnType<typeof committerRefLogMetadata>,
  context: PublishedCommitContext | undefined,
): CommitResult {
  // A symbolic HEAD on an unborn branch creates the branch here.
  if (expectedHead.ref === null) {
    repositoryMutations(repo).mutateRefsOwned({ head: result.oid }, metadata);
  } else {
    repositoryMutations(repo).mutateRefsOwned(
      { puts: [{ name: expectedHead.ref, target: result.oid }] },
      metadata,
    );
  }
  // A false result leaves the prior baseline mismatched, so sparse readers safely use full scans.
  context?.indexTracker?.advanceBaseline?.(repo.checkout.checkoutId, result.tree);
  return { oid: result.oid };
}

function validatePublishedMessage(message: string): void {
  if (message.trim() === "") throw new GitError("EMSG", "commit message is required");
}

function cleanPublishedMessage(message: string): string {
  return cleanMessage(message);
}

function readCommitOwned(repo: Repository, oid: string): Commit {
  return repo.readAuthenticatedCommitOwned(oid);
}

/**
 * Author and committer, in the precedence Computer documents: explicit
 * option, then `env`, then local `user.name` / `user.email`, then
 * `context.defaultIdentity`. There is no global `~/.gitconfig` fallback.
 *
 * Amending inserts the amended commit's own author just below the explicit
 * option and keeps its author date, the way `git commit --amend` does; the
 * committer is always re-stamped with the current time.
 */
export function resolveIdentity(
  context: GitContext,
  repo: Repository,
  options: Pick<CommitOptions, "author" | "committer" | "env">,
  amended?: Commit,
  maxIdentityBytes?: number,
): CommitIdentities {
  const sources = identitySources(context, options, amended);
  const config =
    maxIdentityBytes !== undefined &&
    sources.authorBeforeConfig !== null &&
    sources.committerBeforeConfig !== null
      ? null
      : identityOf(
          maxIdentityBytes === undefined
            ? repo.store.configGet("user.name")
            : repo.store.configGetBounded("user.name", maxIdentityBytes),
          maxIdentityBytes === undefined
            ? repo.store.configGet("user.email")
            : repo.store.configGetBounded("user.email", maxIdentityBytes),
        );
  return completeIdentity(context, amended, sources, config);
}

interface IdentitySources {
  authorBeforeConfig: GitIdentity | null;
  committerBeforeConfig: GitIdentity | null;
  fallback: GitIdentity | null;
}

function identitySources(
  context: GitContext,
  options: Pick<CommitOptions, "author" | "committer" | "env">,
  amended?: Commit,
): IdentitySources {
  const env = options.env ?? {};
  const explicitAuthor = identityOf(options.author?.name, options.author?.email);
  const amendedAuthor = identityOf(amended?.author.name, amended?.author.email);
  const environmentAuthor = identityOf(env.GIT_AUTHOR_NAME, env.GIT_AUTHOR_EMAIL);
  const explicitCommitter = identityOf(options.committer?.name, options.committer?.email);
  const environmentCommitter = identityOf(
    env.GIT_COMMITTER_NAME ?? env.GIT_AUTHOR_NAME,
    env.GIT_COMMITTER_EMAIL ?? env.GIT_AUTHOR_EMAIL,
  );
  const authorBeforeConfig = explicitAuthor ?? amendedAuthor ?? environmentAuthor;
  const committerBeforeConfig = explicitCommitter ?? environmentCommitter;
  const fallback = identityOf(context.defaultIdentity?.name, context.defaultIdentity?.email);
  return { authorBeforeConfig, committerBeforeConfig, fallback };
}

function completeIdentity(
  context: GitContext,
  amended: Commit | undefined,
  sources: IdentitySources,
  config: GitIdentity | null,
): CommitIdentities {
  const author = sources.authorBeforeConfig ?? config ?? sources.fallback;
  if (author === null) throw new MissingIdentityError();

  const committer = sources.committerBeforeConfig ?? config ?? sources.fallback ?? author;

  const now = stamp(context);
  return {
    author: {
      ...author,
      timestamp: amended?.author.timestamp ?? now.timestamp,
      timezoneOffset: amended?.author.timezoneOffset ?? now.timezoneOffset,
    },
    committer: { ...committer, ...now },
  };
}

function readAmended(repo: Repository, head: ResolvedHead): Commit {
  if (head.oid === null) {
    throw new GitError("ENOCOMMIT", "cannot amend: HEAD does not point at a commit yet");
  }
  return readCommitOwned(repo, head.oid);
}

/** A source only wins when it supplies both halves of an identity. */
function identityOf(name: string | undefined, email: string | undefined): GitIdentity | null {
  if (name === undefined || name === "" || email === undefined || email === "") return null;
  return { name, email };
}

function stamp(context: GitContext): { timestamp: number; timezoneOffset: number } {
  return {
    timestamp: Math.floor(context.now() / 1000),
    timezoneOffset: context.timezoneOffset(),
  };
}

/** git's message cleanup: no CRs, no surrounding blank lines, exactly one trailing newline. */
function cleanMessage(message: string): string {
  return `${message.replace(/\r/g, "").replace(/^\n+/, "").replace(/\n+$/, "")}\n`;
}
