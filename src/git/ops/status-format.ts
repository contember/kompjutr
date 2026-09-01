import { utf8 } from "../common/bytes.js";
import { GitError } from "../common/errors.js";
import type { StatusEntry } from "./kinds.js";
import type { Repository } from "./repository.js";
import type { StatusBranch } from "./status.js";
import type { StatusDetail } from "./status-rows.js";

const QUOTE_PATH_CONFIG_BYTES = 16;
const TRUE_CONFIG_VALUES = new Set(["1", "true", "yes", "on"]);
const FALSE_CONFIG_VALUES = new Set(["", "0", "false", "no", "off"]);
const NUMERIC_CONFIG_VALUE = /^[+-]?(?:[0-9]+|0[xX][0-9a-fA-F]+)$/;

/** Leaves headroom for source rows, record strings, and the joined result below 100 MiB. */
export const STATUS_FORMAT_MAX_RETAINED_BYTES = 16 * 1024 * 1024;
export const STATUS_FORMAT_MAX_OUTPUT_BYTES = 16 * 1024 * 1024;
export const STATUS_FORMAT_MAX_RECORDS = 65_536;
const STATUS_FORMAT_MAX_CODE_UNITS = STATUS_FORMAT_MAX_RETAINED_BYTES / 2;
const STATUS_PATH_ERROR = "status paths must be NUL-free well-formed UTF-16";
const STATUS_BUDGET_ERROR = "status formatting exceeds its bounded output budget";

export interface StatusFormatOptions {
  /** Escape non-ASCII UTF-8 bytes using Git's C-style octal form. */
  quotePath?: boolean;
  /** Use NUL record framing and leave paths byte-transparent. */
  zeroTerminate?: boolean;
}

interface ResolvedStatusFormatOptions {
  quotePath: boolean;
  zeroTerminate: boolean;
}

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

function resolveOptions(options: StatusFormatOptions): ResolvedStatusFormatOptions {
  return {
    quotePath: options.quotePath ?? true,
    zeroTerminate: options.zeroTerminate ?? false,
  };
}

/** `git status --porcelain=v2`, with optional `--branch` headers. */
export function formatPorcelainV2(
  entries: StatusDetail[],
  branch?: StatusBranch,
  options: StatusFormatOptions = {},
): string {
  const resolved = resolveOptions(options);
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

function validateStatusBranch(branch: StatusBranch): void {
  if (
    (branch.ahead !== undefined || branch.behind !== undefined) &&
    (branch.upstream === undefined || branch.ahead === undefined || branch.behind === undefined)
  ) {
    throw new GitError("EINVAL", "status branch counts require an upstream and both counts");
  }
}

/** `git status --porcelain=v1`. */
export function formatPorcelainV1(
  entries: StatusEntry[],
  options: StatusFormatOptions = {},
): string {
  const resolved = resolveOptions(options);
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
  const resolved = resolveOptions(options);
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
  const resolved = resolveOptions(options);
  for (const path of paths) validateStatusPath(path);
  const budget = new StatusFormatBudget(
    maxOutputBytes,
    `git CLI stdout exceeds ${maxOutputBytes} bytes`,
  );
  for (const path of paths) budget.addRecord(pathOutputMetrics(path, resolved, false, false));
  const records = paths.map((path) => formatPath(path, resolved, false));
  return joinRecords(records, false);
}

function formatShortBranch(branch: StatusBranch): string {
  validateStatusBranch(branch);
  if (branch.head === null) return "## HEAD (no branch)\n";
  if (branch.oid === null) return `## No commits yet on ${branch.head}\n`;
  if (branch.upstream === undefined) return `## ${branch.head}\n`;
  let suffix = "";
  if (branch.ahead === undefined || branch.behind === undefined) suffix = " [gone]";
  else if (branch.ahead > 0 && branch.behind > 0) {
    suffix = ` [ahead ${branch.ahead}, behind ${branch.behind}]`;
  } else if (branch.ahead > 0) suffix = ` [ahead ${branch.ahead}]`;
  else if (branch.behind > 0) suffix = ` [behind ${branch.behind}]`;
  return `## ${branch.head}...${branch.upstream}${suffix}\n`;
}

function preflightShortBranch(branch: StatusBranch, budget: StatusFormatBudget): void {
  const line = formatShortBranch(branch);
  budget.addRecord(outputMetrics(line.slice(0, -1)));
}

function formatHumanStatus(
  entries: readonly StatusDetail[],
  branch: StatusBranch,
  options: ResolvedStatusFormatOptions,
  maximum: number,
): string {
  validateStatusBranch(branch);
  const out = new StatusTextOutput(maximum, `git CLI status output exceeds ${maximum} bytes`);
  if (branch.head === null) out.append(`HEAD detached at ${branch.oid?.slice(0, 7)}\n`);
  else out.append(`On branch ${branch.head}\n`);
  appendHumanTracking(out, branch);
  if (branch.oid === null) out.append("\nNo commits yet\n\n");

  const staged = entries.filter((entry) => humanStaged(entry));
  const unmerged = entries.filter((entry) => entry.unmerged === true);
  const unstaged = entries.filter((entry) => humanUnstaged(entry));
  const untracked = entries.filter((entry) => entry.worktree === "?");
  if (staged.length > 0) {
    out.append(
      "Changes to be committed:\n" + '  (use "git restore --staged <file>..." to unstage)\n',
    );
    for (const entry of staged) appendHumanEntry(out, stagedLabel(entry), entry, options);
    out.append("\n");
  }
  if (unmerged.length > 0) {
    const deletion = unmerged.some((entry) => {
      const code = `${entry.index}${entry.worktree}`;
      return code === "DD" || code === "UD" || code === "DU";
    });
    out.append(
      "Unmerged paths:\n" +
        '  (use "git restore --staged <file>..." to unstage)\n' +
        (deletion
          ? '  (use "git add/rm <file>..." as appropriate to mark resolution)\n'
          : '  (use "git add <file>..." to mark resolution)\n'),
    );
    for (const entry of unmerged) {
      out.append(`\t${unmergedLabel(entry)}:   ${formatPath(entry.path, options, true)}\n`);
    }
    out.append("\n");
  }
  if (unstaged.length > 0) {
    out.append(
      "Changes not staged for commit:\n" +
        '  (use "git add <file>..." to update what will be committed)\n' +
        '  (use "git restore <file>..." to discard changes in working directory)\n',
    );
    for (const entry of unstaged) appendHumanEntry(out, commitWorktreeLabel(entry), entry, options);
    out.append("\n");
  }
  if (untracked.length > 0) {
    out.append(
      "Untracked files:\n" + '  (use "git add <file>..." to include in what will be committed)\n',
    );
    for (const entry of untracked) {
      out.append(`\t${formatPath(entry.path, options, true)}\n`);
    }
    out.append("\n");
  }
  if (unmerged.length > 0) {
    out.append('no changes added to commit (use "git add" and/or "git commit -a")\n');
    return out.finish();
  }
  if (staged.length > 0) return out.finish();
  if (unstaged.length > 0) {
    out.append('no changes added to commit (use "git add" and/or "git commit -a")\n');
  } else if (untracked.length > 0) {
    out.append('nothing added to commit but untracked files present (use "git add" to track)\n');
  } else if (branch.oid === null) {
    out.append('nothing to commit (create/copy files and use "git add" to track)\n');
  } else out.append("nothing to commit, working tree clean\n");
  return out.finish();
}

function appendHumanTracking(out: StatusTextOutput, branch: StatusBranch): void {
  if (branch.upstream === undefined) return;
  if (branch.ahead === undefined || branch.behind === undefined) {
    out.append(
      `Your branch is based on '${branch.upstream}', but the upstream is gone.\n` +
        '  (use "git branch --unset-upstream" to fixup)\n\n',
    );
  } else if (branch.ahead === 0 && branch.behind === 0) {
    out.append(`Your branch is up to date with '${branch.upstream}'.\n\n`);
  } else if (branch.ahead > 0 && branch.behind > 0) {
    out.append(
      `Your branch and '${branch.upstream}' have diverged,\n` +
        `and have ${branch.ahead} and ${branch.behind} different commits each, respectively.\n` +
        '  (use "git pull" if you want to integrate the remote branch with yours)\n\n',
    );
  } else if (branch.ahead > 0) {
    out.append(
      `Your branch is ahead of '${branch.upstream}' by ${branch.ahead} commit${branch.ahead === 1 ? "" : "s"}.\n` +
        '  (use "git push" to publish your local commits)\n\n',
    );
  } else if (branch.behind > 0) {
    out.append(
      `Your branch is behind '${branch.upstream}' by ${branch.behind} commit${branch.behind === 1 ? "" : "s"}, and can be fast-forwarded.\n` +
        '  (use "git pull" to update your local branch)\n\n',
    );
  }
}

function humanStaged(entry: StatusDetail): boolean {
  return (
    entry.ignored !== true &&
    entry.unmerged !== true &&
    entry.worktree !== "?" &&
    entry.index !== " "
  );
}

function humanUnstaged(entry: StatusDetail): boolean {
  return (
    entry.ignored !== true &&
    entry.unmerged !== true &&
    entry.worktree !== "?" &&
    entry.worktree !== " "
  );
}

function stagedLabel(entry: StatusDetail): "new file" | "modified" | "deleted" | "renamed" {
  if (entry.renamed === true) return "renamed";
  if (entry.index === "A") return "new file";
  if (entry.index === "D") return "deleted";
  return "modified";
}

function unmergedLabel(entry: StatusDetail): string {
  const code = `${entry.index}${entry.worktree}`;
  if (code === "DD") return "both deleted";
  if (code === "AU") return "added by us";
  if (code === "UD") return "deleted by them";
  if (code === "UA") return "added by them";
  if (code === "DU") return "deleted by us";
  if (code === "AA") return "both added";
  return "both modified";
}

function appendHumanEntry(
  out: StatusTextOutput,
  label: string,
  entry: StatusDetail,
  options: ResolvedStatusFormatOptions,
): void {
  const path =
    "originalPath" in entry && entry.originalPath !== undefined
      ? `${formatPath(entry.originalPath, options, true, true)} -> ${formatPath(entry.path, options, true, true)}`
      : formatPath(entry.path, options, true);
  out.append(`\t${`${label}:`.padEnd(12, " ")}${path}\n`);
}

/** Long status text used when `git commit` finds an unchanged index tree. */
export function formatCommitRefusalStatus(
  entries: StatusDetail[],
  branch: string,
  options: StatusFormatOptions = {},
  maxOutputBytes = STATUS_FORMAT_MAX_OUTPUT_BYTES,
): string {
  const resolved = resolveOptions(options);
  validateStatusPaths(entries);
  const out = new StatusTextOutput(maxOutputBytes);
  out.append(`On branch ${branch}\n`);
  let unstaged = false;
  let untracked = false;
  for (const entry of entries) {
    if (entry.worktree === "?") untracked = true;
    else if (entry.ignored !== true && entry.unmerged !== true && entry.worktree !== " ") {
      unstaged = true;
    }
  }
  if (!unstaged && !untracked) {
    out.append("nothing to commit, working tree clean\n");
    return out.finish();
  }
  if (unstaged) {
    out.append(
      "Changes not staged for commit:\n" +
        '  (use "git add <file>..." to update what will be committed)\n' +
        '  (use "git restore <file>..." to discard changes in working directory)\n',
    );
    for (const entry of entries) {
      if (
        entry.ignored === true ||
        entry.unmerged === true ||
        entry.worktree === "?" ||
        entry.worktree === " "
      ) {
        continue;
      }
      const label = commitWorktreeLabel(entry);
      out.append(`\t${`${label}:`.padEnd(12, " ")}${formatPath(entry.path, resolved, true)}\n`);
    }
    out.append("\n");
  }
  if (untracked) {
    out.append(
      "Untracked files:\n" + '  (use "git add <file>..." to include in what will be committed)\n',
    );
    for (const entry of entries) {
      if (entry.worktree !== "?") continue;
      out.append(`\t${formatPath(entry.path, resolved, true)}\n`);
    }
    out.append("\n");
  }
  out.append(
    unstaged
      ? 'no changes added to commit (use "git add" and/or "git commit -a")\n'
      : 'nothing added to commit but untracked files present (use "git add" to track)\n',
  );
  return out.finish();
}

function commitWorktreeLabel(entry: StatusDetail): "deleted" | "modified" | "typechange" {
  if (entry.worktree === "D") return "deleted";
  if (
    entry.unmerged !== true &&
    entry.ignored !== true &&
    "indexMode" in entry &&
    "worktreeMode" in entry &&
    entry.indexMode.slice(0, 3) !== entry.worktreeMode.slice(0, 3)
  ) {
    return "typechange";
  }
  return "modified";
}

class StatusTextOutput {
  #bytes = 0;
  #output = "";
  readonly #maximum: number;
  readonly #error: string;

  constructor(maximum: number, error = STATUS_BUDGET_ERROR) {
    if (!Number.isSafeInteger(maximum) || maximum < 0) {
      throw new GitError("EINVAL", "status output ceiling must be a safe nonnegative integer");
    }
    this.#maximum = Math.min(maximum, STATUS_FORMAT_MAX_OUTPUT_BYTES);
    this.#error = error;
  }

  append(value: string): void {
    const metrics = outputMetrics(value);
    if (metrics.utf8Bytes > this.#maximum - this.#bytes) {
      throw new GitError("E2BIG", this.#error);
    }
    this.#bytes += metrics.utf8Bytes;
    this.#output += value;
  }

  finish(): string {
    return this.#output;
  }
}

interface OutputMetrics {
  codeUnits: number;
  utf8Bytes: number;
}

type OutputMetricPart = string | OutputMetrics;

class StatusFormatBudget {
  #records = 0;
  #codeUnits = 0;
  #utf8Bytes = 0;

  constructor(
    private readonly maximum = STATUS_FORMAT_MAX_OUTPUT_BYTES,
    private readonly error = STATUS_BUDGET_ERROR,
  ) {
    if (!Number.isSafeInteger(maximum) || maximum < 0) {
      throw new GitError("EINVAL", "status output ceiling must be a safe nonnegative integer");
    }
  }

  addRecord(metrics: OutputMetrics): void {
    if (this.#records >= STATUS_FORMAT_MAX_RECORDS) throwStatusBudget();
    this.#records++;
    this.#codeUnits = boundedAdd(this.#codeUnits, metrics.codeUnits, STATUS_FORMAT_MAX_CODE_UNITS);
    this.#codeUnits = boundedAdd(this.#codeUnits, 1, STATUS_FORMAT_MAX_CODE_UNITS);
    this.#utf8Bytes = boundedAdd(
      this.#utf8Bytes,
      metrics.utf8Bytes,
      Math.min(this.maximum, STATUS_FORMAT_MAX_OUTPUT_BYTES),
      this.error,
    );
    this.#utf8Bytes = boundedAdd(
      this.#utf8Bytes,
      1,
      Math.min(this.maximum, STATUS_FORMAT_MAX_OUTPUT_BYTES),
      this.error,
    );
  }
}

function throwStatusBudget(): never {
  throw new GitError("E2BIG", STATUS_BUDGET_ERROR);
}

function boundedAdd(
  current: number,
  additional: number,
  ceiling: number,
  error = STATUS_BUDGET_ERROR,
): number {
  if (
    !Number.isSafeInteger(current) ||
    !Number.isSafeInteger(additional) ||
    additional < 0 ||
    additional > ceiling - current
  ) {
    throw new GitError("E2BIG", error);
  }
  return current + additional;
}

function validateStatusPaths(entries: readonly StatusEntry[]): void {
  for (const entry of entries) {
    validateStatusPath(entry.path);
    if (entry.originalPath !== undefined) validateStatusPath(entry.originalPath);
  }
}

function validateStatusPath(path: unknown): void {
  if (typeof path !== "string") throw new GitError("EINVAL", STATUS_PATH_ERROR);
  for (let index = 0; index < path.length; index++) {
    const code = path.charCodeAt(index);
    if (code === 0) throw new GitError("EINVAL", STATUS_PATH_ERROR);
    if (code >= 0xd800 && code <= 0xdbff) {
      const low = path.charCodeAt(index + 1);
      if (low < 0xdc00 || low > 0xdfff) throw new GitError("EINVAL", STATUS_PATH_ERROR);
      index++;
    } else if (code >= 0xdc00 && code <= 0xdfff) {
      throw new GitError("EINVAL", STATUS_PATH_ERROR);
    }
  }
  if (path.length > STATUS_FORMAT_MAX_CODE_UNITS) throwStatusBudget();
}

function preflightPorcelainV1(
  entries: readonly StatusEntry[],
  options: ResolvedStatusFormatOptions,
  budget = new StatusFormatBudget(),
): void {
  for (const entry of entries) {
    if (entry.worktree === "?" || entry.worktree === "!") continue;
    const prefix = outputMetrics(`${entry.index}${entry.worktree} `);
    if (entry.originalPath === undefined) {
      budget.addRecord(combineMetrics(prefix, pathOutputMetrics(entry.path, options, true, false)));
    } else if (options.zeroTerminate) {
      budget.addRecord(combineMetrics(prefix, pathOutputMetrics(entry.path, options, true, true)));
      budget.addRecord(pathOutputMetrics(entry.originalPath, options, true, true));
    } else {
      budget.addRecord(
        combineMetrics(
          prefix,
          pathOutputMetrics(entry.originalPath, options, true, true),
          " -> ",
          pathOutputMetrics(entry.path, options, true, true),
        ),
      );
    }
  }
  for (const entry of entries) {
    if (entry.worktree === "?") {
      budget.addRecord(combineMetrics("?? ", pathOutputMetrics(entry.path, options, true, false)));
    }
  }
  for (const entry of entries) {
    if (entry.worktree === "!") {
      budget.addRecord(combineMetrics("!! ", pathOutputMetrics(entry.path, options, true, false)));
    }
  }
}

function preflightPorcelainV2(
  entries: readonly StatusDetail[],
  branch: StatusBranch | undefined,
  options: ResolvedStatusFormatOptions,
  budget = new StatusFormatBudget(),
): void {
  if (branch !== undefined) preflightStatusBranch(branch, budget);
  for (const entry of entries) {
    if (entry.ignored === true || entry.worktree === "?") continue;
    if (entry.unmerged === true) {
      budget.addRecord(
        combineMetrics(
          `u ${entry.index}${entry.worktree} N... `,
          entry.baseMode,
          " ",
          entry.currentMode,
          " ",
          entry.incomingMode,
          " ",
          entry.worktreeMode,
          " ",
          entry.baseOid,
          " ",
          entry.currentOid,
          " ",
          entry.incomingOid,
          " ",
          pathOutputMetrics(entry.path, options, false, false),
        ),
      );
      continue;
    }
    if (entry.renamed === true) {
      const prefix = combineMetrics(
        `2 ${entry.index}${v2Code(entry.worktree)} N... `,
        entry.headMode,
        " ",
        entry.indexMode,
        " ",
        entry.worktreeMode,
        " ",
        entry.headOid,
        " ",
        entry.indexOid,
        ` R${entry.similarity} `,
      );
      if (options.zeroTerminate) {
        budget.addRecord(
          combineMetrics(prefix, pathOutputMetrics(entry.path, options, false, false)),
        );
        budget.addRecord(pathOutputMetrics(entry.originalPath, options, false, false));
      } else {
        budget.addRecord(
          combineMetrics(
            prefix,
            pathOutputMetrics(entry.path, options, false, false),
            "\t",
            pathOutputMetrics(entry.originalPath, options, false, false),
          ),
        );
      }
      continue;
    }
    budget.addRecord(
      combineMetrics(
        `1 ${v2Code(entry.index)}${v2Code(entry.worktree)} N... `,
        entry.headMode,
        " ",
        entry.indexMode,
        " ",
        entry.worktreeMode,
        " ",
        entry.headOid,
        " ",
        entry.indexOid,
        " ",
        pathOutputMetrics(entry.path, options, false, false),
      ),
    );
  }
  for (const entry of entries) {
    if (entry.worktree === "?") {
      budget.addRecord(combineMetrics("? ", pathOutputMetrics(entry.path, options, false, false)));
    }
  }
  for (const entry of entries) {
    if (entry.ignored === true) {
      budget.addRecord(combineMetrics("! ", pathOutputMetrics(entry.path, options, false, false)));
    }
  }
}

function preflightStatusBranch(branch: StatusBranch, budget: StatusFormatBudget): void {
  validateStatusBranch(branch);
  budget.addRecord(combineMetrics("# branch.oid ", branch.oid ?? "(initial)"));
  budget.addRecord(combineMetrics("# branch.head ", branch.head ?? "(detached)"));
  if (branch.upstream !== undefined) {
    budget.addRecord(combineMetrics("# branch.upstream ", branch.upstream));
  }
  if (branch.ahead !== undefined && branch.behind !== undefined) {
    budget.addRecord(
      combineMetrics("# branch.ab +", String(branch.ahead), " -", String(branch.behind)),
    );
  }
}

function combineMetrics(...parts: readonly OutputMetricPart[]): OutputMetrics {
  let codeUnits = 0;
  let utf8Bytes = 0;
  for (const part of parts) {
    const metrics = typeof part === "string" ? outputMetrics(part) : part;
    codeUnits = boundedAdd(codeUnits, metrics.codeUnits, STATUS_FORMAT_MAX_CODE_UNITS);
    utf8Bytes = boundedAdd(utf8Bytes, metrics.utf8Bytes, STATUS_FORMAT_MAX_OUTPUT_BYTES);
  }
  return { codeUnits, utf8Bytes };
}

function outputMetrics(value: string): OutputMetrics {
  let utf8Bytes = 0;
  for (let index = 0; index < value.length; index++) {
    const code = value.charCodeAt(index);
    if (code <= 0x7f) utf8Bytes = boundedAdd(utf8Bytes, 1, STATUS_FORMAT_MAX_OUTPUT_BYTES);
    else if (code <= 0x7ff) utf8Bytes = boundedAdd(utf8Bytes, 2, STATUS_FORMAT_MAX_OUTPUT_BYTES);
    else if (code >= 0xd800 && code <= 0xdbff) {
      const low = value.charCodeAt(index + 1);
      if (low >= 0xdc00 && low <= 0xdfff) index++;
      utf8Bytes = boundedAdd(
        utf8Bytes,
        low >= 0xdc00 && low <= 0xdfff ? 4 : 3,
        STATUS_FORMAT_MAX_OUTPUT_BYTES,
      );
    } else {
      utf8Bytes = boundedAdd(utf8Bytes, 3, STATUS_FORMAT_MAX_OUTPUT_BYTES);
    }
  }
  if (value.length > STATUS_FORMAT_MAX_CODE_UNITS) throwStatusBudget();
  return { codeUnits: value.length, utf8Bytes };
}

function pathOutputMetrics(
  path: string,
  options: ResolvedStatusFormatOptions,
  quoteEdgeSpaces: boolean,
  quoteRenameSeparator: boolean,
): OutputMetrics {
  if (options.zeroTerminate) return outputMetrics(path);
  let quoted =
    (quoteEdgeSpaces && edgeSpace(path)) || (quoteRenameSeparator && path.includes(" -> "));
  let codeUnits = 0;
  let utf8Bytes = 0;
  for (let index = 0; index < path.length; index++) {
    const code = path.charCodeAt(index);
    if (code < 0x80) {
      const escaped = escapeAscii(code);
      const length = escaped === null ? 1 : escaped.length;
      if (escaped !== null) quoted = true;
      codeUnits = boundedAdd(codeUnits, length, STATUS_FORMAT_MAX_CODE_UNITS);
      utf8Bytes = boundedAdd(utf8Bytes, length, STATUS_FORMAT_MAX_OUTPUT_BYTES);
      continue;
    }
    let sourceCodeUnits = 1;
    let sourceUtf8Bytes = code <= 0x7ff ? 2 : 3;
    if (code >= 0xd800 && code <= 0xdbff) {
      sourceCodeUnits = 2;
      sourceUtf8Bytes = 4;
      index++;
    }
    if (options.quotePath) {
      quoted = true;
      const escapedLength = sourceUtf8Bytes * 4;
      codeUnits = boundedAdd(codeUnits, escapedLength, STATUS_FORMAT_MAX_CODE_UNITS);
      utf8Bytes = boundedAdd(utf8Bytes, escapedLength, STATUS_FORMAT_MAX_OUTPUT_BYTES);
    } else {
      codeUnits = boundedAdd(codeUnits, sourceCodeUnits, STATUS_FORMAT_MAX_CODE_UNITS);
      utf8Bytes = boundedAdd(utf8Bytes, sourceUtf8Bytes, STATUS_FORMAT_MAX_OUTPUT_BYTES);
    }
  }
  if (quoted) {
    codeUnits = boundedAdd(codeUnits, 2, STATUS_FORMAT_MAX_CODE_UNITS);
    utf8Bytes = boundedAdd(utf8Bytes, 2, STATUS_FORMAT_MAX_OUTPUT_BYTES);
  }
  return { codeUnits, utf8Bytes };
}

function formatPath(
  path: string,
  options: ResolvedStatusFormatOptions,
  quoteEdgeSpaces: boolean,
  quoteRenameSeparator = false,
): string {
  if (options.zeroTerminate) return path;
  return options.quotePath
    ? quoteUtf8Bytes(path, quoteEdgeSpaces, quoteRenameSeparator)
    : quoteUnicodePath(path, quoteEdgeSpaces, quoteRenameSeparator);
}

function quoteUtf8Bytes(
  path: string,
  quoteEdgeSpaces: boolean,
  quoteRenameSeparator: boolean,
): string {
  let quoted =
    (quoteEdgeSpaces && edgeSpace(path)) || (quoteRenameSeparator && path.includes(" -> "));
  let output = "";
  for (const byte of utf8.encode(path)) {
    const escaped = escapeAscii(byte);
    if (escaped !== null) {
      quoted = true;
      output += escaped;
    } else if (byte >= 0x80) {
      quoted = true;
      output += octal(byte);
    } else {
      output += String.fromCharCode(byte);
    }
  }
  return quoted ? `"${output}"` : output;
}

function quoteUnicodePath(
  path: string,
  quoteEdgeSpaces: boolean,
  quoteRenameSeparator: boolean,
): string {
  let quoted =
    (quoteEdgeSpaces && edgeSpace(path)) || (quoteRenameSeparator && path.includes(" -> "));
  let output = "";
  for (const character of path) {
    const code = character.codePointAt(0);
    if (code === undefined) throw new GitError("ECORRUPT", "status path contains no code point");
    const escaped = code < 0x80 ? escapeAscii(code) : null;
    if (escaped !== null) {
      quoted = true;
      output += escaped;
    } else {
      output += character;
    }
  }
  return quoted ? `"${output}"` : output;
}

function escapeAscii(byte: number): string | null {
  if (byte === 0x07) return "\\a";
  if (byte === 0x08) return "\\b";
  if (byte === 0x09) return "\\t";
  if (byte === 0x0a) return "\\n";
  if (byte === 0x0b) return "\\v";
  if (byte === 0x0c) return "\\f";
  if (byte === 0x0d) return "\\r";
  if (byte === 0x22) return '\\"';
  if (byte === 0x5c) return "\\\\";
  if (byte < 0x20 || byte === 0x7f) return octal(byte);
  return null;
}

function octal(byte: number): string {
  return `\\${byte.toString(8).padStart(3, "0")}`;
}

function edgeSpace(path: string): boolean {
  return path.startsWith(" ") || path.endsWith(" ");
}

/** Porcelain v2 spells "unmodified" as a dot where v1 uses a space. */
function v2Code(code: string): string {
  return code === " " ? "." : code;
}

function joinRecords(records: string[], zeroTerminate: boolean): string {
  if (records.length === 0) return "";
  const terminator = zeroTerminate ? "\0" : "\n";
  return `${records.join(terminator)}${terminator}`;
}
