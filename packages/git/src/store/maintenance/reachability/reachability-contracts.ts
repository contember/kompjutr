import type { MaintenanceRunView } from "../state/state-contracts.js";

export type {
  HeaderScanResult,
  ObjectExpansion,
  QueueObject,
  ReachabilityEdge,
  ReachabilityObjectInfo,
} from "../../graph/semantic-contracts.js";
export { EDGE_PAGE } from "../../graph/semantic-contracts.js";

import type { ReachabilityEdge } from "../../graph/semantic-contracts.js";
// Bounds one synchronous mark transaction: each expansion reads one queue row and its edge page.
export const MARK_EXPANSIONS_PER_CALL = 64;

export type MaintenanceReachabilityStatus = "progress" | "complete" | "root-changed";

export interface MaintenanceReachabilityProgress {
  runId: number;
  status: MaintenanceReachabilityStatus;
  processedOid: string | null;
  discoveredObjects: number;
}

export type RunState = MaintenanceRunView;

export interface NormalizedEdge extends ReachabilityEdge {
  present: boolean;
}

export interface PublicationResult {
  discoveredObjects: number;
  queuedObjects: number;
  reachableObjects: number;
}
