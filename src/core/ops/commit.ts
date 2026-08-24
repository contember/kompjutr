// Recording a commit: the index becomes trees, the trees become a commit,
// and the ref HEAD points at moves to it.

import type { GitContext, GitIdentity } from "../context.js";
import { GitError, MissingIdentityError } from "../errors.js";
import { type Commit, type Person, serializeCommit } from "../objects.js";
import type { Repository, ResolvedHead } from "../repository.js";
import type { CommitResult } from "./kinds.js";
import { buildTreeInBatch } from "./tree-build.js";

/** Mirrors Computer's `GitCommitOptions`, minus `dir` — the repository is already resolved. */
export interface CommitOptions {
  message: string;
  author?: GitIdentity;
  committer?: GitIdentity;
  amend?: boolean;
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
    const identities = resolveIdentity(context, repo, options, amended);
    return writeCommitIndex(repo, {
      message: options.message,
      parent,
      identities,
      expectedHead: head,
    });
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
    return writeCommitIndex(repo, options);
  });
}

/** Caller owns the transaction and has already validated `expectedHead`. */
function writeCommitIndex(repo: Repository, options: IndexedCommitOptions): CommitResult {
  // A paged scan, so the index never exists as one array alongside the build.
  const oid = repo.store.writeObjects((batch) => {
    const tree = buildTreeInBatch(batch, repo.store.indexScan({ pageSize: 2048 }));
    return batch.write(
      "commit",
      serializeCommit({
        tree,
        parent: [...options.parent],
        author: options.identities.author,
        committer: options.identities.committer,
        message: cleanMessage(options.message),
      }),
    );
  });

  // A symbolic HEAD on an unborn branch creates the branch here.
  if (options.expectedHead.ref === null) repo.store.setHead(oid);
  else repo.store.setRef(options.expectedHead.ref, oid);
  return { oid };
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
