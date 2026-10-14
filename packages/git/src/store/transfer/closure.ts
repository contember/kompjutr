import { CorruptError, GitError } from "../../common/errors.js";
import { expectSafeInteger, int, nullable, RowShape, text } from "../../common/rows.js";
import type { QueueObject, ReachabilityEdge } from "../graph/semantic-contracts.js";
import { headerExpansion, treeExpansion } from "../graph/semantic-expand.js";
import { requireObjectInfo } from "../graph/semantic-headers.js";
import { TreeObjectReads } from "../graph/semantic-tree-object.js";
import type { SharedRepoStore } from "../index.js";
import {
  assertTransfer,
  createTransfer,
  releaseTransfer,
  TRANSFER_PAGE,
  type TransferOwner,
  type TransferRoot,
} from "./lifetime.js";

const EXPANSIONS_PER_STEP = 64;
const QUEUE_ROW = new RowShape({ oid: text(), edge_cursor: int(0), edge_offset: nullable(int(0)) });

function enqueueEdges(
  store: SharedRepoStore,
  owner: TransferOwner,
  side: string,
  edges: ReachabilityEdge[],
): void {
  // Gitlinks refer to another repository even if the same OID happens to exist here.
  const required = edges.filter((edge) => !edge.optionalMissing);
  if (required.length === 0) return;
  const infos = new Map(
    store.objectInfo(required.map((edge) => edge.oid)).map((info) => [info.oid, info]),
  );
  for (const edge of required) {
    const info = infos.get(edge.oid);
    if (info === undefined)
      throw new CorruptError(`transfer closure is missing ${edge.type} ${edge.oid}`);
    if (info.type !== edge.type)
      throw new CorruptError(`transfer edge ${edge.oid} is ${info.type}, expected ${edge.type}`);
  }
  store.db.run(
    `INSERT OR IGNORE INTO git_transfer_objects (repo_id, transfer_id, side, oid)
    SELECT ?, ?, ?, value FROM json_each(?)`,
    owner.repoId,
    owner.transferId,
    side,
    JSON.stringify(required.map((edge) => edge.oid)),
  );
}

/** Advance a bounded strict semantic walk. Common closure is established before wanted closure. */
export function advanceTransfer(
  store: SharedRepoStore,
  owner: TransferOwner,
  nowMs: number,
): boolean {
  return store.db.transactionSync(() => {
    let { phase } = assertTransfer(store, owner, nowMs);
    if (phase === "complete") return true;
    const trees = new TreeObjectReads();
    for (let step = 0; step < EXPANSIONS_PER_STEP; step++) {
      // An OID-ordered primary-key scan would revisit every already expanded object.
      const raw = store.db.one<Record<string, unknown>>(
        `SELECT oid, edge_cursor, edge_offset FROM git_transfer_objects INDEXED BY git_transfer_objects_frontier
        WHERE repo_id = ? AND transfer_id = ? AND side = ? AND expanded = 0 ORDER BY oid LIMIT 1`,
        owner.repoId,
        owner.transferId,
        phase,
      );
      if (raw === undefined) {
        const next: "wanted" | "complete" = phase === "common" ? "wanted" : "complete";
        store.db.run(
          "UPDATE git_transfers SET phase = ? WHERE repo_id = ? AND transfer_id = ?",
          next,
          owner.repoId,
          owner.transferId,
        );
        if (next === "complete") return true;
        phase = next;
        continue;
      }
      const row = QUEUE_ROW.decode(raw);
      const object: QueueObject = {
        oid: row.oid,
        edgeCursor: row.edge_cursor,
        edgeOffset: row.edge_offset,
        sourceMask: 0,
        shallowBoundary: false,
      };
      const common =
        phase === "wanted"
          ? store.db.one<Record<string, unknown>>(
              `SELECT oid FROM git_transfer_objects
        WHERE repo_id = ? AND transfer_id = ? AND side = 'common' AND oid = ?`,
              owner.repoId,
              owner.transferId,
              row.oid,
            )
          : undefined;
      if (common !== undefined) {
        store.db.run(
          `UPDATE git_transfer_objects SET expanded = 1 WHERE repo_id = ? AND transfer_id = ? AND side = ? AND oid = ?`,
          owner.repoId,
          owner.transferId,
          phase,
          row.oid,
        );
        continue;
      }
      const info = requireObjectInfo(store, row.oid);
      const expansion =
        info.type === "tree"
          ? treeExpansion(store.db, store, object, info, trees)
          : headerExpansion(store, object, info);
      enqueueEdges(store, owner, phase, expansion.edges);
      store.db.run(
        `UPDATE git_transfer_objects SET expanded = ?, edge_cursor = ?, edge_offset = ?
        WHERE repo_id = ? AND transfer_id = ? AND side = ? AND oid = ?`,
        expansion.complete ? 1 : 0,
        expansion.nextCursor,
        expansion.nextOffset,
        owner.repoId,
        owner.transferId,
        phase,
        row.oid,
      );
    }
    return false;
  });
}

function requireComplete(store: SharedRepoStore, owner: TransferOwner, nowMs: number): void {
  if (assertTransfer(store, owner, nowMs).phase !== "complete") {
    throw new GitError("EINVAL", "transfer closure is not complete");
  }
}

export function countTransferObjects(
  store: SharedRepoStore,
  owner: TransferOwner,
  nowMs: number,
): number {
  requireComplete(store, owner, nowMs);
  const count = expectSafeInteger(
    store.db.scalar<unknown>(
      `SELECT count(*) FROM git_transfer_objects wanted
    WHERE repo_id = ? AND transfer_id = ? AND side = 'wanted'
      AND NOT EXISTS (SELECT 1 FROM git_transfer_objects common WHERE common.repo_id = wanted.repo_id
        AND common.transfer_id = wanted.transfer_id AND common.side = 'common' AND common.oid = wanted.oid)`,
      owner.repoId,
      owner.transferId,
    ),
    0,
    Number.MAX_SAFE_INTEGER,
    "transfer object count",
  );
  if (count > 0xffffffff)
    throw new GitError("E2BIG", "transfer exceeds the pack format's 32-bit object count");
  return count;
}

export function readTransferObjectPage(
  store: SharedRepoStore,
  owner: TransferOwner,
  nowMs: number,
  afterOid: string | null = null,
  limit = TRANSFER_PAGE,
): string[] {
  requireComplete(store, owner, nowMs);
  if (!Number.isInteger(limit) || limit < 1 || limit > TRANSFER_PAGE)
    throw new GitError("EINVAL", "invalid transfer object page size");
  const oids: string[] = [];
  for (const raw of store.db.iterate(
    `SELECT wanted.oid FROM git_transfer_objects wanted
    WHERE repo_id = ? AND transfer_id = ? AND side = 'wanted' AND oid > ? COLLATE BINARY
      AND NOT EXISTS (SELECT 1 FROM git_transfer_objects common WHERE common.repo_id = wanted.repo_id
        AND common.transfer_id = wanted.transfer_id AND common.side = 'common' AND common.oid = wanted.oid)
    ORDER BY wanted.oid COLLATE BINARY LIMIT ?`,
    owner.repoId,
    owner.transferId,
    afterOid ?? "",
    limit,
  )) {
    oids.push(new RowShape({ oid: text() }).decode(raw).oid);
  }
  return oids;
}

/** Validate every required edge while the caller's publication transaction keeps sources stable. */
export function validateCompleteClosure(
  store: SharedRepoStore,
  roots: Iterable<TransferRoot>,
): void {
  store.db.transactionSync(() => {
    const nowMs = Date.now();
    const owner = createTransfer(store, { wanted: roots, nowMs });
    try {
      while (!advanceTransfer(store, owner, nowMs)) {
        /* The enclosing transaction cannot yield. */
      }
    } finally {
      releaseTransfer(store, owner);
    }
  });
}
