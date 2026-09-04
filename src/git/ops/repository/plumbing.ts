import { checkoutStoreMutations } from "../../store/core/checkout-mutations-registry.js";
import { sharedRepoStoreMutations, writeObjectsOwned } from "../../store/repository/shared.js";
// Plumbing: hashing bytes, reading raw objects, writing refs, and finding
// the repository a directory belongs to.

import { isOid, utf8 } from "../../common/bytes.js";
import { GitError, ObjectNotFoundError } from "../../common/errors.js";
import { hashObject as hashRaw } from "../../common/objects.js";
import { withGitMutationGuard } from "../../store/core/mutation-guard.js";
import { type IndexEntry, type IndexStore, indexScanOwned } from "../../store/index.js";
import { checkoutTree, indexFromTree } from "../checkout/checkout.js";
import { type GitContext, openRepository } from "../core/context.js";
import { operationRefLogMetadata } from "../core/ref-log.js";
import {
  buildTreeInBatch,
  MAX_TREE_BUILD_LEAF_ENTRIES,
  preflightTreeBuild,
} from "../tree/tree-build.js";
import type { Worktree } from "../worktree/worktree.js";
import { type CatFileResult, catFile as readObject, treeOf } from "./reads.js";
import {
  type Repository,
  readRawRefOwned,
  repositoryMutations,
  resolveHeadOwned,
  symbolicTargetOwned,
} from "./repository.js";

export type { CommitTreeOptions } from "./plumbing-commit-tree.js";
export {
  commitTree,
  commitTreeOwned,
  MAX_COMMIT_TREE_PARENTS,
  MAX_COMMIT_TREE_REVISION_TRAVERSALS,
} from "./plumbing-commit-tree.js";

const READ_TREE_MAX_ROWS_PER_STREAM = 50_000;
const WRITE_TREE_INDEX_PAGE = 2_048;

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

/** @internal Hash or write an object while the caller owns the Git mutation guard. */
export function hashObjectOwned(repo: Repository, options: HashObjectOptions): string {
  const bytes =
    typeof options.content === "string" ? utf8.encode(options.content) : options.content;
  return options.write === true
    ? sharedRepoStoreMutations(repo.store).writeOwned("blob", bytes)
    : hashRaw("blob", bytes);
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
  withGitMutationGuard(repo.checkout.db, () => readTreeOwned(repo, worktree, options, index));
}

/** @internal Replace an index while the caller owns the Git mutation guard. */
export function readTreeOwned(
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
          },
          index,
        );
        return;
      }
      if (index === repo.checkout) {
        checkoutStoreMutations(repo.checkout).indexReplaceOwned(
          boundedReadTreeIndex(repo, treeOid),
        );
      } else {
        index.indexReplace(boundedReadTreeIndex(repo, treeOid));
      }
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
  return withGitMutationGuard(repo.checkout.db, () => writeTreeOwned(repo, index));
}

/** @internal Materialize an index while the caller owns the Git mutation guard. */
export function writeTreeOwned(repo: Repository, index: IndexStore = repo.checkout): string {
  return repo.store.runScratchAwareOperation(() =>
    repo.store.db.transactionSync(() => {
      if (index.hasConflicts()) {
        throw new GitError("EUNMERGED", "cannot write tree: the index has unmerged paths");
      }
      const requiredObjects = new Set<string>();
      const entries = function* (): Generator<IndexEntry> {
        for (const entry of indexScanOwned(index, {
          pageSize: WRITE_TREE_INDEX_PAGE,
        })) {
          if (entry.stage !== 0) {
            throw new GitError("EUNMERGED", "cannot write tree: the index has unmerged paths");
          }
          if (entry.mode !== 0o160000 && !requiredObjects.has(entry.oid)) {
            requiredObjects.add(entry.oid);
          }
          yield entry;
        }
      };
      preflightTreeBuild(entries(), {
        maxEntriesPerTree: MAX_TREE_BUILD_LEAF_ENTRIES,
      });
      const missing = repo.store.missing(requiredObjects);
      if (missing[0] !== undefined) throw new ObjectNotFoundError(missing[0]);
      return writeObjectsOwned(repo.store, (batch) =>
        buildTreeInBatch(batch, indexScanOwned(index, { pageSize: WRITE_TREE_INDEX_PAGE })),
      );
    }),
  );
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
  const raw = readRawRefOwned(repo, ref);
  if (raw === null) return { kind: "absent" };
  const target = symbolicTargetOwned(raw);
  return target === null ? { kind: "direct", oid: raw } : { kind: "symbolic", target };
}

/**
 * `force` gates overwriting an existing ref, which is what
 * isomorphic-git's `writeRef` does and therefore what Computer's callers
 * see today — its doc comment describes a fast-forward check it never
 * performs.
 */
export function updateRefOwned(
  context: GitContext,
  repo: Repository,
  options: UpdateRefOptions,
): void {
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
      repositoryMutations(repo).mutateRefsOwned(
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
    const metadata = operationRefLogMetadata(context, repo, "update-ref");
    repo.typeOf(target);
    repositoryMutations(repo).mutateRefsOwned(
      { puts: [{ name: ref, target }], expected: { name: ref, target: checkedExpected ?? null } },
      metadata,
    );
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
  repositoryMutations(repo).mutateRefsOwned(
    mutation,
    operationRefLogMetadata(context, repo, "update-ref"),
  );
}

/** Apply one public low-level ref mutation under the database-local mutation guard. */
export function updateRef(context: GitContext, repo: Repository, options: UpdateRefOptions): void {
  withGitMutationGuard(repo.checkout.db, () => updateRefOwned(context, repo, options));
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
  return resolveHeadOwned(repo).ref ?? undefined;
}
