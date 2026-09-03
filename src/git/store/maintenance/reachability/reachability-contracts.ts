import type { ObjectType } from "../../../common/objects.js";
import type { MaintenanceRunView } from "../state/state-contracts.js";

export const EDGE_PAGE = 256;
// Bounds one synchronous mark transaction: each expansion reads one queue row and its edge page.
export const MARK_EXPANSIONS_PER_CALL = 64;

export type MaintenanceReachabilityStatus = "progress" | "complete" | "root-changed";

export interface MaintenanceReachabilityProgress {
  runId: number;
  status: MaintenanceReachabilityStatus;
  processedOid: string | null;
  discoveredObjects: number;
  discoveredLogicalObjects: number;
}

export type RunState = MaintenanceRunView;

export interface QueueObject {
  oid: string;
  sourceMask: number;
  shallowBoundary: boolean;
  physicalOnly: boolean;
  edgeCursor: number;
}

export interface ReachabilityEdge {
  oid: string;
  type: ObjectType;
  optionalMissing: boolean;
  allowPromisedMissing: boolean;
  physicalOnly: boolean;
}

export interface ObjectExpansion {
  edges: ReachabilityEdge[];
  nextCursor: number;
  complete: boolean;
}

export interface HeaderScanResult {
  treeOid: string | null;
  parentOids: string[];
  parentCount: number;
  tagOid: string | null;
  tagType: ObjectType | null;
}

export interface NormalizedEdge extends ReachabilityEdge {
  present: boolean;
}

export interface ExistingMark {
  exists: boolean;
  physicalOnly: boolean;
  expanded: boolean;
  edgeCursor: number;
}

export interface PublicationResult {
  discoveredObjects: number;
  discoveredLogicalObjects: number;
  queuedObjects: number;
  reachableObjects: number;
}

export interface ReachabilityObjectInfo {
  oid: string;
  type: ObjectType;
  size: number;
  source: "loose" | "pack";
  stored: "raw" | "zlib" | null;
}
