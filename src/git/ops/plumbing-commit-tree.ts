import { CorruptError, GitError, ObjectNotFoundError } from "../common/errors.js";
import type { Person } from "../common/objects.js";
import { withGitMutationGuard } from "../store/mutation-guard.js";
import {
  type CommitIdentities,
  resolveIdentity,
  writeUnpublishedCommitFromTree,
} from "./commit.js";
import type { GitContext, GitIdentity } from "./context.js";
import type { Repository } from "./repository.js";

export const MAX_COMMIT_TREE_PARENTS = 2;
export const MAX_COMMIT_TREE_REVISION_TRAVERSALS = 8;

export interface CommitTreeOptions {
  /** Exact tree revision; commit and tag objects are not peeled. */
  tree: string;
  /** Exact commit message, without porcelain cleanup. */
  message: string;
  /** Ordered commit revisions; duplicates keep their first occurrence. */
  parent?: readonly string[];
  author?: GitIdentity;
  committer?: GitIdentity;
  /** Read for GIT_AUTHOR_* / GIT_COMMITTER_* identity fields. */
  env?: Record<string, string>;
}

interface CheckedCommitTreeInput {
  tree: string;
  message: string;
  parent: readonly string[];
  bytes: number;
}

/** Write one detached commit object without changing refs, indexes, or the worktree. */
export function commitTree(
  context: GitContext,
  repo: Repository,
  options: CommitTreeOptions,
): string {
  return withGitMutationGuard(repo.checkout.db, () => commitTreeOwned(context, repo, options));
}

/** @internal Write a detached commit while the caller owns the Git mutation guard. */
export function commitTreeOwned(
  context: GitContext,
  repo: Repository,
  options: CommitTreeOptions,
): string {
  return repo.store.runScratchAwareOperation(() => {
    const input = checkCommitTreeInput(options);
    return repo.store.db.transactionSync(() => {
      const tree = repo.revParse(input.tree);
      authenticateCommitTreeObject(repo, tree, "tree");

      const parent: string[] = [];
      const seen = new Set<string>();
      for (const expression of input.parent) {
        const oid = repo.revParse(expression);
        if (seen.has(oid)) continue;
        seen.add(oid);
        authenticateCommitTreeObject(repo, oid, "commit");
        parent.push(oid);
      }

      const identities = resolveIdentity(context, repo, options);
      const identityBytes = validateCommitIdentities(identities);
      requireCommitTreeInputBytes(input.bytes, identityBytes);
      return writeUnpublishedCommitFromTree(repo, tree, {
        message: input.message,
        parent,
        identities,
      });
    });
  });
}

function authenticateCommitTreeObject(
  repo: Repository,
  oid: string,
  expectedType: "tree" | "commit",
): void {
  const info = repo.store.typeAndSize(oid);
  if (info === null) throw new ObjectNotFoundError(oid);
  if (info.type !== expectedType) {
    throw new CorruptError(`${oid} is a ${info.type}, not a ${expectedType}`);
  }
  if (expectedType === "commit") {
    repo.readAuthenticatedCommitOwned(oid);
    return;
  }
  if (repo.store.readAuthenticatedObject(oid, expectedType) === null) {
    throw new ObjectNotFoundError(oid);
  }
}

function checkCommitTreeInput(options: CommitTreeOptions): CheckedCommitTreeInput {
  const tree: unknown = Reflect.get(options, "tree");
  const message: unknown = Reflect.get(options, "message");
  const rawParent: unknown = Reflect.get(options, "parent");
  if (typeof tree !== "string" || tree === "") {
    throw new GitError("EINVAL", "commit-tree requires a tree revision");
  }
  if (typeof message !== "string") {
    throw new GitError("EINVAL", "commit-tree requires a message");
  }
  if (rawParent !== undefined && !Array.isArray(rawParent)) {
    throw new GitError("EINVAL", "commit-tree parent must be an array of revisions");
  }
  const candidates: readonly unknown[] = rawParent === undefined ? [] : rawParent;
  if (candidates.length > MAX_COMMIT_TREE_PARENTS) {
    throw new GitError("E2BIG", `commit-tree exceeds ${MAX_COMMIT_TREE_PARENTS} parent revisions`);
  }

  let bytes = commitTreeTextBytes(tree, "tree revision");
  let traversals = commitTreeRevisionTraversals(tree);
  bytes = requireCommitTreeInputBytes(bytes, commitTreeTextBytes(message, "message"));
  const parent: string[] = [];
  for (const candidate of candidates) {
    if (typeof candidate !== "string" || candidate === "") {
      throw new GitError("EINVAL", "commit-tree parent revisions must be non-empty strings");
    }
    bytes = requireCommitTreeInputBytes(bytes, commitTreeTextBytes(candidate, "parent revision"));
    traversals += commitTreeRevisionTraversals(candidate);
    if (traversals > MAX_COMMIT_TREE_REVISION_TRAVERSALS) {
      throw new GitError(
        "E2BIG",
        `commit-tree revisions exceed ${MAX_COMMIT_TREE_REVISION_TRAVERSALS} traversal operations`,
      );
    }
    parent.push(candidate);
  }
  if (traversals > MAX_COMMIT_TREE_REVISION_TRAVERSALS) {
    throw new GitError(
      "E2BIG",
      `commit-tree revisions exceed ${MAX_COMMIT_TREE_REVISION_TRAVERSALS} traversal operations`,
    );
  }
  return { tree, message, parent, bytes };
}

function commitTreeRevisionTraversals(expression: string): number {
  let position = expression.length;
  for (let index = 0; index < expression.length; index++) {
    const unit = expression.charCodeAt(index);
    if (unit === 0x5e || unit === 0x7e) {
      position = index;
      break;
    }
  }
  let traversals = 0;
  while (position < expression.length) {
    const operator = expression.charCodeAt(position++);
    if (operator !== 0x5e && operator !== 0x7e) return traversals;
    const digitsStart = position;
    let value = 0;
    while (position < expression.length) {
      const digit = expression.charCodeAt(position) - 0x30;
      if (digit < 0 || digit > 9) break;
      if (value <= MAX_COMMIT_TREE_REVISION_TRAVERSALS) {
        value = value * 10 + digit;
      }
      position++;
    }
    if (operator === 0x5e) traversals++;
    else traversals += digitsStart === position ? 1 : value;
    if (traversals > MAX_COMMIT_TREE_REVISION_TRAVERSALS) return traversals;
  }
  return traversals;
}

function validateCommitIdentities(identities: CommitIdentities): number {
  return requireCommitTreeInputBytes(
    validateCommitPerson(identities.author, "author"),
    validateCommitPerson(identities.committer, "committer"),
  );
}

function validateCommitPerson(person: Person, label: string): number {
  if (typeof person.name !== "string" || typeof person.email !== "string") {
    throw new GitError("EINVAL", `commit-tree ${label} identity is invalid`);
  }
  const name = validateIdentityText(person.name, `${label} name`);
  const email = validateIdentityText(person.email, `${label} email`);
  if (name === 0 || email === 0) {
    throw new GitError("EINVAL", `commit-tree ${label} identity is incomplete`);
  }
  if (!Number.isSafeInteger(person.timestamp) || person.timestamp < 0) {
    throw new GitError("EINVAL", `commit-tree ${label} timestamp is invalid`);
  }
  if (
    !Number.isSafeInteger(person.timezoneOffset) ||
    person.timezoneOffset < -24 * 60 ||
    person.timezoneOffset > 24 * 60
  ) {
    throw new GitError("EINVAL", `commit-tree ${label} timezone is invalid`);
  }
  return requireCommitTreeInputBytes(name, email);
}

function validateIdentityText(value: string, label: string): number {
  return commitTreeTextBytes(
    value,
    label,
    (unit) => unit === 0 || unit === 0x0a || unit === 0x0d || unit === 0x3c || unit === 0x3e,
  );
}

function commitTreeTextBytes(
  value: string,
  label: string,
  forbidden: (unit: number) => boolean = () => false,
): number {
  let bytes = 0;
  for (let index = 0; index < value.length; index++) {
    const unit = value.charCodeAt(index);
    if (forbidden(unit)) {
      throw new GitError("EINVAL", `commit-tree ${label} contains an invalid character`);
    }
    if (unit >= 0xd800 && unit <= 0xdbff) {
      const low = value.charCodeAt(index + 1);
      if (low < 0xdc00 || low > 0xdfff) {
        throw new GitError("EINVAL", `commit-tree ${label} is not canonical UTF-16`);
      }
      index++;
      bytes += 4;
    } else if (unit >= 0xdc00 && unit <= 0xdfff) {
      throw new GitError("EINVAL", `commit-tree ${label} is not canonical UTF-16`);
    } else {
      bytes += unit < 0x80 ? 1 : unit < 0x800 ? 2 : 3;
    }
    if (!Number.isSafeInteger(bytes)) throw new GitError("E2BIG", "commit-tree input overflows");
  }
  return bytes;
}

function requireCommitTreeInputBytes(left: number, right: number): number {
  if (!Number.isSafeInteger(left) || !Number.isSafeInteger(right)) {
    throw new GitError("E2BIG", "commit-tree input byte accounting overflow");
  }
  const bytes = left + right;
  if (!Number.isSafeInteger(bytes)) throw new GitError("E2BIG", "commit-tree input overflows");
  return bytes;
}
