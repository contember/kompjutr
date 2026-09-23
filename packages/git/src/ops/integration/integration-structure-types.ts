export interface IntegrationIdentity {
  mode: string;
  oid: string;
}

export interface IntegrationStages {
  base: IntegrationIdentity | null;
  current: IntegrationIdentity | null;
  incoming: IntegrationIdentity | null;
}

export interface CleanStructuralEntry {
  kind: "clean";
  path: string;
  before: IntegrationIdentity | null;
  result: IntegrationIdentity | null;
}

/** A regular-file candidate whose bytes must be resolved by the content phase. */
export interface ContentStructuralEntry {
  kind: "content";
  path: string;
  base: IntegrationIdentity;
  current: IntegrationIdentity;
  incoming: IntegrationIdentity;
  resultMode: string;
}

export type StructuralConflictKind =
  | "add/add"
  | "modify/delete"
  | "mode"
  | "symlink"
  | "gitlink"
  | "file/directory";

export interface ConflictStructuralEntry {
  kind: "conflict";
  path: string;
  conflict: StructuralConflictKind;
  stages: IntegrationStages;
}

export type StructuralIntegrationEntry =
  | CleanStructuralEntry
  | ContentStructuralEntry
  | ConflictStructuralEntry;

export interface ResolvedLimits {
  maxRows: number;
  maxEntries: number;
  maxRetainedBytes: number | undefined;
}

export interface ClassifiedRow {
  entry: StructuralIntegrationEntry | null;
  occupiesPath: boolean;
}
