import { GitError } from "../common/errors.js";
import type { StatusEntry } from "./kinds.js";
import type { Repository } from "./repository.js";
import {
  pathOutputMetrics,
  preflightPorcelainV1,
  preflightPorcelainV2,
  StatusFormatBudget,
  validateStatusPath,
  validateStatusPaths,
} from "./status-format-budget.js";
import {
  formatHumanStatus,
  formatShortBranch,
  preflightShortBranch,
} from "./status-format-human.js";
import { formatPath, joinRecords, v2Code } from "./status-format-path.js";
import {
  resolveStatusFormatOptions,
  type StatusFormatOptions,
  validateStatusBranch,
} from "./status-format-types.js";
import type { StatusDetail } from "./status-rows.js";
import type { StatusBranch } from "./status-types.js";

const QUOTE_PATH_CONFIG_BYTES = 16;
const TRUE_CONFIG_VALUES = new Set(["1", "true", "yes", "on"]);
const FALSE_CONFIG_VALUES = new Set(["", "0", "false", "no", "off"]);
const NUMERIC_CONFIG_VALUE = /^[+-]?(?:[0-9]+|0[xX][0-9a-fA-F]+)$/;

export { formatCommitRefusalStatus } from "./status-format-human.js";
export {
  STATUS_FORMAT_MAX_OUTPUT_BYTES,
  STATUS_FORMAT_MAX_RECORDS,
  STATUS_FORMAT_MAX_RETAINED_BYTES,
  type StatusFormatOptions,
} from "./status-format-types.js";

/** Resolve explicit options over bounded `core.quotePath` configuration. */
export function statusFormatOptions(
  repo: Repository,
  overrides: StatusFormatOptions = {},
): StatusFormatOptions {
  let quotePath = overrides.quotePath;
  if (quotePath === undefined) {
    const configured = repo.store.configGetBounded("core.quotePath", QUOTE_PATH_CONFIG_BYTES);
    quotePath = configured === undefined ? true : parseQuotePath(configured);
  }
  return { quotePath, zeroTerminate: overrides.zeroTerminate ?? false };
}

function parseQuotePath(value: string): boolean {
  const normalized = value.toLowerCase();
  if (TRUE_CONFIG_VALUES.has(normalized)) return true;
  if (FALSE_CONFIG_VALUES.has(normalized)) return false;
  if (NUMERIC_CONFIG_VALUE.test(value)) {
    const unsigned = value.startsWith("+") || value.startsWith("-") ? value.slice(1) : value;
    return BigInt(unsigned) !== 0n;
  }
  throw new GitError("EINVAL", `config core.quotePath has invalid boolean value ${value}`);
}

/** `git status --porcelain=v2`, with optional `--branch` headers. */
export function formatPorcelainV2(
  entries: StatusDetail[],
  branch?: StatusBranch,
  options: StatusFormatOptions = {},
): string {
  const resolved = resolveStatusFormatOptions(options);
  validateStatusPaths(entries);
  preflightPorcelainV2(entries, branch, resolved);
  const records = branch === undefined ? [] : formatStatusBranch(branch);
  for (const entry of entries) {
    if (entry.ignored === true || entry.worktree === "?") continue;
    if (entry.unmerged === true) {
      records.push(
        `u ${entry.index}${entry.worktree} N... ` +
          `${entry.baseMode} ${entry.currentMode} ${entry.incomingMode} ${entry.worktreeMode} ` +
          `${entry.baseOid} ${entry.currentOid} ${entry.incomingOid} ` +
          formatPath(entry.path, resolved, false),
      );
      continue;
    }
    if (entry.renamed === true) {
      const prefix =
        `2 ${entry.index}${v2Code(entry.worktree)} N... ` +
        `${entry.headMode} ${entry.indexMode} ${entry.worktreeMode} ` +
        `${entry.headOid} ${entry.indexOid} R${entry.similarity} `;
      if (resolved.zeroTerminate) {
        records.push(`${prefix}${entry.path}`, entry.originalPath);
      } else {
        records.push(
          `${prefix}${formatPath(entry.path, resolved, false)}\t` +
            formatPath(entry.originalPath, resolved, false),
        );
      }
      continue;
    }
    records.push(
      `1 ${v2Code(entry.index)}${v2Code(entry.worktree)} N... ` +
        `${entry.headMode} ${entry.indexMode} ${entry.worktreeMode} ` +
        `${entry.headOid} ${entry.indexOid} ${formatPath(entry.path, resolved, false)}`,
    );
  }
  for (const entry of entries) {
    if (entry.worktree === "?") records.push(`? ${formatPath(entry.path, resolved, false)}`);
  }
  for (const entry of entries) {
    if (entry.ignored === true) records.push(`! ${formatPath(entry.path, resolved, false)}`);
  }
  return joinRecords(records, resolved.zeroTerminate);
}

function formatStatusBranch(branch: StatusBranch): string[] {
  validateStatusBranch(branch);
  const records = [
    `# branch.oid ${branch.oid ?? "(initial)"}`,
    `# branch.head ${branch.head ?? "(detached)"}`,
  ];
  if (branch.upstream !== undefined) records.push(`# branch.upstream ${branch.upstream}`);
  if (branch.ahead !== undefined || branch.behind !== undefined) {
    records.push(`# branch.ab +${branch.ahead} -${branch.behind}`);
  }
  return records;
}

/** `git status --porcelain=v1`. */
export function formatPorcelainV1(
  entries: StatusEntry[],
  options: StatusFormatOptions = {},
): string {
  const resolved = resolveStatusFormatOptions(options);
  validateStatusPaths(entries);
  preflightPorcelainV1(entries, resolved);
  const records: string[] = [];
  for (const entry of entries) {
    if (entry.worktree === "?" || entry.worktree === "!") continue;
    const prefix = `${entry.index}${entry.worktree} `;
    if (entry.originalPath !== undefined) {
      if (resolved.zeroTerminate) {
        records.push(`${prefix}${entry.path}`, entry.originalPath);
      } else {
        records.push(
          `${prefix}${formatPath(entry.originalPath, resolved, true, true)} -> ` +
            formatPath(entry.path, resolved, true, true),
        );
      }
      continue;
    }
    records.push(`${prefix}${formatPath(entry.path, resolved, true)}`);
  }
  for (const entry of entries) {
    if (entry.worktree === "?") records.push(`?? ${formatPath(entry.path, resolved, true)}`);
  }
  for (const entry of entries) {
    if (entry.worktree === "!") records.push(`!! ${formatPath(entry.path, resolved, true)}`);
  }
  return joinRecords(records, resolved.zeroTerminate);
}

/**
 * `git status --short`. Identical to porcelain v1 over the states this
 * package models — the two differ only on colour and path quoting.
 */
export function formatShort(entries: StatusEntry[], options: StatusFormatOptions = {}): string {
  return formatPorcelainV1(entries, options);
}

export type CliStatusFormat = "default" | "porcelain-v1" | "porcelain-v2" | "short";

/** Bounded status text for the exact local argv surface. */
export function formatCliStatus(
  entries: StatusDetail[],
  branch: StatusBranch,
  format: CliStatusFormat,
  includeBranch: boolean,
  options: StatusFormatOptions,
  maxOutputBytes: number,
): string {
  const resolved = resolveStatusFormatOptions(options);
  validateStatusPaths(entries);
  if (format === "default") {
    return formatHumanStatus(entries, branch, resolved, maxOutputBytes);
  }
  const budget = new StatusFormatBudget(
    maxOutputBytes,
    `git CLI status output exceeds ${maxOutputBytes} bytes`,
  );
  if (includeBranch && format !== "porcelain-v2") preflightShortBranch(branch, budget);
  if (format === "porcelain-v2") {
    preflightPorcelainV2(entries, includeBranch ? branch : undefined, resolved, budget);
  } else {
    preflightPorcelainV1(entries, resolved, budget);
  }
  const header = includeBranch ? (format === "porcelain-v2" ? "" : formatShortBranch(branch)) : "";
  if (format === "porcelain-v2") {
    return formatPorcelainV2(entries, includeBranch ? branch : undefined, options);
  }
  return `${header}${format === "short" ? formatShort(entries, options) : formatPorcelainV1(entries, options)}`;
}

/** Quote and frame path rows like Git while respecting the caller's exact ceiling. */
export function formatCliPathLines(
  paths: readonly string[],
  options: StatusFormatOptions,
  maxOutputBytes: number,
): string {
  const resolved = resolveStatusFormatOptions(options);
  for (const path of paths) validateStatusPath(path);
  const budget = new StatusFormatBudget(
    maxOutputBytes,
    `git CLI stdout exceeds ${maxOutputBytes} bytes`,
  );
  for (const path of paths) budget.addRecord(pathOutputMetrics(path, resolved, false, false));
  const records = paths.map((path) => formatPath(path, resolved, false));
  return joinRecords(records, false);
}
