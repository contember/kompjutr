// Recording a commit: the index becomes trees, the trees become a commit,
// and the ref HEAD points at moves to it.

import { MAX_SINGLE_REF_MUTATION_SQL_STATEMENTS } from "../../sqlite/store.js";
import type { GitContext, GitIdentity } from "../context.js";
import { GitError, MissingIdentityError } from "../errors.js";
import { type Commit, hashObject, type Person, serializeCommit } from "../objects.js";
import type { Repository, ResolvedHead } from "../repository.js";
import type { CommitResult } from "./kinds.js";
import { MAX_MERGE_IDENTITY_BYTES, MAX_MERGE_MESSAGE_BYTES } from "./merge-state.js";
import { committerRefLogMetadata, type RefLogReason } from "./ref-log.js";
import { buildTreeInBatch, type TreeBuildPreflightStats } from "./tree-build.js";

const OBJECT_BATCH_BYTES = 1024 * 1024;
const OBJECT_BATCH_COUNT = 4_096;
const TREE_INDEX_ROWS = 2_048;
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

/** Conservatively account for one bounded index-tree and commit materialization. */
export function commitMaterializationSqlStatements(stats: TreeBuildPreflightStats): number {
  const objects = stats.treeObjects + 1;
  const payloadBytes =
    stats.serializedTreeBytes +
    stats.treeObjects * 1_024 +
    MAX_MERGE_MESSAGE_BYTES +
    4 * MAX_MERGE_IDENTITY_BYTES +
    1_024;
  const payloadPages = Math.max(1, Math.ceil(payloadBytes / OBJECT_BATCH_BYTES));
  const flushes = Math.ceil(objects / OBJECT_BATCH_COUNT) + payloadPages;
  const indexedRows = stats.leafEntries + stats.treeObjects - 1;
  return (
    20 +
    flushes * 6 +
    payloadPages * 2 +
    Math.ceil(indexedRows / TREE_INDEX_ROWS) * 2 +
    Math.ceil(stats.treeObjects / TREE_INDEX_ROWS) * 2 +
    Math.ceil(stats.leafEntries / 2_048)
  );
}

/** Materialization plus the atomic single-ref/causal-HEAD publication seam. */
export function commitPublicationSqlStatements(stats: TreeBuildPreflightStats): number {
  return commitMaterializationSqlStatements(stats) + MAX_SINGLE_REF_MUTATION_SQL_STATEMENTS;
}

export function commit(
  context: GitContext,
  repo: Repository,
  options: CommitOptions,
): CommitResult {
  if (options.message.trim() === "") throw new GitError("EMSG", "commit message is required");
  return repo.store.db.transactionSync(() => {
    if (repo.store.hasConflicts()) {
      throw new GitError("EUNMERGED", "cannot commit: the index has unmerged paths");
    }

    const head = repo.head();
    const amended = options.amend === true ? readAmended(repo, head) : undefined;
    const parent = amended !== undefined ? amended.parent : head.oid === null ? [] : [head.oid];
    const baselineTree =
      amended !== undefined
        ? undefined
        : head.oid === null
          ? EMPTY_TREE_OID
          : repo.readCommit(head.oid).tree;
    const identities = resolveIdentity(context, repo, options, amended);
    const result = writeCommitObjects(
      repo,
      {
        parent,
        identities,
      },
      { mode: "clean", value: options.message },
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
    );
  });
}

/** Build the stage-zero index and move only the HEAD observed by the caller. */
export function commitIndex(repo: Repository, options: IndexedCommitOptions): CommitResult {
  if (options.message.trim() === "") throw new GitError("EMSG", "commit message is required");

  return repo.store.db.transactionSync(() => {
    const head = repo.head();
    if (head.ref !== options.expectedHead.ref || head.oid !== options.expectedHead.oid) {
      throw new GitError("ESTALEHEAD", "HEAD changed while the commit was being prepared");
    }
    return publishCommit(repo, options);
  });
}

/** Caller owns the transaction; this writes authoritative objects but never publishes a ref. */
export function writeUnpublishedCommit(
  repo: Repository,
  options: UnpublishedCommitOptions,
): UnpublishedCommitResult {
  return writeCommitObjects(repo, options, { mode: "exact", value: options.message });
}

/** Materialize the stage-zero index through one shared object encoder. */
function writeCommitObjects(
  repo: Repository,
  options: Pick<UnpublishedCommitOptions, "parent" | "identities">,
  message: CommitMessage,
): UnpublishedCommitResult {
  // A paged scan, so the index never exists as one array alongside the build.
  return repo.store.writeObjects((batch) => {
    const tree = buildTreeInBatch(batch, repo.store.indexScan({ pageSize: 2048 }));
    const oid = batch.write(
      "commit",
      serializeCommit({
        tree,
        parent: [...options.parent],
        author: options.identities.author,
        committer: options.identities.committer,
        message: message.mode === "clean" ? cleanMessage(message.value) : message.value,
      }),
    );
    return { oid, tree };
  });
}

/** Caller owns the transaction and has already validated `expectedHead`. */
function publishCommit(repo: Repository, options: IndexedCommitOptions): CommitResult {
  const result = writeCommitObjects(repo, options, { mode: "clean", value: options.message });
  return publishCommitResult(
    repo,
    options.expectedHead,
    result,
    committerRefLogMetadata(options.identities.committer, options.refLogReason),
  );
}

function publishCommitResult(
  repo: Repository,
  expectedHead: ResolvedHead,
  result: UnpublishedCommitResult,
  metadata: ReturnType<typeof committerRefLogMetadata>,
): CommitResult {
  // A symbolic HEAD on an unborn branch creates the branch here.
  if (expectedHead.ref === null) repo.store.mutateRefs({ head: result.oid }, metadata);
  else repo.store.mutateRefs({ puts: [{ name: expectedHead.ref, target: result.oid }] }, metadata);
  return { oid: result.oid };
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
): CommitIdentities {
  const env = options.env ?? {};
  const config = identityOf(repo.store.configGet("user.name"), repo.store.configGet("user.email"));
  const fallback = identityOf(context.defaultIdentity?.name, context.defaultIdentity?.email);

  const author =
    identityOf(options.author?.name, options.author?.email) ??
    identityOf(amended?.author.name, amended?.author.email) ??
    identityOf(env.GIT_AUTHOR_NAME, env.GIT_AUTHOR_EMAIL) ??
    config ??
    fallback;
  if (author === null) throw new MissingIdentityError();

  const committer =
    identityOf(options.committer?.name, options.committer?.email) ??
    identityOf(
      env.GIT_COMMITTER_NAME ?? env.GIT_AUTHOR_NAME,
      env.GIT_COMMITTER_EMAIL ?? env.GIT_AUTHOR_EMAIL,
    ) ??
    config ??
    fallback ??
    author;

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
  return repo.readCommit(head.oid);
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
