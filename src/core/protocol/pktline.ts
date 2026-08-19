// Derived from dgit (MIT, Copyright (c) 2026 Divy Srivastava),
// https://github.com/littledivy/dgit — adapted from dgit's src/git/pktline.ts.
//
import { concat, utf8 } from "../bytes.js";

export const FLUSH = utf8.encode("0000");
export const DELIM = utf8.encode("0001");

/** One pkt-line. The four-byte length prefix counts itself. */
export function pkt(payload: string | Uint8Array): Uint8Array {
  const body = typeof payload === "string" ? utf8.encode(payload) : payload;
  if (body.length > 65516) throw new Error("pkt-line payload too long");
  return concat([utf8.encode((body.length + 4).toString(16).padStart(4, "0")), body]);
}

export function pktLines(...payloads: (string | Uint8Array)[]): Uint8Array {
  return concat(payloads.map(pkt));
}
