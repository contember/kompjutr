import type { SqlDatabase } from "@kompjutr/sqlite";
import { int, RowShape, text } from "../../../common/rows.js";
import type { RootCandidate, RootPage } from "./root-contracts.js";

const ROOT_ROW = new RowShape({ root_id: int(1), oid: text() });

export function rootsFromTransfers(
  db: SqlDatabase,
  repoId: number,
  cursor: number | null,
  pageRows: number,
): RootPage {
  const candidates: RootCandidate[] = [];
  let last = cursor;
  let hasMore = false;
  // Expiry alone never drops a root: cleanup publishes release with an epoch bump.
  for (const raw of db.iterate(
    `SELECT root.root_id, root.oid FROM git_transfer_roots root
    JOIN git_transfers owner ON owner.repo_id = root.repo_id AND owner.transfer_id = root.transfer_id
    WHERE root.repo_id = ? AND root.root_id > ? AND owner.released = 0
    ORDER BY root.root_id LIMIT ?`,
    repoId,
    cursor ?? 0,
    pageRows + 1,
  )) {
    if (candidates.length === pageRows) {
      hasMore = true;
      break;
    }
    const row = ROOT_ROW.decode(raw);
    candidates.push({ oid: row.oid, expectedType: null, optionalMissing: false });
    last = row.root_id;
  }
  return { candidates, cursorCheckoutId: null, cursorText: null, cursorOrdinal: last, hasMore };
}
