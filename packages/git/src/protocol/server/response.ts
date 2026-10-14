import { GitError } from "../../common/errors.js";
import { FLUSH, MAX_PKT_PAYLOAD_BYTES, pkt } from "../pktline.js";
import { requireServerOid, requireServerRef } from "./validation.js";

export interface ServerRefStatus {
  readonly ref: string;
  readonly error: string | null;
}

export function encodeAck(oid: string | null, kind?: "common" | "ready"): Uint8Array {
  if (oid === null) {
    if (kind !== undefined) throw new GitError("EINVAL", "NAK cannot carry an ACK kind");
    return pkt("NAK\n");
  }
  requireServerOid(oid);
  return pkt(`ACK ${oid}${kind === undefined ? "" : ` ${kind}`}\n`);
}

function requireStatusText(text: string): void {
  if (text.length === 0 || /[\0\r\n]/.test(text)) {
    throw new GitError("EINVAL", "receive status must contain a single nonempty line");
  }
}

export function* encodeReceiveStatus(
  unpack: string,
  statuses: Iterable<ServerRefStatus>,
): Generator<Uint8Array> {
  requireStatusText(unpack);
  yield pkt(`unpack ${unpack}\n`);
  for (const status of statuses) {
    requireServerRef(status.ref);
    if (status.error === null) {
      yield pkt(`ok ${status.ref}\n`);
    } else {
      requireStatusText(status.error);
      yield pkt(`ng ${status.ref} ${status.error}\n`);
    }
  }
  yield FLUSH;
}

/** ACK/NAK is sent separately before this pack body, even when sideband is selected. */
export async function* encodePackResponse(
  pack: AsyncIterable<Uint8Array>,
  sideband: boolean,
): AsyncGenerator<Uint8Array> {
  for await (const chunk of pack) {
    if (!sideband) {
      yield chunk;
      continue;
    }
    for (let offset = 0; offset < chunk.length; offset += MAX_PKT_PAYLOAD_BYTES - 1) {
      const data = chunk.subarray(offset, offset + MAX_PKT_PAYLOAD_BYTES - 1);
      const payload = new Uint8Array(data.length + 1);
      payload[0] = 1;
      payload.set(data, 1);
      yield pkt(payload);
    }
  }
  if (sideband) yield FLUSH;
}
