// `status`, its three formatters, and `clean`.
//
// The merge-join traversal, retained prepass, matrix, and clean phases live in
// focused sidecars; this module preserves the public entry point.

export { clean } from "./status-clean.js";
export { eagerStatus, status, statusBranch, statusReport, statusStream } from "./status-core.js";
export { formatPorcelainV1, formatPorcelainV2, formatShort } from "./status-format.js";
export { statusIndexRetainedBytes } from "./status-full.js";
export { statusMatrix } from "./status-matrix.js";
export type { StatusDetail, StatusOptions } from "./status-rows.js";
export {
  type CleanOptions,
  STATUS_RETAINED_BYTES,
  type StatusBranch,
  type StatusReport,
  type StatusReportOptions,
} from "./status-types.js";
