import { Buffer } from "node:buffer";
import type { RetainedBudget } from "../../exec/context.js";

const DECODER = new TextDecoder("utf-8", { ignoreBOM: true });
const STRICT_DECODER = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true });

export type JsonText = { text: string } | { bytes: string };

export function jsonText(bytes: Uint8Array): JsonText {
  try {
    return { text: STRICT_DECODER.decode(bytes) };
  } catch {
    return {
      bytes: Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength).toString("base64"),
    };
  }
}

export function withoutBom(bytes: Uint8Array): Uint8Array {
  return bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf ? bytes.subarray(3) : bytes;
}

export interface SearchText {
  readonly text: string;
  byteOffset(index: number): number;
  release(): void;
}

export function searchText(bytes: Uint8Array, retained: RetainedBudget): SearchText {
  const releaseText = retained.retain(bytes.length * 4, "search decoded text");
  let releaseOffsets = () => {};
  try {
    const decoded = DECODER.decode(bytes);
    releaseOffsets = retained.retain((decoded.length + 1) * 4, "search byte offsets");
    const offsets = new Uint32Array(decoded.length + 1);
    let byte = 0;
    for (let index = 0; index < decoded.length; index++) {
      offsets[index] = byte;
      const point = decoded.codePointAt(index) ?? 0;
      if (point > 0xffff) {
        offsets[++index] = byte;
        byte += 4;
      } else if (point === 0xfffd) {
        byte += sequenceWidth(bytes, byte);
      } else {
        byte += point < 0x80 ? 1 : point < 0x800 ? 2 : 3;
      }
    }
    offsets[decoded.length] = byte;
    // Lone surrogates mark malformed bytes, so Unicode atoms cannot match a replacement character.
    const text = decoded.replace(/\ufffd/g, (value: string, index: number) => {
      const start = offsets[index] ?? 0;
      return bytes[start] === 0xef && bytes[start + 1] === 0xbf && bytes[start + 2] === 0xbd
        ? value
        : "\ud800";
    });
    return {
      text,
      byteOffset: (index) => offsets[index] ?? bytes.length,
      release: () => {
        releaseOffsets();
        releaseText();
      },
    };
  } catch (error) {
    releaseOffsets();
    releaseText();
    throw error;
  }
}

/** Consume the same maximal malformed prefix as the platform UTF-8 decoder. */
function sequenceWidth(bytes: Uint8Array, offset: number): number {
  const lead = bytes[offset] ?? 0;
  const width =
    lead >= 0xc2 && lead <= 0xdf
      ? 2
      : lead >= 0xe0 && lead <= 0xef
        ? 3
        : lead >= 0xf0 && lead <= 0xf4
          ? 4
          : 1;
  for (let index = 1; index < width; index++) {
    const byte = bytes[offset + index];
    const minimum =
      index === 1 && lead === 0xe0 ? 0xa0 : index === 1 && lead === 0xf0 ? 0x90 : 0x80;
    const maximum =
      index === 1 && lead === 0xed ? 0x9f : index === 1 && lead === 0xf4 ? 0x8f : 0xbf;
    if (byte === undefined || byte < minimum || byte > maximum) return index;
  }
  return width;
}
