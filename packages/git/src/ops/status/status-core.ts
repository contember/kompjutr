import { isOid } from "../../common/bytes.js";
import { CorruptError } from "../../common/errors.js";
import { comparePaths } from "../../common/streams.js";
import type { GitContext } from "../core/context.js";
import { countAheadBehind } from "../merge/merge-base.js";
import { boundedBranchRef, directRefOid, resolveBranchUpstream } from "../refs/branch-upstream.js";
import type { Repository } from "../repository/repository.js";
import type { Worktree } from "../worktree/worktree.js";
import { applyStatusRenames, fullStatusPrepass, statusStreamInternal } from "./status-full.js";
import type { StatusDetail, StatusOptions } from "./status-rows.js";
import { sparseStatus } from "./status-sparse.js";
import { FullStatusTrackerSeed } from "./status-sparse-tracker.js";
import type { StatusBranch, StatusReport, StatusReportOptions } from "./status-types.js";

const HEADS = "refs/heads/";

export function status(
  repo: Repository,
  worktree: Worktree,
  options: StatusOptions = {},
): StatusDetail[] {
  // Git groups ordinary, untracked, and ignored rows, then path-orders each group.
  return sortStatusDetails([...statusStream(repo, worktree, options)]);
}

function sortStatusDetails(rows: StatusDetail[]): StatusDetail[] {
  return rows.sort((left, right) => {
    const section = statusSection(left) - statusSection(right);
    return section === 0 ? comparePaths(left.path, right.path) : section;
  });
}

function statusSection(row: StatusDetail): number {
  if (row.ignored === true) return 2;
  return row.worktree === "?" ? 1 : 0;
}

/** Eager status plus optional porcelain-v2 branch metadata. */
export function statusReport(
  repo: Repository,
  worktree: Worktree,
  options: StatusReportOptions = {},
): StatusReport {
  const { branch, ...statusOptions } = options;
  const entries = status(repo, worktree, statusOptions);
  return branch === true ? { entries, branch: statusBranch(repo) } : { entries };
}

/** Read and validate HEAD, its configured upstream, and bounded graph counts. */
export function statusBranch(repo: Repository): StatusBranch {
  const rawHead: unknown = repo.checkout.head();
  if (typeof rawHead !== "string") throw new CorruptError("repository HEAD is not text");

  let oid: string | null;
  let head: string | null;
  let headRef: string | undefined;
  if (rawHead.startsWith("ref: ")) {
    const checkedHeadRef = boundedBranchRef(rawHead.slice(5), "status HEAD ref");
    headRef = checkedHeadRef;
    head = checkedHeadRef.slice(HEADS.length);
    oid = directRefOid(repo, checkedHeadRef);
  } else {
    if (!isOid(rawHead)) throw new CorruptError("detached HEAD is not a full object id");
    oid = rawHead;
    head = null;
  }
  if (oid !== null && repo.typeOf(oid) !== "commit") {
    throw new CorruptError("status HEAD does not point to a commit");
  }

  const base: StatusBranch = { oid, head };
  if (headRef === undefined) return base;
  const upstream = resolveBranchUpstream(repo, headRef);
  if (upstream === undefined) return base;
  if (oid === null || upstream.oid === null) return { ...base, upstream: upstream.name };
  const counts = countAheadBehind(repo, { currentOid: oid, incomingOid: upstream.oid });
  return {
    ...base,
    upstream: upstream.name,
    ahead: counts.ahead,
    behind: counts.behind,
  };
}

/** Eager status with an optional same-database sparse fast path. */
export function eagerStatus(
  repo: Repository,
  worktree: Worktree,
  options: StatusOptions,
  context: Pick<GitContext, "sparseWorkspace" | "indexTracker">,
): StatusDetail[] {
  const source = context.sparseWorkspace;
  const tracker = context.indexTracker;
  if (
    source === undefined ||
    tracker === undefined ||
    (options.paths?.length ?? 0) > 0 ||
    (options.excludeRoots?.length ?? 0) > 0
  ) {
    return status(repo, worktree, options);
  }

  const state = source.readState(repo.checkout.checkoutId);
  if (!state.available) {
    const baselineTreeOid = repo.headTree();
    const seed = new FullStatusTrackerSeed();
    const prepass = fullStatusPrepass(repo, baselineTreeOid, options);
    const rows = sortStatusDetails([
      ...applyStatusRenames(
        statusStreamInternal(repo, worktree, options, baselineTreeOid, prepass, seed),
        prepass.renames,
      ),
    ]);
    if (seed.resealable) {
      tracker.reseal(repo.checkout.checkoutId, baselineTreeOid, seed.entries());
    }
    return rows;
  }

  const sparse = sparseStatus(repo, worktree, options, context, state.baselineTreeOid);
  if (sparse === null) return status(repo, worktree, options);
  return sortStatusDetails([...applyStatusRenames(sparse.details, sparse.renames)]);
}

/**
 * The same rows, lazily. HEAD, the index and the working tree are all
 * path-ordered, so one three-way merge answers every path with one item of
 * state per side instead of two maps and a materialised walk.
 *
 * What is still proportional to the repository: tracked path keys and the set
 * of directories that hold something tracked, which `-unormal` collapsing
 * has to know before it can decide. Full index rows remain paged.
 */
export function* statusStream(
  repo: Repository,
  worktree: Worktree,
  options: StatusOptions = {},
): Generator<StatusDetail> {
  const headTreeOid = repo.headTree();
  const prepass = fullStatusPrepass(repo, headTreeOid, options);
  yield* applyStatusRenames(
    statusStreamInternal(repo, worktree, options, headTreeOid, prepass),
    prepass.renames,
  );
}
