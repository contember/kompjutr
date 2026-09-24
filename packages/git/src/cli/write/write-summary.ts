import { utf8Decoder } from "../../common/bytes.js";
import { GitError } from "../../common/errors.js";
import { diffText } from "../../diff/index.js";
import { isBinary } from "../../diff/lines.js";
import { diffHeaderPath, diffTreeSummary } from "../../ops/diff/diff.js";
import type { Repository } from "../../ops/repository/repository.js";
import { statusFormatOptions } from "../../ops/status/status-format.js";
import { PACK_BLOB_BATCH_TARGET_BYTES, type WalkTreeDiffEntry } from "../../store/index.js";
import { TruncatingOutput } from "./write-output.js";

const HEADS = "refs/heads/";
const SUMMARY_WINDOW_ROWS = 1_000;

export interface CommitMutation {
  oid: string;
  previousHead: import("../../ops/repository/repository.js").ResolvedHead;
  amended: boolean;
}

interface CommitSummary {
  files: number;
  insertions: number;
  deletions: number;
  details: TruncatingOutput;
}

interface RootSummaryRow {
  path: string;
  mode: string;
  oid: string;
}

export function formatCommitSummary(
  repo: Repository,
  mutation: CommitMutation,
  out: TruncatingOutput,
): void {
  formatCommit(repo, mutation.oid, branchLabel(mutation.previousHead.ref), out, mutation.amended);
}

export function formatCommit(
  repo: Repository,
  oid: string,
  label: string,
  out: TruncatingOutput,
  amended = false,
): void {
  const commit = repo.readCommit(oid);
  const quoteNonAscii = statusFormatOptions(repo).quotePath ?? true;
  const summary = summarizeCommit(repo, commit.tree, commit.parent[0], quoteNonAscii, out.maximum);
  const root = commit.parent.length === 0 ? " (root-commit)" : "";
  out.append(`[${label}${root} ${abbreviate(repo, oid)}] ${subject(commit.message)}\n`);
  if (amended) out.append(` Date: ${mediumDate(commit.author)}\n`);
  if (summary.files > 0) out.append(` ${shortStat(summary)}\n`);
  out.appendOutput(summary.details);
}

function summarizeCommit(
  repo: Repository,
  tree: string,
  parentOid: string | undefined,
  quoteNonAscii: boolean,
  maximum: number,
): CommitSummary {
  if (parentOid === undefined) return summarizeRoot(repo, tree, quoteNonAscii, maximum);
  const parentTree = repo.readCommit(parentOid).tree;
  // Git's commit summary ignores diff.renameLimit, which only gates inexact
  // detection, and never warns. Exact pairing past the classifier's candidate
  // cap falls back to plain additions and deletions.
  const summary = diffTreeSummary(repo, parentTree, tree, { renames: true });
  const sources = new Set(summary.renames.map((rename) => rename.source.path));
  const renames = new Map(summary.renames.map((rename) => [rename.destination.path, rename]));
  const details = new TruncatingOutput(maximum);
  // Git lists a rename at its destination's position in path order.
  for (const row of repo.walkTreeDiff(parentTree, tree)) {
    const rename = renames.get(row.path);
    if (rename !== undefined) {
      const { source, destination, similarity } = rename;
      details.append(
        ` rename ${summaryRenamePath(source.path, destination.path, quoteNonAscii)} (${similarity}%)\n`,
      );
      if (source.mode !== destination.mode) {
        details.append(` mode change ${source.mode} => ${destination.mode}\n`);
      }
      continue;
    }
    if (sources.has(row.path)) continue;
    const detail = modeDetail(row, quoteNonAscii);
    if (detail !== undefined) details.append(` ${detail}\n`);
  }
  let files = 0;
  let insertions = 0;
  let deletions = 0;
  for (const entry of summary.entries) {
    files++;
    insertions += entry.insertions;
    deletions += entry.deletions;
  }
  return { files, insertions, deletions, details };
}

function summarizeRoot(
  repo: Repository,
  tree: string,
  quoteNonAscii: boolean,
  maximum: number,
): CommitSummary {
  const details = new TruncatingOutput(maximum);
  let files = 0;
  let insertions = 0;
  let pending: RootSummaryRow[] = [];
  const flush = (): void => {
    if (pending.length === 0) return;
    let rows = pending;
    pending = [];
    while (rows.length > 0) {
      const batch = repo.readBlobs(
        rows.map((row) => row.oid),
        { budgetBytes: PACK_BLOB_BATCH_TARGET_BYTES },
      );
      if (batch.blobs.size === 0) {
        throw new Error("commit summary blob batch made no progress");
      }
      let processed = 0;
      while (processed < rows.length) {
        const row = rows[processed];
        if (row === undefined) throw new Error("commit summary blob row is missing");
        const bytes = batch.blobs.get(row.oid);
        if (bytes === undefined) break;
        if (!isBinary(bytes)) insertions += diffText("", utf8Decoder.decode(bytes)).insertions;
        details.append(` create mode ${row.mode} ${summaryPath(row.path, quoteNonAscii)}\n`);
        processed++;
      }
      if (processed === 0) throw new Error("commit summary blob batch made no progress");
      rows = rows.slice(processed);
    }
  };
  for (const row of repo.walkTreeDiff(null, tree)) {
    if (row.afterMode === null || row.afterOid === null) {
      throw new Error("root commit summary yielded a deletion");
    }
    files++;
    pending.push({ path: row.path, mode: row.afterMode, oid: row.afterOid });
    if (pending.length >= SUMMARY_WINDOW_ROWS) flush();
  }
  flush();
  return { files, insertions, deletions: 0, details };
}

function modeDetail(row: WalkTreeDiffEntry, quoteNonAscii: boolean): string | undefined {
  const path = summaryPath(row.path, quoteNonAscii);
  if (row.beforeMode === null && row.afterMode !== null) {
    return `create mode ${row.afterMode} ${path}`;
  }
  if (row.afterMode === null && row.beforeMode !== null) {
    return `delete mode ${row.beforeMode} ${path}`;
  }
  if (row.beforeMode !== null && row.afterMode !== null && row.beforeMode !== row.afterMode) {
    return `mode change ${row.beforeMode} => ${row.afterMode} ${path}`;
  }
  return undefined;
}

function summaryPath(path: string, quoteNonAscii: boolean): string {
  return diffHeaderPath(path, "", { quotePaths: true, quoteNonAscii });
}

function summaryRenamePath(source: string, destination: string, quoteNonAscii: boolean): string {
  const sourcePath = summaryPath(source, quoteNonAscii);
  const destinationPath = summaryPath(destination, quoteNonAscii);
  if (sourcePath.startsWith('"') || destinationPath.startsWith('"')) {
    return `${sourcePath} => ${destinationPath}`;
  }
  const compressed = compressRenamePath(source, destination);
  if (compressed === undefined) {
    return `${sourcePath} => ${destinationPath}`;
  }
  return summaryPath(compressed, quoteNonAscii);
}

function compressRenamePath(source: string, destination: string): string | undefined {
  let common = 0;
  const maximum = Math.min(source.length, destination.length);
  while (common < maximum && source.charCodeAt(common) === destination.charCodeAt(common)) common++;
  const prefixEnd = source.lastIndexOf("/", common - 1) + 1;
  let sourceEnd = source.length;
  let destinationEnd = destination.length;
  while (
    sourceEnd > prefixEnd &&
    destinationEnd > prefixEnd &&
    source.charCodeAt(sourceEnd - 1) === destination.charCodeAt(destinationEnd - 1)
  ) {
    sourceEnd--;
    destinationEnd--;
  }
  const sourceSuffix = source.indexOf("/", sourceEnd);
  const destinationSuffix = destination.indexOf("/", destinationEnd);
  const suffixStart =
    sourceSuffix >= 0 &&
    destinationSuffix >= 0 &&
    source.slice(sourceSuffix) === destination.slice(destinationSuffix)
      ? sourceSuffix
      : source.length;
  if (prefixEnd === 0 && suffixStart === source.length) return undefined;
  const destinationSuffixStart =
    suffixStart === source.length
      ? destination.length
      : destination.length - (source.length - suffixStart);
  return (
    source.slice(0, prefixEnd) +
    `{${source.slice(prefixEnd, suffixStart)} => ${destination.slice(prefixEnd, destinationSuffixStart)}}` +
    source.slice(suffixStart)
  );
}

function shortStat(summary: CommitSummary): string {
  const parts = [`${summary.files} ${summary.files === 1 ? "file" : "files"} changed`];
  if (summary.insertions === 0 && summary.deletions === 0) {
    parts.push("0 insertions(+)", "0 deletions(-)");
  } else {
    if (summary.insertions > 0) {
      parts.push(
        `${summary.insertions} ${summary.insertions === 1 ? "insertion" : "insertions"}(+)`,
      );
    }
    if (summary.deletions > 0) {
      parts.push(`${summary.deletions} ${summary.deletions === 1 ? "deletion" : "deletions"}(-)`);
    }
  }
  return parts.join(", ");
}

function mediumDate(person: { timestamp: number; timezoneOffset: number }): string {
  const localSeconds = person.timestamp - person.timezoneOffset * 60;
  const milliseconds = localSeconds * 1000;
  if (!Number.isSafeInteger(milliseconds)) {
    throw new GitError("EINVAL", "git CLI commit identity date is outside the supported range");
  }
  const date = new Date(milliseconds);
  const weekday = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"][date.getUTCDay()];
  const month = [
    "Jan",
    "Feb",
    "Mar",
    "Apr",
    "May",
    "Jun",
    "Jul",
    "Aug",
    "Sep",
    "Oct",
    "Nov",
    "Dec",
  ][date.getUTCMonth()];
  if (weekday === undefined || month === undefined || Number.isNaN(date.getTime())) {
    throw new GitError("EINVAL", "git CLI commit identity date is outside the supported range");
  }
  const east = -person.timezoneOffset;
  const sign = east < 0 ? "-" : "+";
  const absolute = Math.abs(east);
  const twoDigits = (value: number): string => String(value).padStart(2, "0");
  return (
    `${weekday} ${month} ${date.getUTCDate()} ` +
    `${twoDigits(date.getUTCHours())}:${twoDigits(date.getUTCMinutes())}:` +
    `${twoDigits(date.getUTCSeconds())} ${date.getUTCFullYear()} ${sign}` +
    `${twoDigits(Math.floor(absolute / 60))}${twoDigits(absolute % 60)}`
  );
}

export function branchLabel(ref: string | null): string {
  if (ref === null) return "detached HEAD";
  return ref.startsWith(HEADS) ? ref.slice(HEADS.length) : ref;
}

export function abbreviate(repo: Repository, oid: string): string {
  for (let length = 7; length < oid.length; length++) {
    if (repo.store.resolvePrefix(oid.slice(0, length)) === oid) return oid.slice(0, length);
  }
  return oid;
}

export function subject(message: string): string {
  const parts: string[] = [];
  for (const line of message.split("\n")) {
    if (line.trim() === "") {
      if (parts.length > 0) break;
      continue;
    }
    parts.push(line.trimEnd());
  }
  return parts.join(" ").trimEnd();
}
