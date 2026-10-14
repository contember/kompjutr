import { CorruptError } from "../../common/errors.js";
import type { SharedRepoStore } from "../../store/index.js";
import { PackWriter } from "../../store/pack/writer.js";
import { countTransferObjects, readTransferObjectPage } from "../../store/transfer/closure.js";
import {
  assertTransfer,
  releaseTransfer,
  renewTransfer,
  type TransferOwner,
} from "../../store/transfer/lifetime.js";
import { type TransferRuntime, transferRuntime } from "./transfer.js";

const READ_BATCH_BYTES = 4 * 1024 * 1024;
const DEFLATE_INPUT_BYTES = 16 * 1024;

/** Backpressure stops reads at each yielded chunk; every resumed read checks its durable owner. */
export async function* streamTransferPack(
  store: SharedRepoStore,
  owner: TransferOwner,
  runtime: TransferRuntime = {},
): AsyncGenerator<Uint8Array> {
  const { now, yieldNow } = transferRuntime(runtime);
  const ready: Uint8Array[] = [];
  const writer = new PackWriter((chunk) => ready.push(chunk));
  function check(): void {
    assertTransfer(store, owner, now());
  }
  async function* drain(): AsyncGenerator<Uint8Array> {
    for (const chunk of ready) {
      check();
      yield chunk;
      check();
    }
    ready.length = 0;
  }
  try {
    writer.header(countTransferObjects(store, owner, now()));
    yield* drain();
    let after: string | null = null;
    for (;;) {
      const page = readTransferObjectPage(store, owner, now(), after);
      if (page.length === 0) break;
      let pending = page;
      while (pending.length > 0) {
        check();
        const first = pending[0];
        if (first === undefined) throw new CorruptError("transfer object page made no progress");
        const info = store.objectInfo([first])[0];
        if (info === undefined) throw new CorruptError(`transfer object ${first} disappeared`);
        if (info.size > READ_BATCH_BYTES) {
          check();
          // Materialize within the store's object bound: physical rows may change during an await.
          const raw = store.read(first);
          if (raw === null) throw new CorruptError(`transfer object ${first} disappeared`);
          const entry = writer.startObject(raw.type, raw.data.length);
          yield* drain();
          for (let offset = 0; offset < raw.data.length; offset += DEFLATE_INPUT_BYTES) {
            entry.push(raw.data.subarray(offset, offset + DEFLATE_INPUT_BYTES));
            yield* drain();
            renewTransfer(store, owner, now());
            await yieldNow();
            check();
          }
          entry.finish();
          yield* drain();
          pending = pending.slice(1);
        } else {
          check();
          const batch = store.readObjects(pending, { budgetBytes: READ_BATCH_BYTES });
          if (batch.objects.size === 0)
            throw new CorruptError("transfer object batch made no progress");
          for (const raw of batch.objects.values()) {
            const entry = writer.startObject(raw.type, raw.data.length);
            yield* drain();
            for (let offset = 0; offset < raw.data.length; offset += DEFLATE_INPUT_BYTES) {
              entry.push(raw.data.subarray(offset, offset + DEFLATE_INPUT_BYTES));
              yield* drain();
            }
            entry.finish();
            yield* drain();
            renewTransfer(store, owner, now());
            await yieldNow();
            check();
          }
          pending = batch.remaining;
        }
      }
      after = page[page.length - 1] ?? null;
      renewTransfer(store, owner, now());
      await yieldNow();
      check();
    }
    writer.finish();
    yield* drain();
  } finally {
    releaseTransfer(store, owner);
  }
}
