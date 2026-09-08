// Derived from dgit (MIT, Copyright (c) 2026 Divy Srivastava),
// https://github.com/littledivy/dgit — applyDelta is adapted from dgit's src/git/pack.ts.
//
import { CorruptError } from "../../common/errors.js";
import { type ByteSource, ChunkedBytes, type ChunkPool, chunkFootprint } from "./chunks.js";

const MAX_DELTA_TARGET = 512 * 1024 * 1024;
export const MAX_DELTA_WORKING_BYTES = 48 * 1024 * 1024;
export const MAX_DELTA_INSTRUCTION_BYTES = 48 * 1024 * 1024;

export interface DeltaLimits {
  /** Optional indexed size check, applied before target allocation. */
  expectedTargetSize?: number;
  /** Test seam; production admits at most MAX_DELTA_WORKING_BYTES. */
  maxWorkingBytes?: number;
  /** Inflated delta instructions are bounded independently of output bytes. */
  maxInstructionBytes?: number;
}

type DeltaPhase = "source-size" | "target-size" | "opcode" | "copy" | "literal";

/** Incremental git delta parser writing directly into pool-owned target chunks. */
export class DeltaApplier {
  readonly #base: ByteSource;
  readonly #pool: ChunkPool;
  readonly #expectedTargetSize: number | undefined;
  readonly #maxWorkingBytes: number;
  readonly #maxInstructionBytes: number;
  #phase: DeltaPhase = "source-size";
  #sizeValue = 0;
  #sizeMultiplier = 1;
  #target: ChunkedBytes | null = null;
  #targetSize = 0;
  #written = 0;
  #instructionBytes = 0;
  #copyCommand = 0;
  #copyBit = 1;
  #copyOffset = 0;
  #copySize = 0;
  #literalRemaining = 0;
  #failed = false;
  #finished = false;

  constructor(base: ByteSource, pool: ChunkPool, limits: DeltaLimits = {}) {
    this.#base = base;
    this.#pool = pool;
    this.#expectedTargetSize = limits.expectedTargetSize;
    this.#maxWorkingBytes = limits.maxWorkingBytes ?? MAX_DELTA_WORKING_BYTES;
    this.#maxInstructionBytes = limits.maxInstructionBytes ?? MAX_DELTA_INSTRUCTION_BYTES;
    if (
      (this.#expectedTargetSize !== undefined &&
        (!Number.isSafeInteger(this.#expectedTargetSize) || this.#expectedTargetSize < 0)) ||
      !Number.isSafeInteger(this.#maxWorkingBytes) ||
      this.#maxWorkingBytes < 0 ||
      !Number.isSafeInteger(this.#maxInstructionBytes) ||
      this.#maxInstructionBytes < 0
    ) {
      throw new RangeError("invalid delta limits");
    }
  }

  get instructionBytes(): number {
    return this.#instructionBytes;
  }

  get targetSize(): number | null {
    return this.#phase === "source-size" || this.#phase === "target-size" ? null : this.#targetSize;
  }

  push(input: Uint8Array): void {
    if (this.#failed) throw new Error("delta applier has failed");
    if (this.#finished) throw new Error("delta applier is finished");
    try {
      if (input.length > this.#maxInstructionBytes - this.#instructionBytes) {
        throw new CorruptError("delta instruction stream too large");
      }
      this.#instructionBytes += input.length;
      this.#push(input);
    } catch (error) {
      this.#failed = true;
      this.#releaseTarget();
      throw error;
    }
  }

  finish(): ChunkedBytes {
    if (this.#failed) throw new Error("delta applier has failed");
    if (this.#finished) throw new Error("delta applier is finished");
    try {
      if (this.#phase === "literal") throw new CorruptError("delta literal truncated");
      if (this.#phase !== "opcode") throw new CorruptError("delta truncated");
      if (this.#written !== this.#targetSize) {
        throw new CorruptError("delta target size mismatch");
      }
      const target = this.#requireTarget();
      this.#target = null;
      this.#finished = true;
      return target;
    } catch (error) {
      this.#failed = true;
      this.#releaseTarget();
      throw error;
    }
  }

  abort(): void {
    if (this.#finished) return;
    this.#failed = true;
    this.#releaseTarget();
  }

  #push(input: Uint8Array): void {
    let at = 0;
    while (at < input.length) {
      if (this.#phase === "source-size" || this.#phase === "target-size") {
        const complete = this.#sizeByte(input[at]!);
        at++;
        if (!complete) continue;
        if (this.#phase === "source-size") {
          if (this.#sizeValue !== this.#base.length) {
            throw new CorruptError("delta base size mismatch");
          }
          this.#phase = "target-size";
          this.#resetSize();
          continue;
        }
        this.#admitTarget(this.#sizeValue);
        this.#phase = "opcode";
        this.#resetSize();
        continue;
      }

      if (this.#phase === "opcode") {
        const command = input[at]!;
        at++;
        if ((command & 0x80) !== 0) {
          this.#copyCommand = command;
          this.#copyBit = 1;
          this.#copyOffset = 0;
          this.#copySize = 0;
          this.#phase = "copy";
          continue;
        }
        if (command === 0) throw new CorruptError("invalid delta opcode 0");
        if (command > this.#targetSize - this.#written) {
          throw new CorruptError("delta literal overflows target");
        }
        this.#literalRemaining = command;
        this.#phase = "literal";
        continue;
      }

      if (this.#phase === "copy") {
        while (this.#copyBit <= 0x40 && (this.#copyCommand & this.#copyBit) === 0) {
          this.#copyBit *= 2;
        }
        if (this.#copyBit > 0x40) {
          this.#applyCopy();
          this.#phase = "opcode";
          continue;
        }
        this.#copyByte(this.#copyBit, input[at]!);
        this.#copyBit *= 2;
        at++;
        continue;
      }

      const length = Math.min(this.#literalRemaining, input.length - at);
      this.#requireTarget().write(this.#written, input.subarray(at, at + length));
      this.#written += length;
      this.#literalRemaining -= length;
      at += length;
      if (this.#literalRemaining === 0) this.#phase = "opcode";
    }

    if (this.#phase === "copy") {
      while (this.#copyBit <= 0x40 && (this.#copyCommand & this.#copyBit) === 0) {
        this.#copyBit *= 2;
      }
      if (this.#copyBit > 0x40) {
        this.#applyCopy();
        this.#phase = "opcode";
      }
    }
  }

  #sizeByte(byte: number): boolean {
    const addition = (byte & 0x7f) * this.#sizeMultiplier;
    if (!Number.isSafeInteger(addition) || !Number.isSafeInteger(this.#sizeValue + addition)) {
      throw new CorruptError("delta size is invalid");
    }
    this.#sizeValue += addition;
    if ((byte & 0x80) === 0) return true;
    this.#sizeMultiplier *= 128;
    if (!Number.isSafeInteger(this.#sizeMultiplier)) {
      throw new CorruptError("delta size is invalid");
    }
    return false;
  }

  #resetSize(): void {
    this.#sizeValue = 0;
    this.#sizeMultiplier = 1;
  }

  #admitTarget(targetSize: number): void {
    if (targetSize > MAX_DELTA_TARGET) throw new CorruptError("delta target too large");
    if (this.#expectedTargetSize !== undefined && targetSize !== this.#expectedTargetSize) {
      throw new CorruptError("delta target size mismatch");
    }
    const baseBytes = chunkFootprint(this.#base.length);
    const targetBytes = chunkFootprint(targetSize);
    if (baseBytes > this.#maxWorkingBytes || targetBytes > this.#maxWorkingBytes - baseBytes) {
      throw new CorruptError("delta working set exceeds 48 MiB");
    }
    this.#targetSize = targetSize;
    this.#target = ChunkedBytes.allocate(targetSize, this.#pool);
  }

  #copyByte(bit: number, byte: number): void {
    if (bit <= 0x08) {
      const multiplier =
        bit === 0x01 ? 1 : bit === 0x02 ? 0x100 : bit === 0x04 ? 0x10000 : 0x1000000;
      this.#copyOffset += byte * multiplier;
      return;
    }
    const multiplier = bit === 0x10 ? 1 : bit === 0x20 ? 0x100 : 0x10000;
    this.#copySize += byte * multiplier;
  }

  #applyCopy(): void {
    const size = this.#copySize === 0 ? 0x10000 : this.#copySize;
    if (this.#copyOffset > this.#base.length - size) {
      throw new CorruptError("delta copy out of range");
    }
    if (size > this.#targetSize - this.#written) {
      throw new CorruptError("delta copy overflows target");
    }
    this.#requireTarget().copyFrom(this.#base, this.#written, this.#copyOffset, size);
    this.#written += size;
  }

  #requireTarget(): ChunkedBytes {
    if (this.#target === null) throw new Error("delta target is unavailable");
    return this.#target;
  }

  #releaseTarget(): void {
    if (this.#target === null) return;
    this.#target.release();
    this.#target = null;
  }
}

/**
 * Apply a git delta to its base. Every read is bounded: a truncated or
 * crafted delta throws rather than folding `undefined` into an offset.
 */
export function applyDelta(base: Uint8Array, delta: Uint8Array): Uint8Array {
  let pos = 0;
  const next = (): number => {
    if (pos >= delta.length) throw new CorruptError("delta truncated");
    return delta[pos++]!;
  };
  const varint = (): number => {
    let result = 0;
    let shift = 0;
    let byte: number;
    do {
      byte = next();
      result += (byte & 0x7f) * 2 ** shift;
      shift += 7;
    } while (byte & 0x80);
    return result;
  };

  const sourceSize = varint();
  const targetSize = varint();
  if (sourceSize !== base.length) throw new CorruptError("delta base size mismatch");
  if (targetSize > MAX_DELTA_TARGET) throw new CorruptError("delta target too large");

  const out = new Uint8Array(targetSize);
  let written = 0;
  while (pos < delta.length) {
    const command = next();
    if (command & 0x80) {
      let offset = 0;
      let size = 0;
      if (command & 0x01) offset = next();
      if (command & 0x02) offset |= next() << 8;
      if (command & 0x04) offset |= next() << 16;
      if (command & 0x08) offset += next() * 0x1000000;
      if (command & 0x10) size = next();
      if (command & 0x20) size |= next() << 8;
      if (command & 0x40) size |= next() << 16;
      if (size === 0) size = 0x10000;
      if (offset + size > base.length) throw new CorruptError("delta copy out of range");
      if (written + size > targetSize) throw new CorruptError("delta copy overflows target");
      out.set(base.subarray(offset, offset + size), written);
      written += size;
    } else if (command !== 0) {
      if (pos + command > delta.length) throw new CorruptError("delta literal truncated");
      if (written + command > targetSize) throw new CorruptError("delta literal overflows target");
      out.set(delta.subarray(pos, pos + command), written);
      written += command;
      pos += command;
    } else {
      throw new CorruptError("invalid delta opcode 0");
    }
  }
  if (written !== targetSize) throw new CorruptError("delta target size mismatch");
  return out;
}

/**
 * Encode `target` as a delta against `base`. Used when generating a pack
 * for push; a naive single-literal encoding is legal git, so correctness
 * never depends on how good the matching is.
 */
export function encodeDeltaHeader(sourceSize: number, targetSize: number): Uint8Array {
  const bytes: number[] = [];
  for (const size of [sourceSize, targetSize]) {
    let value = size;
    do {
      const byte = value & 0x7f;
      value = Math.floor(value / 128);
      bytes.push(value > 0 ? byte | 0x80 : byte);
    } while (value > 0);
  }
  return new Uint8Array(bytes);
}
