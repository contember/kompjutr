import { GitError, hasErrorCode } from "../../common/errors.js";
import { PACK_BLOB_BATCH_TARGET_BYTES } from "../../store/index.js";
import { streamFullObjectPack } from "../../store/pack/full-object-stream.js";
import type { Repository } from "../repository/repository.js";
import { MAX_PUSH_OBJECTS, type PushPlan } from "./push-plan-types.js";

/** Open a fresh, byte-identical pack stream for an HTTP attempt. */
export async function* openPushPack(repo: Repository, plan: PushPlan): AsyncGenerator<Uint8Array> {
  try {
    yield* streamFullObjectPack(
      plan.objects,
      {
        readBatch: (objects) =>
          repo.readObjects(
            objects.map((object) => object.oid),
            { budgetBytes: PACK_BLOB_BATCH_TARGET_BYTES },
          ).objects,
        readChunks: (object) => repo.store.readChunks(object.oid),
      },
      {
        maxObjects: MAX_PUSH_OBJECTS,
        maxInflatedBytes: Number.MAX_SAFE_INTEGER,
        maxStoredBytes: Number.MAX_SAFE_INTEGER,
        readBatchBytes: PACK_BLOB_BATCH_TARGET_BYTES,
        allowOversizedObject: true,
      },
    );
  } catch (error) {
    if (hasErrorCode(error, "E2BIG")) throw error;
    throw new GitError("EPUSHLOCAL", "local object validation failed while streaming push", {
      cause: error,
    });
  }
}
