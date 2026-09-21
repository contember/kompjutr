// Derived from dgit (MIT, Copyright (c) 2026 Divy Srivastava),
// https://github.com/littledivy/dgit — the iterative delta-chain walk follows dgit's src/git/packstore.ts.

import { CorruptError } from "../../../common/errors.js";
import type { RawObject } from "../../../common/objects.js";
import {
  type ExternalBatchResolver,
  type ExternalMetadataResolver,
  type ExternalObjectMetadata,
  isObjectType,
  PACK_BLOB_BATCH_TARGET_BYTES,
} from "../shared.js";

export class PackExternalWindow {
  readonly #metadata = new Map<string, ExternalObjectMetadata>();
  #objects = new Map<string, RawObject>();

  constructor(
    oids: readonly string[],
    private readonly resolve: ExternalBatchResolver,
    private readonly metadata: ExternalMetadataResolver,
  ) {
    this.#loadMetadata(oids);
  }

  #loadMetadata(oids: readonly string[]): void {
    if (oids.length === 0) return;
    const resolved = this.metadata(oids);
    for (const oid of oids) {
      const object = resolved.get(oid);
      if (object === undefined) continue;
      if (!isObjectType(object.type) || !Number.isSafeInteger(object.size) || object.size < 0) {
        throw new CorruptError("loose base metadata is invalid");
      }
      this.#metadata.set(oid, object);
    }
  }

  get(oid: string): RawObject | undefined {
    const hit = this.#objects.get(oid);
    if (hit !== undefined) return hit;
    // A cache hit during discovery can be evicted before its dependent is resolved.
    if (!this.#metadata.has(oid)) this.#loadMetadata([oid]);
    const first = this.#metadata.get(oid);
    if (first === undefined) return undefined;

    this.#objects.clear();
    const batch = [oid];
    let bytes = first.size;
    let reached = false;
    for (const [next, metadata] of this.#metadata) {
      if (next === oid) {
        reached = true;
        continue;
      }
      if (!reached) continue;
      if (metadata.size > PACK_BLOB_BATCH_TARGET_BYTES - bytes) break;
      batch.push(next);
      bytes += metadata.size;
    }
    const objects = this.resolve(batch);
    for (const [key, object] of objects) {
      const metadata = this.#metadata.get(key);
      if (
        !batch.includes(key) ||
        metadata === undefined ||
        metadata.type !== object.type ||
        metadata.size !== object.data.length
      ) {
        throw new CorruptError("materialized loose base disagrees with its admitted metadata");
      }
    }
    this.#objects = objects;
    return objects.get(oid);
  }
}
