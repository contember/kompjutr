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
import { gitModeFor, type Worktree } from "../worktree.js";
import { matchesPaths, treeEntries } from "./checkout.js";
import type { DiffSummaryEntry } from "./kinds.js";
import { treeOf } from "./reads.js";
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
  const out: string[] = [];
  for (const change of collect(repo, worktree, options)) {
    const before = change.before;
    const after = change.after;
    const left = before === null ? "/dev/null" : `a/${change.path}`;
    const right = after === null ? "/dev/null" : `b/${change.path}`;

    const header: string[] = [`diff --git a/${change.path} b/${change.path}\n`];
    if (before === null && after !== null) header.push(`new file mode ${after.mode}\n`);
    else if (after === null && before !== null) header.push(`deleted file mode ${before.mode}\n`);
    else if (before !== null && after !== null && before.mode !== after.mode) {
      header.push(`old mode ${before.mode}\n`, `new mode ${after.mode}\n`);
    }

    const oldOid = before?.oid ?? ZERO_OID;
    const newOid = after?.oid ?? ZERO_OID;
    if (oldOid !== newOid) {
      const sameMode = before !== null && after !== null && before.mode === after.mode;
      header.push(
        `index ${oldOid.slice(0, abbrev)}..${newOid.slice(0, abbrev)}` +
          `${sameMode && before !== null ? ` ${before.mode}` : ""}\n`,
      );
    }

    const oldBytes = before === null ? new Uint8Array(0) : before.bytes();
    const newBytes = after === null ? new Uint8Array(0) : after.bytes();
    if (isBinary(oldBytes) || isBinary(newBytes)) {
      out.push(...header, `Binary files ${left} and ${right} differ\n`);
      continue;
    }
    const text = diffText(utf8Decoder.decode(oldBytes), utf8Decoder.decode(newBytes), {
      context: options.context,
    });
    if (text.hunks === "") {
      // A mode change with identical content still gets its header.
      if (header.length > 1) out.push(...header);
      continue;
    }
    out.push(...header, `--- ${left}\n`, `+++ ${right}\n`, text.hunks);
  }
  return out.join("");
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

function collect(repo: Repository, worktree: Worktree, options: DiffOptions): FileChange[] {
  const before = fromTree(repo, resolveFrom(repo, options));
  const after =
    options.to === undefined
      ? fromWorktree(repo, worktree, before, options)
      : fromTree(repo, treeOf(repo, repo.revParse(options.to)));

  const paths = new Set<string>([...before.keys(), ...after.keys()]);
  const changes: FileChange[] = [];
  for (const path of [...paths].sort()) {
    if (!matchesPaths(path, options.paths)) continue;
    const left = before.get(path) ?? null;
    const right = after.get(path) ?? null;
    if (left === null && right === null) continue;
    if (left !== null && right !== null && left.oid === right.oid && left.mode === right.mode) {
      continue;
    }
    changes.push({ path, before: left, after: right });
  }
  return changes;
}

/** The "from" tree: an explicit ref, or HEAD — which may be unborn. */
function resolveFrom(repo: Repository, options: DiffOptions): string | null {
  if (options.ref === undefined) return repo.headTree();
  return treeOf(repo, repo.revParse(options.ref));
}

function fromTree(repo: Repository, tree: string | null): Map<string, Endpoint> {
  const out = new Map<string, Endpoint>();
  for (const entry of treeEntries(repo, tree).values()) {
    if (entry.mode === "160000") continue; // submodules are out of scope
    out.set(entry.path, {
      mode: entry.mode,
      oid: entry.oid,
      bytes: () => repo.readBlob(entry.oid),
    });
  }
  return out;
}

/**
 * The working-tree side. Only paths git would consider — those in the
 * "from" tree or in the index — so an untracked file stays out of the
 * patch, as it does in real `git diff`.
 */
function fromWorktree(
  repo: Repository,
  worktree: Worktree,
  before: Map<string, Endpoint>,
  options: DiffOptions,
): Map<string, Endpoint> {
  const index = new Map<string, IndexEntry>();
  for (const entry of repo.store.indexEntries()) {
    if (entry.stage === 0 && entry.mode !== 0o160000) index.set(entry.path, entry);
  }

  const out = new Map<string, Endpoint>();
  for (const path of new Set<string>([...before.keys(), ...index.keys()])) {
    if (!matchesPaths(path, options.paths)) continue;
    const absolute = joinPath(repo.root, path);
    const stat = worktree.stat(absolute);
    if (stat === null || stat.type === "directory") continue;
    const entry = index.get(path);
    // The index caches the oid alongside the stat that produced it, so an
    // unmodified file never has to be read to be identified.
    const cached = entry !== undefined && indexMatchesStat(entry, stat) ? entry.oid : null;
    const oid = cached ?? hashWorktreePath(repo, worktree, path, { write: false })?.oid;
    if (oid === undefined) continue;
    out.set(path, {
      mode: gitModeFor(stat),
      oid,
      bytes: () => worktreeBytes(worktree, absolute, stat),
    });
  }
  return out;
}
