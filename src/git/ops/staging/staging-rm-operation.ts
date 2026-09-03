import { GitError, PathspecNotFoundError } from "../../common/errors.js";
import { joinSorted3 } from "../../common/streams.js";
import { applyIndexOwned } from "../../store/checkout/checkout.js";
import type { Repository } from "../repository/repository.js";
import { treeStream } from "../tree/tree-stream.js";
import type { Worktree } from "../worktree/worktree.js";
import { walkWorktreeEntriesStreamOwned } from "../worktree/worktree-io.js";
import {
  displayRmSpec,
  normalizeRmSpecs,
  noteRmMatches,
  rmDirectoryError,
  rmIndexPaths,
} from "./staging-rm-specs.js";
import {
  boundedRmRows,
  relativeExcludeRoots,
  requireRmRetained,
  structuralStringBytes,
} from "./staging-rm-support.js";
import type { RmCandidate, RmOptions } from "./staging-rm-types.js";
import { RM_CANDIDATE_FIXED_BYTES } from "./staging-rm-types.js";
import {
  absoluteRmPaths,
  identifyRmWorktree,
  physicalRmPaths,
  planRmDirectoryPrune,
  removeRmWorktreePaths,
} from "./staging-rm-worktree.js";

export function runRm(repo: Repository, worktree: Worktree, options: RmOptions): void {
  const normalized = normalizeRmSpecs(options.paths);
  const specs = normalized.specs;
  if (specs.length === 0) return;

  const cached = options.cached === true;
  const force = options.force === true;
  const recursive = options.recursive === true;
  const excluded = relativeExcludeRoots(repo.root, options.excludeRoots);
  const candidates: RmCandidate[] = [];
  const removed = new Set<string>();
  let retained = normalized.retained;

  for (const row of joinSorted3(
    boundedRmRows(treeStream(repo, repo.headTree()), "HEAD"),
    rmIndexPaths(repo, normalized.index, excluded),
    boundedRmRows(
      walkWorktreeEntriesStreamOwned(worktree, repo.root, {
        excludeRoots: options.excludeRoots,
        includeIgnored: true,
        includeDirectories: true,
      }),
      "worktree",
    ),
    { a: (entry) => entry.path, b: (entry) => entry.path, c: (entry) => entry.path },
  )) {
    const selected = row.b;
    if (selected === undefined) continue;
    noteRmMatches(normalized.index, selected.path, row.c?.stat.type === "dir");
    retained +=
      RM_CANDIDATE_FIXED_BYTES +
      structuralStringBytes(selected.path) +
      structuralStringBytes(selected.entry?.oid ?? "") +
      structuralStringBytes(row.a?.oid ?? "") +
      structuralStringBytes(row.c?.stat.target ?? "") +
      (row.c?.stat.contentId?.byteLength ?? 0);
    requireRmRetained(retained);
    removed.add(selected.path);
    candidates.push({
      path: selected.path,
      head: row.a,
      index: selected.entry,
      worktree: row.c,
      conflicted: selected.conflicted,
      worktreeMatchesIndex: false,
    });
  }

  // Git resolves structural and unmatched errors in caller pathspec order.
  for (const spec of specs) {
    if (spec.worktreeDirectory) {
      throw new GitError(
        "EISDIR",
        `tracked file '${displayRmSpec(spec)}' is a directory in the working tree`,
      );
    }
    if (!spec.matched) throw new PathspecNotFoundError(displayRmSpec(spec));
    if (!recursive && spec.directoryMatch) throw rmDirectoryError(spec);
  }
  if (candidates.length === 0) return;

  if (!force) {
    identifyRmWorktree(repo, worktree, candidates);
    for (const candidate of candidates) {
      if (candidate.conflicted) continue;
      const entry = candidate.index;
      if (entry === undefined) {
        throw new GitError("EUNSAFEREMOVE", `cannot prove index state for '${candidate.path}'`);
      }
      const headMatches =
        candidate.head !== undefined &&
        candidate.head.oid === entry.oid &&
        Number.parseInt(candidate.head.mode, 8) === entry.mode;
      const missingWorktree = candidate.worktree === undefined;
      const safe = cached
        ? headMatches || candidate.worktreeMatchesIndex
        : missingWorktree || (headMatches && candidate.worktreeMatchesIndex);
      if (!safe) {
        throw new GitError(
          "EUNSAFEREMOVE",
          `path '${candidate.path}' has staged or working-tree changes`,
        );
      }
    }
  }

  let pruned: string[] = [];
  if (!cached) {
    const planned = planRmDirectoryPrune(
      repo,
      worktree,
      candidates,
      removed,
      options.excludeRoots,
      retained,
    );
    pruned = planned.directories;
    retained = planned.retained;
  }
  requireRmRetained(retained);

  repo.store.db.transactionSync(() => {
    if (!cached) {
      removeRmWorktreePaths(worktree, physicalRmPaths(repo, candidates), false);
      removeRmWorktreePaths(worktree, absoluteRmPaths(repo, pruned), true);
    }
    applyIndexOwned(repo.checkout, (sink) => {
      for (const candidate of candidates) sink.remove(candidate.path);
    });
  });
}
