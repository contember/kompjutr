// Derived from dgit (MIT, Copyright (c) 2026 Divy Srivastava),
// https://github.com/littledivy/dgit — the three-phase ingest, the rotating offset window, the deferred-delta table and the iterative delta-chain walk all follow dgit's src/git/packstore.ts.

import { toHex } from "../../common/bytes.js";
import { CorruptError } from "../../common/errors.js";
import { type ObjectType, objectHeader } from "../../common/objects.js";
import { Sha1 } from "../../common/sha1.js";
import { InflateInto, InflateStream, inflatePrefix } from "../../common/zlib.js";
import { type ByteSource, type ChunkedBytes, type ChunkPool, chunkFootprint } from "./chunks.js";
import { DeltaApplier } from "./delta.js";
import type { PackReader } from "./ingest-reader.js";
import type { PackReadEngine } from "./read.js";
import {
  DeltaHeaderProbe,
  FlatByteSource,
  MAX_PACK_DELTA_WORKING_BYTES,
  PACK_RANGE_SLICE_BYTES,
  PACK_READ_BYTES,
  pushExactInflate,
} from "./shared.js";

export interface InflatedPackEntry {
  data: Uint8Array | null;
  consumed: number;
  streamedOid: string | null;
  deltaTargetSize: number | null;
  compressedDigest: string;
}

export class PackIngestInflater {
  constructor(
    private readonly read: PackReadEngine,
    private readonly maxBufferedEntry: number,
  ) {}
  applyDeltaBytes(base: Uint8Array, delta: Uint8Array, pool: ChunkPool): ChunkedBytes {
    const probe = new DeltaHeaderProbe();
    probe.update(delta);
    const header = probe.finish();
    if (header.sourceSize !== base.length) throw new CorruptError("delta base size mismatch");
    this.#validatePoolTarget(base.length, header.targetSize);
    const applier = new DeltaApplier(new FlatByteSource(base), pool, {
      expectedTargetSize: header.targetSize,
      maxWorkingBytes: MAX_PACK_DELTA_WORKING_BYTES,
      maxInstructionBytes: MAX_PACK_DELTA_WORKING_BYTES,
    });
    try {
      applier.push(delta);
      const target = applier.finish();
      if (base.length + applier.instructionBytes + target.length > MAX_PACK_DELTA_WORKING_BYTES) {
        target.release();
        throw new CorruptError("delta working set exceeds 48 MiB");
      }
      return target;
    } catch (error) {
      applier.abort();
      throw error;
    }
  }

  applyStoredDelta(
    packId: number,
    dataOff: number,
    dataLen: number,
    instructionSize: number,
    label: string,
    base: ByteSource,
    pool: ChunkPool,
    compressed: Uint8Array | null = null,
  ): ChunkedBytes {
    if (
      !Number.isSafeInteger(dataLen) ||
      !Number.isSafeInteger(instructionSize) ||
      dataLen < 0 ||
      instructionSize < 0 ||
      base.length + instructionSize > MAX_PACK_DELTA_WORKING_BYTES
    ) {
      throw new CorruptError(`${label} exceeds the bounded working set`);
    }
    const header = this.#probeStoredDeltaHeader(packId, dataOff, dataLen, label, compressed);
    if (header.sourceSize !== base.length) throw new CorruptError("delta base size mismatch");
    const targetSize = header.targetSize;
    this.#validatePoolTarget(base.length, targetSize);
    const applier = new DeltaApplier(base, pool, {
      expectedTargetSize: targetSize,
      maxWorkingBytes: MAX_PACK_DELTA_WORKING_BYTES,
      maxInstructionBytes: MAX_PACK_DELTA_WORKING_BYTES,
    });
    const stream = new InflateStream((chunk) => applier.push(chunk));
    let consumed = 0;
    const push = (input: Uint8Array): void => {
      let used: number;
      try {
        used = stream.push(input);
      } catch (error) {
        if (error instanceof CorruptError) throw error;
        throw new CorruptError(`${label} is not a valid zlib stream`, { cause: error });
      }
      consumed += used;
      if (!stream.ended && used !== input.length) {
        throw new CorruptError(`${label} inflater stopped before the stream ended`);
      }
    };
    try {
      if (compressed === null) {
        while (!stream.ended && consumed < dataLen) {
          const length = Math.min(PACK_READ_BYTES, dataLen - consumed);
          push(this.read.readRaw(packId, dataOff + consumed, length));
        }
      } else {
        if (compressed.length !== dataLen) {
          throw new CorruptError(`${label} compressed range has the wrong size`);
        }
        for (let offset = 0; offset < compressed.length; offset += PACK_RANGE_SLICE_BYTES) {
          push(compressed.subarray(offset, offset + PACK_RANGE_SLICE_BYTES));
        }
      }
      if (!stream.ended || consumed !== dataLen || stream.inflated !== instructionSize) {
        throw new CorruptError(`${label} size does not match its index metadata`);
      }
      const target = applier.finish();
      if (base.length + applier.instructionBytes + target.length > MAX_PACK_DELTA_WORKING_BYTES) {
        target.release();
        throw new CorruptError("delta working set exceeds 48 MiB");
      }
      return target;
    } catch (error) {
      applier.abort();
      throw error;
    }
  }

  #probeStoredDeltaHeader(
    packId: number,
    dataOff: number,
    dataLen: number,
    label: string,
    compressed: Uint8Array | null,
  ): { sourceSize: number; targetSize: number } {
    if (compressed !== null && compressed.length !== dataLen) {
      throw new CorruptError(`${label} compressed range has the wrong size`);
    }
    const probe = new DeltaHeaderProbe();
    const stream = new InflateStream((chunk) => probe.update(chunk));
    let consumed = 0;
    while (!probe.complete && !stream.ended && consumed < dataLen) {
      const length = Math.min(PACK_RANGE_SLICE_BYTES, dataLen - consumed);
      const input =
        compressed === null
          ? this.read.readRaw(packId, dataOff + consumed, length)
          : compressed.subarray(consumed, consumed + length);
      let used: number;
      try {
        used = stream.push(input);
      } catch (error) {
        if (error instanceof CorruptError) throw error;
        throw new CorruptError(`${label} is not a valid zlib stream`, { cause: error });
      }
      consumed += used;
      if (!stream.ended && used !== input.length) {
        throw new CorruptError(`${label} inflater stopped before the stream ended`);
      }
    }
    return probe.finish();
  }

  #validatePoolTarget(baseSize: number, targetSize: number): void {
    const baseBytes = chunkFootprint(baseSize);
    const targetBytes = chunkFootprint(targetSize);
    if (
      baseBytes > MAX_PACK_DELTA_WORKING_BYTES ||
      targetBytes > MAX_PACK_DELTA_WORKING_BYTES - baseBytes
    ) {
      throw new CorruptError("delta working set exceeds 48 MiB");
    }
  }

  inflateAt(
    reader: PackReader,
    dataOff: number,
    entrySize: number,
    type: ObjectType | null,
  ): {
    data: Uint8Array | null;
    consumed: number;
    streamedOid: string | null;
    deltaTargetSize: number | null;
    compressedDigest: string;
  } {
    const buffered = entrySize <= this.maxBufferedEntry;
    const deltaHeader = type === null ? new DeltaHeaderProbe() : null;
    const compressedSha = new Sha1();
    reader.seek(dataOff);
    if (buffered) {
      const window = reader.window();
      if (window.length === 0) throw new CorruptError(`truncated pack entry at ${dataOff}`);
      let exact: { data: Uint8Array; consumed: number } | null;
      try {
        exact = inflatePrefix(window, entrySize);
      } catch (error) {
        throw new CorruptError(`invalid pack entry at ${dataOff}`, { cause: error });
      }
      if (exact !== null) {
        if (
          exact.data.length !== entrySize ||
          !Number.isSafeInteger(exact.consumed) ||
          exact.consumed <= 0 ||
          exact.consumed > window.length
        ) {
          throw new CorruptError(`pack entry size mismatch at ${dataOff}`);
        }
        deltaHeader?.update(exact.data);
        compressedSha.update(window.subarray(0, exact.consumed));
        reader.seek(dataOff + exact.consumed);
        return {
          data: exact.data,
          consumed: exact.consumed,
          streamedOid: null,
          deltaTargetSize: deltaHeader?.finish().targetSize ?? null,
          compressedDigest: toHex(compressedSha.digest()),
        };
      }
    }
    const exactInflater = buffered ? new InflateInto(entrySize) : null;
    let produced = 0;
    const sha = type === null ? null : new Sha1().update(objectHeader(type, entrySize));
    const stream =
      exactInflater ??
      new InflateStream((chunk) => {
        produced += chunk.length;
        if (produced > entrySize) {
          throw new CorruptError(`pack entry exceeds its declared size at ${dataOff}`);
        }
        deltaHeader?.update(chunk);
        sha?.update(chunk);
      });
    reader.seek(dataOff);
    let consumed = 0;
    while (!stream.ended) {
      const window = reader.window();
      if (window.length === 0) throw new CorruptError(`truncated pack entry at ${dataOff}`);
      const used =
        exactInflater === null
          ? stream.push(window)
          : pushExactInflate(exactInflater, window, `pack entry at ${dataOff}`);
      consumed += used;
      if (!stream.ended && used !== window.length) {
        throw new CorruptError(`pack entry inflater stopped before the stream ended at ${dataOff}`);
      }
      compressedSha.update(window.subarray(0, used));
      reader.seek(reader.position + (stream.ended ? used : window.length));
    }
    if (stream.inflated !== entrySize) {
      throw new CorruptError(`pack entry size mismatch at ${dataOff}`);
    }
    const data = exactInflater?.finish() ?? null;
    if (data !== null) deltaHeader?.update(data);
    return {
      data,
      consumed,
      streamedOid: buffered || sha === null ? null : toHex(sha.digest()),
      deltaTargetSize: deltaHeader?.finish().targetSize ?? null,
      compressedDigest: toHex(compressedSha.digest()),
    };
  }
}
