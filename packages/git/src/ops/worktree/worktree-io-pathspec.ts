import { GitError, PathspecNotFoundError } from "../../common/errors.js";
import { comparePaths, lowerBoundPath } from "../../common/paths.js";
import { type CompiledReadPathspec, compileReadPathspec } from "./pathspec.js";

export const MAX_COMPILED_PATHS = 32_768;

export function hasGlobSyntax(path: string): boolean {
  return /[*?[\\]/.test(path);
}

/** One immutable exact/prefix pathspec projection in Git byte order. */
export interface CompiledPathspecMatcher {
  /** Preserve checkout's historical raw-exact and trailing-slash prefix semantics. */
  matches(path: string): boolean;
  /** Preserve the walker's normalized exact semantics for files and symlinks. */
  matchesEntry(path: string): boolean;
  /** Whether the directory itself or any possible descendant can match. */
  includesDirectory(path: string): boolean;
}

class ByteOrderedPathspecMatcher implements CompiledPathspecMatcher {
  readonly #checkoutAll: boolean;
  readonly #walkAll: boolean;
  readonly #exact: string[];
  readonly #checkoutPrefixes: string[];
  readonly #walkPrefixes: string[];
  readonly #glob: CompiledReadPathspec | undefined;

  constructor(paths: readonly string[] | undefined) {
    this.#glob =
      paths?.some(hasGlobSyntax) && !paths.includes("")
        ? compileReadPathspec({ paths })
        : undefined;
    this.#checkoutAll =
      paths === undefined || paths.length === 0 || paths.includes("") || paths.includes(".");
    this.#walkAll =
      this.#checkoutAll ||
      paths?.some((path) => {
        const normalized = path.replace(/\/+$/, "");
        return normalized === "" || normalized === ".";
      }) === true;
    this.#exact = uniqueByteOrdered(paths ?? []);
    this.#checkoutPrefixes = uniqueByteOrdered(
      (paths ?? []).map((path) => path.replace(/\/+$/, "")),
    );
    this.#walkPrefixes = this.#checkoutPrefixes.filter((path) => path !== "" && path !== ".");
  }

  matches(path: string): boolean {
    if (this.#glob !== undefined) return this.#glob.matches(path);
    return (
      this.#checkoutAll ||
      containsByteOrdered(this.#exact, path) ||
      this.#hasPrefix(this.#checkoutPrefixes, path)
    );
  }

  matchesEntry(path: string): boolean {
    if (this.#glob !== undefined) return this.#glob.matches(path);
    return (
      this.#walkAll ||
      containsByteOrdered(this.#walkPrefixes, path) ||
      this.#hasPrefix(this.#walkPrefixes, path)
    );
  }

  includesDirectory(path: string): boolean {
    if (this.#glob !== undefined) return true;
    if (this.#walkAll || this.matchesEntry(path)) return true;
    const prefix = `${path}/`;
    const at = lowerBoundPath(this.#walkPrefixes, prefix);
    return this.#walkPrefixes[at]?.startsWith(prefix) === true;
  }

  #hasPrefix(prefixes: readonly string[], path: string): boolean {
    let slash = path.indexOf("/");
    while (slash >= 0) {
      if (containsByteOrdered(prefixes, path.slice(0, slash))) return true;
      slash = path.indexOf("/", slash + 1);
    }
    return false;
  }
}

/** Compile once when one pathspec list is reused across joins or walks. */
export function compilePathspecs(paths: readonly string[] | undefined): CompiledPathspecMatcher {
  validateCompiledPathspecs(paths);
  return new ByteOrderedPathspecMatcher(paths);
}

/** Fail on the first pathspec that matches no path in any of the sources. */
export function requirePathspecsMatched(
  specs: readonly string[],
  sources: readonly Iterable<{ readonly path: string }>[],
): void {
  const matchers = specs.map((spec) => compilePathspecs([spec]));
  const matched = specs.map(() => false);
  let unmatched = specs.length;
  for (const source of sources) {
    for (const entry of source) {
      for (let index = 0; index < specs.length; index++) {
        if (matched[index] !== true && matchers[index]?.matches(entry.path) === true) {
          matched[index] = true;
          unmatched--;
        }
      }
      if (unmatched === 0) return;
    }
  }
  const first = specs.find((_, index) => matched[index] !== true);
  if (first !== undefined) throw new PathspecNotFoundError(first);
}

function validateCompiledPathspecs(paths: readonly string[] | undefined): void {
  if (paths === undefined) return;
  if (paths.length > MAX_COMPILED_PATHS) {
    throw new GitError("E2BIG", `compiled pathspec exceeds ${MAX_COMPILED_PATHS} paths`);
  }
  for (let index = 0; index < paths.length; index++) {
    const path = paths[index];
    if (path === undefined) throw new GitError("EINVAL", "compiled pathspec is not dense");
  }
}

function uniqueByteOrdered(values: readonly string[]): string[] {
  const ordered = [...values].sort(comparePaths);
  const unique: string[] = [];
  for (const value of ordered) {
    if (unique[unique.length - 1] !== value) unique.push(value);
  }
  return unique;
}

function containsByteOrdered(values: readonly string[], wanted: string): boolean {
  return values[lowerBoundPath(values, wanted)] === wanted;
}
