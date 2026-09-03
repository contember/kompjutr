import { GitError } from "../common/errors.js";
import { comparePaths } from "../common/streams.js";

export const MAX_COMPILED_PATHS = 32_768;

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

  constructor(paths: readonly string[] | undefined) {
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
    return (
      this.#checkoutAll ||
      containsByteOrdered(this.#exact, path) ||
      this.#hasPrefix(this.#checkoutPrefixes, path)
    );
  }

  matchesEntry(path: string): boolean {
    return (
      this.#walkAll ||
      containsByteOrdered(this.#walkPrefixes, path) ||
      this.#hasPrefix(this.#walkPrefixes, path)
    );
  }

  includesDirectory(path: string): boolean {
    if (this.#walkAll || this.matchesEntry(path)) return true;
    const prefix = `${path}/`;
    const at = lowerBound(this.#walkPrefixes, prefix);
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
  return compilePathspecsOwned(paths);
}

/** Compile a matcher for internal callers. */
export function compilePathspecsOwned(
  paths: readonly string[] | undefined,
): ByteOrderedPathspecMatcher {
  validateCompiledPathspecs(paths);
  return new ByteOrderedPathspecMatcher(paths);
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

function lowerBound(values: readonly string[], wanted: string): number {
  let low = 0;
  let high = values.length;
  while (low < high) {
    const middle = low + Math.floor((high - low) / 2);
    const value = values[middle];
    if (value !== undefined && comparePaths(value, wanted) < 0) low = middle + 1;
    else high = middle;
  }
  return low;
}

function containsByteOrdered(values: readonly string[], wanted: string): boolean {
  return values[lowerBound(values, wanted)] === wanted;
}
