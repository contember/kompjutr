import { fromHex, utf8 } from "../bytes.js";
import { type ObjectType, TYPE_NUMBER } from "../objects.js";
import { Sha1 } from "../sha1.js";
import { deflate } from "../zlib.js";

const REF_DELTA = 7;

function encodeTypeAndSize(typeNumber: number, size: number): Uint8Array {
  const bytes: number[] = [];
  let first = (typeNumber << 4) | (size & 0x0f);
  let rest = Math.floor(size / 16);
  while (rest > 0) {
    bytes.push(first | 0x80);
    first = rest & 0x7f;
    rest = Math.floor(rest / 128);
  }
  bytes.push(first);
  return new Uint8Array(bytes);
}

/**
 * Incremental packfile writer. Bytes leave through `emit` while the
 * running SHA-1 accumulates for the trailer, so a pack can be streamed to
 * a remote without ever being assembled.
 */
export class PackWriter {
  readonly #sha = new Sha1();
  readonly #emit: (chunk: Uint8Array) => void;

  constructor(emit: (chunk: Uint8Array) => void) {
    this.#emit = emit;
  }

  #out(chunk: Uint8Array): void {
    this.#sha.update(chunk);
    this.#emit(chunk);
  }

  header(count: number): void {
    const head = new Uint8Array(12);
    head.set(utf8.encode("PACK"), 0);
    new DataView(head.buffer).setUint32(4, 2);
    new DataView(head.buffer).setUint32(8, count);
    this.#out(head);
  }

  object(type: ObjectType, data: Uint8Array): void {
    this.#out(encodeTypeAndSize(TYPE_NUMBER[type], data.length));
    this.#out(deflate(data));
  }

  /** A ref-delta entry against `baseOid`. `delta` is the raw delta body. */
  refDelta(baseOid: string, delta: Uint8Array): void {
    this.#out(encodeTypeAndSize(REF_DELTA, delta.length));
    this.#out(fromHex(baseOid));
    this.#out(deflate(delta));
  }

  /** Emits the trailer; the trailer itself is not hashed. */
  finish(): void {
    this.#emit(this.#sha.digest());
  }
}
