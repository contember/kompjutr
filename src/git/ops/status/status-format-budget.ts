import { GitError } from "../../common/errors.js";
import type { StatusEntry } from "../core/kinds.js";
import { edgeSpace, escapeAscii, v2Code } from "./status-format-path.js";
import {
  type ResolvedStatusFormatOptions,
  STATUS_BUDGET_ERROR,
  STATUS_FORMAT_MAX_CODE_UNITS,
  STATUS_FORMAT_MAX_OUTPUT_BYTES,
  STATUS_FORMAT_MAX_RECORDS,
  STATUS_PATH_ERROR,
  validateStatusBranch,
} from "./status-format-types.js";
import type { StatusDetail } from "./status-rows.js";
import type { StatusBranch } from "./status-types.js";

export class StatusTextOutput {
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

export interface OutputMetrics {
  codeUnits: number;
  utf8Bytes: number;
}

type OutputMetricPart = string | OutputMetrics;

export class StatusFormatBudget {
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

export function validateStatusPaths(entries: readonly StatusEntry[]): void {
  for (const entry of entries) {
    validateStatusPath(entry.path);
    if (entry.originalPath !== undefined) validateStatusPath(entry.originalPath);
  }
}

export function validateStatusPath(path: unknown): void {
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

export function preflightPorcelainV1(
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

export function preflightPorcelainV2(
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

export function outputMetrics(value: string): OutputMetrics {
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

export function pathOutputMetrics(
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
