// Derived from dgit (MIT, Copyright (c) 2026 Divy Srivastava),
// https://github.com/littledivy/dgit — the three-phase ingest, the rotating offset window, the deferred-delta table and the iterative delta-chain walk all follow dgit's src/git/packstore.ts.

import { toHex } from "../../../common/bytes.js";
import { CorruptError } from "../../../common/errors.js";
import { NUMBER_TYPE } from "../../../common/objects.js";
import { OFFSET_WINDOW, PACK_CHUNK } from "../shared.js";

/** Rotating (offset -> oid) map: ofs-delta bases are almost always recent. */
export class OffsetWindow {
  #current = new Map<number, string>();
  #previous = new Map<number, string>();

  set(offset: number, oid: string): void {
    this.#current.set(offset, oid);
    if (this.#current.size >= OFFSET_WINDOW) {
      this.#previous = this.#current;
      this.#current = new Map();
    }
  }

  get(offset: number): string | null {
    return this.#current.get(offset) ?? this.#previous.get(offset) ?? null;
  }
}

export interface EntryHeader {
  offset: number;
  dataOff: number;
  type: number;
  entrySize: number;
  kind: "ofs" | "ref" | null;
  baseDelta: number | null;
  baseOid: string | null;
}

/** Sequential cursor over a pack stored as chunk rows. */
export class PackReader {
  #position = 0;

  constructor(
    private readonly readRaw: (offset: number, length: number) => Uint8Array,
    readonly packId: number,
    readonly limit: number,
  ) {}

  get position(): number {
    return this.#position;
  }

  seek(position: number): void {
    this.#position = position;
  }

  byte(): number {
    if (this.#position >= this.limit) throw new CorruptError("pack truncated");
    const value = this.readRaw(this.#position, 1)[0]!;
    this.#position += 1;
    return value;
  }

  take(length: number): Uint8Array {
    const bytes = this.readRaw(this.#position, length);
    this.#position += length;
    return bytes;
  }

  uint32(): number {
    const bytes = this.take(4);
    return ((bytes[0]! << 24) | (bytes[1]! << 16) | (bytes[2]! << 8) | bytes[3]!) >>> 0;
  }

  /** Remaining bytes of the chunk row containing the cursor. */
  window(): Uint8Array {
    if (this.#position >= this.limit) return new Uint8Array(0);
    const chunkStart = Math.floor(this.#position / PACK_CHUNK) * PACK_CHUNK;
    const end = Math.min(chunkStart + PACK_CHUNK, this.limit);
    return this.readRaw(this.#position, end - this.#position);
  }

  entryHeader(): EntryHeader {
    const offset = this.#position;
    let byte = this.byte();
    const type = (byte >> 4) & 7;
    let entrySize = byte & 15;
    let shift = 4;
    while (byte & 0x80) {
      byte = this.byte();
      entrySize += (byte & 0x7f) * 2 ** shift;
      shift += 7;
    }
    let kind: "ofs" | "ref" | null = null;
    let baseDelta: number | null = null;
    let baseOid: string | null = null;
    if (type === 6) {
      kind = "ofs";
      byte = this.byte();
      let delta = byte & 0x7f;
      while (byte & 0x80) {
        byte = this.byte();
        delta = (delta + 1) * 128 + (byte & 0x7f);
      }
      baseDelta = delta;
    } else if (type === 7) {
      kind = "ref";
      baseOid = toHex(this.take(20));
    } else if (NUMBER_TYPE[type] === undefined) {
      throw new CorruptError(`bad object type ${type} at ${offset}`);
    }
    return { offset, dataOff: this.#position, type, entrySize, kind, baseDelta, baseOid };
  }
}
