// Mirrors the legacy compatibility error hierarchy: same class
// names, same `code` values, same messages. `code` is the documented
// contract the CLI dispatcher and external callers branch on.
//
// The classes are re-declared rather than imported from
// the optional compatibility package, so a native workspace never loads
// the isomorphic-git implementation it exists to replace. `instanceof`
// against Computer's classes therefore does not hold; `error.code` does.

import { GitError } from "@kompjutr/sqlite";

export { GitError } from "@kompjutr/sqlite";

export function hasErrorCode(error: unknown, code: string): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === code;
}

export class NotARepositoryError extends GitError {
  constructor(dir: string, options?: { cause?: unknown }) {
    super("ENOTAREPO", `not a git repository: ${dir}`, options);
    this.name = "NotARepositoryError";
  }
}

export class AlreadyInitializedError extends GitError {
  constructor(dir: string, options?: { cause?: unknown }) {
    super("EALREADYINIT", `git repository already exists at ${dir}`, options);
    this.name = "AlreadyInitializedError";
  }
}

export class MissingIdentityError extends GitError {
  constructor(options?: { cause?: unknown }) {
    super(
      "EIDENTITY",
      "author identity unknown. Pass author, set GIT_AUTHOR_NAME / GIT_AUTHOR_EMAIL, or configure defaultIdentity on the GitClient.",
      options,
    );
    this.name = "MissingIdentityError";
  }
}

export class PathOutsideRepoError extends GitError {
  constructor(path: string, dir: string, options?: { cause?: unknown }) {
    super("EPATHOUTSIDE", `path '${path}' is outside the repository at ${dir}`, options);
    this.name = "PathOutsideRepoError";
  }
}

export class PathspecNotFoundError extends GitError {
  constructor(pathspec: string, options?: { cause?: unknown }) {
    super("EPATHSPEC", `pathspec '${pathspec}' did not match any files`, options);
    this.name = "PathspecNotFoundError";
  }
}

/** An object id that is not in the store. */
export class ObjectNotFoundError extends GitError {
  constructor(oid: string, options?: { cause?: unknown }) {
    super("ENOTFOUND", `object not found: ${oid}`, options);
    this.name = "ObjectNotFoundError";
  }
}

/** Blob bytes intentionally omitted by a partial clone. */
export class PromisedObjectError extends GitError {
  constructor(
    readonly oids: readonly string[],
    options?: { cause?: unknown },
  ) {
    super("EPROMISED", `promised blob content is not present: ${oids.join(", ")}`, options);
    this.name = "PromisedObjectError";
  }
}

/** Recover promised OIDs through operation-specific error wrappers without relying on class identity. */
export function promisedObjectOids(error: unknown, depth = 0): string[] | null {
  if (depth > 4 || typeof error !== "object" || error === null) return null;
  if (hasErrorCode(error, "EPROMISED")) {
    const value = Reflect.get(error, "oids");
    if (!Array.isArray(value)) return null;
    const oids: string[] = [];
    for (const oid of value) {
      if (typeof oid !== "string") return null;
      oids.push(oid);
    }
    return oids;
  }
  return promisedObjectOids(Reflect.get(error, "cause"), depth + 1);
}

/** A ref or revision expression that does not resolve. */
export class RefNotFoundError extends GitError {
  constructor(ref: string, options?: { cause?: unknown }) {
    super("ENOTFOUND", `unknown revision: ${ref}`, options);
    this.name = "RefNotFoundError";
  }
}

/** A malformed object, pack, or wire response. */
export class CorruptError extends GitError {
  constructor(message: string, options?: { cause?: unknown }) {
    super("ECORRUPT", message, options);
    this.name = "CorruptError";
  }
}

/** A method the interface requires but this client does not implement yet. */
export class UnsupportedOperationError extends GitError {
  constructor(operation: string, options?: { cause?: unknown }) {
    super("EUNSUPPORTED", `${operation} is not supported by the SQLite git client yet`, options);
    this.name = "UnsupportedOperationError";
  }
}
