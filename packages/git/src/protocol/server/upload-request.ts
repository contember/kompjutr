import { CorruptError, GitError } from "../../common/errors.js";
import { MAX_PROTOCOL_NEGOTIATION_ENTRIES, releaseReader } from "../remote-base.js";
import { ByteReader } from "../stream.js";
import { UPLOAD_SERVER_CAPABILITIES } from "./advertisement.js";
import { parseCapabilities, requireServerOid, serverPacketText } from "./validation.js";

export interface ServerUploadRequest {
  readonly wants: readonly string[];
  readonly haves: readonly string[];
  readonly done: boolean;
  readonly detailedAck: boolean;
  readonly sideband: boolean;
}

export async function parseUploadPackRequest(
  body: AsyncIterable<Uint8Array>,
  signal?: AbortSignal,
): Promise<ServerUploadRequest> {
  const reader = new ByteReader(body, signal);
  const wants = new Set<string>();
  const haves = new Set<string>();
  let capabilities = new Set<string>();
  let wantsEnded = false;
  let done = false;
  let entries = 0;
  try {
    for (;;) {
      const packet = await reader.readPkt();
      if (packet === null)
        throw new CorruptError("upload request ended before its terminal packet");
      if (packet.kind === "flush") {
        if (wantsEnded) break;
        wantsEnded = true;
        continue;
      }
      const text = serverPacketText(packet);
      if (text === "done" && wantsEnded) {
        done = true;
        break;
      }
      const fields = text.split(" ");
      const [command, oid] = fields;
      if (oid === undefined || command !== (wantsEnded ? "have" : "want")) {
        throw new CorruptError("unexpected upload command or command order");
      }
      requireServerOid(oid);
      if (!wantsEnded && wants.size === 0) {
        capabilities = parseCapabilities(fields.slice(2).join(" "), UPLOAD_SERVER_CAPABILITIES);
      } else if (fields.length !== 2) {
        throw new CorruptError("upload capabilities occur after the first want");
      }
      const selected = wantsEnded ? haves : wants;
      // Count frames, including repeated OIDs from native clients, to bound request processing.
      if (entries === MAX_PROTOCOL_NEGOTIATION_ENTRIES) {
        throw new GitError("E2BIG", "upload negotiation exceeds the bounded object-id set");
      }
      entries++;
      selected.add(oid);
    }
    if (wants.size === 0) throw new CorruptError("upload request contains no wants");
    if ((await reader.readPkt()) !== null) {
      throw new CorruptError("bytes follow the upload request terminal packet");
    }
    return {
      wants: [...wants],
      haves: [...haves],
      done,
      detailedAck: capabilities.has("multi_ack_detailed"),
      sideband: capabilities.has("side-band-64k"),
    };
  } finally {
    await releaseReader(reader);
  }
}
