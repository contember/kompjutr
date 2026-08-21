// Mirrors the legacy compatibility error hierarchy: same class
// names, same `code` values, same messages. `code` is the documented
// contract the CLI dispatcher and external callers branch on.
//
// The classes are re-declared rather than imported from
// the optional compatibility package, so a native workspace never loads
// the isomorphic-git implementation it exists to replace. `instanceof`
// against Computer's classes therefore does not hold; `error.code` does.

export class GitError extends Error {
  readonly code: string;
  constructor(code: string, message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.code = code;
    this.name = "GitError";
  }
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
