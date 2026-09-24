import type { ObjectType } from "../../common/objects.js";

export const MAX_PUSH_COMMITS = 512;
export const MAX_PUSH_OBJECTS = 100_000;
export const OBJECT_PAGE = 4096;
export const MAX_TAG_DEPTH = 16;
export const MAX_PUSH_UPDATES = 1_024;
export const NO_REMOTE_OIDS: readonly string[] = Object.freeze([]);

export interface PushObject {
  oid: string;
  type: ObjectType;
  size: number;
  source: "loose" | "pack";
}

export interface PushPlan {
  readonly objects: readonly PushObject[];
  readonly newCommits: number;
}

export interface PushPlanOptions {
  readonly maxObjects?: number;
  readonly maxCommits?: number;
  readonly remoteOids?: readonly string[];
}

export interface PlannedCommit {
  oid: string;
  tree: string;
  parents: readonly string[];
}

export interface ResolvedRoot {
  directType: ObjectType;
  finalOid: string;
  finalType: Exclude<ObjectType, "tag">;
  tags: readonly string[];
}

export interface RootResolutionState {
  readonly types: Map<string, ObjectType>;
  readonly tags: Map<string, TagTarget>;
}

export interface TagTarget {
  readonly object: string;
  readonly type: ObjectType;
}

export interface NormalizedPushPlanOptions {
  readonly maxObjects: number;
  readonly maxCommits: number;
  readonly remoteOids: readonly string[];
}
