export {};

// @types/pako omits two members of the incremental `Inflate` that are part
// of pako's real API: `ended` (the stream reached its end) and
// `strm.avail_in` (how much of the last pushed buffer went unconsumed).
// Finding where a pack entry's deflate stream stops needs the latter, so
// declare them properly rather than casting at the call site.
declare module "pako" {
  interface Inflate {
    readonly ended: boolean;
    readonly strm: {
      readonly avail_in: number;
      output: Uint8Array;
      next_out: number;
      avail_out: number;
    };
  }
}
