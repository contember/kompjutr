export const PACK_CHUNK_BYTES = 64 * 1024;

export interface ByteSource {
  readonly length: number;
  byteAt(index: number): number;
  copyTo(target: ChunkedBytes, targetOffset: number, sourceOffset: number, length: number): void;
  chunks(): Iterable<Uint8Array>;
}

export function chunkFootprint(length: number): number {
  if (!Number.isSafeInteger(length) || length < 0) {
    throw new RangeError("invalid chunked byte length");
  }
  const footprint = Math.ceil(length / PACK_CHUNK_BYTES) * PACK_CHUNK_BYTES;
  if (!Number.isSafeInteger(footprint)) throw new RangeError("chunked byte length is too large");
  return footprint;
}

/** Operation-local owner of reusable, fixed-size byte chunks. */
export class ChunkPool {
  readonly #free: Uint8Array[] = [];
  readonly #checkedOut = new Set<Uint8Array>();
  #allocatedBytes = 0;

  constructor(private readonly maxAllocatedBytes = Number.MAX_SAFE_INTEGER) {
    if (!Number.isSafeInteger(maxAllocatedBytes) || maxAllocatedBytes < 0) {
      throw new RangeError("invalid chunk pool allocation limit");
    }
  }

  get allocatedBytes(): number {
    return this.#allocatedBytes;
  }

  get checkedOutBytes(): number {
    return this.#checkedOut.size * PACK_CHUNK_BYTES;
  }

  acquire(): Uint8Array {
    this.preflight(1);
    const chunk = this.#free.pop() ?? this.#allocate();
    if (this.#checkedOut.has(chunk)) throw new Error("chunk pool returned an owned chunk");
    this.#checkedOut.add(chunk);
    return chunk;
  }

  release(chunk: Uint8Array): void {
    if (chunk.length !== PACK_CHUNK_BYTES || !this.#checkedOut.delete(chunk)) {
      throw new Error("chunk is not owned by this pool");
    }
    this.#free.push(chunk);
  }

  preflight(count: number): void {
    if (!Number.isSafeInteger(count) || count < 0) {
      throw new RangeError("invalid chunk allocation count");
    }
    const needed = Math.max(0, count - this.#free.length) * PACK_CHUNK_BYTES;
    if (!Number.isSafeInteger(needed) || needed > this.maxAllocatedBytes - this.#allocatedBytes) {
      throw new RangeError("chunk pool allocation limit exceeded");
    }
  }

  assertIdle(): void {
    if (this.#checkedOut.size !== 0) throw new Error("chunk pool still has owned chunks");
  }

  dispose(): void {
    this.assertIdle();
    this.#free.length = 0;
    this.#allocatedBytes = 0;
  }

  #allocate(): Uint8Array {
    const chunk = new Uint8Array(PACK_CHUNK_BYTES);
    this.#allocatedBytes += PACK_CHUNK_BYTES;
    return chunk;
  }
}

/** Logical bytes backed by chunks exclusively owned until release. */
export class ChunkedBytes implements ByteSource {
  readonly #chunks: Uint8Array[];
  readonly #pool: ChunkPool;
  #released = false;

  private constructor(
    readonly length: number,
    chunks: Uint8Array[],
    pool: ChunkPool,
  ) {
    this.#chunks = chunks;
    this.#pool = pool;
  }

  static allocate(length: number, pool: ChunkPool): ChunkedBytes {
    if (!Number.isSafeInteger(length) || length < 0) {
      throw new RangeError("invalid chunked byte length");
    }
    const chunks: Uint8Array[] = [];
    try {
      const count = Math.ceil(length / PACK_CHUNK_BYTES);
      pool.preflight(count);
      for (let index = 0; index < count; index++) {
        chunks.push(pool.acquire());
      }
      return new ChunkedBytes(length, chunks, pool);
    } catch (error) {
      for (const chunk of chunks) pool.release(chunk);
      throw error;
    }
  }

  static fromBytes(bytes: Uint8Array, pool: ChunkPool): ChunkedBytes {
    const result = ChunkedBytes.allocate(bytes.length, pool);
    try {
      result.write(0, bytes);
      return result;
    } catch (error) {
      result.release();
      throw error;
    }
  }

  write(offset: number, bytes: Uint8Array): void {
    this.#assertRange(offset, bytes.length);
    let sourceOffset = 0;
    let targetOffset = offset;
    while (sourceOffset < bytes.length) {
      const chunkIndex = Math.floor(targetOffset / PACK_CHUNK_BYTES);
      const chunk = this.#chunk(chunkIndex);
      const inChunk = targetOffset % PACK_CHUNK_BYTES;
      const length = Math.min(bytes.length - sourceOffset, PACK_CHUNK_BYTES - inChunk);
      chunk.set(bytes.subarray(sourceOffset, sourceOffset + length), inChunk);
      sourceOffset += length;
      targetOffset += length;
    }
  }

  copyFrom(source: ByteSource, targetOffset: number, sourceOffset: number, length: number): void {
    source.copyTo(this, targetOffset, sourceOffset, length);
  }

  copyTo(target: ChunkedBytes, targetOffset: number, sourceOffset: number, length: number): void {
    this.#assertRange(sourceOffset, length);
    target.#assertRange(targetOffset, length);
    let copied = 0;
    while (copied < length) {
      const sourceAt = sourceOffset + copied;
      const targetAt = targetOffset + copied;
      const sourceInChunk = sourceAt % PACK_CHUNK_BYTES;
      const targetInChunk = targetAt % PACK_CHUNK_BYTES;
      const source = this.#chunk(Math.floor(sourceAt / PACK_CHUNK_BYTES));
      const targetChunk = target.#chunk(Math.floor(targetAt / PACK_CHUNK_BYTES));
      const copyLength = Math.min(
        length - copied,
        PACK_CHUNK_BYTES - sourceInChunk,
        PACK_CHUNK_BYTES - targetInChunk,
      );
      targetChunk.set(source.subarray(sourceInChunk, sourceInChunk + copyLength), targetInChunk);
      copied += copyLength;
    }
  }

  byteAt(index: number): number {
    this.#assertRange(index, 1);
    const chunk = this.#chunk(Math.floor(index / PACK_CHUNK_BYTES));
    return chunk[index % PACK_CHUNK_BYTES]!;
  }

  *chunks(): Iterable<Uint8Array> {
    this.#assertOwned();
    let offset = 0;
    for (const chunk of this.#chunks) {
      const length = Math.min(PACK_CHUNK_BYTES, this.length - offset);
      yield chunk.subarray(0, length);
      offset += length;
    }
  }

  toUint8Array(): Uint8Array {
    this.#assertOwned();
    const result = new Uint8Array(this.length);
    let offset = 0;
    for (const chunk of this.#chunks) {
      const length = Math.min(PACK_CHUNK_BYTES, this.length - offset);
      result.set(chunk.subarray(0, length), offset);
      offset += length;
    }
    return result;
  }

  release(): void {
    if (this.#released) throw new Error("chunked bytes were already released");
    this.#released = true;
    for (const chunk of this.#chunks) this.#pool.release(chunk);
    this.#chunks.length = 0;
  }

  #chunk(index: number): Uint8Array {
    this.#assertOwned();
    const chunk = this.#chunks[index];
    if (chunk === undefined) throw new RangeError("chunk index is out of range");
    return chunk;
  }

  #assertRange(offset: number, length: number): void {
    this.#assertOwned();
    if (
      !Number.isSafeInteger(offset) ||
      !Number.isSafeInteger(length) ||
      offset < 0 ||
      length < 0 ||
      offset > this.length - length
    ) {
      throw new RangeError("chunked byte range is out of bounds");
    }
  }

  #assertOwned(): void {
    if (this.#released) throw new Error("chunked bytes were released");
  }
}
