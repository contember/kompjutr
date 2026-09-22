import { isOid } from "../../../common/bytes.js";
import { Decoder, int, nullable, object, oneOf, optional, text } from "../../../common/rows.js";

export interface IntegrationIdentity {
  mode: string;
  oid: string;
}

export interface IntegrationStages {
  base: IntegrationIdentity | null;
  current: IntegrationIdentity | null;
  incoming: IntegrationIdentity | null;
}

export type StructuralConflictKind =
  | "add/add"
  | "modify/delete"
  | "mode"
  | "symlink"
  | "gitlink"
  | "file/directory";

export type IntegrationConflictKind = StructuralConflictKind | "content" | "binary";

export interface IntegrationContentReference {
  oid: string;
  size: number;
}

export interface CleanStructuralEntry {
  kind: "clean";
  path: string;
  before: IntegrationIdentity | null;
  result: IntegrationIdentity | null;
}

export interface ContentStructuralEntry {
  kind: "content";
  path: string;
  base: IntegrationIdentity;
  current: IntegrationIdentity;
  incoming: IntegrationIdentity;
  resultMode: string;
}

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

export interface CleanIntegrationEntry<Content = IntegrationContentReference>
  extends CleanStructuralEntry {
  content: Content | null;
}

export interface ConflictIntegrationEntry<Content = IntegrationContentReference> {
  kind: "conflict";
  path: string;
  conflict: IntegrationConflictKind;
  stages: IntegrationStages;
  resultMode?: string;
  content: Content | null;
  conflicts?: number;
}

export type IntegrationEntry<Content = IntegrationContentReference> =
  | CleanIntegrationEntry<Content>
  | ConflictIntegrationEntry<Content>;
export type MergePathPurpose = "primary" | "current-relocation" | "incoming-relocation";

export interface ProjectedMergeEntry<Content = IntegrationContentReference> {
  path: string;
  logicalPath: string;
  purpose: MergePathPurpose;
  stageZero: IntegrationIdentity | null;
  stages: IntegrationStages | null;
  worktree: IntegrationIdentity | null;
  content: Content | null;
}

export interface IntegrationReservation {
  path: string;
  logicalPath: string;
  purpose: MergePathPurpose;
  identity: IntegrationIdentity | null;
  allocatedPath?: string;
}

const oid = text().where(isOid, "integration identity has an invalid OID");
const mode = oneOf(["40000", "040000", "100644", "100755", "120000", "160000"]);
const path = text().where(
  (value) => value.length > 0 && !value.startsWith("/") && !value.includes("\0"),
  "integration path is invalid",
);
const identity = object({ mode, oid });
const stages = object({
  base: nullable(identity),
  current: nullable(identity),
  incoming: nullable(identity),
});
const structuralConflict = oneOf([
  "add/add",
  "modify/delete",
  "mode",
  "symlink",
  "gitlink",
  "file/directory",
]);
const content = nullable(object({ oid, size: int(0) }));
const cleanFields = { path, before: nullable(identity), result: nullable(identity) };
const clean = object({ kind: oneOf(["clean"]), ...cleanFields });
const candidate = object({
  kind: oneOf(["content"]),
  path,
  base: identity,
  current: identity,
  incoming: identity,
  resultMode: mode,
});
const conflict = object({ kind: oneOf(["conflict"]), path, conflict: structuralConflict, stages });

function alternatives<T>(decoders: readonly Decoder<T>[]): Decoder<T> {
  return new Decoder((value) => {
    for (const decoder of decoders) {
      const result = decoder.tryDecode(value);
      if (result.ok) return result;
    }
    return { ok: false, message: "integration descriptor is malformed" };
  });
}

export const structuralDescriptor = alternatives<StructuralIntegrationEntry>([
  clean,
  candidate,
  conflict,
]);
export const resolvedDescriptor = alternatives<IntegrationEntry>([
  object({ kind: oneOf(["clean"]), ...cleanFields, content }),
  object({
    kind: oneOf(["conflict"]),
    path,
    conflict: oneOf([
      "add/add",
      "modify/delete",
      "mode",
      "symlink",
      "gitlink",
      "file/directory",
      "content",
      "binary",
    ]),
    stages,
    resultMode: optional(mode),
    content,
    conflicts: optional(int(0)),
  }),
]);
const purpose = oneOf(["primary", "current-relocation", "incoming-relocation"]);
export const projectedDescriptor: Decoder<ProjectedMergeEntry> = object({
  path,
  logicalPath: path,
  purpose,
  stageZero: nullable(identity),
  stages: nullable(stages),
  worktree: nullable(identity),
  content,
});
export const reservationDescriptor: Decoder<IntegrationReservation> = object({
  path,
  logicalPath: path,
  purpose,
  identity: nullable(identity),
  allocatedPath: optional(path),
});
