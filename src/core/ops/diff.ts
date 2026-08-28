// `diff` and `diffSummary`.
//
// Three modes, matching Computer: working tree vs HEAD, working tree vs a
// ref, and a commit pair. The patch text itself comes from
// `src/core/diff/`; this file decides *what* is compared and writes the
// `diff --git` headers around it.

import type { BlobIdMapping, BlobReadBatch, IndexEntry } from "../../sqlite/store.js";
import { utf8, utf8Decoder, ZERO_OID } from "../bytes.js";
import { diffText } from "../diff/index.js";
import { isBinary } from "../diff/lines.js";
import { CorruptError, GitError } from "../errors.js";
import { joinPath } from "../paths.js";
import type { Repository } from "../repository.js";
import type { SparseWorkspaceSource } from "../sparse-workspace.js";
import { joinSorted, joinSorted3 } from "../streams.js";
import { gitModeFor, type Worktree } from "../worktree.js";
import { matchesPaths, stageZero } from "./checkout.js";
import {
  compareIdentities,
  type DiffOptions,
  type EndpointIdentity,
  type PendingChange,
  treeIdentity,
  type WorkingCandidate,
} from "./diff-internal.js";
import type { DiffSummaryEntry } from "./kinds.js";
import {
  type ExactRename,
  type ExactRenameClassification,
  ExactRenameClassifier,
  renameDetectionEnabled,
} from "./rename-detection.js";
import { sparseCommitPair, sparseWorkingCandidates } from "./sparse-diff.js";
import { type TargetEntry, treeStream } from "./tree-stream.js";
import {
  hashExactWorktreePaths,
  hashWorktreePaths,
  indexMatchesStat,
  type WorktreePath,
  walkWorktreeEntriesStream,
} from "./worktree-io.js";

/** git's default abbreviation for `index` lines in a small repository. */
const DEFAULT_ABBREV = 7;
const DIFF_WINDOW_ROWS = 1000;
const DIFF_REPOSITORY_BYTES = 8 * 1024 * 1024;
const DIFF_WORKTREE_BYTES = 8 * 1024 * 1024;
const DIFF_PATH_BYTES = 2_200;

export type { DiffOptions } from "./diff-internal.js";

export interface DiffFormatOptions {
  /** Apply Git's C-style path quoting in patch headers. */
  quotePaths?: boolean;
  /** Escape non-ASCII UTF-8 bytes as octal when paths are quoted. */
  quoteNonAscii?: boolean;
  /** Compare the index to the worktree, as plain `git diff` does. */
  indexBase?: boolean;
  /** Bound rendered UTF-8 bytes before appending them. */
  maxOutputBytes?: number;
}

/** One side of a file's change; null means the file is absent there. */
interface Endpoint {
  mode: string;
  oid: string;
  bytes: Uint8Array | null;
}

interface FileChange {
  path: string;
  originalPath?: string;
  similarity?: 100;
  before: Endpoint | null;
  after: Endpoint | null;
}

export function diff(
  repo: Repository,
  worktree: Worktree,
  options: DiffOptions = {},
  sparseWorkspace?: SparseWorkspaceSource,
  formatOptions: DiffFormatOptions = {},
): string {
  const abbrev = options.abbrev ?? DEFAULT_ABBREV;
  const out = new DiffOutput(formatOptions.maxOutputBytes);
  for (const change of collect(
    repo,
    worktree,
    options,
    sparseWorkspace,
    formatOptions.indexBase === true,
  )) {
    const before = change.before;
    const after = change.after;
    if (
      change.originalPath !== undefined &&
      change.similarity !== undefined &&
      before !== null &&
      after !== null
    ) {
      let header =
        `diff --git ${diffHeaderPath(change.originalPath, "a/", formatOptions)} ` +
        `${diffHeaderPath(change.path, "b/", formatOptions)}\n`;
      if (before.mode !== after.mode) {
        header += `old mode ${before.mode}\nnew mode ${after.mode}\n`;
      }
      out.append(header);
      out.append(`similarity index ${change.similarity}%\n`);
      out.append(`rename from ${diffHeaderPath(change.originalPath, "", formatOptions)}\n`);
      out.append(`rename to ${diffHeaderPath(change.path, "", formatOptions)}\n`);
      continue;
    }
    const left = before === null ? "/dev/null" : diffHeaderPath(change.path, "a/", formatOptions);
    const right = after === null ? "/dev/null" : diffHeaderPath(change.path, "b/", formatOptions);

    let header =
      `diff --git ${diffHeaderPath(change.path, "a/", formatOptions)} ` +
      `${diffHeaderPath(change.path, "b/", formatOptions)}\n`;
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

    if (oldOid === newOid) {
      if (headerLines > 1) out.append(header);
      continue;
    }
    const oldBytes = before === null ? new Uint8Array(0) : endpointBytes(before);
    const newBytes = after === null ? new Uint8Array(0) : endpointBytes(after);
    if (isBinary(oldBytes) || isBinary(newBytes)) {
      out.append(header);
      out.append(`Binary files ${left} and ${right} differ\n`);
      continue;
    }
    const text = diffText(utf8Decoder.decode(oldBytes), utf8Decoder.decode(newBytes), {
      context: options.context,
    });
    if (text.hunks === "") {
      continue;
    }
    out.append(header);
    out.append(`--- ${left}\n`);
    out.append(`+++ ${right}\n`);
    out.append(text.hunks);
  }
  return out.finish();
}

class DiffOutput {
  #bytes = 0;
  #output = "";

  constructor(private readonly maximum: number | undefined) {
    if (maximum !== undefined && (!Number.isSafeInteger(maximum) || maximum < 0)) {
      throw new GitError("EINVAL", "diff output ceiling must be a non-negative safe integer");
    }
  }

  append(value: string): void {
    if (value === "") return;
    if (this.maximum !== undefined) {
      const bytes = diffUtf8Bytes(value);
      if (bytes > this.maximum - this.#bytes) {
        throw new GitError("E2BIG", `diff output exceeds ${this.maximum} UTF-8 bytes`);
      }
      this.#bytes += bytes;
    }
    this.#output += value;
  }

  finish(): string {
    return this.#output;
  }
}

function diffUtf8Bytes(value: string): number {
  let bytes = 0;
  for (let index = 0; index < value.length; index++) {
    const code = value.charCodeAt(index);
    if (code >= 0xd800 && code <= 0xdbff) {
      const low = value.charCodeAt(index + 1);
      if (low < 0xdc00 || low > 0xdfff) {
        throw new GitError("EINVAL", "diff output must be well-formed UTF-16");
      }
      index++;
      bytes += 4;
    } else if (code >= 0xdc00 && code <= 0xdfff) {
      throw new GitError("EINVAL", "diff output must be well-formed UTF-16");
    } else {
      bytes += code < 0x80 ? 1 : code < 0x800 ? 2 : 3;
    }
    if (!Number.isSafeInteger(bytes)) throw new GitError("E2BIG", "diff output is too large");
  }
  return bytes;
}

/** Format one already-bounded repository path for a Git patch header. */
export function diffHeaderPath(
  path: string,
  prefix: "" | "a/" | "b/",
  options: DiffFormatOptions,
): string {
  if (options.quotePaths !== true) return `${prefix}${path}`;
  const quoteNonAscii = options.quoteNonAscii ?? true;
  if (typeof quoteNonAscii !== "boolean") {
    throw new GitError("EINVAL", "diff quoteNonAscii must be a boolean");
  }
  validateDiffPath(path);
  return quoteNonAscii ? quoteDiffUtf8(`${prefix}${path}`) : quoteDiffUnicode(`${prefix}${path}`);
}

function validateDiffPath(path: string): void {
  let bytes = 0;
  for (let index = 0; index < path.length; index++) {
    const code = path.charCodeAt(index);
    if (code === 0) throw new GitError("EINVAL", "diff path must not contain NUL");
    if (code >= 0xd800 && code <= 0xdbff) {
      const low = path.charCodeAt(index + 1);
      if (low < 0xdc00 || low > 0xdfff) {
        throw new GitError("EINVAL", "diff path must be well-formed UTF-16");
      }
      index++;
      bytes += 4;
    } else if (code >= 0xdc00 && code <= 0xdfff) {
      throw new GitError("EINVAL", "diff path must be well-formed UTF-16");
    } else {
      bytes += code < 0x80 ? 1 : code < 0x800 ? 2 : 3;
    }
    if (bytes > DIFF_PATH_BYTES) {
      throw new GitError("E2BIG", `diff path exceeds ${DIFF_PATH_BYTES} UTF-8 bytes`);
    }
  }
}

function quoteDiffUtf8(path: string): string {
  let quoted = false;
  let output = "";
  for (const byte of utf8.encode(path)) {
    const escaped = escapeDiffByte(byte);
    if (escaped !== null) {
      quoted = true;
      output += escaped;
    } else if (byte >= 0x80) {
      quoted = true;
      output += octalByte(byte);
    } else {
      output += String.fromCharCode(byte);
    }
  }
  return quoted ? `"${output}"` : output;
}

function quoteDiffUnicode(path: string): string {
  let quoted = false;
  let output = "";
  for (const character of path) {
    const code = character.codePointAt(0);
    if (code === undefined) throw new GitError("ECORRUPT", "diff path contains no code point");
    const escaped = code < 0x80 ? escapeDiffByte(code) : null;
    if (escaped === null) output += character;
    else {
      quoted = true;
      output += escaped;
    }
  }
  return quoted ? `"${output}"` : output;
}

function escapeDiffByte(byte: number): string | null {
  if (byte === 0x07) return "\\a";
  if (byte === 0x08) return "\\b";
  if (byte === 0x09) return "\\t";
  if (byte === 0x0a) return "\\n";
  if (byte === 0x0b) return "\\v";
  if (byte === 0x0c) return "\\f";
  if (byte === 0x0d) return "\\r";
  if (byte === 0x22) return '\\"';
  if (byte === 0x5c) return "\\\\";
  if (byte < 0x20 || byte === 0x7f) return octalByte(byte);
  return null;
}

function octalByte(byte: number): string {
  return `\\${byte.toString(8).padStart(3, "0")}`;
}

export function diffSummary(
  repo: Repository,
  worktree: Worktree,
  options: DiffOptions = {},
  sparseWorkspace?: SparseWorkspaceSource,
): DiffSummaryEntry[] {
  const out: DiffSummaryEntry[] = [];
  for (const change of collect(repo, worktree, options, sparseWorkspace)) {
    if (change.originalPath !== undefined && change.similarity !== undefined) {
      out.push({
        path: change.path,
        originalPath: change.originalPath,
        similarity: change.similarity,
        status: "R",
        insertions: 0,
        deletions: 0,
      });
      continue;
    }
    const status = change.before === null ? "A" : change.after === null ? "D" : "M";
    if (change.before?.oid === change.after?.oid) {
      out.push({ path: change.path, status, insertions: 0, deletions: 0 });
      continue;
    }
    const oldBytes = change.before === null ? new Uint8Array(0) : endpointBytes(change.before);
    const newBytes = change.after === null ? new Uint8Array(0) : endpointBytes(change.after);
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
  sparseWorkspace: SparseWorkspaceSource | undefined,
  indexBase = false,
): Generator<FileChange> {
  const sparse = indexBase
    ? null
    : boundedSparsePendingChanges(repo, worktree, options, sparseWorkspace);
  if (sparse !== null) {
    yield* collectPendingChanges(
      repo,
      worktree,
      sparse,
      classifyDiffRenames(repo, options, sparse),
    );
    return;
  }
  const classification = classifyDiffRenames(
    repo,
    options,
    pendingChanges(repo, worktree, options, true, indexBase),
  );
  yield* collectPendingChanges(
    repo,
    worktree,
    pendingChanges(repo, worktree, options, false, indexBase),
    classification,
  );
}

function* collectPendingChanges(
  repo: Repository,
  worktree: Worktree,
  changes: Iterable<PendingChange>,
  classification: ExactRenameClassification | undefined,
): Generator<FileChange> {
  const sources =
    classification?.kind === "classified"
      ? new Set(classification.renames.map((rename) => rename.source.path))
      : new Set<string>();
  const destinations =
    classification?.kind === "classified"
      ? new Map(classification.renames.map((rename) => [rename.destination.path, rename]))
      : new Map<string, ExactRename>();
  const pending: PendingChange[] = [];
  for (const change of changes) {
    if (sources.has(change.path)) continue;
    const rename = destinations.get(change.path);
    if (rename !== undefined) {
      yield* hydrateChanges(repo, worktree, pending);
      yield exactRenameChange(rename, change);
      continue;
    }
    pending.push(change);
    if (pending.length >= DIFF_WINDOW_ROWS) yield* hydrateChanges(repo, worktree, pending);
  }
  yield* hydrateChanges(repo, worktree, pending);
}

function classifyDiffRenames(
  repo: Repository,
  options: DiffOptions,
  changes: Iterable<PendingChange>,
): ExactRenameClassification | undefined {
  if (!renameDetectionEnabled(repo, "diff", options.renames)) return undefined;
  const classifier = new ExactRenameClassifier();
  for (const change of changes) {
    let retained = true;
    if (change.before !== null && change.after === null) {
      retained = classifier.addSource({
        path: change.path,
        mode: change.before.mode,
        oid: change.before.oid,
      });
    } else if (change.before === null && change.after !== null) {
      retained = classifier.addDestination({
        path: change.path,
        mode: change.after.mode,
        oid: change.after.oid,
      });
    }
    if (!retained) break;
  }
  return classifier.finish();
}

function boundedSparsePendingChanges(
  repo: Repository,
  worktree: Worktree,
  options: DiffOptions,
  sparseWorkspace: SparseWorkspaceSource | undefined,
): PendingChange[] | null {
  const fromTreeOid = resolveFrom(repo, options);
  if (options.to !== undefined) {
    return sparseCommitPair(repo, fromTreeOid, repo.resolveTreeRevision(options.to), options);
  }
  if (sparseWorkspace === undefined) return null;
  const candidates = sparseWorkingCandidates(repo, sparseWorkspace, fromTreeOid, options);
  if (candidates === null) return null;
  return [...resolveWorkingCandidateIdentities(repo, worktree, candidates, true)];
}

function* pendingChanges(
  repo: Repository,
  worktree: Worktree,
  options: DiffOptions,
  renameCandidatesOnly = false,
  indexBase = false,
): Generator<PendingChange> {
  if (indexBase) {
    yield* indexWorktreeChanges(repo, worktree, options, renameCandidatesOnly);
    return;
  }
  const fromTreeOid = resolveFrom(repo, options);
  const byPath = { left: (entry: TargetEntry) => entry.path };

  if (options.to !== undefined) {
    const toTreeOid = repo.resolveTreeRevision(options.to);
    const from = treeStream(repo, fromTreeOid);
    const to = treeStream(repo, toTreeOid);
    for (const row of joinSorted(from, to, { ...byPath, right: (entry) => entry.path })) {
      if (!matchesPaths(row.path, options.paths)) continue;
      const change = compareIdentities(row.path, treeIdentity(row.left), treeIdentity(row.right));
      if (
        change !== null &&
        (!renameCandidatesOnly || (change.before === null) !== (change.after === null))
      ) {
        yield change;
      }
    }
    return;
  }

  // The working-tree side covers only paths git would consider — those in
  // the "from" tree or in the index — so an untracked file stays out of the
  // patch, as it does in real `git diff`.
  const from = treeStream(repo, fromTreeOid);
  const candidates: WorkingCandidate[] = [];
  for (const row of joinSorted3(
    from,
    stageZero(repo.checkout.indexScan()),
    walkWorktreeEntriesStream(
      worktree,
      repo.root,
      options.paths === undefined || options.paths.length === 0
        ? { filesOnly: true }
        : { paths: options.paths },
    ),
    {
      a: (entry) => entry.path,
      b: (entry) => entry.path,
      c: (entry) => entry.path,
    },
  )) {
    if (!matchesPaths(row.path, options.paths)) continue;
    if (row.a === undefined && row.b === undefined) continue;
    const worktreePresent = row.c !== undefined && row.c.stat.type !== "dir";
    if (renameCandidatesOnly && (row.a === undefined) === !worktreePresent) continue;
    candidates.push({
      path: row.path,
      before: row.a,
      index: row.b !== undefined && row.b.mode !== 0o160000 ? row.b : undefined,
      worktree: row.c,
    });
    if (candidates.length >= DIFF_WINDOW_ROWS) {
      yield* resolveWorkingCandidateIdentities(
        repo,
        worktree,
        candidates,
        false,
        renameCandidatesOnly,
      );
    }
  }
  yield* resolveWorkingCandidateIdentities(repo, worktree, candidates, false, renameCandidatesOnly);
}

function* indexWorktreeChanges(
  repo: Repository,
  worktree: Worktree,
  options: DiffOptions,
  renameCandidatesOnly: boolean,
): Generator<PendingChange> {
  const candidates: WorkingCandidate[] = [];
  for (const row of joinSorted(
    stageZero(repo.checkout.indexScan()),
    walkWorktreeEntriesStream(
      worktree,
      repo.root,
      options.paths === undefined || options.paths.length === 0
        ? { filesOnly: true }
        : { paths: options.paths },
    ),
    { left: (entry) => entry.path, right: (entry) => entry.path },
  )) {
    const index = row.left;
    if (index === undefined || index.mode === 0o160000 || !matchesPaths(row.path, options.paths)) {
      continue;
    }
    const worktreeEntry = row.right;
    candidates.push({
      path: row.path,
      before: indexTarget(index),
      index,
      worktree: worktreeEntry,
    });
    if (candidates.length >= DIFF_WINDOW_ROWS) {
      yield* resolveWorkingCandidateIdentities(
        repo,
        worktree,
        candidates,
        false,
        renameCandidatesOnly,
      );
    }
  }
  yield* resolveWorkingCandidateIdentities(repo, worktree, candidates, false, renameCandidatesOnly);
}

function indexTarget(entry: IndexEntry): TargetEntry {
  return { path: entry.path, mode: entry.mode.toString(8).padStart(6, "0"), oid: entry.oid };
}

function* resolveWorkingCandidateIdentities(
  repo: Repository,
  worktree: Worktree,
  candidates: WorkingCandidate[],
  exact = false,
  renameCandidatesOnly = false,
): Generator<PendingChange> {
  if (candidates.length === 0) return;
  const sourceRows = candidates.splice(0);
  const rows = renameCandidatesOnly
    ? sourceRows.filter((row) => {
        const worktreePresent = row.worktree !== undefined && row.worktree.stat.type !== "dir";
        return (row.before === undefined) !== !worktreePresent;
      })
    : sourceRows;
  if (rows.length === 0) return;
  const expected: BlobIdMapping[] = [];
  for (const row of rows) {
    const mapping = expectedWorktreeMapping(row);
    if (mapping !== null) expected.push(mapping);
  }
  const mismatches = repo.store.blobIdMismatches(expected);
  const unresolved: WorktreePath[] = [];
  const mapped = new Map<string, string>();
  let expectedOrdinal = 0;
  for (const row of rows) {
    if (cachedWorktreeOid(row.index, row.worktree) !== null) continue;
    const mapping = expectedWorktreeMapping(row);
    const mismatch = mapping === null ? null : mismatches.get(expectedOrdinal);
    const oid =
      mapping === null
        ? undefined
        : mismatches.has(expectedOrdinal)
          ? (mismatch ?? undefined)
          : mapping.oid;
    if (mapping !== null) expectedOrdinal++;
    if (oid !== undefined) mapped.set(row.path, oid);
    else if (row.worktree !== undefined && row.worktree.stat.type !== "dir") {
      unresolved.push(row.worktree);
    }
  }
  const hashes = exact
    ? hashExactWorktreePaths(repo, worktree, unresolved, { write: false })
    : hashWorktreePaths(repo, worktree, unresolved, { write: false });
  repo.store.upsertBlobIds(
    [...hashes.values()].flatMap((hashed) => {
      const contentId = hashed.stat.contentId;
      return contentId === null ? [] : [{ contentId, oid: hashed.oid }];
    }),
  );

  for (const row of rows) {
    const cached = cachedWorktreeOid(row.index, row.worktree);
    const hashed = hashes.get(row.path);
    const oid = cached ?? mapped.get(row.path) ?? hashed?.oid;
    const after =
      oid === undefined || row.worktree === undefined || row.worktree.stat.type === "dir"
        ? null
        : {
            mode: hashed?.mode ?? gitModeFor(row.worktree.stat),
            oid,
            worktree: row.worktree,
          };
    const change = compareIdentities(row.path, treeIdentity(row.before), after);
    if (
      change !== null &&
      (!renameCandidatesOnly || (change.before === null) !== (change.after === null))
    ) {
      yield change;
    }
  }
}

function exactRenameChange(rename: ExactRename, destination: PendingChange): FileChange {
  if (
    destination.before !== null ||
    destination.after === null ||
    destination.path !== rename.destination.path ||
    destination.after.mode !== rename.destination.mode ||
    destination.after.oid !== rename.destination.oid
  ) {
    throw new CorruptError("diff rename destination does not match its addition");
  }
  return {
    path: rename.destination.path,
    originalPath: rename.source.path,
    similarity: rename.similarity,
    before: { mode: rename.source.mode, oid: rename.source.oid, bytes: null },
    after: { mode: rename.destination.mode, oid: rename.destination.oid, bytes: null },
  };
}

function expectedWorktreeOid(row: WorkingCandidate): string | undefined {
  return row.index?.oid ?? row.before?.oid;
}

function expectedWorktreeMapping(row: WorkingCandidate): BlobIdMapping | null {
  if (cachedWorktreeOid(row.index, row.worktree) !== null) return null;
  const contentId = row.worktree?.stat.contentId;
  const oid = expectedWorktreeOid(row);
  return contentId === null || contentId === undefined || oid === undefined
    ? null
    : { contentId, oid };
}

function cachedWorktreeOid(
  entry: IndexEntry | undefined,
  worktree: WorktreePath | undefined,
): string | null {
  if (entry === undefined || worktree === undefined || worktree.stat.type === "dir") return null;
  return indexMatchesStat(entry, worktree.stat) ? entry.oid : null;
}

function* hydrateChanges(
  repo: Repository,
  worktree: Worktree,
  changes: PendingChange[],
): Generator<FileChange> {
  if (changes.length === 0) return;
  const pending = changes.splice(0);
  const root = worktree.realpath(repo.root);
  let offset = 0;

  while (offset < pending.length) {
    let end = offset;
    let worktreeBytes = 0;
    while (end < pending.length && end - offset < DIFF_WINDOW_ROWS) {
      const change = pending[end]!;
      const size = requiredWorktreeBytes(change);
      if (size > DIFF_WORKTREE_BYTES) {
        throw new GitError("EFBIG", `diff path ${change.path} exceeds the working-tree byte limit`);
      }
      if (end > offset && worktreeBytes + size > DIFF_WORKTREE_BYTES) break;
      worktreeBytes += size;
      end++;
    }

    const proposed = pending.slice(offset, end);
    const wanted = repositoryOids(proposed);
    const stored = new Map<string, Uint8Array>();
    let remaining = wanted;
    let storedBytes = 0;
    while (remaining.length > 0 && storedBytes < DIFF_REPOSITORY_BYTES) {
      const budget = Math.min(4 * 1024 * 1024, DIFF_REPOSITORY_BYTES - storedBytes);
      let batch: BlobReadBatch;
      try {
        batch = repo.readBlobs(remaining, { budgetBytes: budget });
      } catch (error) {
        if (error instanceof GitError && error.code === "EFBIG") break;
        throw error;
      }
      for (const [oid, bytes] of batch.blobs) stored.set(oid, bytes);
      storedBytes += batch.bytes;
      if (batch.remaining.length >= remaining.length) {
        throw new CorruptError("bulk blob reader did not make progress");
      }
      remaining = batch.remaining;
    }

    let ready = 0;
    for (const change of proposed) {
      if (!repositoryOids([change]).every((oid) => stored.has(oid))) break;
      ready++;
    }
    if (ready === 0) {
      throw new GitError(
        "EFBIG",
        `diff path ${pending[offset]?.path ?? ""} exceeds the blob limit`,
      );
    }
    const group = proposed.slice(0, ready);
    const worktreeContents = readWorktreeContents(worktree, root, group);
    for (const change of group) {
      yield {
        path: change.path,
        before: hydrateEndpoint(change.before, stored, worktreeContents),
        after: hydrateEndpoint(change.after, stored, worktreeContents),
      };
    }
    offset += ready;
  }
}

function requiredWorktreeBytes(change: PendingChange): number {
  if (!contentDiffers(change) || change.after === null || change.after.worktree === null) return 0;
  return change.after.worktree.stat.size;
}

function repositoryOids(changes: readonly PendingChange[]): string[] {
  const oids = new Set<string>();
  for (const change of changes) {
    if (!contentDiffers(change)) continue;
    if (change.before !== null && change.before.worktree === null) oids.add(change.before.oid);
    if (change.after !== null && change.after.worktree === null) oids.add(change.after.oid);
  }
  return [...oids];
}

function contentDiffers(change: PendingChange): boolean {
  return change.before?.oid !== change.after?.oid;
}

function readWorktreeContents(
  worktree: Worktree,
  root: string,
  changes: readonly PendingChange[],
): Map<string, Uint8Array> {
  const contents = new Map<string, Uint8Array>();
  const files: string[] = [];
  for (const change of changes) {
    const endpoint = change.after;
    if (!contentDiffers(change) || endpoint === null || endpoint.worktree === null) continue;
    if (endpoint.worktree.stat.type === "symlink") {
      const target = endpoint.worktree.stat.target;
      if (target === null) throw new CorruptError(`symlink ${change.path} has no target`);
      contents.set(change.path, utf8.encode(target));
    } else {
      files.push(joinPath(root, change.path));
    }
  }

  let remaining = files;
  while (remaining.length > 0) {
    const batch = worktree.readFiles(remaining);
    for (const [absolute, bytes] of batch.files) {
      const prefix = root === "/" ? "/" : `${root}/`;
      if (!absolute.startsWith(prefix)) {
        throw new CorruptError(`worktree read returned a path outside ${root}`);
      }
      contents.set(absolute.slice(prefix.length), bytes);
    }
    if (batch.remaining.length >= remaining.length) {
      throw new CorruptError("bulk worktree reader did not make progress");
    }
    remaining = batch.remaining;
  }
  return contents;
}

function hydrateEndpoint(
  identity: EndpointIdentity | null,
  stored: ReadonlyMap<string, Uint8Array>,
  worktree: ReadonlyMap<string, Uint8Array>,
): Endpoint | null {
  if (identity === null) return null;
  const bytes =
    identity.worktree === null ? stored.get(identity.oid) : worktree.get(identity.worktree.path);
  return { mode: identity.mode, oid: identity.oid, bytes: bytes ?? null };
}

function endpointBytes(endpoint: Endpoint): Uint8Array {
  if (endpoint.bytes === null) throw new CorruptError(`diff bytes missing for ${endpoint.oid}`);
  return endpoint.bytes;
}

/** The "from" tree: an explicit ref, or HEAD — which may be unborn. */
function resolveFrom(repo: Repository, options: DiffOptions): string | null {
  if (options.ref === undefined) return repo.headTree();
  return repo.resolveTreeRevision(options.ref);
}
