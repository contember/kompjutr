import type { IgnoreMatcher } from "../../ignore/index.js";
import type { StatusDetail, StatusOptions } from "./status-rows.js";

export interface StatusBranch {
  /** Full commit OID, or null for an unborn branch. */
  oid: string | null;
  /** Checked-out branch name, or null for detached HEAD. */
  head: string | null;
  upstream?: string;
  ahead?: number;
  behind?: number;
}

export interface StatusReport {
  entries: StatusDetail[];
  branch?: StatusBranch;
}

export interface StatusReportOptions extends StatusOptions {
  /** Include porcelain-v2 branch metadata. */
  branch?: boolean;
}

export interface CleanOptions {
  paths?: string[];
  excludeRoots?: string[];
  ignores?: IgnoreMatcher;
  /** Descend into untracked directories and remove them whole (`-d`). */
  directories?: boolean;
  /** Report what would go without removing anything (`-n`). */
  dryRun?: boolean;
}

/** Retained index, directory and tracked-path state for one status call. */
export const STATUS_RETAINED_BYTES = 16 * 1024 * 1024;
export const STATUS_WINDOW_ROWS = 1000;
export const DIRECTORY_FIXED_BYTES = 96;

export function statusStringBytes(value: string): number {
  return 48 + value.length * 2;
}
