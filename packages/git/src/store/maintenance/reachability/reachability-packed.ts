import { CorruptError } from "../../../common/errors.js";
import type { ObjectType } from "../../../common/objects.js";
import { nullable, oneOf, RowShape } from "../../../common/rows.js";
import type { SharedRepoStore } from "../../index.js";
import { oidField } from "./reachability-codecs.js";
import type { ReachabilityEdge } from "./reachability-contracts.js";

// One canonical physical edge, not the remaining suffix: the chain's shape —
// type consistency, termination and depth — is admitted by ADR-0023 inside
// every publication and deletion transaction, so re-deriving the suffix per
// queued object only repeated work the store already owns.
const INVALID_BASE = "packed delta base row is malformed";

const BASE_ROW = new RowShape(
  {
    source_type: oneOf(["blob", "tree", "commit", "tag"], INVALID_BASE),
    base_packed_type: nullable(oneOf(["blob", "tree", "commit", "tag"], INVALID_BASE)),
    base_loose_type: nullable(oneOf(["blob", "tree", "commit", "tag"], INVALID_BASE)),
  },
  INVALID_BASE,
);

export interface PackedBaseSource {
  readonly sourceType: ObjectType;
  readonly base: ReachabilityEdge | null;
}

/**
 * Packed-over-loose precedence is explicit: `base_packed_type` is non-NULL only
 * when the base's canonical row belongs to a *complete* pack, and
 * `base_loose_type` is projected only when it does not. A base owned solely by
 * a pending pack therefore reads as missing. Every join is a `(repo_id, oid)`
 * primary-key seek; a witness pins the plan.
 */
export const MAINTENANCE_PACK_BASE_SQL = `SELECT /* maintenance-pack-base */
        object.type AS source_type,
        object.base_oid AS base_oid,
        CASE WHEN base_pack.pack_id IS NOT NULL THEN base.type END AS base_packed_type,
        CASE WHEN base_pack.pack_id IS NULL THEN loose.type END AS base_loose_type
   FROM git_pack_objects object
   JOIN git_pack_meta pack
     ON pack.repo_id = object.repo_id AND pack.pack_id = object.pack_id
    AND pack.state = 'complete'
   LEFT JOIN git_pack_objects base
     ON base.repo_id = object.repo_id AND base.oid = object.base_oid
   LEFT JOIN git_pack_meta base_pack
     ON base_pack.repo_id = base.repo_id AND base_pack.pack_id = base.pack_id
    AND base_pack.state = 'complete'
   LEFT JOIN git_objects loose
     ON loose.repo_id = object.repo_id AND loose.oid = object.base_oid
  WHERE object.repo_id = ? AND object.oid = ?`;

/** The canonical packed source of `oid` and its immediate base edge, if any. */
export function validatedPackedBase(store: SharedRepoStore, oid: string): PackedBaseSource | null {
  const row = store.db.one<Record<string, unknown>>(MAINTENANCE_PACK_BASE_SQL, store.repoId, oid);
  if (row === undefined) return null;
  const decoded = BASE_ROW.decode(row);
  if (row.base_oid === null) return { sourceType: decoded.source_type, base: null };
  const baseOid = oidField(row.base_oid, "packed delta base OID");
  const baseType = decoded.base_packed_type ?? decoded.base_loose_type;
  if (baseType === null) throw new CorruptError(`packed delta base ${baseOid} is missing`);
  if (baseType !== decoded.source_type) {
    throw new CorruptError(`packed delta base ${baseOid} has the wrong type`);
  }
  return {
    sourceType: decoded.source_type,
    base: {
      oid: baseOid,
      type: decoded.source_type,
      optionalMissing: false,
      allowPromisedMissing: false,
      physicalOnly: true,
    },
  };
}

export function packedBaseEdge(
  store: SharedRepoStore,
  oid: string,
  expectedType: ObjectType,
): ReachabilityEdge | null {
  const packed = validatedPackedBase(store, oid);
  if (packed === null) return null;
  if (packed.sourceType !== expectedType) {
    throw new CorruptError(`packed copy of ${oid} disagrees with its authoritative type`);
  }
  return packed.base;
}
