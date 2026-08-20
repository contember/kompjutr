// `diff` and `diffSummary`.
//
// Three modes, matching Computer: working tree vs HEAD, working tree vs a
// ref, and a commit pair. The patch text itself comes from
// `src/core/diff/`; this file decides *what* is compared and writes the
// `diff --git` headers around it.

import type { IndexEntry } from "../../sqlite/store.js";
import { utf8Decoder, ZERO_OID } from "../bytes.js";
import { diffText } from "../diff/index.js";
import { isBinary } from "../diff/lines.js";
import { joinPath } from "../paths.js";
import type { Repository } from "../repository.js";
import { joinSorted } from "../streams.js";
import { gitModeFor, type Worktree } from "../worktree.js";
import { matchesPaths, stageZero } from "./checkout.js";
import type { DiffSummaryEntry } from "./kinds.js";
import { treeOf } from "./reads.js";
import { type TargetEntry, treeStream } from "./tree-stream.js";
import { hashWorktreePath, indexMatchesStat, worktreeBytes } from "./worktree-io.js";

/** git's default abbreviation for `index` lines in a small repository. */
const DEFAULT_ABBREV = 7;

export interface DiffOptions {
  /** The "from" side. Defaults to HEAD. */
  ref?: string;
  /** The "to" side. Set it to diff two commits instead of the working tree. */
  to?: string;
  /** Exact-or-directory-prefix path filter. No globs. */
  paths?: string[];
  /** Context lines around each hunk. */
  context?: number;
  /** Length of the abbreviated oids on `index` lines. */
  abbrev?: number;
}

/** One side of a file's change; null means the file is absent there. */
interface Endpoint {
  mode: string;
  oid: string;
  bytes(): Uint8Array;
}

interface FileChange {
  path: string;
  before: Endpoint | null;
  after: Endpoint | null;
}

export function diff(repo: Repository, worktree: Worktree, options: DiffOptions = {}): string {
  const abbrev = options.abbrev ?? DEFAULT_ABBREV;
  // Appended, not collected and joined: the parts array and the joined
  // result are alive at the same instant, so joining doubles the patch.
  let out = "";
  for (const change of collect(repo, worktree, options)) {
    const before = change.before;
    const after = change.after;
    const left = before === null ? "/dev/null" : `a/${change.path}`;
    const right = after === null ? "/dev/null" : `b/${change.path}`;

    let header = `diff --git a/${change.path} b/${change.path}\n`;
    let headerLines = 1;
    if (before === null && after !== null) {
      header += `new file mode ${after.mode}\n`;
      headerLines++;
    } else if (after === null && before !== null) {
      header += `deleted file mode ${before.mode}\n`;
      headerLines++;
    } else if (before !== null && after !== null && before.mode !== after.mode) {
      header += `old mode ${before.mode}\nnew mode ${after.mode}\n`;
      headerLines += 2;
    }

    const oldOid = before?.oid ?? ZERO_OID;
    const newOid = after?.oid ?? ZERO_OID;
    if (oldOid !== newOid) {
      const sameMode = before !== null && after !== null && before.mode === after.mode;
      header +=
        `index ${oldOid.slice(0, abbrev)}..${newOid.slice(0, abbrev)}` +
        `${sameMode && before !== null ? ` ${before.mode}` : ""}\n`;
      headerLines++;
    }

    const oldBytes = before === null ? new Uint8Array(0) : before.bytes();
    const newBytes = after === null ? new Uint8Array(0) : after.bytes();
    if (isBinary(oldBytes) || isBinary(newBytes)) {
      out += `${header}Binary files ${left} and ${right} differ\n`;
      continue;
    }
    const text = diffText(utf8Decoder.decode(oldBytes), utf8Decoder.decode(newBytes), {
      context: options.context,
    });
    if (text.hunks === "") {
      // A mode change with identical content still gets its header.
      if (headerLines > 1) out += header;
      continue;
    }
    out += `${header}--- ${left}\n+++ ${right}\n${text.hunks}`;
  }
  return out;
}

export function diffSummary(
  repo: Repository,
  worktree: Worktree,
  options: DiffOptions = {},
): DiffSummaryEntry[] {
  const out: DiffSummaryEntry[] = [];
  for (const change of collect(repo, worktree, options)) {
    const status = change.before === null ? "A" : change.after === null ? "D" : "M";
    const oldBytes = change.before === null ? new Uint8Array(0) : change.before.bytes();
    const newBytes = change.after === null ? new Uint8Array(0) : change.after.bytes();
    if (isBinary(oldBytes) || isBinary(newBytes)) {
      // git prints "-" for a binary file; there is no line count to give.
      out.push({ path: change.path, status, insertions: 0, deletions: 0 });
      continue;
    }
    const text = diffText(utf8Decoder.decode(oldBytes), utf8Decoder.decode(newBytes));
    out.push({
      path: change.path,
      status,
      insertions: text.insertions,
      deletions: text.deletions,
    });
  }
  return out;
}

/**
 * The changed paths, lazily. Both sides are path-ordered — a tree walk and
 * either another tree walk or the paged index — so a merge join replaces the
 * three maps and the sorted union this used to build.
 */
function* collect(
  repo: Repository,
  worktree: Worktree,
  options: DiffOptions,
): Generator<FileChange> {
  const from = treeStream(repo, resolveFrom(repo, options));
  const byPath = { left: (entry: TargetEntry) => entry.path };

  if (options.to !== undefined) {
    const to = treeStream(repo, treeOf(repo, repo.revParse(options.to)));
    for (const row of joinSorted(from, to, { ...byPath, right: (entry) => entry.path })) {
      if (!matchesPaths(row.path, options.paths)) continue;
      const change = compare(row.path, treeEndpoint(repo, row.left), treeEndpoint(repo, row.right));
      if (change !== null) yield change;
    }
    return;
  }

  // The working-tree side covers only paths git would consider — those in
  // the "from" tree or in the index — so an untracked file stays out of the
  // patch, as it does in real `git diff`.
  for (const row of joinSorted(from, stageZero(repo.store.indexScan()), {
    ...byPath,
    right: (entry) => entry.path,
  })) {
    if (!matchesPaths(row.path, options.paths)) continue;
    const indexed = row.right !== undefined && row.right.mode !== 0o160000 ? row.right : undefined;
    const change = compare(
      row.path,
      treeEndpoint(repo, row.left),
      worktreeEndpoint(repo, worktree, row.path, indexed),
    );
    if (change !== null) yield change;
  }
}

/** A change, or null when the two sides agree or neither exists. */
function compare(path: string, before: Endpoint | null, after: Endpoint | null): FileChange | null {
  if (before === null && after === null) return null;
  if (before !== null && after !== null && before.oid === after.oid && before.mode === after.mode) {
    return null;
  }
  return { path, before, after };
}

function treeEndpoint(repo: Repository, entry: TargetEntry | undefined): Endpoint | null {
  // Submodules are out of scope.
  if (entry === undefined || entry.mode === "160000") return null;
  return { mode: entry.mode, oid: entry.oid, bytes: () => repo.readBlob(entry.oid) };
}

function worktreeEndpoint(
  repo: Repository,
  worktree: Worktree,
  path: string,
  entry: IndexEntry | undefined,
): Endpoint | null {
  const absolute = joinPath(repo.root, path);
  const stat = worktree.stat(absolute);
  if (stat === null || stat.type === "dir") return null;
  // The index caches the oid alongside the stat that produced it, so an
  // unmodified file never has to be read to be identified.
  const cached = entry !== undefined && indexMatchesStat(entry, stat) ? entry.oid : null;
  const oid = cached ?? hashWorktreePath(repo, worktree, path, { write: false })?.oid;
  if (oid === undefined) return null;
  return { mode: gitModeFor(stat), oid, bytes: () => worktreeBytes(worktree, absolute, stat) };
}

/** The "from" tree: an explicit ref, or HEAD — which may be unborn. */
function resolveFrom(repo: Repository, options: DiffOptions): string | null {
  if (options.ref === undefined) return repo.headTree();
  return treeOf(repo, repo.revParse(options.ref));
}
