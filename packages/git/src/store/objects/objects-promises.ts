import type { SqlDatabase } from "@kompjutr/sqlite";
import { jsonPages } from "../core/json-pages.js";
import { bumpMaintenanceRootEpoch } from "../maintenance/control.js";

// Consume promises before the loose insert trigger, within the publication transaction.
export function fulfillLoosePromises(
  db: SqlDatabase,
  repoId: number,
  oids: Iterable<string>,
): void {
  let fulfilled = false;
  for (const page of jsonPages(oids, "loose promise fulfillment")) {
    // RETURNING replaces a separate `changes()` probe. SQLite buffers its
    // output, so the delete is already complete at the first row and the rest
    // of the cursor is abandoned without keeping every fulfilled OID.
    for (const _oid of db.iterate(
      `DELETE FROM git_promised_blobs
        WHERE repo_id = ? AND oid IN (SELECT value FROM json_each(?))
        RETURNING oid`,
      repoId,
      page,
    )) {
      fulfilled = true;
      break;
    }
  }
  if (fulfilled) bumpMaintenanceRootEpoch(db, repoId);
}
