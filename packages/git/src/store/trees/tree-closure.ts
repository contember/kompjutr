import type { SqlDatabase } from "@kompjutr/sqlite";
import { CorruptError } from "../../common/errors.js";
import { expectText } from "../../common/rows.js";
import type { ObjectReadBatch } from "../core/contracts.js";
import { parseTreeSourceInto } from "./tree-index.js";
import { TreeIndexBatch } from "./tree-index-batch.js";

/** Tree OIDs per probe statement and per object read, within both JSON input bounds. */
const TREE_CLOSURE_PAGE = 4096;

/** The object reads `ensureTreeClosure` needs: loose and complete-pack objects. */
export interface TreeObjectReader {
  readObjects(oids: readonly string[], options?: { budgetBytes?: number }): ObjectReadBatch;
}

/** The trees of `oids` that have no projection row: neither projected nor unprojectable. */
function unprojected(db: SqlDatabase, repoId: number, oids: readonly string[]): string[] {
  const missing: string[] = [];
  for (let start = 0; start < oids.length; start += TREE_CLOSURE_PAGE) {
    for (const row of db.iterate(
      `SELECT wanted.value AS oid
         FROM json_each(?) wanted
        WHERE NOT EXISTS (
          SELECT 1 FROM git_tree_sources source
           WHERE source.repo_id = ? AND source.tree_oid = wanted.value
        )`,
      JSON.stringify(oids.slice(start, start + TREE_CLOSURE_PAGE)),
      repoId,
    )) {
      missing.push(expectText(row.oid, "unprojected tree oid"));
    }
  }
  return missing;
}

/**
 * Project every tree of the roots' closures that has no projection row, level
 * by level, in one transaction (ADR-0030). A projected or unprojectable
 * subtree stops the descent: the projected set is downward-closed, so its
 * closure is already complete. Trees queued earlier in the closure are known
 * in memory, so the batch flushes only when full and once at the end. A
 * missing tree object is `ObjectNotFoundError`.
 */
export function ensureTreeClosure(
  db: SqlDatabase,
  repoId: number,
  objects: TreeObjectReader,
  roots: readonly string[],
): void {
  if (roots.length === 0) return;
  db.transactionSync(() => {
    const queued = new Set<string>();
    let level = [...new Set(roots)];
    const batch = new TreeIndexBatch(db, { seeded: false });
    try {
      while (level.length > 0) {
        const next: string[] = [];
        let pending = unprojected(db, repoId, level);
        for (const oid of pending) queued.add(oid);
        while (pending.length > 0) {
          const read = objects.readObjects(pending.slice(0, TREE_CLOSURE_PAGE));
          for (const [oid, object] of read.objects) {
            if (object.type !== "tree")
              throw new CorruptError(`${oid} is a ${object.type}, not a tree`);
            const source = { repoId, treeOid: oid, objectSize: object.data.length };
            parseTreeSourceInto(batch, source, [object.data], true, next);
          }
          pending = [...read.remaining, ...pending.slice(TREE_CLOSURE_PAGE)];
        }
        level = [...new Set(next)].filter((oid) => !queued.has(oid));
      }
      batch.flush();
    } finally {
      batch.dispose();
    }
  });
}
