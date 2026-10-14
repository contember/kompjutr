import { errorCode, hasErrorCode } from "../../common/errors.js";
import {
  encodeReceiveStatus,
  type ServerReceiveRequest,
  type ServerRefStatus,
} from "../../protocol/server/index.js";
import { throwIfAborted } from "../../protocol/stream.js";
import type { SharedRepoStore } from "../../store/index.js";
import {
  pendingPackGeneration,
  publishServerRefs,
  rejectUnpublishedPack,
} from "../../store/refs/server-publication.js";
import { requireCompleteRepository } from "../../store/transfer/lifetime.js";
import type { ServerRuntime } from "./runtime.js";

async function* replayFirst(
  first: Uint8Array,
  iterator: AsyncIterator<Uint8Array>,
): AsyncGenerator<Uint8Array> {
  try {
    yield first;
    for (;;) {
      const next = await iterator.next();
      if (next.done === true) return;
      yield next.value;
    }
  } finally {
    await iterator.return?.();
  }
}

export async function receivePack(
  store: SharedRepoStore,
  request: ServerReceiveRequest,
  runtime: ServerRuntime,
): Promise<Iterable<Uint8Array>> {
  let statuses: ServerRefStatus[] = [];
  let unpack = "ok";
  let pending: { packId: number; generation: number } | undefined;
  let published = false;
  try {
    const metadata = {
      actor: { name: "Git server", email: "git@localhost" },
      reason: "push",
      timestamp: Math.floor(runtime.now() / 1000),
      timezoneOffset: 0,
    };
    throwIfAborted(runtime.signal);
    requireCompleteRepository(store);
    const iterator = request.pack[Symbol.asyncIterator]();
    const first = await iterator.next();
    if (first.done === true) {
      throwIfAborted(runtime.signal);
      statuses = publishServerRefs(store, request.commands, metadata);
    } else {
      await store.packs.ingest(replayFirst(first.value, iterator), {
        signal: runtime.signal,
        now: runtime.now,
        yieldNow: runtime.yieldNow,
        lifecycle: {
          reserved(packId) {
            pending = { packId, generation: pendingPackGeneration(store, packId) };
          },
          published(result) {
            statuses = publishServerRefs(store, request.commands, metadata, result.packId);
            rejectUnpublishedPack(statuses);
          },
        },
      });
      published = true;
    }
  } catch (error) {
    if (!hasErrorCode(error, "ERECEIVEREJECTED")) {
      const code = errorCode(error);
      if (!["ECORRUPT", "EINVAL", "ENOTFOUND", "EUNSUPPORTED"].includes(code ?? "")) throw error;
      unpack = "invalid pack or incomplete object closure";
      statuses = request.commands.map(({ ref }) => ({ ref, error: "unpacker error" }));
    }
  } finally {
    try {
      if (!published && pending !== undefined) {
        store.packs.discardPendingPack(pending.packId, pending.generation);
        store.revalidateStorageCaches();
      }
    } finally {
      await request.release();
    }
  }
  return request.reportStatus ? encodeReceiveStatus(unpack, statuses) : [];
}
