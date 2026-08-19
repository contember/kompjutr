import { CorruptError } from "../errors.js";

const MAX_DELTA_TARGET = 512 * 1024 * 1024;

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
