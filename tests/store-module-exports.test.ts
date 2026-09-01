import { describe, expect, it } from "vitest";
import { CheckoutStore } from "../src/git/store/checkout.js";
import { FetchPublicationToken, TrackingRefPublicationToken } from "../src/git/store/contracts.js";
import { SqliteGitDatabase } from "../src/git/store/database.js";
import * as store from "../src/git/store/index.js";
import { SharedRepoStore } from "../src/git/store/shared.js";

describe("sqlite store module exports", () => {
  it("preserves the compatibility facade runtime surface and class identities", () => {
    expect(Object.keys(store).sort()).toEqual([
      "CONFIG_SECTION_MOVE_UPDATE_SQL",
      "CheckoutStore",
      "FetchPublicationToken",
      "MAX_CONFIG_SECTION_MOVE_ROWS",
      "MAX_LOG_COMMITS",
      "MAX_REFLOG_ROOT_SCAN_ENTRIES",
      "PACK_BLOB_BATCH_TARGET_BYTES",
      "PROVISIONAL_CLONE_LEASE_MS",
      "PROVISIONAL_CLONE_RENEW_WINDOW_MS",
      "SharedRepoStore",
      "SqliteGitDatabase",
      "TrackingRefPublicationToken",
      "WALK_TREE_SQL",
      "advanceMaintenanceRootSnapshotOwned",
      "ancestors",
      "configGetOwned",
      "contentIdKey",
      "indexScanOwned",
      "listCheckoutsOwned",
      "mutateRefsOwned",
      "normalizeRoot",
      "readAuthenticatedObjectOwned",
      "readOperationStateOwned",
      "readShallowOwned",
      "replaceOperationJournalOwned",
      "replaceOperationStateOwned",
      "writeBatchOwned",
      "writeObjectsOwned",
      "writeOperationJournalOwned",
    ]);
    expect(store.CheckoutStore).toBe(CheckoutStore);
    expect(store.SharedRepoStore).toBe(SharedRepoStore);
    expect(store.SqliteGitDatabase).toBe(SqliteGitDatabase);
    expect(store.FetchPublicationToken).toBe(FetchPublicationToken);
    expect(store.TrackingRefPublicationToken).toBe(TrackingRefPublicationToken);
  });
});
