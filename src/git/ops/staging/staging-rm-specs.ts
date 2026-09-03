import { GitError } from "../../common/errors.js";
import { indexScanOwned } from "../../store/index.js";
import type { Repository } from "../repository/repository.js";
import {
  boundedRmRows,
  isExcluded,
  requireRmRetained,
  structuralStringBytes,
} from "./staging-rm-support.js";
import type { RmIndexPath, RmSpec, RmSpecIndex } from "./staging-rm-types.js";
import {
  RM_ARRAY_ENTRY_BYTES,
  RM_EXECUTION_HEADROOM_BYTES,
  RM_MAX_PATHSPECS,
  RM_SPEC_FIXED_BYTES,
} from "./staging-rm-types.js";

export function* rmIndexPaths(
  repo: Repository,
  specs: RmSpecIndex,
  excluded: readonly string[],
): Generator<RmIndexPath> {
  let current: RmIndexPath | null = null;
  for (const entry of boundedRmRows(indexScanOwned(repo.checkout), "index")) {
    if (!matchesRmSpecs(specs, entry.path) || isExcluded(entry.path, excluded)) continue;
    if (current === null || current.path !== entry.path) {
      if (current !== null) yield current;
      current = {
        path: entry.path,
        entry: entry.stage === 0 ? entry : undefined,
        conflicted: entry.stage !== 0,
      };
      continue;
    }
    if (entry.stage === 0) current.entry = entry;
    else current.conflicted = true;
  }
  if (current !== null) yield current;
}

export function normalizeRmSpecs(paths: readonly string[]): {
  specs: RmSpec[];
  index: RmSpecIndex;
  retained: number;
} {
  if (paths.length > RM_MAX_PATHSPECS) {
    throw new GitError("E2BIG", `rm pathspec count exceeds ${RM_MAX_PATHSPECS}`);
  }
  const specs: RmSpec[] = [];
  const files = new Map<string, RmSpec>();
  const directories = new Map<string, RmSpec>();
  let retained = RM_EXECUTION_HEADROOM_BYTES;
  for (const raw of paths) {
    let path: string;
    let directoryOnly: boolean;
    path = raw;
    while (path.startsWith("./")) path = path.slice(2);
    directoryOnly = path === "." || path.endsWith("/");
    while (path.endsWith("/")) path = path.slice(0, -1);
    if (path === ".") {
      path = "";
      directoryOnly = true;
    }
    const seen = directoryOnly ? directories : files;
    if (seen.has(path)) continue;
    const additional = RM_SPEC_FIXED_BYTES + RM_ARRAY_ENTRY_BYTES + structuralStringBytes(path);
    requireRmRetained(retained + additional);
    retained += additional;
    const spec: RmSpec = {
      path,
      directoryOnly,
      matched: false,
      directoryMatch: false,
      worktreeDirectory: false,
    };
    seen.set(path, spec);
    specs.push(spec);
  }
  return {
    specs,
    index: { files, directories },
    retained,
  };
}

export function matchesRmSpecs(specs: RmSpecIndex, path: string): boolean {
  return visitMatchingRmSpecs(specs, path, () => {});
}

export function noteRmMatches(specs: RmSpecIndex, path: string, worktreeDirectory: boolean): void {
  visitMatchingRmSpecs(specs, path, (spec) => {
    spec.matched = true;
    if (spec.directoryOnly || path !== spec.path) spec.directoryMatch = true;
    if (!spec.directoryOnly && path === spec.path && worktreeDirectory) {
      spec.worktreeDirectory = true;
    }
  });
}

function visitMatchingRmSpecs(
  specs: RmSpecIndex,
  path: string,
  visit: (spec: RmSpec) => void,
): boolean {
  let matched = false;
  const found = (spec: RmSpec | undefined): void => {
    if (spec === undefined) return;
    matched = true;
    visit(spec);
  };
  found(specs.files.get(""));
  found(specs.directories.get(""));
  found(specs.files.get(path));
  for (let slash = path.indexOf("/"); slash !== -1; slash = path.indexOf("/", slash + 1)) {
    const prefix = path.slice(0, slash);
    found(specs.files.get(prefix));
    found(specs.directories.get(prefix));
  }
  return matched;
}

export function displayRmSpec(spec: RmSpec): string {
  if (spec.path === "") return ".";
  return spec.directoryOnly ? `${spec.path}/` : spec.path;
}

export function rmDirectoryError(spec: RmSpec): GitError {
  return new GitError(
    "EISDIR",
    `not removing '${displayRmSpec(spec)}' recursively without recursive`,
  );
}
