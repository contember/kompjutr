import type { SqlDatabase } from "@kompjutr/sqlite";
import type { TreeSource } from "./tree-index.js";

/** One source inside a batch, named by its position in the batch's pending flush. */
export class TreeSourceSlot {
  /** Its projection row exists: seeded by this batch or by the loose object trigger. */
  seeded: boolean;
  /** Position in the batch's pending flush, or -1. */
  pending = -1;

  constructor(
    readonly source: TreeSource,
    seeded: boolean,
  ) {
    this.seeded = seeded;
  }
}

/** Seed the incomplete projection rows that entry statements join. */
export function seedTreeSourceSlots(db: SqlDatabase, slots: readonly TreeSourceSlot[]): void {
  if (slots.length === 0) return;
  db.run(
    `INSERT OR IGNORE INTO git_tree_sources
       (repo_id, tree_oid, complete, object_size, entry_count, base_cost)
     SELECT json_extract(value, '$[0]'), json_extract(value, '$[1]'),
            0, json_extract(value, '$[2]'), NULL, NULL
       FROM json_each(?)`,
    JSON.stringify(slots.map(({ source }) => [source.repoId, source.treeOid, source.objectSize])),
  );
  for (const slot of slots) slot.seeded = true;
}
