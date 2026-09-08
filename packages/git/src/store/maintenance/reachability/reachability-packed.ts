import { CorruptError } from "../../../common/errors.js";
import type { ObjectType } from "../../../common/objects.js";
import type { SharedRepoStore } from "../../index.js";
import { MAX_DELTA_DEPTH } from "../../pack/packs.js";
import { objectType, oidField } from "./reachability-codecs.js";
import type { ReachabilityEdge } from "./reachability-contracts.js";

interface PackedBaseChain {
  sourceType: ObjectType;
  baseOid: string | null;
}

interface PackedChainRow {
  oid: string;
  type: ObjectType;
  baseOid: string | null;
  looseType: ObjectType | null;
}

function nullableOidField(value: unknown, label: string): string | null {
  return value === null ? null : oidField(value, label);
}

export function validatedPackedBaseChain(
  store: SharedRepoStore,
  oid: string,
): PackedBaseChain | null {
  const chain = new Map<string, PackedChainRow>();
  for (const row of store.db.iterate(
    `WITH RECURSIVE /* maintenance-pack-chain */ packed_chain(
       repo_id, oid, type, base_oid, pack_repo_id, pack_state
     ) AS (
       SELECT object.repo_id, object.oid, object.type, object.base_oid, pack.repo_id, pack.state
         FROM git_pack_objects object
         JOIN git_pack_meta pack
           ON pack.repo_id = object.repo_id AND pack.pack_id = object.pack_id
        WHERE object.repo_id = ? AND object.oid = ? AND pack.state = 'complete'
       UNION
       SELECT next.repo_id, next.oid, next.type, next.base_oid, pack.repo_id, pack.state
         FROM packed_chain current
         JOIN git_pack_objects next
           ON next.repo_id = ? AND next.oid = current.base_oid
         JOIN git_pack_meta pack
           ON pack.repo_id = next.repo_id AND pack.pack_id = next.pack_id
          AND pack.state = 'complete'
     )
     SELECT chain.repo_id, chain.oid, chain.type, chain.base_oid,
            chain.pack_repo_id, chain.pack_state,
            loose.repo_id AS loose_repo_id, loose.oid AS loose_oid, loose.type AS loose_type
       FROM packed_chain chain
       LEFT JOIN git_objects loose
         ON loose.repo_id = ? AND loose.oid = chain.base_oid
        AND NOT EXISTS (
          SELECT 1 FROM git_pack_objects next
          JOIN git_pack_meta pack
            ON pack.repo_id = next.repo_id AND pack.pack_id = next.pack_id
           AND pack.state = 'complete'
          WHERE next.repo_id = ? AND next.oid = chain.base_oid
        )
      LIMIT ${MAX_DELTA_DEPTH + 2}`,
    store.repoId,
    oid,
    store.repoId,
    store.repoId,
    store.repoId,
  )) {
    if (chain.size >= MAX_DELTA_DEPTH + 1) {
      throw new CorruptError(`packed delta chain for ${oid} exceeds its depth bound`);
    }
    if (row.repo_id !== store.repoId || row.pack_repo_id !== store.repoId) {
      throw new CorruptError("packed delta chain crossed repository boundaries");
    }
    if (row.pack_state !== "complete") {
      throw new CorruptError("packed delta chain contains an incomplete pack");
    }
    const rowOid = oidField(row.oid, "packed delta chain OID");
    if (chain.has(rowOid)) throw new CorruptError("packed delta chain returned duplicate rows");
    const type = objectType(row.type, "packed delta chain type");
    const baseOid = nullableOidField(row.base_oid, "packed delta chain base OID");
    let looseType: ObjectType | null = null;
    if (row.loose_oid !== null) {
      if (row.loose_repo_id !== store.repoId || row.loose_oid !== baseOid) {
        throw new CorruptError("packed delta terminal crossed object boundaries");
      }
      looseType = objectType(row.loose_type, "packed delta terminal type");
    }
    chain.set(rowOid, { oid: rowOid, type, baseOid, looseType });
  }
  const source = chain.get(oid);
  if (source === undefined) {
    if (chain.size !== 0) throw new CorruptError("packed delta chain omitted its source");
    return null;
  }
  const seen = new Set<string>();
  let current = source;
  let deltaDepth = 0;
  while (true) {
    if (seen.has(current.oid)) {
      throw new CorruptError(`packed delta chain for ${oid} contains a cycle`);
    }
    seen.add(current.oid);
    if (current.type !== source.type) {
      throw new CorruptError(`packed delta base ${current.oid} has the wrong type`);
    }
    if (current.baseOid === null) break;
    if (deltaDepth >= MAX_DELTA_DEPTH) {
      throw new CorruptError(`packed delta chain for ${oid} exceeds its depth bound`);
    }
    deltaDepth++;
    const next = chain.get(current.baseOid);
    if (next !== undefined) {
      current = next;
      continue;
    }
    if (current.looseType === null) {
      throw new CorruptError(`packed delta base ${current.baseOid} is missing`);
    }
    if (current.looseType !== source.type) {
      throw new CorruptError(`packed delta base ${current.baseOid} has the wrong type`);
    }
    break;
  }
  return { sourceType: source.type, baseOid: source.baseOid };
}
export function packedBaseEdge(
  store: SharedRepoStore,
  oid: string,
  expectedType: ObjectType,
): ReachabilityEdge | null {
  const packed = validatedPackedBaseChain(store, oid);
  if (packed === null) return null;
  if (packed.sourceType !== expectedType) {
    throw new CorruptError(`packed copy of ${oid} disagrees with its authoritative type`);
  }
  if (packed.baseOid === null) return null;
  return {
    oid: packed.baseOid,
    type: expectedType,
    optionalMissing: false,
    allowPromisedMissing: false,
    physicalOnly: true,
  };
}
