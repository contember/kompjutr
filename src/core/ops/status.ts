// `status`, its three formatters, and `clean`.
//
// The cost model is the point: one `treeEntries` walk answers HEAD for
// every path, one `indexEntries` read answers the index, and a file is
// hashed only when the stat data cached in `git_index` no longer holds. A
// repeated status over an untouched tree therefore reads no file content
// at all.

import type { IndexEntry } from "../../sqlite/store.js";
import { ZERO_OID } from "../bytes.js";
import { type IgnoreMatcher, loadIgnoreMatcher } from "../ignore/index.js";
import { joinPath } from "../paths.js";
import type { Repository } from "../repository.js";
import { gitModeFor, type Worktree } from "../worktree.js";
import { matchesPaths, type TargetEntry, treeEntries } from "./checkout.js";
import type { StatusEntry, StatusRow } from "./kinds.js";
import { hashWorktreePath, indexMatchesStat, walkWorktree } from "./worktree-io.js";

/** A mode column in porcelain v2, and the mode of an absent side. */
const ABSENT_MODE = "000000";

/**
 * A `StatusEntry` plus the columns porcelain v2 prints. `status` returns
 * these so the v2 formatter needs no second pass over the repository;
 * anything wanting Computer's narrower shape can use it as-is.
 */
export interface StatusDetail extends StatusEntry {
  /** Mode in HEAD, in the index and on disk; "000000" where absent. */
  headMode: string;
  indexMode: string;
  worktreeMode: string;
  /** Oid in HEAD and in the index; all-zero where absent. */
  headOid: string;
  indexOid: string;
}

export interface StatusOptions {
  /** Restrict to these repo-relative pathspecs: exact or directory prefix. */
  paths?: string[];
  /** Roots of repositories nested inside this one; their files are theirs. */
  excludeRoots?: string[];
  /** Report ignored paths too, as untracked. git's `--ignored`. */
  includeIgnored?: boolean;
  /** Override the ignore rules. Defaults to the working tree's `.gitignore`s. */
  ignores?: IgnoreMatcher;
  /**
   * "normal" (git's default) collapses a wholly untracked directory into
   * one `dir/` entry; "all" lists every file under it.
   */
  untrackedFiles?: "normal" | "all";
}

export function status(
  repo: Repository,
  worktree: Worktree,
  options: StatusOptions = {},
): StatusDetail[] {
  const head = treeEntries(repo, repo.headTree());
  const index = stagedIndex(repo);
  const rows: StatusDetail[] = [];

  const tracked = new Set<string>([...head.keys(), ...index.keys()]);
  for (const path of [...tracked].sort()) {
    if (!matchesPaths(path, options.paths)) continue;
    const row = trackedRow(repo, worktree, path, head.get(path), index.get(path));
    if (row !== null) rows.push(row);
  }

  for (const path of untrackedEntries(repo, worktree, index, options)) {
    rows.push({
      path,
      index: " ",
      worktree: "?",
      headMode: ABSENT_MODE,
      indexMode: ABSENT_MODE,
      worktreeMode: ABSENT_MODE,
      headOid: ZERO_OID,
      indexOid: ZERO_OID,
    });
  }

  // Stable, so a path that is both staged-deleted and untracked keeps the
  // tracked row first, exactly as git orders the two lines.
  return rows.sort((left, right) => (left.path < right.path ? -1 : left.path > right.path ? 1 : 0));
}

function trackedRow(
  repo: Repository,
  worktree: Worktree,
  path: string,
  head: TargetEntry | undefined,
  entry: IndexEntry | undefined,
): StatusDetail | null {
  const headMode = head?.mode ?? ABSENT_MODE;
  const headOid = head?.oid ?? ZERO_OID;
  const indexMode = entry === undefined ? ABSENT_MODE : octalMode(entry.mode);
  const indexOid = entry?.oid ?? ZERO_OID;

  let staged: StatusEntry["index"] = " ";
  if (head === undefined) staged = entry === undefined ? " " : "A";
  else if (entry === undefined) staged = "D";
  else if (head.oid !== entry.oid || head.mode !== indexMode) staged = "M";

  const { code, mode } = worktreeState(repo, worktree, path, entry);
  if (staged === " " && code === " ") return null;
  return {
    path,
    index: staged,
    worktree: code,
    headMode,
    indexMode,
    worktreeMode: mode,
    headOid,
    indexOid,
  };
}

/** The working-tree half of a tracked path, hashing only when it must. */
function worktreeState(
  repo: Repository,
  worktree: Worktree,
  path: string,
  entry: IndexEntry | undefined,
): { code: StatusEntry["worktree"]; mode: string } {
  // Not in the index: the file, if any, shows up as untracked instead.
  if (entry === undefined) return { code: " ", mode: ABSENT_MODE };
  // Submodules are out of scope; nothing on disk describes their state.
  if (entry.mode === 0o160000) return { code: " ", mode: octalMode(entry.mode) };

  const stat = worktree.stat(joinPath(repo.root, path));
  if (stat === null || stat.type === "directory") return { code: "D", mode: ABSENT_MODE };
  const mode = gitModeFor(stat);
  if (indexMatchesStat(entry, stat)) return { code: " ", mode };
  const hashed = hashWorktreePath(repo, worktree, path, { write: false });
  if (hashed === null) return { code: "D", mode: ABSENT_MODE };
  if (hashed.oid !== entry.oid || mode !== octalMode(entry.mode)) return { code: "M", mode };
  return { code: " ", mode };
}

/**
 * Untracked paths, with git's `-unormal` collapsing: a directory holding
 * no tracked path at all is reported as `dir/` rather than file by file.
 */
function untrackedEntries(
  repo: Repository,
  worktree: Worktree,
  index: Map<string, IndexEntry>,
  options: StatusOptions,
): string[] {
  const files = worktreeFiles(repo, worktree, options);
  const collapse = (options.untrackedFiles ?? "normal") === "normal";
  const tracked = trackedDirectories(index);
  const entries = new Set<string>();
  for (const file of files) {
    if (index.has(file)) continue;
    let entry = file;
    if (collapse) {
      const directory = shallowestUntrackedDirectory(file, tracked);
      if (directory !== null && matchesPaths(directory, options.paths)) entry = `${directory}/`;
    }
    // git hides an untracked entry that names an index path — a tracked
    // file replaced by a directory is a deletion, not a new directory.
    if (index.has(stripSlash(entry))) continue;
    entries.add(entry);
  }
  return [...entries].sort();
}

function worktreeFiles(repo: Repository, worktree: Worktree, options: StatusOptions): string[] {
  return walkWorktree(worktree, repo.root, {
    excludeRoots: options.excludeRoots,
    paths: options.paths,
    ignores: options.ignores ?? loadIgnoreMatcher(worktree, repo.root),
    includeIgnored: options.includeIgnored,
  });
}

/** Every directory that has a tracked path somewhere beneath it. */
function trackedDirectories(index: Map<string, IndexEntry>): Set<string> {
  const directories = new Set<string>();
  for (const path of index.keys()) {
    const parts = path.split("/");
    for (let depth = 1; depth < parts.length; depth++)
      directories.add(parts.slice(0, depth).join("/"));
  }
  return directories;
}

function shallowestUntrackedDirectory(file: string, tracked: Set<string>): string | null {
  const parts = file.split("/");
  for (let depth = 1; depth < parts.length; depth++) {
    const directory = parts.slice(0, depth).join("/");
    if (!tracked.has(directory)) return directory;
  }
  return null;
}

function stripSlash(path: string): string {
  return path.endsWith("/") ? path.slice(0, -1) : path;
}

function stagedIndex(repo: Repository): Map<string, IndexEntry> {
  const index = new Map<string, IndexEntry>();
  for (const entry of repo.store.indexEntries()) {
    if (entry.stage === 0) index.set(entry.path, entry);
  }
  return index;
}

function octalMode(mode: number): string {
  return mode.toString(8).padStart(6, "0");
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
  const present = new Set(worktreeFiles(repo, worktree, options));

  const paths = new Set<string>([...head.keys(), ...index.keys(), ...present]);
  const rows: StatusRow[] = [];
  for (const path of [...paths].sort()) {
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

/** `git status --porcelain=v2`. */
export function formatPorcelainV2(entries: StatusDetail[]): string {
  const lines: string[] = [];
  for (const entry of entries) {
    if (entry.worktree === "?") continue;
    lines.push(
      `1 ${v2Code(entry.index)}${v2Code(entry.worktree)} N... ` +
        `${entry.headMode} ${entry.indexMode} ${entry.worktreeMode} ` +
        `${entry.headOid} ${entry.indexOid} ${entry.path}`,
    );
  }
  for (const entry of entries) if (entry.worktree === "?") lines.push(`? ${entry.path}`);
  return join(lines);
}

/** `git status --porcelain=v1`. */
export function formatPorcelainV1(entries: StatusEntry[]): string {
  const lines: string[] = [];
  for (const entry of entries) {
    if (entry.worktree === "?") continue;
    lines.push(`${entry.index}${entry.worktree} ${entry.path}`);
  }
  for (const entry of entries) if (entry.worktree === "?") lines.push(`?? ${entry.path}`);
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
  const collapsed = untrackedEntries(repo, worktree, index, statusOptions);
  if (options.directories !== true) {
    const files = collapsed.filter((entry) => !entry.endsWith("/"));
    return removeAll(repo, worktree, files, options);
  }

  const visible = new Set(worktreeFiles(repo, worktree, statusOptions));
  const everything = walkWorktree(worktree, repo.root, {
    excludeRoots: options.excludeRoots,
    paths: options.paths,
    includeIgnored: true,
  });
  const ignored = everything.filter((path) => !visible.has(path));
  const untracked = [...visible].filter((path) => !index.has(path));
  const entries = collapsed.flatMap((entry) => expandAroundIgnored(entry, untracked, ignored));
  return removeAll(repo, worktree, entries.sort(), options);
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
  for (const path of contents) {
    worktree.unlink(joinPath(repo.root, path));
    const parts = path.split("/");
    for (let depth = 1; depth < parts.length; depth++)
      directories.add(parts.slice(0, depth).join("/"));
  }
  const deepestFirst = [...directories].sort((a, b) => b.split("/").length - a.split("/").length);
  for (const path of deepestFirst) worktree.rmdir(joinPath(repo.root, path));
}
