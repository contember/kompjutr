// `diff` and `diffSummary`.
//
// Three modes, matching Computer: working tree vs HEAD, working tree vs a
// ref, and a commit pair. The patch text itself comes from
// `src/core/diff/`; this file decides *what* is compared and writes the
// `diff --git` headers around it.

import type { BlobIdMapping, BlobReadBatch, IndexEntry } from "../../sqlite/store.js";
import { utf8, utf8Decoder, ZERO_OID } from "../bytes.js";
import { diffLines, diffText, splitLines } from "../diff/index.js";
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
import { type StatusIndexGroup, statusIndexGroups } from "./status-rows.js";
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
const DIFF_SUMMARY_ENTRY_FIXED_BYTES = 128;
const DIFF_SUMMARY_MAX_ROWS = 50_000;
const MIB = 1024 * 1024;
export const DIFF_MAX_OUTPUT_BYTES = 16 * MIB;
// 64 MiB renderer + 16 MiB hydration + 12 MiB caches + 4 MiB headroom = 96 MiB.
export const DIFF_COMBINED_MAX_MEMORY_BYTES = 64 * MIB;
export const DIFF_COMBINED_MAX_LINES = 100_000;
const DIFF_COMBINED_MAX_CHANGES = 50_000;
const DIFF_COMBINED_MAX_ROWS = DIFF_COMBINED_MAX_LINES;
// Match xmerge's per-line estimates; rows also reserve incremental render nodes.
const DIFF_COMBINED_LINE_RECORD_BYTES = 96;
const DIFF_COMBINED_DIFF_LINE_BYTES = 320;
const DIFF_COMBINED_CHANGE_BYTES = 192;
const DIFF_COMBINED_ROW_BYTES = 128;
const DIFF_COMBINED_FIXED_BYTES = 16 * 1024;

function diffStringBytes(value: string): number {
  return 48 + value.length * 2;
}

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

interface CombinedFileChange {
  kind: "combined";
  path: string;
  parents: readonly [Endpoint, Endpoint];
  after: Endpoint | null;
}

interface UnmergedPathChange {
  kind: "unmerged";
  path: string;
}

type PatchChange = FileChange | CombinedFileChange | UnmergedPathChange;

function isCombinedFileChange(change: PatchChange): change is CombinedFileChange {
  return "kind" in change && change.kind === "combined";
}

function isUnmergedFileChange(change: PatchChange): change is UnmergedPathChange {
  return "kind" in change && change.kind === "unmerged";
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
    if (isUnmergedFileChange(change)) {
      out.append(`* Unmerged path ${diffHeaderPath(change.path, "", formatOptions)}\n`);
      continue;
    }
    if (isCombinedFileChange(change)) {
      appendCombinedDiff(out, change, abbrev, options.context, formatOptions);
      continue;
    }
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
  readonly #maximum: number;

  constructor(maximum: number | undefined) {
    if (maximum !== undefined && (!Number.isSafeInteger(maximum) || maximum < 0)) {
      throw new GitError("EINVAL", "diff output ceiling must be a non-negative safe integer");
    }
    this.#maximum = Math.min(maximum ?? DIFF_MAX_OUTPUT_BYTES, DIFF_MAX_OUTPUT_BYTES);
  }

  append(value: string): void {
    if (value === "") return;
    const bytes = diffUtf8Bytes(value);
    if (bytes > this.#maximum - this.#bytes) {
      throw new GitError("E2BIG", `diff output exceeds ${this.#maximum} UTF-8 bytes`);
    }
    this.#bytes += bytes;
    this.#output += value;
  }

  outputCeiling(): number {
    return this.#maximum;
  }

  finish(): string {
    return this.#output;
  }
}

function appendCombinedDiff(
  out: DiffOutput,
  change: CombinedFileChange,
  abbrev: number,
  context: number | undefined,
  options: DiffFormatOptions,
): void {
  const [first, second] = change.parents;
  const after = change.after;
  let header = `diff --cc ${diffHeaderPath(change.path, "", options)}\n`;
  header += `index ${first.oid.slice(0, abbrev)},${second.oid.slice(0, abbrev)}..${ZERO_OID.slice(0, abbrev)}\n`;
  if (after === null) {
    header += `deleted file mode ${first.mode},${second.mode}\n`;
  } else if (first.mode !== after.mode || second.mode !== after.mode) {
    header += `mode ${first.mode},${second.mode}..${after.mode}\n`;
  }
  out.append(header);
  const firstBytes = endpointBytes(first);
  const secondBytes = endpointBytes(second);
  const afterBytes = after === null ? null : endpointBytes(after);
  if (
    isBinary(firstBytes) ||
    isBinary(secondBytes) ||
    (afterBytes !== null && isBinary(afterBytes))
  ) {
    out.append("Binary files differ\n");
    return;
  }
  if (after !== null && (after.oid === first.oid || after.oid === second.oid)) {
    out.append(`--- ${diffHeaderPath(change.path, "a/", options)}\n`);
    out.append(`+++ ${diffHeaderPath(change.path, "b/", options)}\n`);
    return;
  }

  out.append(`--- ${diffHeaderPath(change.path, "a/", options)}\n`);
  out.append(
    after === null ? "+++ /dev/null\n" : `+++ ${diffHeaderPath(change.path, "b/", options)}\n`,
  );
  if (
    afterBytes === null ||
    !combinedModesCanDiff(first.mode, second.mode, after?.mode ?? first.mode)
  ) {
    return;
  }
  preflightCombinedDiff(firstBytes, secondBytes, afterBytes, out.outputCeiling(), change.path);
  appendCombinedHunks(
    out,
    utf8Decoder.decode(firstBytes),
    utf8Decoder.decode(secondBytes),
    utf8Decoder.decode(afterBytes),
    context,
  );
}

function combinedModesCanDiff(first: string, second: string, after: string): boolean {
  return modeClass(first) === modeClass(second) && modeClass(first) === modeClass(after);
}

function modeClass(mode: string): "regular" | "symlink" | "other" {
  if (mode === "100644" || mode === "100755") return "regular";
  if (mode === "120000") return "symlink";
  return "other";
}

interface CombinedInputInfo {
  bytes: number;
  lines: number;
}

function preflightCombinedDiff(
  first: Uint8Array,
  second: Uint8Array,
  result: Uint8Array,
  outputCeiling: number,
  path: string,
): void {
  const firstInfo = combinedInputInfo(first);
  const secondInfo = combinedInputInfo(second);
  const resultInfo = combinedInputInfo(result);
  const inputBytes = checkedCombinedSum(
    [firstInfo.bytes, secondInfo.bytes, resultInfo.bytes],
    "input bytes",
  );
  const lines = checkedCombinedSum(
    [firstInfo.lines, secondInfo.lines, resultInfo.lines],
    "line count",
  );
  if (lines > DIFF_COMBINED_MAX_LINES) {
    throw new GitError("E2BIG", `combined diff exceeds ${DIFF_COMBINED_MAX_LINES} lines`);
  }
  const maximumPairLines = Math.max(
    firstInfo.lines + resultInfo.lines,
    secondInfo.lines + resultInfo.lines,
    firstInfo.lines + secondInfo.lines,
  );
  const potentialChanges = Math.min(DIFF_COMBINED_MAX_CHANGES, lines * 2 + 4);
  // Reserve decoded UTF-16 sources and worst-case copied split-line payloads.
  const textBytes = inputBytes * 4;
  const retainedBytes = checkedCombinedSum(
    [
      textBytes,
      lines * DIFF_COMBINED_LINE_RECORD_BYTES,
      maximumPairLines * DIFF_COMBINED_DIFF_LINE_BYTES,
      potentialChanges * DIFF_COMBINED_CHANGE_BYTES,
      lines * DIFF_COMBINED_ROW_BYTES,
      resultInfo.lines * 2,
      outputCeiling * 2,
      diffStringBytes(path),
      DIFF_COMBINED_FIXED_BYTES,
    ],
    "retained memory",
  );
  if (retainedBytes > DIFF_COMBINED_MAX_MEMORY_BYTES) {
    throw new GitError(
      "E2BIG",
      `combined diff retained memory exceeds ${DIFF_COMBINED_MAX_MEMORY_BYTES} bytes`,
    );
  }
}

function combinedInputInfo(bytes: Uint8Array): CombinedInputInfo {
  if (bytes.length === 0) return { bytes: 0, lines: 0 };
  let lines = bytes[bytes.length - 1] === 0x0a ? 0 : 1;
  for (const byte of bytes) if (byte === 0x0a) lines++;
  return { bytes: bytes.length, lines };
}

function checkedCombinedSum(values: readonly number[], label: string): number {
  let total = 0;
  for (const value of values) {
    if (!Number.isSafeInteger(value) || value < 0 || value > Number.MAX_SAFE_INTEGER - total) {
      throw new GitError("E2BIG", `combined diff ${label} overflows a safe integer`);
    }
    total += value;
  }
  return total;
}

interface CombinedRow {
  prefix: string;
  line: string;
}

interface PairAlignment {
  deleted: ReadonlyMap<number, DeletedRange>;
  present: Uint8Array;
}

interface DeletedRange {
  lines: string[];
  start: number;
  count: number;
}

interface CombinedDiffBudget {
  changes: number;
}

function appendCombinedHunks(
  out: DiffOutput,
  firstText: string,
  secondText: string,
  resultText: string,
  context = 3,
): void {
  if (!Number.isSafeInteger(context) || context < 0) {
    throw new GitError("EINVAL", "diff context must be a non-negative safe integer");
  }
  const first = splitLines(firstText);
  const second = splitLines(secondText);
  const result = splitLines(resultText);
  const budget = { changes: 0 };
  const firstAlignment = pairAlignment(first, result, budget);
  const secondAlignment = pairAlignment(second, result, budget);
  const rows: CombinedRow[] = [];
  for (let position = 0; position <= result.length; position++) {
    appendCombinedDeletions(
      rows,
      firstAlignment.deleted.get(position),
      secondAlignment.deleted.get(position),
      budget,
    );
    const line = result[position];
    if (line === undefined) continue;
    appendCombinedRow(rows, {
      prefix: `${firstAlignment.present[position] === 1 ? " " : "+"}${secondAlignment.present[position] === 1 ? " " : "+"}`,
      line,
    });
  }
  renderCombinedHunks(out, rows, context);
}

function pairAlignment(
  parent: string[],
  result: string[],
  budget: CombinedDiffBudget,
): PairAlignment {
  const changes = diffLines(parent, result, { maxChanges: remainingCombinedChanges(budget) });
  budget.changes += changes.length;
  const present = new Uint8Array(result.length);
  present.fill(1);
  const deleted = new Map<number, DeletedRange>();
  for (const change of changes) {
    for (let index = change.newStart; index < change.newStart + change.newCount; index++) {
      present[index] = 0;
    }
    if (change.oldCount > 0) {
      deleted.set(change.newStart, {
        lines: parent,
        start: change.oldStart,
        count: change.oldCount,
      });
    }
  }
  return { deleted, present };
}

function appendCombinedDeletions(
  rows: CombinedRow[],
  firstRange: DeletedRange | undefined,
  secondRange: DeletedRange | undefined,
  budget: CombinedDiffBudget,
): void {
  if (firstRange === undefined && secondRange === undefined) return;
  const first = deletedLines(firstRange);
  const second = deletedLines(secondRange);
  const changes = diffLines(first, second, { maxChanges: remainingCombinedChanges(budget) });
  budget.changes += changes.length;
  let firstAt = 0;
  let secondAt = 0;
  for (const change of changes) {
    while (firstAt < change.oldStart && secondAt < change.newStart) {
      appendCombinedRow(rows, { prefix: "--", line: first[firstAt] ?? "" });
      firstAt++;
      secondAt++;
    }
    for (let index = 0; index < change.oldCount; index++) {
      appendCombinedRow(rows, { prefix: "- ", line: first[change.oldStart + index] ?? "" });
    }
    for (let index = 0; index < change.newCount; index++) {
      appendCombinedRow(rows, { prefix: " -", line: second[change.newStart + index] ?? "" });
    }
    firstAt = change.oldStart + change.oldCount;
    secondAt = change.newStart + change.newCount;
  }
  while (firstAt < first.length && secondAt < second.length) {
    appendCombinedRow(rows, { prefix: "--", line: first[firstAt] ?? "" });
    firstAt++;
    secondAt++;
  }
  while (firstAt < first.length) {
    appendCombinedRow(rows, { prefix: "- ", line: first[firstAt] ?? "" });
    firstAt++;
  }
  while (secondAt < second.length) {
    appendCombinedRow(rows, { prefix: " -", line: second[secondAt] ?? "" });
    secondAt++;
  }
}

function deletedLines(range: DeletedRange | undefined): string[] {
  return range === undefined ? [] : range.lines.slice(range.start, range.start + range.count);
}

function remainingCombinedChanges(budget: CombinedDiffBudget): number {
  const remaining = DIFF_COMBINED_MAX_CHANGES - budget.changes;
  if (remaining < 0) {
    throw new GitError("E2BIG", `combined diff exceeds ${DIFF_COMBINED_MAX_CHANGES} changes`);
  }
  return remaining;
}

function appendCombinedRow(rows: CombinedRow[], row: CombinedRow): void {
  if (rows.length >= DIFF_COMBINED_MAX_ROWS) {
    throw new GitError("E2BIG", `combined diff exceeds ${DIFF_COMBINED_MAX_ROWS} rows`);
  }
  rows.push(row);
}

function renderCombinedHunks(out: DiffOutput, rows: readonly CombinedRow[], context: number): void {
  const before = { first: 0, second: 0, result: 0 };
  let countedThrough = 0;
  let search = 0;
  for (;;) {
    const firstChange = nextCombinedChange(rows, search);
    if (firstChange === -1) return;
    let lastChange = firstChange;
    for (;;) {
      const next = nextCombinedChange(rows, lastChange + 1);
      if (next === -1) break;
      if (next - lastChange - 1 > context * 2) break;
      lastChange = next;
    }
    const start = Math.max(0, firstChange - context);
    const end = Math.min(rows.length, lastChange + context + 1);
    const comment = combinedHunkComment(rows, countedThrough, start);
    addCombinedLineCounts(before, rows, countedThrough, start);
    const counts = combinedLineCounts(rows, start, end);
    out.append(
      `@@@ -${combinedRange(before.first, counts.first)} -${combinedRange(before.second, counts.second)} +${combinedRange(before.result, counts.result)} @@@${comment === "" ? "" : ` ${comment}`}\n`,
    );
    for (let index = start; index < end; index++) {
      const row = rows[index];
      if (row !== undefined) emitCombinedRow(out, row);
    }
    addCombinedLineCounts(before, rows, start, end);
    countedThrough = end;
    search = lastChange + 1;
  }
}

function nextCombinedChange(rows: readonly CombinedRow[], start: number): number {
  for (let index = start; index < rows.length; index++) {
    if (rows[index]?.prefix !== "  ") return index;
  }
  return -1;
}

function combinedHunkComment(rows: readonly CombinedRow[], start: number, end: number): string {
  let candidate = "";
  for (let index = start; index < end; index++) {
    const row = rows[index];
    if (row === undefined || row.prefix.includes("-")) continue;
    const first = row.line[0];
    if (first !== undefined && /[A-Za-z_$]/.test(first)) candidate = row.line;
  }
  let commentEnd = 0;
  for (let index = 0; index < Math.min(40, candidate.length); index++) {
    const character = candidate[index];
    if (character === undefined || character === "\n") break;
    if (!/\s/.test(character)) commentEnd = index;
  }
  // Git's combined-diff formatter treats the last non-space index as exclusive.
  return commentEnd === 0 ? "" : candidate.slice(0, commentEnd);
}

function combinedLineCounts(
  rows: readonly CombinedRow[],
  start: number,
  end: number,
): { first: number; second: number; result: number } {
  const counts = { first: 0, second: 0, result: 0 };
  addCombinedLineCounts(counts, rows, start, end);
  return counts;
}

function addCombinedLineCounts(
  counts: { first: number; second: number; result: number },
  rows: readonly CombinedRow[],
  start: number,
  end: number,
): void {
  for (let index = start; index < end; index++) {
    const prefix = rows[index]?.prefix;
    if (prefix === undefined) continue;
    const resultPresent = !prefix.includes("-");
    if (prefix[0] === "-" || (prefix[0] === " " && resultPresent)) counts.first++;
    if (prefix[1] === "-" || (prefix[1] === " " && resultPresent)) counts.second++;
    if (resultPresent) counts.result++;
  }
}

function combinedRange(before: number, count: number): string {
  return `${count === 0 ? before : before + 1},${count}`;
}

function emitCombinedRow(out: DiffOutput, row: CombinedRow): void {
  out.append(`${row.prefix}${row.line}${row.line.endsWith("\n") ? "" : "\n"}`);
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
  for (let index = 0; index < path.length; index++) {
    const code = path.charCodeAt(index);
    if (code === 0) throw new GitError("EINVAL", "diff path must not contain NUL");
    if (code >= 0xd800 && code <= 0xdbff) {
      const low = path.charCodeAt(index + 1);
      if (low < 0xdc00 || low > 0xdfff) {
        throw new GitError("EINVAL", "diff path must be well-formed UTF-16");
      }
      index++;
    } else if (code >= 0xdc00 && code <= 0xdfff) {
      throw new GitError("EINVAL", "diff path must be well-formed UTF-16");
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
  return [...diffSummaryEntries(repo, worktree, options, sparseWorkspace)];
}

/** Internal bounded summary materialization for output-producing adapters. */
export function diffSummaryBounded(
  repo: Repository,
  worktree: Worktree,
  options: DiffOptions,
  sparseWorkspace: SparseWorkspaceSource | undefined,
  limits: { maxRows: number; maxRetainedBytes: number },
): DiffSummaryEntry[] {
  validateDiffSummaryLimits(limits);
  const out: DiffSummaryEntry[] = [];
  let retainedBytes = 0;
  for (const entry of diffSummaryEntries(repo, worktree, options, sparseWorkspace)) {
    if (out.length >= limits.maxRows) {
      throw new GitError("E2BIG", `diff summary exceeds ${limits.maxRows} rows`);
    }
    const bytes = diffSummaryEntryRetainedBytes(entry);
    if (bytes > limits.maxRetainedBytes - retainedBytes) {
      throw new GitError("E2BIG", `diff summary exceeds ${limits.maxRetainedBytes} retained bytes`);
    }
    retainedBytes += bytes;
    out.push(entry);
  }
  return out;
}

function* diffSummaryEntries(
  repo: Repository,
  worktree: Worktree,
  options: DiffOptions,
  sparseWorkspace: SparseWorkspaceSource | undefined,
): Generator<DiffSummaryEntry> {
  for (const change of collect(repo, worktree, options, sparseWorkspace)) {
    if (isCombinedFileChange(change) || isUnmergedFileChange(change)) {
      throw new CorruptError("tree-based diff summary produced an index conflict");
    }
    if (change.originalPath !== undefined && change.similarity !== undefined) {
      yield {
        path: change.path,
        originalPath: change.originalPath,
        similarity: change.similarity,
        status: "R",
        insertions: 0,
        deletions: 0,
      };
      continue;
    }
    const status = change.before === null ? "A" : change.after === null ? "D" : "M";
    if (change.before?.oid === change.after?.oid) {
      yield { path: change.path, status, insertions: 0, deletions: 0 };
      continue;
    }
    const oldBytes = change.before === null ? new Uint8Array(0) : endpointBytes(change.before);
    const newBytes = change.after === null ? new Uint8Array(0) : endpointBytes(change.after);
    if (isBinary(oldBytes) || isBinary(newBytes)) {
      // git prints "-" for a binary file; there is no line count to give.
      yield { path: change.path, status, insertions: 0, deletions: 0 };
      continue;
    }
    const text = diffText(utf8Decoder.decode(oldBytes), utf8Decoder.decode(newBytes));
    yield {
      path: change.path,
      status,
      insertions: text.insertions,
      deletions: text.deletions,
    };
  }
}

function validateDiffSummaryLimits(limits: { maxRows: number; maxRetainedBytes: number }): void {
  if (
    !Number.isSafeInteger(limits.maxRows) ||
    limits.maxRows < 0 ||
    limits.maxRows > DIFF_SUMMARY_MAX_ROWS
  ) {
    throw new GitError(
      "EINVAL",
      `diff summary row limit must be between 0 and ${DIFF_SUMMARY_MAX_ROWS}`,
    );
  }
  if (
    !Number.isSafeInteger(limits.maxRetainedBytes) ||
    limits.maxRetainedBytes < 0 ||
    limits.maxRetainedBytes > DIFF_REPOSITORY_BYTES
  ) {
    throw new GitError(
      "EINVAL",
      `diff summary retained limit must be between 0 and ${DIFF_REPOSITORY_BYTES} bytes`,
    );
  }
}

export function diffSummaryEntryRetainedBytes(entry: DiffSummaryEntry): number {
  return (
    DIFF_SUMMARY_ENTRY_FIXED_BYTES +
    diffStringBytes(entry.path) +
    (entry.originalPath === undefined ? 0 : diffStringBytes(entry.originalPath))
  );
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
): Generator<PatchChange> {
  if (indexBase) {
    yield* indexWorktreePatchChanges(repo, worktree, options);
    return;
  }
  const sparse = boundedSparsePendingChanges(repo, worktree, options, sparseWorkspace);
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
    pendingChanges(repo, worktree, options, true),
  );
  yield* collectPendingChanges(
    repo,
    worktree,
    pendingChanges(repo, worktree, options, false),
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
): Generator<PendingChange> {
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

type IndexPatchCandidate =
  | { kind: "tracked"; row: WorkingCandidate }
  | {
      kind: "combined";
      path: string;
      parents: readonly [IndexEntry, IndexEntry];
      worktree: WorktreePath | undefined;
    }
  | UnmergedPathChange;

interface PendingCombinedChange {
  kind: "combined";
  path: string;
  parents: readonly [EndpointIdentity, EndpointIdentity];
  after: EndpointIdentity | null;
}

type PendingIndexPatchChange = PendingChange | PendingCombinedChange | UnmergedPathChange;

function isPendingCombinedChange(change: PendingIndexPatchChange): change is PendingCombinedChange {
  return "kind" in change && change.kind === "combined";
}

function isPendingUnmergedChange(change: PendingIndexPatchChange): change is UnmergedPathChange {
  return "kind" in change && change.kind === "unmerged";
}

function* indexWorktreePatchChanges(
  repo: Repository,
  worktree: Worktree,
  options: DiffOptions,
): Generator<PatchChange> {
  const candidates: IndexPatchCandidate[] = [];
  for (const row of joinSorted(
    statusIndexGroups(repo.checkout.indexScan()),
    walkWorktreeEntriesStream(
      worktree,
      repo.root,
      options.paths === undefined || options.paths.length === 0
        ? { filesOnly: true }
        : { paths: options.paths },
    ),
    { left: (group) => group.path, right: (entry) => entry.path },
  )) {
    const group = row.left;
    if (group === undefined || !matchesPaths(row.path, options.paths)) continue;
    if (group.kind === "tracked" && group.entry.mode === 0o160000) continue;
    candidates.push(indexPatchCandidate(group, row.right));
    if (candidates.length >= DIFF_WINDOW_ROWS) {
      yield* hydrateIndexPatchCandidates(repo, worktree, candidates);
    }
  }
  yield* hydrateIndexPatchCandidates(repo, worktree, candidates);
}

function indexPatchCandidate(
  group: StatusIndexGroup,
  worktree: WorktreePath | undefined,
): IndexPatchCandidate {
  if (group.kind === "tracked") {
    return {
      kind: "tracked",
      row: {
        path: group.path,
        before: indexTarget(group.entry),
        index: group.entry,
        worktree,
      },
    };
  }
  const current = group.current;
  const incoming = group.incoming;
  if (
    current === undefined ||
    incoming === undefined ||
    current.mode === 0o160000 ||
    incoming.mode === 0o160000
  ) {
    return { kind: "unmerged", path: group.path };
  }
  return { kind: "combined", path: group.path, parents: [current, incoming], worktree };
}

function* hydrateIndexPatchCandidates(
  repo: Repository,
  worktree: Worktree,
  candidates: IndexPatchCandidate[],
): Generator<PatchChange> {
  if (candidates.length === 0) return;
  const source = candidates.splice(0);
  const working: WorkingCandidate[] = [];
  for (const candidate of source) {
    if (candidate.kind === "tracked") {
      working.push(candidate.row);
    } else if (candidate.kind === "combined") {
      working.push({
        path: candidate.path,
        before: indexTarget(candidate.parents[0]),
        index: undefined,
        worktree: candidate.worktree,
      });
    }
  }
  const afters = resolveWorkingCandidateAfters(repo, worktree, working, true);
  const pending: PendingIndexPatchChange[] = [];
  for (const candidate of source) {
    if (candidate.kind === "unmerged") {
      pending.push(candidate);
      continue;
    }
    const after = afters.get(candidate.kind === "tracked" ? candidate.row.path : candidate.path);
    if (after === undefined) throw new CorruptError("diff lost a working-tree candidate");
    if (candidate.kind === "tracked") {
      const change = compareIdentities(
        candidate.row.path,
        treeIdentity(candidate.row.before),
        after,
      );
      if (change !== null) pending.push(change);
      continue;
    }
    pending.push({
      kind: "combined",
      path: candidate.path,
      parents: [
        treeIdentity(indexTarget(candidate.parents[0])) ?? missingConflictParent(candidate.path),
        treeIdentity(indexTarget(candidate.parents[1])) ?? missingConflictParent(candidate.path),
      ],
      after,
    });
  }
  yield* hydrateIndexPatchChanges(repo, worktree, pending);
}

function missingConflictParent(path: string): never {
  throw new CorruptError(`diff conflict parent disappeared at ${path}`);
}

function* hydrateIndexPatchChanges(
  repo: Repository,
  worktree: Worktree,
  changes: readonly PendingIndexPatchChange[],
): Generator<PatchChange> {
  if (changes.length === 0) return;
  const root = worktree.realpath(repo.root);
  let offset = 0;
  while (offset < changes.length) {
    let end = offset;
    let worktreeBytes = 0;
    while (end < changes.length && end - offset < DIFF_WINDOW_ROWS) {
      const change = changes[end]!;
      const size = indexPatchWorktreeBytes(change);
      if (size > DIFF_WORKTREE_BYTES) {
        throw new GitError("EFBIG", `diff path ${change.path} exceeds the working-tree byte limit`);
      }
      if (end > offset && worktreeBytes + size > DIFF_WORKTREE_BYTES) break;
      worktreeBytes += size;
      end++;
    }

    const proposed = changes.slice(offset, end);
    const wanted = indexPatchRepositoryOids(proposed);
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
      if (!indexPatchRepositoryOids([change]).every((oid) => stored.has(oid))) break;
      ready++;
    }
    if (ready === 0) {
      throw new GitError(
        "EFBIG",
        `diff path ${changes[offset]?.path ?? ""} exceeds the blob limit`,
      );
    }
    const group = proposed.slice(0, ready);
    const worktreeContents = readIndexPatchWorktreeContents(worktree, root, group);
    for (const change of group) {
      if (isPendingUnmergedChange(change)) {
        yield change;
      } else if (isPendingCombinedChange(change)) {
        yield {
          kind: "combined",
          path: change.path,
          parents: [
            hydrateEndpoint(change.parents[0], stored, worktreeContents) ??
              missingHydratedConflictParent(change.path),
            hydrateEndpoint(change.parents[1], stored, worktreeContents) ??
              missingHydratedConflictParent(change.path),
          ],
          after: hydrateEndpoint(change.after, stored, worktreeContents),
        };
      } else {
        yield {
          path: change.path,
          before: hydrateEndpoint(change.before, stored, worktreeContents),
          after: hydrateEndpoint(change.after, stored, worktreeContents),
        };
      }
    }
    offset += ready;
  }
}

function missingHydratedConflictParent(path: string): never {
  throw new CorruptError(`diff conflict parent bytes disappeared at ${path}`);
}

function indexPatchWorktreeBytes(change: PendingIndexPatchChange): number {
  if (isPendingUnmergedChange(change)) return 0;
  if (isPendingCombinedChange(change)) {
    if (change.after === null) return 0;
    return change.after.worktree?.stat.size ?? 0;
  }
  return requiredWorktreeBytes(change);
}

function indexPatchRepositoryOids(changes: readonly PendingIndexPatchChange[]): string[] {
  const oids = new Set<string>();
  for (const change of changes) {
    if (isPendingUnmergedChange(change)) continue;
    if (isPendingCombinedChange(change)) {
      for (const parent of change.parents) oids.add(parent.oid);
      continue;
    }
    for (const oid of repositoryOids([change])) oids.add(oid);
  }
  return [...oids];
}

function readIndexPatchWorktreeContents(
  worktree: Worktree,
  root: string,
  changes: readonly PendingIndexPatchChange[],
): Map<string, Uint8Array> {
  const contents = new Map<string, Uint8Array>();
  const files: string[] = [];
  for (const change of changes) {
    if (isPendingUnmergedChange(change)) continue;
    const endpoint = change.after;
    if (endpoint === null || endpoint.worktree === null) continue;
    if (!isPendingCombinedChange(change) && !contentDiffers(change)) continue;
    if (endpoint.worktree.stat.type === "symlink") {
      const target = endpoint.worktree.stat.target;
      if (target === null) throw new CorruptError(`symlink ${change.path} has no target`);
      contents.set(change.path, utf8.encode(target));
    } else {
      files.push(joinPath(root, change.path));
    }
  }
  readWorktreeFileContents(worktree, root, files, contents);
  return contents;
}

function readWorktreeFileContents(
  worktree: Worktree,
  root: string,
  files: string[],
  contents: Map<string, Uint8Array>,
): void {
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
  const afters = resolveWorkingCandidateAfters(repo, worktree, rows, exact);
  for (const row of rows) {
    const after = afters.get(row.path);
    if (after === undefined) throw new CorruptError("diff lost a working-tree identity");
    const change = compareIdentities(row.path, treeIdentity(row.before), after);
    if (
      change !== null &&
      (!renameCandidatesOnly || (change.before === null) !== (change.after === null))
    ) {
      yield change;
    }
  }
}

function resolveWorkingCandidateAfters(
  repo: Repository,
  worktree: Worktree,
  rows: readonly WorkingCandidate[],
  exact: boolean,
): Map<string, EndpointIdentity | null> {
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

  const afters = new Map<string, EndpointIdentity | null>();
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
    afters.set(row.path, after);
  }
  return afters;
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

  readWorktreeFileContents(worktree, root, files, contents);
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
