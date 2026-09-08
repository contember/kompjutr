// Derived from dgit (MIT, Copyright (c) 2026 Divy Srivastava),
// https://github.com/littledivy/dgit — the three-phase ingest, the rotating offset window, the deferred-delta table and the iterative delta-chain walk all follow dgit's src/git/packstore.ts.

import { CorruptError } from "../../common/errors.js";
import type { ObjectType, RawObject } from "../../common/objects.js";
import type { ByteSource, ChunkedBytes, ChunkPool } from "./chunks.js";

export const MAX_PACK_DELTA_WORKING_BYTES = 48 * 1024 * 1024;
export const PACK_DELTA_OBJECT_WRAPPER_BYTES = 256;

export type ExternalBatchResolver = (oids: readonly string[]) => Map<string, RawObject>;
export interface ExternalObjectMetadata {
  type: ObjectType;
  size: number;
}
export type ExternalMetadataResolver = (
  oids: readonly string[],
) => Map<string, ExternalObjectMetadata>;

export interface CompressedEntry {
  bytes: Uint8Array;
  filled: number;
}

export interface PackGraphOrigin {
  readonly rootOid: string;
  depth: number;
  readonly checkpoints: Set<string>;
}

export interface PackGraphPage {
  readonly roots: readonly string[];
  readonly entryLimit: number;
}

export interface PackGraphExit {
  readonly oid: string | null;
  readonly distance: number;
}

export interface PackRangeRequest {
  ordinal: number;
  offset: number;
  position: number;
  length: number;
}

export interface PackIngestMemory {
  pool: ChunkPool;
}

export interface IngestBase {
  type: ObjectType;
  source: ByteSource;
  owned: ChunkedBytes | null;
}

/**
 * Validate the delta header and the live base, instructions, target, and
 * object wrapper before allocating the result.
 */
export function validateDeltaWorkingSet(
  base: Uint8Array,
  delta: Uint8Array,
  expectedTargetSize: number,
): number {
  let at = 0;
  const varint = (): number => {
    let value = 0;
    let shift = 0;
    let byte: number;
    do {
      if (at >= delta.length) throw new CorruptError("delta truncated");
      byte = delta[at++]!;
      value += (byte & 0x7f) * 2 ** shift;
      shift += 7;
      if (shift > 56) throw new CorruptError("delta size is invalid");
    } while ((byte & 0x80) !== 0);
    return value;
  };
  const sourceSize = varint();
  const targetSize = varint();
  if (sourceSize !== base.length) throw new CorruptError("delta base size mismatch");
  if (targetSize !== expectedTargetSize) throw new CorruptError("delta target size mismatch");
  const workingBytes = base.length + delta.length + targetSize + PACK_DELTA_OBJECT_WRAPPER_BYTES;
  if (!Number.isSafeInteger(workingBytes) || workingBytes > MAX_PACK_DELTA_WORKING_BYTES) {
    throw new CorruptError("delta working set exceeds 48 MiB");
  }
  return targetSize;
}

export function checkDeltaInflateBudget(base: Uint8Array, deltaSize: number): void {
  if (
    !Number.isSafeInteger(deltaSize) ||
    deltaSize < 0 ||
    base.length + deltaSize > MAX_PACK_DELTA_WORKING_BYTES
  ) {
    throw new CorruptError("delta input exceeds the bounded working set");
  }
}

export class DeltaHeaderProbe {
  #value = 0;
  #shift = 0;
  #field = 0;
  #sourceSize: number | null = null;
  #targetSize: number | null = null;

  get complete(): boolean {
    return this.#targetSize !== null;
  }

  update(bytes: Uint8Array): void {
    if (this.#targetSize !== null) return;
    for (const byte of bytes) {
      this.#value += (byte & 0x7f) * 2 ** this.#shift;
      this.#shift += 7;
      if (this.#shift > 56 || !Number.isSafeInteger(this.#value)) {
        throw new CorruptError("delta size is invalid");
      }
      if ((byte & 0x80) !== 0) continue;
      if (this.#field === 0) this.#sourceSize = this.#value;
      else this.#targetSize = this.#value;
      this.#field++;
      this.#value = 0;
      this.#shift = 0;
      if (this.#targetSize !== null) return;
    }
  }

  finish(): { sourceSize: number; targetSize: number } {
    if (this.#sourceSize === null || this.#targetSize === null) {
      throw new CorruptError("delta header is truncated");
    }
    return { sourceSize: this.#sourceSize, targetSize: this.#targetSize };
  }
}
