import { utf8Decoder, ZERO_OID } from "../common/bytes.js";
import { GitError } from "../common/errors.js";
import { diffLines, splitLines } from "../diff/index.js";
import { isBinary } from "../diff/lines.js";
import { diffHeaderPath } from "./diff-path-format.js";
import {
  type CombinedFileChange,
  type DiffFormatOptions,
  type DiffOutput,
  diffStringBytes,
  endpointBytes,
} from "./diff-types.js";

export const DIFF_COMBINED_MAX_MEMORY_BYTES = 64 * 1024 * 1024;
export const DIFF_COMBINED_MAX_LINES = 100_000;
const DIFF_COMBINED_MAX_CHANGES = 50_000;
const DIFF_COMBINED_MAX_ROWS = DIFF_COMBINED_MAX_LINES;
const DIFF_COMBINED_LINE_RECORD_BYTES = 96;
const DIFF_COMBINED_DIFF_LINE_BYTES = 320;
const DIFF_COMBINED_CHANGE_BYTES = 192;
const DIFF_COMBINED_ROW_BYTES = 128;
const DIFF_COMBINED_FIXED_BYTES = 16 * 1024;

export function appendCombinedDiff(
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
