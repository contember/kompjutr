// Derived from dgit (MIT, Copyright (c) 2026 Divy Srivastava),
// https://github.com/littledivy/dgit — the entry header encoding and the streaming writer are adapted from dgit's src/git/pack.ts.
//
import { fromHex, toHex, utf8 } from "../bytes.js";
import { type ObjectType, objectHeader, TYPE_NUMBER } from "../objects.js";
import { Sha1 } from "../sha1.js";
import { DeflateStream, deflate } from "../zlib.js";

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
    const object = this.startObject(type, data.length);
    object.push(data);
    object.finish();
  }

  /** Begin one full object whose input can arrive in bounded chunks. */
  startObject(type: ObjectType, size: number, expectedOid?: string): PackObjectWriter {
    if (!Number.isSafeInteger(size) || size < 0) throw new RangeError("invalid pack object size");
    this.#out(encodeTypeAndSize(TYPE_NUMBER[type], size));
    return new PackObjectWriter(type, size, expectedOid, (chunk) => this.#out(chunk));
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

/** One streamed full-object entry owned by a PackWriter. */
export class PackObjectWriter {
  readonly #sha = new Sha1();
  readonly #deflate: DeflateStream;
  #written = 0;
  #finished = false;

  constructor(
    type: ObjectType,
    private readonly size: number,
    private readonly expectedOid: string | undefined,
    emit: (chunk: Uint8Array) => void,
  ) {
    this.#sha.update(objectHeader(type, size));
    this.#deflate = new DeflateStream(emit);
  }

  push(chunk: Uint8Array): void {
    if (this.#finished) throw new Error("pack object is already finished");
    if (chunk.length > this.size - this.#written) {
      throw new Error("pack object exceeds its declared size");
    }
    this.#written += chunk.length;
    this.#sha.update(chunk);
    this.#deflate.push(chunk);
  }

  finish(): void {
    if (this.#finished) throw new Error("pack object is already finished");
    if (this.#written !== this.size) throw new Error("pack object size does not match its input");
    this.#finished = true;
    this.#deflate.finish();
    const oid = toHex(this.#sha.digest());
    if (this.expectedOid !== undefined && oid !== this.expectedOid) {
      throw new Error(`pack object ${this.expectedOid} hashes to ${oid}`);
    }
  }
}
