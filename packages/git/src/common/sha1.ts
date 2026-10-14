// Incremental SHA-1. Git's object ids are SHA-1 and packs carry a SHA-1
// trailer over the whole file, so the hash has to accept bytes in
// arbitrary chunks without ever holding the full input.
//
// workerd implements `node:crypto` hashing natively under nodejs_compat;
// it replaced a TypeScript compression loop that cost seconds per clone.
//
// SHA-1 collision detection is not implemented.

import { createHash, type Hash } from "node:crypto";

export class Sha1 {
  readonly #hash: Hash = createHash("sha1");

  update(data: Uint8Array): this {
    this.#hash.update(data);
    return this;
  }

  digest(): Uint8Array {
    const digest = this.#hash.digest();
    return new Uint8Array(digest.buffer, digest.byteOffset, digest.byteLength);
  }
}

export function sha1(data: Uint8Array): Uint8Array {
  return new Sha1().update(data).digest();
}
