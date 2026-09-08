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
    db.run(
      `DELETE FROM git_promised_blobs
        WHERE repo_id = ? AND oid IN (SELECT value FROM json_each(?))`,
      repoId,
      page,
    );
    if (db.scalar<number>("SELECT changes()") !== 0) fulfilled = true;
  }
  if (fulfilled) bumpMaintenanceRootEpoch(db, repoId);
}
