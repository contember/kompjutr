// `status`, its three formatters, and `clean`.
//
// The cost model is the point: one `treeEntries` walk answers HEAD for
// every path, a bounded index prepass answers tracked-directory membership,
// and a paged index stream answers the merge. A file is hashed only when the
// stat data cached in `git_index` no longer holds. A repeated status over an
// untouched tree therefore reads no file content at all.

import type { IndexEntry } from "../../sqlite/store.js";
import { isOid, utf8 } from "../bytes.js";
import type { GitContext } from "../context.js";
import { CorruptError, GitError } from "../errors.js";
import { type IgnoreMatcher, loadIgnoreMatcher } from "../ignore/index.js";
import { joinPath, relativeTo } from "../paths.js";
import { requireBranchRef } from "../protocol/receive-pack.js";
import type { Repository } from "../repository.js";
import { retainedStringBytes } from "../retained.js";
import { comparePaths, joinSorted3 } from "../streams.js";
import type { Worktree } from "../worktree.js";
import { matchesPaths, treeEntries } from "./checkout.js";
import type { StatusEntry, StatusRow } from "./kinds.js";
import { countAheadBehind } from "./merge-base.js";
import {
  type BufferedStatusRow,
  flushStatusRows,
  ignoredRow,
  type StatusDetail,
  type StatusOptions,
  statusIndexGroups,
  trackedRow,
  unmergedRow,
  untrackedRow,
} from "./status-rows.js";
import { FullStatusTrackerSeed, sparseStatus } from "./status-sparse.js";
import { treeStream } from "./tree-stream.js";
import {
  hashWorktreePath,
  indexMatchesStat,
  type WorktreePath,
  walkWorktree,
  walkWorktreeEntriesStream,
  walkWorktreeStream,
} from "./worktree-io.js";

export type { StatusDetail, StatusOptions } from "./status-rows.js";

const HEADS = "refs/heads/";
const STATUS_BRANCH_REF_BYTES = 1_024;
const STATUS_REMOTE_BYTES = 255;
const STATUS_FETCH_BYTES = 2_048;

export interface StatusBranch {
  /** Full commit OID, or null for an unborn branch. */
  oid: string | null;
  /** Checked-out branch name, or null for detached HEAD. */
  head: string | null;
  upstream?: string;
  ahead?: number;
  behind?: number;
}

export interface StatusReport {
  entries: StatusDetail[];
  branch?: StatusBranch;
}

export interface StatusReportOptions extends StatusOptions {
  /** Include porcelain-v2 branch metadata. */
  branch?: boolean;
}

/** Retained index, directory and tracked-path state for one status call. */
export const STATUS_RETAINED_BYTES = 16 * 1024 * 1024;
const STATUS_WINDOW_ROWS = 1000;
const DIRECTORY_FIXED_BYTES = 96;
const SET_ENTRY_BYTES = 48;

interface StatusIndexSnapshot {
  trackedDirs: Set<string>;
  trackedPaths: Set<string>;
  budget: RetainedStatusBudget;
  retainsTrackedPaths: boolean;
}

class RetainedStatusBudget {
  #bytes = 0;

  constructor(private readonly limit: number) {}

  add(bytes: number): void {
    if (bytes > this.limit - this.#bytes) {
      throw new GitError("E2BIG", `status retained state exceeds ${this.limit} bytes`);
    }
    this.#bytes += bytes;
  }
}

export function status(
  repo: Repository,
  worktree: Worktree,
  options: StatusOptions = {},
): StatusDetail[] {
  // Sorted over the rows, which is the output — a collapsed `dir/` entry
  // does not sort where the file that produced it did.
  return [...statusStream(repo, worktree, options)].sort((left, right) =>
    comparePaths(left.path, right.path),
  );
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
  const rawHead: unknown = repo.store.head();
  if (typeof rawHead !== "string") throw new CorruptError("repository HEAD is not text");

  let oid: string | null;
  let head: string | null;
  let headRef: string | undefined;
  if (rawHead.startsWith("ref: ")) {
    headRef = boundedBranchRef(rawHead.slice(5).trim(), "status HEAD ref");
    head = headRef.slice(HEADS.length);
    oid = directRefOid(repo, headRef);
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
  const upstream = statusUpstream(repo, headRef);
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

interface ResolvedStatusUpstream {
  name: string;
  oid: string | null;
}

function statusUpstream(repo: Repository, headRef: string): ResolvedStatusUpstream | undefined {
  const branch = headRef.slice(HEADS.length);
  const remote = repo.store.configGetBounded(`branch.${branch}.remote`, STATUS_REMOTE_BYTES);
  const configuredMerge = repo.store.configGetBounded(
    `branch.${branch}.merge`,
    STATUS_BRANCH_REF_BYTES,
  );
  if (remote === undefined || configuredMerge === undefined) return undefined;
  const mergeRef = boundedBranchRef(configuredMerge, "status upstream ref");
  const upstreamBranch = mergeRef.slice(HEADS.length);

  if (remote === ".") {
    return { name: upstreamBranch, oid: directRefOid(repo, mergeRef) };
  }
  requireStatusRemote(remote);
  const fetch = repo.store.configGetBounded(`remote.${remote}.fetch`, STATUS_FETCH_BYTES);
  const expected = `refs/heads/*:refs/remotes/${remote}/*`;
  if (fetch !== expected && fetch !== `+${expected}`) return undefined;
  const trackingRef = `refs/remotes/${remote}/${upstreamBranch}`;
  return {
    name: `${remote}/${upstreamBranch}`,
    oid: directRefOid(repo, trackingRef),
  };
}

function boundedBranchRef(value: string, label: string): string {
  if (utf8.encode(value).length > STATUS_BRANCH_REF_BYTES) {
    throw new GitError("E2BIG", `${label} exceeds ${STATUS_BRANCH_REF_BYTES} bytes`);
  }
  return requireBranchRef(value.startsWith("refs/") ? value : `${HEADS}${value}`);
}

function requireStatusRemote(remote: string): void {
  if (
    remote.length === 0 ||
    remote.startsWith("/") ||
    remote.endsWith("/") ||
    remote.includes("//") ||
    remote.includes("..") ||
    remote.includes("@{") ||
    remote.includes("\\")
  ) {
    throw new GitError("EINVAL", `invalid status remote ${remote}`);
  }
  for (const character of remote) {
    const code = character.charCodeAt(0);
    if (code <= 0x20 || code === 0x7f || "~^:?*[".includes(character)) {
      throw new GitError("EINVAL", `invalid status remote ${remote}`);
    }
  }
}

function directRefOid(repo: Repository, ref: string): string | null {
  const target: unknown = repo.store.getRef(ref);
  if (target === null) return null;
  if (typeof target !== "string" || !isOid(target)) {
    throw new CorruptError(`status ref ${ref} does not contain a full object id`);
  }
  return target;
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

  const state = source.readState(repo.store.repoId);
  if (!state.available) {
    const baselineTreeOid = repo.headTree();
    const seed = new FullStatusTrackerSeed();
    const rows = [...statusStreamInternal(repo, worktree, options, baselineTreeOid, seed)].sort(
      (left, right) => comparePaths(left.path, right.path),
    );
    if (seed.resealable) {
      tracker.reseal(repo.store.repoId, baselineTreeOid, seed.entries());
    }
    return rows;
  }

  const sparse = sparseStatus(repo, worktree, options, context, state.baselineTreeOid);
  return sparse ?? status(repo, worktree, options);
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
  yield* statusStreamInternal(repo, worktree, options, repo.headTree());
}

function* statusStreamInternal(
  repo: Repository,
  worktree: Worktree,
  options: StatusOptions,
  headTreeOid: string | null,
  seed?: FullStatusTrackerSeed,
): Generator<StatusDetail> {
  const collapse = (options.untrackedFiles ?? "normal") === "normal";
  const excluded = excludedRoots(repo.root, options.excludeRoots);
  const snapshot = snapshotStatusIndex(repo, collapse, collapse || excluded.length > 0);
  const ignores = options.ignores ?? loadIgnoreMatcher(worktree, repo.root);
  const prunable = prunableExcludeRoots(excluded, snapshot.trackedPaths);
  const buffered: BufferedStatusRow[] = [];
  let sourceRows = 0;
  let collapsedIgnored: string | null = null;
  let collapsedUntracked: string | null = null;

  for (const row of joinSorted3(
    treeStream(repo, headTreeOid),
    statusIndexGroups(repo.store.indexScan()),
    worktreeEntries(repo, worktree, options, ignores, prunable),
    { a: (entry) => entry.path, b: (entry) => entry.path, c: (entry) => entry.path },
  )) {
    sourceRows++;
    if (row.a !== undefined || row.b !== undefined) {
      if (snapshot.retainsTrackedPaths) retainTrackedPath(snapshot, row.path);
      const matches = matchesPaths(row.path, options.paths);
      if (matches || seed !== undefined) {
        const detail: BufferedStatusRow | null =
          row.b?.kind === "unmerged"
            ? { kind: "ready", detail: unmergedRow(row.b, row.c) }
            : trackedRow(row.path, row.a, row.b?.entry, row.c);
        if (row.b?.kind === "unmerged") seed?.observeConflict(row.path);
        else seed?.observeTracked(row.a, row.b?.entry, row.c, detail);
        if (matches && detail !== null) buffered.push(detail);
      }
      // A tracked path is never also untracked, whatever is on disk.
    } else if (row.c !== undefined) {
      seed?.observeUntracked(row.path);
      const ignored = ignores.ignores(row.path, false);
      if (isExcluded(row.path, excluded) || (options.includeIgnored !== true && ignored)) {
        if (sourceRows >= STATUS_WINDOW_ROWS) {
          yield* flushStatusRows(repo, worktree, buffered, seed);
          sourceRows = 0;
        }
        continue;
      }
      let path = row.path;
      if (collapse) {
        if (
          (collapsedIgnored !== null && path.startsWith(`${collapsedIgnored}/`)) ||
          (!ignored && collapsedUntracked !== null && path.startsWith(`${collapsedUntracked}/`))
        ) {
          if (sourceRows >= STATUS_WINDOW_ROWS) {
            yield* flushStatusRows(repo, worktree, buffered, seed);
            sourceRows = 0;
          }
          continue;
        }
        const directory = ignored
          ? shallowestIgnoredDirectory(path, snapshot.trackedDirs, ignores)
          : shallowestUntrackedDirectory(path, snapshot.trackedDirs);
        if (directory !== null && matchesPaths(directory, options.paths)) {
          if (ignored) collapsedIgnored = directory;
          else collapsedUntracked = directory;
          path = `${directory}/`;
        }
      }
      if (
        (matchesPaths(path, options.paths) || matchesPaths(row.path, options.paths)) &&
        // A tracked file replaced by a directory is a deletion, not a new directory.
        (!collapse || !snapshot.trackedPaths.has(stripSlash(path)))
      ) {
        buffered.push({ kind: "ready", detail: ignored ? ignoredRow(path) : untrackedRow(path) });
      }
    }

    if (sourceRows >= STATUS_WINDOW_ROWS) {
      yield* flushStatusRows(repo, worktree, buffered, seed);
      sourceRows = 0;
    }
  }
  yield* flushStatusRows(repo, worktree, buffered, seed);
  seed?.finish();
}

function worktreeFiles(
  repo: Repository,
  worktree: Worktree,
  options: StatusOptions,
): Generator<string> {
  return walkWorktreeStream(worktree, repo.root, worktreeWalkOptions(worktree, repo, options));
}

function worktreeEntries(
  repo: Repository,
  worktree: Worktree,
  options: StatusOptions,
  ignores: IgnoreMatcher,
  excludeRoots: string[],
): Generator<WorktreePath> {
  return walkWorktreeEntriesStream(worktree, repo.root, {
    excludeRoots,
    paths: options.paths,
    ignores,
    // Tracked paths remain visible even when a later ignore rule matches.
    includeIgnored: true,
  });
}

interface ExcludedRoot {
  absolute: string;
  relative: string;
}

function excludedRoots(root: string, roots: string[] | undefined): ExcludedRoot[] {
  return (roots ?? []).flatMap((candidate) => {
    const relative = relativeTo(root, candidate);
    return relative === null || relative === "" ? [] : [{ absolute: candidate, relative }];
  });
}

function prunableExcludeRoots(
  roots: readonly ExcludedRoot[],
  trackedPaths: ReadonlySet<string>,
): string[] {
  return roots
    .filter((root) => !hasTrackedPath(root.relative, trackedPaths))
    .map((root) => root.absolute);
}

function hasTrackedPath(root: string, trackedPaths: ReadonlySet<string>): boolean {
  for (const path of trackedPaths) {
    if (path === root || path.startsWith(`${root}/`)) return true;
  }
  return false;
}

function isExcluded(path: string, roots: readonly ExcludedRoot[]): boolean {
  return roots.some((root) => path === root.relative || path.startsWith(`${root.relative}/`));
}

function worktreeWalkOptions(
  worktree: Worktree,
  repo: Repository,
  options: StatusOptions,
): {
  excludeRoots: string[] | undefined;
  paths: string[] | undefined;
  ignores: IgnoreMatcher;
  includeIgnored: boolean | undefined;
} {
  return {
    excludeRoots: options.excludeRoots,
    paths: options.paths,
    ignores: options.ignores ?? loadIgnoreMatcher(worktree, repo.root),
    includeIgnored: options.includeIgnored,
  };
}

/**
 * Snapshot only stage-zero path keys. Normal untracked collapsing needs all
 * tracked directories before the merge reaches its first worktree path.
 */
function snapshotStatusIndex(
  repo: Repository,
  includeDirectories: boolean,
  includeTrackedPaths: boolean,
): StatusIndexSnapshot {
  const budget = new RetainedStatusBudget(STATUS_RETAINED_BYTES);
  const trackedDirs = new Set<string>();
  const trackedPaths = new Set<string>();
  if (!includeDirectories && !includeTrackedPaths) {
    return { trackedDirs, trackedPaths, budget, retainsTrackedPaths: false };
  }
  for (const group of statusIndexGroups(repo.store.indexScan())) {
    const path = group.path;
    if (includeTrackedPaths) {
      budget.add(trackedPathRetainedBytes(path));
      trackedPaths.add(path);
    }
    if (!includeDirectories) continue;
    for (let slash = path.indexOf("/"); slash !== -1; slash = path.indexOf("/", slash + 1)) {
      const directory = path.slice(0, slash);
      if (trackedDirs.has(directory)) continue;
      budget.add(DIRECTORY_FIXED_BYTES + retainedStringBytes(directory));
      trackedDirs.add(directory);
    }
  }
  return { trackedDirs, trackedPaths, budget, retainsTrackedPaths: includeTrackedPaths };
}

function retainTrackedPath(snapshot: StatusIndexSnapshot, path: string): void {
  if (snapshot.trackedPaths.has(path)) return;
  snapshot.budget.add(SET_ENTRY_BYTES + retainedStringBytes(path));
  snapshot.trackedPaths.add(path);
}

/** @internal Charge when one path and all its directory prefixes are new. */
export function statusIndexRetainedBytes(entry: IndexEntry): number {
  let bytes = trackedPathRetainedBytes(entry.path);
  for (
    let slash = entry.path.indexOf("/");
    slash !== -1;
    slash = entry.path.indexOf("/", slash + 1)
  ) {
    bytes += DIRECTORY_FIXED_BYTES + retainedStringBytes(entry.path.slice(0, slash));
  }
  return bytes;
}

function trackedPathRetainedBytes(path: string): number {
  return SET_ENTRY_BYTES + retainedStringBytes(path);
}

function shallowestUntrackedDirectory(file: string, tracked: Set<string>): string | null {
  const parts = file.split("/");
  for (let depth = 1; depth < parts.length; depth++) {
    const directory = parts.slice(0, depth).join("/");
    if (!tracked.has(directory)) return directory;
  }
  return null;
}

function shallowestIgnoredDirectory(
  file: string,
  tracked: Set<string>,
  ignores: IgnoreMatcher,
): string | null {
  const parts = file.split("/");
  for (let depth = 1; depth < parts.length; depth++) {
    const directory = parts.slice(0, depth).join("/");
    if (!tracked.has(directory) && ignores.ignores(directory, true)) return directory;
  }
  return null;
}

function stripSlash(path: string): string {
  return path.endsWith("/") ? path.slice(0, -1) : path;
}

/** O(tracked). Only `statusMatrix`, which is not on the client surface, still needs it. */
function stagedIndex(repo: Repository): Map<string, IndexEntry> {
  const index = new Map<string, IndexEntry>();
  for (const group of statusIndexGroups(repo.store.indexScan())) {
    if (group.kind === "unmerged") {
      throw new GitError("EUNMERGED", `status matrix cannot represent conflict at ${group.path}`);
    }
    index.set(group.path, group.entry);
  }
  return index;
}

// -- the isomorphic-git shape ------------------------------------------

/**
 * isomorphic-git's `statusMatrix`, for callers that already speak it. It
 * lists every file individually — no directory collapsing — and compares
 * content only, so a mode-only change is invisible here.
 */
export function statusMatrix(
  repo: Repository,
  worktree: Worktree,
  options: StatusOptions = {},
): StatusRow[] {
  const head = treeEntries(repo, repo.headTree());
  const index = stagedIndex(repo);
  const present = new Set<string>(worktreeFiles(repo, worktree, options));

  const paths = new Set<string>([...head.keys(), ...index.keys(), ...present]);
  const rows: StatusRow[] = [];
  for (const path of [...paths].sort(comparePaths)) {
    if (!matchesPaths(path, options.paths)) continue;
    const headOid = head.get(path)?.oid ?? null;
    const stageOid = index.get(path)?.oid ?? null;
    const workdirOid = worktreeOid(repo, worktree, path, index.get(path), present.has(path));
    rows.push([
      path,
      headOid === null ? 0 : 1,
      workdirOid === null ? 0 : workdirOid === headOid ? 1 : 2,
      stageOid === null ? 0 : stageOid === headOid ? 1 : stageOid === workdirOid ? 2 : 3,
    ]);
  }
  return rows;
}

function worktreeOid(
  repo: Repository,
  worktree: Worktree,
  path: string,
  entry: IndexEntry | undefined,
  present: boolean,
): string | null {
  if (!present) return null;
  if (entry !== undefined) {
    const stat = worktree.stat(joinPath(repo.root, path));
    if (stat !== null && indexMatchesStat(entry, stat)) return entry.oid;
  }
  return hashWorktreePath(repo, worktree, path, { write: false })?.oid ?? null;
}

// -- formatters --------------------------------------------------------

/** `git status --porcelain=v2`, with optional `--branch` headers. */
export function formatPorcelainV2(entries: StatusDetail[], branch?: StatusBranch): string {
  const lines = branch === undefined ? [] : formatStatusBranch(branch);
  for (const entry of entries) {
    if (entry.ignored === true || entry.worktree === "?") continue;
    if (entry.unmerged === true) {
      lines.push(
        `u ${entry.index}${entry.worktree} N... ` +
          `${entry.baseMode} ${entry.currentMode} ${entry.incomingMode} ${entry.worktreeMode} ` +
          `${entry.baseOid} ${entry.currentOid} ${entry.incomingOid} ${entry.path}`,
      );
      continue;
    }
    lines.push(
      `1 ${v2Code(entry.index)}${v2Code(entry.worktree)} N... ` +
        `${entry.headMode} ${entry.indexMode} ${entry.worktreeMode} ` +
        `${entry.headOid} ${entry.indexOid} ${entry.path}`,
    );
  }
  for (const entry of entries) if (entry.worktree === "?") lines.push(`? ${entry.path}`);
  for (const entry of entries) if (entry.ignored === true) lines.push(`! ${entry.path}`);
  return join(lines);
}

function formatStatusBranch(branch: StatusBranch): string[] {
  const lines = [
    `# branch.oid ${branch.oid ?? "(initial)"}`,
    `# branch.head ${branch.head ?? "(detached)"}`,
  ];
  if (branch.upstream !== undefined) lines.push(`# branch.upstream ${branch.upstream}`);
  if (branch.ahead !== undefined || branch.behind !== undefined) {
    if (
      branch.upstream === undefined ||
      branch.ahead === undefined ||
      branch.behind === undefined
    ) {
      throw new GitError("EINVAL", "status branch counts require an upstream and both counts");
    }
    lines.push(`# branch.ab +${branch.ahead} -${branch.behind}`);
  }
  return lines;
}

/** `git status --porcelain=v1`. */
export function formatPorcelainV1(entries: StatusEntry[]): string {
  const lines: string[] = [];
  for (const entry of entries) {
    if (entry.worktree === "?" || entry.worktree === "!") continue;
    lines.push(`${entry.index}${entry.worktree} ${entry.path}`);
  }
  for (const entry of entries) if (entry.worktree === "?") lines.push(`?? ${entry.path}`);
  for (const entry of entries) if (entry.worktree === "!") lines.push(`!! ${entry.path}`);
  return join(lines);
}

/**
 * `git status --short`. Identical to porcelain v1 over the states this
 * package models — the two differ only on colour, renames and path
 * quoting, none of which are represented in a `StatusEntry`.
 */
export function formatShort(entries: StatusEntry[]): string {
  return formatPorcelainV1(entries);
}

/** Porcelain v2 spells "unmodified" as a dot where v1 uses a space. */
function v2Code(code: string): string {
  return code === " " ? "." : code;
}

function join(lines: string[]): string {
  return lines.length === 0 ? "" : `${lines.join("\n")}\n`;
}

// -- clean -------------------------------------------------------------

export interface CleanOptions {
  paths?: string[];
  excludeRoots?: string[];
  ignores?: IgnoreMatcher;
  /** Descend into untracked directories and remove them whole (`-d`). */
  directories?: boolean;
  /** Report what would go without removing anything (`-n`). */
  dryRun?: boolean;
}

/**
 * Remove untracked paths, returning them as git's `clean -n` names them:
 * a directory removed whole keeps its trailing slash.
 *
 * Ignored files are never touched, and a directory holding one is not
 * removed whole — its untracked contents are removed around it, which is
 * what `git clean -d` does.
 */
export function clean(repo: Repository, worktree: Worktree, options: CleanOptions = {}): string[] {
  const index = stagedIndex(repo);
  const ignores = options.ignores ?? loadIgnoreMatcher(worktree, repo.root);
  const statusOptions: StatusOptions = {
    paths: options.paths,
    excludeRoots: options.excludeRoots,
    ignores,
  };
  const collapsed = untrackedEntries(repo, worktree, statusOptions);
  if (options.directories !== true) {
    const files = collapsed.filter((entry) => !entry.endsWith("/"));
    return removeAll(repo, worktree, files, options);
  }

  const snapshot = snapshotCleanWorktree(repo, worktree, options, ignores);
  const visible = new Set<string>(snapshot.visible);
  const ignored = snapshot.ignored;
  const untracked = [...visible].filter((path) => !index.has(path));
  const directories = cleanableDirectories(snapshot.directories, [
    ...index.keys(),
    ...ignored,
    ...snapshot.protectedDirectories,
  ]);
  const entries = minimalCleanEntries([
    ...collapsed.flatMap((entry) => expandAroundIgnored(entry, untracked, ignored)),
    ...directories.map((path) => `${path}/`),
  ]);
  return removeAll(repo, worktree, entries, options);
}

/** The untracked half of `status`, which is what `clean` acts on. */
function untrackedEntries(repo: Repository, worktree: Worktree, options: StatusOptions): string[] {
  const out: string[] = [];
  for (const row of statusStream(repo, worktree, options)) {
    if (row.worktree === "?") out.push(row.path);
  }
  return out.sort(comparePaths);
}

/**
 * A directory that holds an ignored file cannot go as a unit, so replace
 * it with the entries one level down and try again there.
 */
function expandAroundIgnored(entry: string, untracked: string[], ignored: string[]): string[] {
  if (!entry.endsWith("/")) return [entry];
  const prefix = entry;
  if (!ignored.some((path) => path.startsWith(prefix))) return [entry];
  const children = new Set<string>();
  for (const path of untracked) {
    if (!path.startsWith(prefix)) continue;
    const rest = path.slice(prefix.length);
    const slash = rest.indexOf("/");
    children.add(slash === -1 ? path : `${prefix}${rest.slice(0, slash)}/`);
  }
  return [...children].flatMap((child) => expandAroundIgnored(child, untracked, ignored));
}

interface CleanWorktreeSnapshot {
  visible: string[];
  ignored: string[];
  directories: string[];
  protectedDirectories: string[];
}

/** Classify files and otherwise invisible empty directories in one paged traversal. */
function snapshotCleanWorktree(
  repo: Repository,
  worktree: Worktree,
  options: CleanOptions,
  ignores: IgnoreMatcher,
): CleanWorktreeSnapshot {
  const excluded = excludedRoots(repo.root, options.excludeRoots);
  const visible: string[] = [];
  const ignored: string[] = [];
  const directories: string[] = [];
  const protectedDirectories = excluded.map((root) => root.relative);
  let retainedBytes = 0;
  const retain = (path: string): void => {
    retainedBytes += DIRECTORY_FIXED_BYTES + retainedStringBytes(path);
    if (retainedBytes > STATUS_RETAINED_BYTES) {
      throw new GitError("E2BIG", `clean retained state exceeds ${STATUS_RETAINED_BYTES} bytes`);
    }
  };
  for (const path of protectedDirectories) retain(path);

  const root = worktree.realpath(repo.root);
  let ignoredRoot: string | null = null;
  let after: string | undefined;
  while (true) {
    const page = worktree.scan(root, { after, limit: STATUS_WINDOW_ROWS });
    if (page.length === 0) break;
    for (const entry of page) {
      const path = relativeTo(root, entry.path);
      if (path === null || path === "") continue;
      if (ignoredRoot !== null && !path.startsWith(`${ignoredRoot}/`)) ignoredRoot = null;
      if (isExcluded(path, excluded)) continue;
      if (entry.type === "dir") {
        if (ignoredRoot !== null) continue;
        if (ignores.ignores(path, true)) {
          retain(path);
          ignored.push(path);
          protectedDirectories.push(path);
          ignoredRoot = path;
          continue;
        }
        if (!matchesPaths(path, options.paths)) continue;
        retain(path);
        directories.push(path);
        continue;
      }
      if (ignoredRoot !== null || !matchesPaths(path, options.paths)) continue;
      retain(path);
      if (ignores.ignores(path, false)) ignored.push(path);
      else visible.push(path);
    }
    const tail = page[page.length - 1];
    if (tail === undefined || page.length < STATUS_WINDOW_ROWS) break;
    after = tail.path;
  }
  return { visible, ignored, directories, protectedDirectories };
}

/** Include empty directories that status cannot report because Git tracks no directories. */
function cleanableDirectories(directories: string[], protectedPaths: string[]): string[] {
  const protectedDirectories = new Set<string>();
  let retainedBytes = 0;
  const protect = (path: string): void => {
    for (let slash = path.indexOf("/"); slash !== -1; slash = path.indexOf("/", slash + 1)) {
      const directory = path.slice(0, slash);
      if (protectedDirectories.has(directory)) continue;
      retainedBytes += DIRECTORY_FIXED_BYTES + retainedStringBytes(directory);
      if (retainedBytes > STATUS_RETAINED_BYTES) {
        throw new GitError("E2BIG", `clean retained state exceeds ${STATUS_RETAINED_BYTES} bytes`);
      }
      protectedDirectories.add(directory);
    }
    if (!protectedDirectories.has(path)) {
      retainedBytes += DIRECTORY_FIXED_BYTES + retainedStringBytes(path);
      if (retainedBytes > STATUS_RETAINED_BYTES) {
        throw new GitError("E2BIG", `clean retained state exceeds ${STATUS_RETAINED_BYTES} bytes`);
      }
      protectedDirectories.add(path);
    }
  };
  for (const path of protectedPaths) protect(path);
  return directories.filter((path) => !protectedDirectories.has(path));
}

function minimalCleanEntries(entries: string[]): string[] {
  const sorted = entries.sort(comparePaths);
  const out: string[] = [];
  let directory: string | null = null;
  for (const entry of sorted) {
    if (directory !== null && entry.startsWith(directory)) continue;
    const previous = out[out.length - 1];
    if (entry === previous) continue;
    out.push(entry);
    directory = entry.endsWith("/") ? entry : null;
  }
  return out;
}

function removeAll(
  repo: Repository,
  worktree: Worktree,
  entries: string[],
  options: CleanOptions,
): string[] {
  if (options.dryRun === true) return entries;
  for (const entry of entries) {
    if (entry.endsWith("/")) removeDirectory(repo, worktree, stripSlash(entry));
    else worktree.unlink(joinPath(repo.root, entry));
  }
  return entries;
}

function removeDirectory(repo: Repository, worktree: Worktree, directory: string): void {
  const contents = walkWorktree(worktree, repo.root, {
    paths: [directory],
    includeIgnored: true,
  });
  const directories = new Set<string>([directory]);
  const rootDepth = directory.split("/").length;
  for (const path of contents) {
    worktree.unlink(joinPath(repo.root, path));
    const parts = path.split("/");
    for (let depth = rootDepth; depth < parts.length; depth++)
      directories.add(parts.slice(0, depth).join("/"));
  }
  const deepestFirst = [...directories].sort((a, b) => {
    const depth = b.split("/").length - a.split("/").length;
    return depth === 0 ? comparePaths(a, b) : depth;
  });
  for (const path of deepestFirst) worktree.rmdir(joinPath(repo.root, path));
}
