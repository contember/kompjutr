import { describe, expect, it } from "vitest";
import { CheckoutStore } from "../src/sqlite/store/checkout.js";
import {
  FetchPublicationToken,
  TrackingRefPublicationToken,
} from "../src/sqlite/store/contracts.js";
import { SqliteGitDatabase } from "../src/sqlite/store/database.js";
import { SharedRepoStore } from "../src/sqlite/store/shared.js";
import * as store from "../src/sqlite/store.js";

describe("sqlite store module exports", () => {
  it("preserves the compatibility facade runtime surface and class identities", () => {
    expect(Object.keys(store).sort()).toEqual([
      "CONFIG_SECTION_MOVE_UPDATE_SQL",
      "CheckoutStore",
      "FetchPublicationToken",
      "MAX_CONFIG_SECTION_MOVE_ROWS",
      "MAX_REFLOG_ROOT_RETAINED_BYTES",
      "MAX_REFLOG_ROOT_SCAN_BYTES",
      "MAX_REFLOG_ROOT_SCAN_ENTRIES",
      "MAX_REF_MUTATION_RETAINED_BYTES",
      "PACK_BLOB_BATCH_TARGET_BYTES",
      "PACK_BLOB_CALLER_HEADROOM_BYTES",
      "PROVISIONAL_CLONE_LEASE_MS",
      "REFLOG_ROOT_ENDPOINT_BYTES",
      "REFLOG_ROOT_JS_HEADROOM_BYTES",
      "REFLOG_ROOT_OBJECT_CACHE_BYTES",
      "REFLOG_ROOT_PACK_ROW_CACHE_BYTES",
      "REFLOG_ROOT_ROW_FIXED_BYTES",
      "REFLOG_ROOT_SCAN_FIXED_BYTES",
      "REF_MUTATION_FIXED_RETAINED_BYTES",
      "RefMutationMemoryOwner",
      "SharedRepoStore",
      "SqliteGitDatabase",
      "TrackingRefPublicationToken",
      "WALK_TREE_SQL",
      "advanceMaintenanceRootSnapshotOwned",
      "ancestors",
      "blobIdMismatchRetainedBytes",
      "configGetOwned",
      "contentIdKey",
      "createRefMutationMemoryOwner",
      "indexScanOwned",
      "listCheckoutsOwned",
      "mutateRefsOwned",
      "normalizeRoot",
      "readAuthenticatedObjectOwned",
      "readOperationStateOwned",
      "readShallowOwned",
      "refMutationCheckoutRetainedBytes",
      "refMutationCreateRetainedBytes",
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
