// Derived from dgit (MIT, Copyright (c) 2026 Divy Srivastava),
// https://github.com/littledivy/dgit — adapted from dgit's src/git/pktline.ts.
//

/** Four-byte prefix included. */
export const MAX_PKT_FRAME_BYTES = 65_520;
export const MAX_PKT_PAYLOAD_BYTES = MAX_PKT_FRAME_BYTES - 4;

const ENCODER = new TextEncoder();

function concat(chunks: readonly Uint8Array[]): Uint8Array {
  const size = chunks.reduce((total, chunk) => total + chunk.length, 0);
  const output = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    output.set(chunk, offset);
    offset += chunk.length;
  }
  return output;
}

export const FLUSH: Uint8Array = ENCODER.encode("0000");
export const DELIM: Uint8Array = ENCODER.encode("0001");

/** One pkt-line. The four-byte length prefix counts itself. */
export function pkt(payload: string | Uint8Array): Uint8Array {
  const body = typeof payload === "string" ? ENCODER.encode(payload) : payload;
  if (body.length > MAX_PKT_PAYLOAD_BYTES) throw new Error("pkt-line payload too long");
  return concat([ENCODER.encode((body.length + 4).toString(16).padStart(4, "0")), body]);
}

export function pktLines(...payloads: (string | Uint8Array)[]): Uint8Array {
  return concat(payloads.map(pkt));
}
