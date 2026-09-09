import { Workspace } from "../../packages/do/src/runtime/workspace.js";
import { createGit, type GitMaintenanceResult } from "../../packages/git/src/client.js";
import { concat } from "../../packages/git/src/common/bytes.js";
import type { ObjectType } from "../../packages/git/src/common/objects.js";
import { fetchHttpClient } from "../../packages/git/src/protocol/transport.js";
import { SqliteGitDatabase } from "../../packages/git/src/store/index.js";
import { encodeDeltaHeader } from "../../packages/git/src/store/pack/delta.js";
import { PackWriter } from "../../packages/git/src/store/pack/writer.js";
import { TestDatabase } from "./db.js";
import { SqliteTestStorage } from "./storage.js";

export function lifecyclePack(write: (writer: PackWriter) => void, count: number): Uint8Array {
  const chunks: Uint8Array[] = [];
  const writer = new PackWriter((chunk) => chunks.push(chunk));
  writer.header(count);
  write(writer);
  writer.finish();
  return concat(chunks);
}

export function lifecycleDelta(baseSize: number, target: Uint8Array): Uint8Array {
  const chunks = [encodeDeltaHeader(baseSize, target.length)];
  for (let offset = 0; offset < target.length; offset += 127) {
    const part = target.subarray(offset, offset + 127);
    chunks.push(new Uint8Array([part.length]), part);
  }
  return concat(chunks);
}

export function packMaintenance() {
  const storage = new SqliteTestStorage();
  const db = new TestDatabase(storage);
  const clock = { value: 1_800_000_000_000 };
  const now = () => clock.value;
  const runtime = (yieldNow?: () => Promise<void>) =>
    new Workspace({
      storage,
      git: createGit(),
      now,
      http: fetchHttpClient,
      ...(yieldNow === undefined ? {} : { yieldNow }),
    });
  const store = () => {
    const database = new SqliteGitDatabase(db, { now, objectCacheBytes: 0 });
    const checkout = database.findCheckout("/repo");
    if (checkout === null) throw new Error("pack fixture checkout missing");
    return database.openCheckout(checkout);
  };
  const call = () => runtime().git.maintenance({ dir: "/repo" });
  const until = async (phase: GitMaintenanceResult["phase"], bound = 60) => {
    for (let calls = 0; calls < bound; calls++) {
      const result = await call();
      if (result.phase === phase) return result;
    }
    throw new Error(`pack maintenance did not reach ${phase} within ${bound} calls`);
  };
  const ingest = async (bytes: Uint8Array) => {
    async function* source() {
      yield bytes;
    }
    return store().packs.ingest(source());
  };
  const full = (data: Uint8Array, type: ObjectType = "blob") =>
    ingest(lifecyclePack((writer) => writer.object(type, data), 1));
  return { storage, db, clock, runtime, store, call, until, ingest, full };
}
