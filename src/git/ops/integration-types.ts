import type { TextMergeOptions } from "../diff/xmerge.js";
import type {
  IntegrationIdentity,
  IntegrationStages,
  StructuralConflictKind,
} from "./integration-structure.js";

export const MAX_INTEGRATION_SOURCE_ROWS = 200_000;
export const MAX_INTEGRATION_PLAN_ENTRIES = 1_000;

export type IntegrationConflictKind = StructuralConflictKind | "content" | "binary";

export interface CleanIntegrationEntry {
  kind: "clean";
  path: string;
  before: IntegrationIdentity | null;
  result: IntegrationIdentity | null;
  /** Null reuses `result.oid`; bytes name a new content-addressed blob. */
  content: Uint8Array | null;
}

export interface ConflictIntegrationEntry {
  kind: "conflict";
  path: string;
  conflict: IntegrationConflictKind;
  stages: IntegrationStages;
  /** Worktree mode after independently resolving the mode dimension, when defined. */
  resultMode?: string;
  /** Conflict-marker bytes, or the current bytes for a binary conflict. */
  content: Uint8Array | null;
  conflicts?: number;
}

export type IntegrationEntry = CleanIntegrationEntry | ConflictIntegrationEntry;

export interface IntegrationPlan {
  /** A Git-path-ordered delta relative to the current tree. */
  entries: readonly IntegrationEntry[];
  sourceRows: number;
}

export interface IntegrationLimits {
  maxSourceRows?: number;
  maxEntries?: number;
  maxStructureBytes?: number;
  maxPlanBytes?: number;
}

export interface IntegrationInput {
  baseTreeOid: string | null;
  currentTreeOid: string | null;
  incomingTreeOid: string | null;
  text?: TextMergeOptions;
  limits?: IntegrationLimits;
}

export interface VirtualAncestorIntegrationInput extends IntegrationInput {
  labels: { current: string; incoming: string };
  /** Recursive merge depth. Git adds two marker bytes at every depth; defaults to one. */
  depth?: number;
}

export interface ContentCandidate {
  path: string;
  base: IntegrationIdentity | null;
  current: IntegrationIdentity;
  incoming: IntegrationIdentity;
  resultMode: string;
  stages: IntegrationStages;
  forceAddAddConflict: boolean;
}

export interface RelocationRequest {
  key: string;
  path: string;
  desired: string;
  side: "current" | "incoming";
  identity: IntegrationIdentity;
}

export interface ResolvedIntegrationLimits {
  maxSourceRows: number;
  maxEntries: number;
  maxStructureBytes: number | undefined;
  maxPlanBytes: number | undefined;
}
