import type { SqlDatabase } from "../../packages/do/src/db/db.js";
import type { ObjectType } from "../../packages/git/src/common/objects.js";
import type { PackStore } from "../../packages/git/src/store/pack/packs.js";
import { lifecyclePack } from "./pack-maintenance.js";

export interface PackMember {
  oid: string;
  type: ObjectType;
  size: number;
}

/**
 * True when `packId` is complete and physically holds exactly `objects`, each
 * readable through a canonical row in some complete pack.
 */
export function completePackMatches(
  store: { readonly db: SqlDatabase; readonly repoId: number },
  packId: number,
  objects: readonly PackMember[],
): boolean {
  const meta = store.db.one<{ state: string; count: number }>(
    "SELECT state, count FROM git_pack_meta WHERE repo_id = ? AND pack_id = ?",
    store.repoId,
    packId,
  );
  if (meta?.state !== "complete" || meta.count !== objects.length) return false;
  const expected = new Map(objects.map((object) => [object.oid, object]));
  if (expected.size !== objects.length) throw new Error("duplicate expected pack member");
  const entries = store.db.all<{ oid: string; type: string; size: number; owned: number }>(
    `SELECT entry.oid, entry.type, entry.size,
            EXISTS (
              SELECT 1 FROM git_pack_objects object
              JOIN git_pack_meta owner
                ON owner.repo_id = object.repo_id AND owner.pack_id = object.pack_id
               AND owner.state = 'complete'
             WHERE object.repo_id = entry.repo_id AND object.oid = entry.oid
            ) AS owned
       FROM git_pack_entries entry
      WHERE entry.repo_id = ? AND entry.pack_id = ?`,
    store.repoId,
    packId,
  );
  return (
    entries.length === expected.size &&
    entries.every((entry) => {
      const object = expected.get(entry.oid);
      return object?.type === entry.type && object.size === entry.size && entry.owned === 1;
    })
  );
}

/**
 * Reclaim abandoned pending packs through the ordinary ingest seam and return
 * how many went. The empty probe pack is deleted again afterwards, but it
 * still consumes one pack ID.
 */
export async function reclaimPending(store: {
  readonly db: SqlDatabase;
  readonly repoId: number;
  readonly packs: PackStore;
}): Promise<number> {
  const pending = () =>
    store.db.scalar<number>(
      "SELECT count(*) FROM git_pack_meta WHERE repo_id = ? AND state != 'complete'",
      store.repoId,
    ) ?? 0;
  const before = pending();
  async function* emptyPack(): AsyncGenerator<Uint8Array> {
    yield lifecyclePack(() => {}, 0);
  }
  const probe = await store.packs.ingest(emptyPack());
  store.packs.deleteCompletePacks([probe.packId]);
  return before - pending();
}
