import { GitError } from "../../common/errors.js";
import { RowShape, text } from "../../common/rows.js";
import type { SharedRepoStore } from "../index.js";
import { assertTransfer, TRANSFER_PAGE, type TransferOwner } from "./lifetime.js";

/** Request OIDs are already bounded and decoded; closure membership proves server ownership. */
export function transferMembers(
  store: SharedRepoStore,
  owner: TransferOwner,
  oids: readonly string[],
  nowMs: number,
): string[] {
  if (assertTransfer(store, owner, nowMs).phase !== "complete") {
    throw new GitError("EINVAL", "transfer closure is not complete");
  }
  const result: string[] = [];
  for (let offset = 0; offset < oids.length; offset += TRANSFER_PAGE) {
    for (const row of store.db.iterate(
      `SELECT requested.value AS oid FROM json_each(?) requested
      WHERE EXISTS (SELECT 1 FROM git_transfer_objects
        WHERE repo_id = ? AND transfer_id = ? AND side = 'wanted' AND oid = requested.value)
      ORDER BY requested.key`,
      JSON.stringify(oids.slice(offset, offset + TRANSFER_PAGE)),
      owner.repoId,
      owner.transferId,
    )) {
      result.push(new RowShape({ oid: text() }).decode(row).oid);
    }
  }
  return result;
}
