// Plumbing: hashing bytes, reading raw objects, writing refs, and finding
// the repository a directory belongs to.

import { utf8 } from "../bytes.js";
import { type GitContext, openRepository } from "../context.js";
import { GitError } from "../errors.js";
import { hashObject as hashRaw } from "../objects.js";
import type { Repository } from "../repository.js";
import { type CatFileResult, catFile as readObject } from "./reads.js";
import { operationRefLogMetadata } from "./ref-log.js";

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

export interface UpdateRefOptions {
  /** Ref to write, e.g. "refs/heads/main" or "HEAD". */
  ref: string;
  /** Oid, or the ref name a symbolic ref should point at. */
  value: string;
  /** Overwrite a ref that already exists. */
  force?: boolean;
  symbolic?: boolean;
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
  repo.store.mutateRefs(mutation, operationRefLogMetadata(context, repo, "update-ref"));
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
