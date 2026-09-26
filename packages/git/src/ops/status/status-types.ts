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

export const STATUS_MAX_PATHS = 30_000;
export const STATUS_MAX_DIRECTORIES = 30_000;
export const STATUS_WINDOW_ROWS = 1000;
