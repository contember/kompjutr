// Plumbing: hashing bytes, reading raw objects, writing refs, and finding
// the repository a directory belongs to.

import type { IndexEntry, IndexStore } from "../../sqlite/store.js";
import { utf8 } from "../bytes.js";
import { type GitContext, openRepository } from "../context.js";
import { GitError } from "../errors.js";
import { hashObject as hashRaw } from "../objects.js";
import type { Repository } from "../repository.js";
import type { Worktree } from "../worktree.js";
import { checkoutTree, indexFromTree } from "./checkout.js";
import { type CatFileResult, catFile as readObject, treeOf } from "./reads.js";
import { operationRefLogMetadata } from "./ref-log.js";

const READ_TREE_MAX_ROWS_PER_STREAM = 50_000;
const READ_TREE_MAX_WRITE_BYTES = 64 * 1024 * 1024;

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

export interface UpdateRefOptions {
  /** Ref to write, e.g. "refs/heads/main" or "HEAD". */
  ref: string;
  /** Oid, or the ref name a symbolic ref should point at. */
  value: string;
  /** Overwrite a ref that already exists. */
  force?: boolean;
  symbolic?: boolean;
}

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
  const raw = ref === "HEAD" ? repo.checkout.head() : repo.store.getRef(ref);
  if (raw === null) return { kind: "absent" };
  if (raw.startsWith("ref: ")) return { kind: "symbolic", target: raw.slice(5) };
  return { kind: "direct", oid: raw };
}

/**
 * `force` gates overwriting an existing ref, which is what
 * isomorphic-git's `writeRef` does and therefore what Computer's callers
 * see today — its doc comment describes a fast-forward check it never
 * performs.
 */
export function updateRef(context: GitContext, repo: Repository, options: UpdateRefOptions): void {
  if (options.force !== true && repo.store.getRef(options.ref) !== null) {
    throw new GitError("EUPDATEREFFAIL", `ref ${options.ref} already exists`);
  }
  const target = options.symbolic === true ? `ref: ${options.value}` : repo.revParse(options.value);
  const mutation =
    options.ref === "HEAD" ? { head: target } : { puts: [{ name: options.ref, target }] };
  repo.mutateRefs(mutation, operationRefLogMetadata(context, repo, "update-ref"));
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
  return repo.head().ref ?? undefined;
}
