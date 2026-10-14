import type { ObjectType } from "../../common/objects.js";

export const EDGE_PAGE = 256;

export interface QueueObject {
  oid: string;
  sourceMask: number;
  shallowBoundary: boolean;
  edgeCursor: number;
  /** Byte offset of entry `edgeCursor` when an unprojected tree was paged; null otherwise. */
  edgeOffset: number | null;
}

export interface ReachabilityEdge {
  oid: string;
  type: ObjectType;
  optionalMissing: boolean;
  allowPromisedMissing: boolean;
}

export interface ObjectExpansion {
  edges: ReachabilityEdge[];
  nextCursor: number;
  nextOffset: number | null;
  complete: boolean;
}

export interface HeaderScanResult {
  treeOid: string | null;
  parentOids: string[];
  parentCount: number;
  tagOid: string | null;
  tagType: ObjectType | null;
}

export interface ReachabilityObjectInfo {
  oid: string;
  type: ObjectType;
  size: number;
  source: "loose" | "pack";
}
