// pako's low-level decoder, which its package exports. A reused stream
// avoids allocating decoder state per pack entry; @types/pako omits it.
declare module "pako/lib/zlib/zstream.js" {
  export default class ZStream {
    input: Uint8Array | null;
    next_in: number;
    avail_in: number;
    output: Uint8Array | null;
    next_out: number;
    avail_out: number;
    msg: string;
  }
}

declare module "pako/lib/zlib/inflate.js" {
  import type ZStream from "pako/lib/zlib/zstream.js";

  export function inflateInit2(strm: ZStream, windowBits: number): number;
  export function inflateReset(strm: ZStream): number;
  export function inflate(strm: ZStream, flush: number): number;
}
