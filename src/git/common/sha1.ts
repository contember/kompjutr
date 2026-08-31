// Incremental SHA-1. Git's object ids are SHA-1 and packs carry a SHA-1
// trailer over the whole file, so the hash has to accept bytes in
// arbitrary chunks without ever holding the full input.
//
// No collision detection (dgit's sha1dc): this is a client writing into
// its own workspace, not a hosting server accepting pushes from
// strangers.

export class Sha1 {
  readonly #state = new Int32Array(5);
  readonly #block = new Uint8Array(64);
  readonly #view = new DataView(this.#block.buffer);
  readonly #w = new Int32Array(80);
  #filled = 0;
  #length = 0;

  constructor() {
    this.reset();
  }

  reset(): this {
    this.#state[0] = 0x67452301;
    this.#state[1] = 0xefcdab89 | 0;
    this.#state[2] = 0x98badcfe | 0;
    this.#state[3] = 0x10325476;
    this.#state[4] = 0xc3d2e1f0 | 0;
    this.#filled = 0;
    this.#length = 0;
    return this;
  }

  update(data: Uint8Array): this {
    this.#length += data.length;
    let offset = 0;
    if (this.#filled > 0) {
      const take = Math.min(64 - this.#filled, data.length);
      this.#block.set(data.subarray(0, take), this.#filled);
      this.#filled += take;
      offset = take;
      if (this.#filled < 64) return this;
      this.#compress(this.#view, 0);
      this.#filled = 0;
    }
    // Whole blocks straight out of the caller's buffer. A DataView over
    // the input avoids a copy per block; the byteOffset dance keeps it
    // correct for subarrays.
    const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
    for (; offset + 64 <= data.length; offset += 64) this.#compress(view, offset);
    if (offset < data.length) {
      this.#block.set(data.subarray(offset), 0);
      this.#filled = data.length - offset;
    }
    return this;
  }

  digest(): Uint8Array {
    const bits = this.#length * 8;
    const tail = new Uint8Array(this.#filled < 56 ? 64 : 128);
    tail.set(this.#block.subarray(0, this.#filled), 0);
    tail[this.#filled] = 0x80;
    const tailView = new DataView(tail.buffer);
    // Length is a 64-bit big-endian bit count. Split through division
    // rather than shifts: >>> wraps at 32 bits and repos do carry
    // objects past 512 MB.
    tailView.setUint32(tail.length - 8, Math.floor(bits / 0x100000000));
    tailView.setUint32(tail.length - 4, bits >>> 0);
    for (let offset = 0; offset < tail.length; offset += 64) this.#compress(tailView, offset);

    const out = new Uint8Array(20);
    const outView = new DataView(out.buffer);
    for (let i = 0; i < 5; i++) outView.setInt32(i * 4, this.#state[i]!);
    return out;
  }

  #compress(view: DataView, offset: number): void {
    const w = this.#w;
    for (let i = 0; i < 16; i++) w[i] = view.getInt32(offset + i * 4);
    for (let i = 16; i < 80; i++) {
      const x = w[i - 3]! ^ w[i - 8]! ^ w[i - 14]! ^ w[i - 16]!;
      w[i] = (x << 1) | (x >>> 31);
    }

    let a = this.#state[0]!;
    let b = this.#state[1]!;
    let c = this.#state[2]!;
    let d = this.#state[3]!;
    let e = this.#state[4]!;

    for (let i = 0; i < 80; i++) {
      let f: number;
      let k: number;
      if (i < 20) {
        f = (b & c) | (~b & d);
        k = 0x5a827999;
      } else if (i < 40) {
        f = b ^ c ^ d;
        k = 0x6ed9eba1;
      } else if (i < 60) {
        f = (b & c) | (b & d) | (c & d);
        k = 0x8f1bbcdc | 0;
      } else {
        f = b ^ c ^ d;
        k = 0xca62c1d6 | 0;
      }
      const t = (((a << 5) | (a >>> 27)) + f + e + k + w[i]!) | 0;
      e = d;
      d = c;
      c = (b << 30) | (b >>> 2);
      b = a;
      a = t;
    }

    this.#state[0] = (this.#state[0]! + a) | 0;
    this.#state[1] = (this.#state[1]! + b) | 0;
    this.#state[2] = (this.#state[2]! + c) | 0;
    this.#state[3] = (this.#state[3]! + d) | 0;
    this.#state[4] = (this.#state[4]! + e) | 0;
  }
}

export function sha1(data: Uint8Array): Uint8Array {
  return new Sha1().update(data).digest();
}
