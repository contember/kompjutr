import type { TextMergeOptions } from "../../diff/xmerge.js";
import type {
  CleanIntegrationEntry as StoredCleanEntry,
  ConflictIntegrationEntry as StoredConflictEntry,
} from "../../store/operations/integration-workspace/descriptors.js";
import type {
  IntegrationIdentity,
  IntegrationStages,
  StructuralConflictKind,
} from "./integration-structure.js";

export const MAX_INTEGRATION_SOURCE_ROWS = 200_000;
export const MAX_INTEGRATION_PLAN_ENTRIES = 1_000;

export type IntegrationConflictKind = StructuralConflictKind | "content" | "binary";

export type CleanIntegrationEntry = StoredCleanEntry<Uint8Array>;
export type ConflictIntegrationEntry = StoredConflictEntry<Uint8Array>;

export type IntegrationEntry = CleanIntegrationEntry | ConflictIntegrationEntry;

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
  maxStructureBytes: number | undefined;
  maxPlanBytes: number | undefined;
}
