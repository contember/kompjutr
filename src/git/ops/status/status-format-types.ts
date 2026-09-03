import { GitError } from "../../common/errors.js";
import type { StatusBranch } from "./status-types.js";

/** Leaves headroom for source rows, record strings, and the joined result below 100 MiB. */
export const STATUS_FORMAT_MAX_RETAINED_BYTES = 16 * 1024 * 1024;
export const STATUS_FORMAT_MAX_OUTPUT_BYTES = 16 * 1024 * 1024;
export const STATUS_FORMAT_MAX_RECORDS = 65_536;
export const STATUS_FORMAT_MAX_CODE_UNITS = STATUS_FORMAT_MAX_RETAINED_BYTES / 2;
export const STATUS_PATH_ERROR = "status paths must be NUL-free well-formed UTF-16";
export const STATUS_BUDGET_ERROR = "status formatting exceeds its bounded output budget";

export interface StatusFormatOptions {
  /** Escape non-ASCII UTF-8 bytes using Git's C-style octal form. */
  quotePath?: boolean;
  /** Use NUL record framing and leave paths byte-transparent. */
  zeroTerminate?: boolean;
}

export interface ResolvedStatusFormatOptions {
  quotePath: boolean;
  zeroTerminate: boolean;
}

export function resolveStatusFormatOptions(
  options: StatusFormatOptions,
): ResolvedStatusFormatOptions {
  return {
    quotePath: options.quotePath ?? true,
    zeroTerminate: options.zeroTerminate ?? false,
  };
}

export function validateStatusBranch(branch: StatusBranch): void {
  if (
    (branch.ahead !== undefined || branch.behind !== undefined) &&
    (branch.upstream === undefined || branch.ahead === undefined || branch.behind === undefined)
  ) {
    throw new GitError("EINVAL", "status branch counts require an upstream and both counts");
  }
}
