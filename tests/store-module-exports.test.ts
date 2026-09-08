import { describe, expect, it } from "vitest";
import { CheckoutStore } from "../packages/git/src/store/checkout/checkout.js";
import {
  FetchPublicationToken,
  TrackingRefPublicationToken,
} from "../packages/git/src/store/core/contracts.js";
import { SqliteGitDatabase } from "../packages/git/src/store/database/database.js";
import * as store from "../packages/git/src/store/index.js";
import { SharedRepoStore } from "../packages/git/src/store/repository/shared.js";

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
      "ancestors",
      "configGetOwned",
      "contentIdKey",
      "indexScanOwned",
      "listCheckoutsOwned",
      "normalizeRoot",
      "readAuthenticatedObjectOwned",
      "readOperationStateOwned",
      "readRebaseCursorOwned",
      "readShallowOwned",
    ]);
    expect(store.CheckoutStore).toBe(CheckoutStore);
    expect(store.SharedRepoStore).toBe(SharedRepoStore);
    expect(store.SqliteGitDatabase).toBe(SqliteGitDatabase);
    expect(store.FetchPublicationToken).toBe(FetchPublicationToken);
    expect(store.TrackingRefPublicationToken).toBe(TrackingRefPublicationToken);
  });
});
