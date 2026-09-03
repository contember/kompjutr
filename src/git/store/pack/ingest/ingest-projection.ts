// Derived from dgit (MIT, Copyright (c) 2026 Divy Srivastava),
// https://github.com/littledivy/dgit — the three-phase ingest, the rotating offset window, the deferred-delta table and the iterative delta-chain walk all follow dgit's src/git/packstore.ts.

import { concat } from "../../../common/bytes.js";
import { CorruptError } from "../../../common/errors.js";
import type { ObjectType } from "../../../common/objects.js";
import { InflateStream } from "../../../common/zlib.js";
import type { ChunkedBytes } from "../chunks.js";
import type {
  PackCommitIndex,
  PackObjectBatch,
  PackObjectInput,
  PackTreeIndex,
} from "../pack-ingest-index.js";
import type { PackReadEngine } from "../read.js";
import { PACK_CHUNK } from "../shared.js";

export class PackResolvedProjection {
  constructor(
    private readonly repoId: number,
    private readonly read: PackReadEngine,
  ) {}
  insertResolved(
    row: PackObjectInput,
    packId: number,
    oid: string,
    type: ObjectType,
    data: Uint8Array | null,
    treeIndex: PackTreeIndex,
    commitIndex: PackCommitIndex,
    dataOff: number,
    dataLen: number,
    objectSize: number,
    objectIndex: PackObjectBatch,
    chunked: ChunkedBytes | null,
  ): void {
    objectIndex.add(row);
    if (type === "commit") {
      let commitData: Uint8Array;
      if (data !== null) {
        commitData = data;
      } else if (chunked !== null) {
        commitData = chunked.toUint8Array();
      } else {
        const inflated = [...this.#inflateEntryChunks(packId, dataOff, dataLen, objectSize)];
        commitData = concat(inflated);
      }
      commitIndex.add({ repoId: this.repoId, oid, data: commitData });
    }
    if (type !== "tree") return;
    if (chunked !== null) {
      treeIndex.addChunked(this.repoId, oid, packId, objectSize, chunked);
      return;
    }
    if (data !== null) {
      treeIndex.addBuffered(this.repoId, oid, packId, objectSize, data);
      return;
    }
    treeIndex.addStream(this.repoId, oid, packId, objectSize, () =>
      this.#inflateEntryChunks(packId, dataOff, dataLen, objectSize),
    );
  }

  /** Re-inflate a large full tree directly into the streaming parser. */
  *#inflateEntryChunks(
    packId: number,
    dataOff: number,
    dataLen: number,
    expectedSize: number,
  ): Generator<Uint8Array> {
    if (
      !Number.isSafeInteger(dataOff) ||
      !Number.isSafeInteger(dataLen) ||
      !Number.isSafeInteger(expectedSize) ||
      dataOff < 0 ||
      dataLen < 0 ||
      expectedSize < 0 ||
      !Number.isSafeInteger(dataOff + dataLen)
    ) {
      throw new CorruptError("packed tree has invalid size metadata");
    }
    const ready: Uint8Array[] = [];
    const stream = new InflateStream((chunk) => ready.push(chunk));
    let consumed = 0;
    while (!stream.ended && consumed < dataLen) {
      const length = Math.min(PACK_CHUNK, dataLen - consumed);
      const input = this.read.readRaw(packId, dataOff + consumed, length);
      const used = stream.push(input);
      consumed += used;
      for (const chunk of ready) yield chunk;
      ready.length = 0;
      if (!stream.ended && used !== input.length) {
        throw new CorruptError("packed tree inflater stopped before the stream ended");
      }
    }
    for (const chunk of ready) yield chunk;
    if (!stream.ended || consumed !== dataLen || stream.inflated !== expectedSize) {
      throw new CorruptError("packed tree size does not match its index metadata");
    }
  }
}
