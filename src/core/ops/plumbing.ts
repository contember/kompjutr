// Plumbing: hashing bytes, reading raw objects, writing refs, and finding
// the repository a directory belongs to.

import { MAX_INDEXED_COMMIT_BYTES } from "../../sqlite/commits.js";
import {
  createRefMutationMemoryOwner,
  type IndexEntry,
  type IndexStore,
  indexScanOwned,
  mutateRefsOwned,
  writeObjectsOwned,
} from "../../sqlite/store.js";
import { isOid, utf8 } from "../bytes.js";
import { type GitContext, type GitIdentity, openRepository } from "../context.js";
import { CorruptError, GitError, ObjectNotFoundError } from "../errors.js";
import { hashObject as hashRaw, type Person } from "../objects.js";
import {
  type Repository,
  readRawRefOwned,
  resolveHeadOwned,
  symbolicTargetOwned,
} from "../repository.js";
import { retainedStringBytes } from "../retained.js";
import type { Worktree } from "../worktree.js";
import { checkoutTree, indexFromTree } from "./checkout.js";
import {
  type CommitIdentities,
  resolveIdentity,
  writeUnpublishedCommitFromTree,
} from "./commit.js";
import { MAX_MERGE_IDENTITY_BYTES, MAX_MERGE_MESSAGE_BYTES } from "./merge-state.js";
import { type CatFileResult, catFile as readObject, treeOf } from "./reads.js";
import { operationRefLogMetadata } from "./ref-log.js";
import {
  buildTreeInBatch,
  MAX_TREE_BUILD_LEAF_ENTRIES,
  MAX_TREE_BUILD_OBJECTS,
  preflightTreeBuild,
} from "./tree-build.js";

const READ_TREE_MAX_ROWS_PER_STREAM = 50_000;
const READ_TREE_MAX_WRITE_BYTES = 64 * 1024 * 1024;
const WRITE_TREE_INDEX_PAGE = 2_048;
export const MAX_COMMIT_TREE_PARENTS = 2;
export const MAX_COMMIT_TREE_REVISION_TRAVERSALS = 8;
export const MAX_COMMIT_TREE_MESSAGE_BYTES = MAX_MERGE_MESSAGE_BYTES;
export const MAX_COMMIT_TREE_INPUT_BYTES = MAX_INDEXED_COMMIT_BYTES;
const COMMIT_TREE_EXECUTION_MEMORY_BYTES = 24 * 1024 * 1024;
const REQUIRED_OBJECTS_FIXED_BYTES = 192;
const REQUIRED_OBJECT_ENTRY_BYTES = 64;

export interface HashObjectOptions {
  content: Uint8Array | string;
  /** Write the blob into the object database. Defaults to false. */
  write?: boolean;
}

export function hashObject(repo: Repository, options: HashObjectOptions): string {
  const bytes =
    typeof options.content === "string" ? utf8.encode(options.content) : options.content;
  return options.write === true ? repo.store.write("blob", bytes) : hashRaw("blob", bytes);
}

export interface CatFileOptions {
  oid: string;
  /** Sub-path inside a tree. The `<oid>:<path>` shorthand works too. */
  filepath?: string;
}

export function catFile(repo: Repository, options: CatFileOptions): CatFileResult {
  return readObject(repo, options.oid, options.filepath);
}

export type ReadTreeOptions =
  | {
      /** Tree-ish to load into the selected index. */
      tree: string;
      empty?: false;
      /** Apply reset-with-update semantics to the working tree too. */
      updateWorktree?: boolean;
    }
  | {
      /** Clear the selected index, like `git read-tree --empty`. */
      empty: true;
      tree?: never;
      updateWorktree?: false;
    };

/** Replace the selected index from one tree-ish, optionally updating the worktree. */
export function readTree(
  repo: Repository,
  worktree: Worktree,
  options: ReadTreeOptions,
  index: IndexStore = repo.checkout,
): void {
  const empty = Reflect.get(options, "empty") === true;
  const tree: unknown = Reflect.get(options, "tree");
  const updateWorktree: unknown = Reflect.get(options, "updateWorktree");
  if (empty === (typeof tree === "string")) {
    throw new GitError("EINVAL", "read-tree requires exactly one tree or empty option");
  }
  if (empty && updateWorktree === true) {
    throw new GitError("EINVAL", "read-tree cannot update the worktree from an empty index");
  }

  repo.store.runScratchAwareOperation(() =>
    repo.store.db.transactionSync(() => {
      const treeOid = empty
        ? null
        : treeOf(repo, repo.revParse(typeof tree === "string" ? tree : ""));
      if (updateWorktree === true) {
        checkoutTree(
          repo,
          worktree,
          treeOid,
          {
            discardUnmerged: true,
            restoreStructure: true,
            maxWorktreeRowsPerPass: READ_TREE_MAX_ROWS_PER_STREAM,
            maxSourceRowsPerPass: READ_TREE_MAX_ROWS_PER_STREAM,
            maxWriteBytes: READ_TREE_MAX_WRITE_BYTES,
          },
          index,
        );
        return;
      }
      index.indexReplace(boundedReadTreeIndex(repo, treeOid));
    }),
  );
}

function* boundedReadTreeIndex(repo: Repository, treeOid: string | null): Generator<IndexEntry> {
  let rows = 0;
  for (const entry of indexFromTree(repo, treeOid)) {
    if (rows >= READ_TREE_MAX_ROWS_PER_STREAM) {
      throw new GitError("E2BIG", `read-tree index exceeds ${READ_TREE_MAX_ROWS_PER_STREAM} rows`);
    }
    rows++;
    yield entry;
  }
}

/** Materialize the selected index as trees without changing refs or worktree state. */
export function writeTree(repo: Repository, index: IndexStore = repo.checkout): string {
  return repo.store.runScratchAwareOperation(() =>
    repo.store.db.transactionSync(() => {
      const reservation = repo.store.reserveMemory();
      try {
        let requiredObjectBytes = REQUIRED_OBJECTS_FIXED_BYTES;
        reservation.set("other", requiredObjectBytes);
        if (index.hasConflicts()) {
          throw new GitError("EUNMERGED", "cannot write tree: the index has unmerged paths");
        }
        const requiredObjects = new Set<string>();
        const entries = function* (): Generator<IndexEntry> {
          for (const entry of indexScanOwned(index, reservation, {
            pageSize: WRITE_TREE_INDEX_PAGE,
          })) {
            if (entry.stage !== 0) {
              throw new GitError("EUNMERGED", "cannot write tree: the index has unmerged paths");
            }
            if (entry.mode !== 0o160000 && !requiredObjects.has(entry.oid)) {
              const next =
                requiredObjectBytes + REQUIRED_OBJECT_ENTRY_BYTES + retainedStringBytes(entry.oid);
              reservation.set("other", next);
              requiredObjects.add(entry.oid);
              requiredObjectBytes = next;
            }
            yield entry;
          }
        };
        preflightTreeBuild(
          entries(),
          {
            maxEntriesPerTree: MAX_TREE_BUILD_LEAF_ENTRIES,
            maxTreeObjects: MAX_TREE_BUILD_OBJECTS,
          },
          reservation,
        );
        const missing = repo.store.missing(requiredObjects);
        if (missing[0] !== undefined) throw new ObjectNotFoundError(missing[0]);
        return writeObjectsOwned(repo.store, reservation, (batch) =>
          buildTreeInBatch(
            batch,
            indexScanOwned(index, reservation, { pageSize: WRITE_TREE_INDEX_PAGE }),
            reservation,
          ),
        );
      } finally {
        reservation.dispose();
      }
    }),
  );
}

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
  return repo.store.runScratchAwareOperation(() => {
    const input = checkCommitTreeInput(options);
    return repo.store.db.transactionSync(() => {
      const reservation = repo.store.reserveMemory();
      try {
        reservation.set("commit", COMMIT_TREE_EXECUTION_MEMORY_BYTES);
        const tree = repo.revParse(input.tree);
        authenticateCommitTreeObject(repo, tree, "tree", reservation);

        const parent: string[] = [];
        const seen = new Set<string>();
        for (const expression of input.parent) {
          const oid = repo.revParse(expression);
          if (seen.has(oid)) continue;
          seen.add(oid);
          authenticateCommitTreeObject(repo, oid, "commit", reservation, MAX_INDEXED_COMMIT_BYTES);
          parent.push(oid);
        }

        const identities = resolveIdentity(
          context,
          repo,
          options,
          undefined,
          MAX_MERGE_IDENTITY_BYTES,
        );
        const identityBytes = validateCommitIdentities(identities);
        requireCommitTreeInputBytes(input.bytes, identityBytes);
        return writeUnpublishedCommitFromTree(repo, tree, {
          message: input.message,
          parent,
          identities,
        });
      } finally {
        reservation.dispose();
      }
    });
  });
}

function authenticateCommitTreeObject(
  repo: Repository,
  oid: string,
  expectedType: "tree" | "commit",
  reservation: ReturnType<Repository["store"]["reserveMemory"]>,
  maxBytes?: number,
): void {
  const info = repo.store.typeAndSize(oid);
  if (info === null) throw new ObjectNotFoundError(oid);
  if (info.type !== expectedType) {
    throw new CorruptError(`${oid} is a ${info.type}, not a ${expectedType}`);
  }
  if (maxBytes !== undefined && info.size > maxBytes) {
    throw new GitError("E2BIG", `${expectedType} ${oid} exceeds ${maxBytes} bytes`);
  }
  if (expectedType === "commit") {
    repo.readAuthenticatedCommit(oid);
    return;
  }
  reservation.set("tree", info.size);
  try {
    if (repo.store.readAuthenticatedObject(oid, expectedType) === null) {
      throw new ObjectNotFoundError(oid);
    }
  } finally {
    reservation.clear("tree");
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

  let bytes = boundedCommitTreeText(tree, "tree revision", MAX_COMMIT_TREE_INPUT_BYTES);
  let traversals = commitTreeRevisionTraversals(tree);
  bytes = requireCommitTreeInputBytes(
    bytes,
    boundedCommitTreeText(message, "message", MAX_COMMIT_TREE_MESSAGE_BYTES),
  );
  const parent: string[] = [];
  for (const candidate of candidates) {
    if (typeof candidate !== "string" || candidate === "") {
      throw new GitError("EINVAL", "commit-tree parent revisions must be non-empty strings");
    }
    bytes = requireCommitTreeInputBytes(
      bytes,
      boundedCommitTreeText(candidate, "parent revision", MAX_COMMIT_TREE_INPUT_BYTES),
    );
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
  return boundedCommitTreeText(
    value,
    label,
    MAX_MERGE_IDENTITY_BYTES,
    (unit) => unit === 0 || unit === 0x0a || unit === 0x0d || unit === 0x3c || unit === 0x3e,
  );
}

function boundedCommitTreeText(
  value: string,
  label: string,
  limit: number,
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
    if (bytes > limit) {
      throw new GitError("E2BIG", `commit-tree ${label} exceeds ${limit} UTF-8 bytes`);
    }
  }
  return bytes;
}

function requireCommitTreeInputBytes(left: number, right: number): number {
  if (!Number.isSafeInteger(left) || !Number.isSafeInteger(right)) {
    throw new GitError("E2BIG", "commit-tree input byte accounting overflow");
  }
  const bytes = left + right;
  if (!Number.isSafeInteger(bytes) || bytes > MAX_COMMIT_TREE_INPUT_BYTES) {
    throw new GitError(
      "E2BIG",
      `commit-tree input exceeds ${MAX_COMMIT_TREE_INPUT_BYTES} UTF-8 bytes`,
    );
  }
  return bytes;
}

export interface UpdateRefWriteOptions {
  /** Ref to write, e.g. "refs/heads/main" or "HEAD". */
  ref: string;
  /** Oid, or the ref name a symbolic ref should point at. */
  value: string;
  /** Overwrite a ref that already exists. */
  force?: boolean;
  symbolic?: boolean;
  delete?: never;
  expected?: never;
}

export interface UpdateRefGuardedOptions {
  /** Full direct `refs/...` name; guarded HEAD and symref writes are invalid. */
  ref: string;
  /** Full oid to store. */
  value: string;
  /** Full raw oid to compare, or null when the ref must be absent. */
  expected: string | null;
  force?: never;
  symbolic?: never;
  delete?: never;
}

export interface UpdateRefDeleteOptions {
  /** Full direct `refs/...` name to delete. */
  ref: string;
  delete: true;
  /** Full raw oid to compare, or null when the ref must be absent. */
  expected?: string | null;
  value?: never;
  force?: never;
  symbolic?: never;
}

export type UpdateRefOptions =
  | UpdateRefWriteOptions
  | UpdateRefGuardedOptions
  | UpdateRefDeleteOptions;

export interface ReadRefOptions {
  /** Exact `HEAD` or full `refs/...` name to read without following it. */
  ref: string;
}

export type RawRefTarget =
  | { kind: "symbolic"; target: string }
  | { kind: "direct"; oid: string }
  | { kind: "absent" };

/** Read one raw ref target without resolving symrefs or checking object existence. */
export function readRef(repo: Repository, options: ReadRefOptions): RawRefTarget {
  const ref = options.ref;
  if (
    typeof ref !== "string" ||
    (ref !== "HEAD" && (!ref.startsWith("refs/") || ref.length === "refs/".length))
  ) {
    throw new GitError("EINVAL", "raw ref name must be HEAD or a full refs/... name");
  }
  const owner = createRefMutationMemoryOwner(repo.store);
  try {
    const raw = readRawRefOwned(repo, ref, owner);
    if (raw === null) return { kind: "absent" };
    const target = symbolicTargetOwned(raw, owner);
    return target === null ? { kind: "direct", oid: raw } : { kind: "symbolic", target };
  } finally {
    owner.dispose();
  }
}

/**
 * `force` gates overwriting an existing ref, which is what
 * isomorphic-git's `writeRef` does and therefore what Computer's callers
 * see today — its doc comment describes a fast-forward check it never
 * performs.
 */
export function updateRef(context: GitContext, repo: Repository, options: UpdateRefOptions): void {
  const deletion: unknown = Reflect.get(options, "delete");
  const expected: unknown = Reflect.get(options, "expected");
  const force: unknown = Reflect.get(options, "force");
  const symbolic: unknown = Reflect.get(options, "symbolic");
  const value: unknown = Reflect.get(options, "value");
  if (deletion !== undefined && deletion !== true) {
    throw new GitError("EINVAL", "update-ref delete must be true when present");
  }
  if (expected !== undefined || deletion === true) {
    const ref = requireDirectUpdateRef(options.ref);
    if (force !== undefined || symbolic !== undefined) {
      throw new GitError("EINVAL", "guarded and delete ref updates reject force and symbolic");
    }
    const checkedExpected =
      expected === undefined ? undefined : expected === null ? null : requireDirectOid(expected);
    if (deletion === true) {
      if (value !== undefined) throw new GitError("EINVAL", "delete ref update rejects value");
      repo.mutateRefs(
        {
          deletes: [ref],
          expected:
            checkedExpected === undefined ? undefined : { name: ref, target: checkedExpected },
        },
        operationRefLogMetadata(context, repo, "update-ref"),
      );
      return;
    }
    const target = requireDirectOid(value);
    const owner = createRefMutationMemoryOwner(repo.store);
    try {
      const metadata = operationRefLogMetadata(context, repo, "update-ref", {}, owner);
      repo.typeOf(target);
      mutateRefsOwned(
        repo.checkout,
        { puts: [{ name: ref, target }], expected: { name: ref, target: checkedExpected ?? null } },
        metadata,
        owner,
      );
    } finally {
      owner.dispose();
    }
    return;
  }
  if (typeof value !== "string") throw new GitError("EINVAL", "update-ref value is required");
  if (force !== undefined && typeof force !== "boolean") {
    throw new GitError("EINVAL", "update-ref force must be boolean");
  }
  if (symbolic !== undefined && typeof symbolic !== "boolean") {
    throw new GitError("EINVAL", "update-ref symbolic must be boolean");
  }
  if (force !== true && repo.store.getRef(options.ref) !== null) {
    throw new GitError("EUPDATEREFFAIL", `ref ${options.ref} already exists`);
  }
  const target = symbolic === true ? `ref: ${value}` : repo.revParse(value);
  if (symbolic !== true) repo.typeOf(target);
  const mutation =
    options.ref === "HEAD" ? { head: target } : { puts: [{ name: options.ref, target }] };
  repo.mutateRefs(mutation, operationRefLogMetadata(context, repo, "update-ref"));
}

function requireDirectUpdateRef(value: unknown): string {
  if (typeof value !== "string" || !value.startsWith("refs/") || value.length === "refs/".length) {
    throw new GitError("EINVAL", "guarded and delete ref updates require a full refs/... name");
  }
  return value;
}

function requireDirectOid(value: unknown): string {
  if (typeof value !== "string" || !isOid(value) || value === "0".repeat(40)) {
    throw new GitError("EINVAL", "guarded ref updates require a non-zero full oid");
  }
  return value;
}

export interface RepoRootOptions {
  dir?: string;
}

/** The root of the repository `dir` belongs to. */
export function repoRoot(context: GitContext, options: RepoRootOptions = {}): string {
  return openRepository(context, options.dir ?? "/").root;
}

/** HEAD's symbolic target, or undefined when HEAD is detached. */
export function symbolicRef(repo: Repository): string | undefined {
  const owner = createRefMutationMemoryOwner(repo.store);
  try {
    return resolveHeadOwned(repo, owner).ref ?? undefined;
  } finally {
    owner.dispose();
  }
}
