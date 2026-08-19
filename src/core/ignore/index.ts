// `.gitignore` handling.
//
// Rules are read from the working tree on demand, one directory at a time,
// and cached for the life of the matcher. A `status` walk therefore reads
// one `.gitignore` per directory it enters, not one per file it sees.
//
// Not modelled: `.git/info/exclude` and `core.excludesFile`. Neither has a
// home in a repository with no `.git` directory; a caller wanting global
// excludes can pass them in.

import { joinPath } from "../paths.js";
import type { Worktree } from "../worktree.js";
import { compilePattern, type IgnorePattern } from "./pattern.js";

export type { IgnorePattern } from "./pattern.js";

export interface IgnoreMatcher {
  /**
   * Is this repo-relative path ignored? `isDirectory` decides whether
   * directory-only patterns apply. A path under an ignored directory is
   * ignored too — git does not descend to look for re-includes.
   */
  ignores(path: string, isDirectory: boolean): boolean;
}

/** Nothing is ignored. For tests and for callers that opt out. */
export const includeEverything: IgnoreMatcher = {
  ignores: () => false,
};

export interface IgnoreOptions {
  /** Extra patterns applied at the repository root, lowest precedence. */
  extra?: string[];
}

export function parseIgnoreFile(contents: string): IgnorePattern[] {
  const patterns: IgnorePattern[] = [];
  for (const line of contents.split("\n")) {
    const compiled = compilePattern(line.replace(/\r$/, ""));
    if (compiled !== null) patterns.push(compiled);
  }
  return patterns;
}

class WorktreeIgnoreMatcher implements IgnoreMatcher {
  /** Directory (repo-relative, "" for the root) to its compiled rules. */
  readonly #rules = new Map<string, IgnorePattern[]>();
  readonly #decisions = new Map<string, boolean>();
  readonly #extra: IgnorePattern[];

  constructor(
    private readonly worktree: Worktree,
    private readonly root: string,
    extra: string[] = [],
  ) {
    this.#extra = extra.length > 0 ? parseIgnoreFile(extra.join("\n")) : [];
  }

  ignores(path: string, isDirectory: boolean): boolean {
    if (path === "") return false;
    const segments = path.split("/");
    let ignored = false;
    for (let depth = 1; depth <= segments.length; depth++) {
      const candidate = segments.slice(0, depth).join("/");
      const candidateIsDirectory = depth < segments.length || isDirectory;
      const decision = this.#decide(candidate, candidateIsDirectory, segments, depth);
      if (decision === null) continue;
      ignored = decision;
      // Once a directory is ignored, nothing inside it can be re-included.
      if (ignored && depth < segments.length) return true;
    }
    return ignored;
  }

  #decide(
    candidate: string,
    isDirectory: boolean,
    segments: string[],
    depth: number,
  ): boolean | null {
    const key = `${candidate}\0${isDirectory ? "d" : "f"}`;
    const cached = this.#decisions.get(key);
    if (cached !== undefined) return cached;

    // Deeper .gitignore files win, so walk from the root down and keep the
    // last match at the deepest level that matched.
    let decision: boolean | null = null;
    for (const pattern of this.#extra) {
      if (pattern.directoryOnly && !isDirectory) continue;
      if (pattern.test(candidate)) decision = !pattern.negated;
    }
    for (let level = 0; level < depth; level++) {
      const directory = segments.slice(0, level).join("/");
      const relative = segments.slice(level, depth).join("/");
      for (const pattern of this.#rulesFor(directory)) {
        if (pattern.directoryOnly && !isDirectory) continue;
        if (!pattern.test(relative)) continue;
        decision = !pattern.negated;
      }
    }
    if (decision !== null) this.#decisions.set(key, decision);
    return decision;
  }

  #rulesFor(directory: string): IgnorePattern[] {
    const cached = this.#rules.get(directory);
    if (cached !== undefined) return cached;
    const absolute = joinPath(this.root, directory === "" ? ".gitignore" : `${directory}/.gitignore`);
    let patterns: IgnorePattern[] = [];
    const stat = this.worktree.stat(absolute);
    if (stat !== null && stat.type === "file") {
      patterns = parseIgnoreFile(new TextDecoder().decode(this.worktree.readFile(absolute)));
    }
    this.#rules.set(directory, patterns);
    return patterns;
  }
}

export function loadIgnoreMatcher(
  worktree: Worktree,
  root: string,
  options: IgnoreOptions = {},
): IgnoreMatcher {
  return new WorktreeIgnoreMatcher(worktree, root, options.extra);
}
