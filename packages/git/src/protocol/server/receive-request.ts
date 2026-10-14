import { ZERO_OID } from "../../common/bytes.js";
import { CorruptError, GitError } from "../../common/errors.js";
import { MAX_RECEIVE_PACK_COMMANDS, type ReceivePackCommand } from "../receive-pack-types.js";
import { releaseReader } from "../remote-base.js";
import { ByteReader } from "../stream.js";
import { RECEIVE_SERVER_CAPABILITIES } from "./advertisement.js";
import {
  parseCapabilities,
  requireServerOid,
  requireServerRef,
  serverPacketText,
} from "./validation.js";

export interface ServerReceiveOptions {
  /** Maximum incoming pack bytes this deployment can store, independent of Content-Length. */
  readonly maxPackBytes: number;
  readonly signal?: AbortSignal;
}

export interface ServerReceiveRequest {
  readonly commands: readonly ReceivePackCommand[];
  readonly reportStatus: boolean;
  readonly pack: AsyncIterable<Uint8Array>;
  /** Release even when the pack iterator has never been started. */
  release(): Promise<void>;
}

export async function parseReceivePackRequest(
  body: AsyncIterable<Uint8Array>,
  options: ServerReceiveOptions,
): Promise<ServerReceiveRequest> {
  if (!Number.isSafeInteger(options.maxPackBytes) || options.maxPackBytes < 0) {
    throw new GitError("EINVAL", "maxPackBytes must be a nonnegative safe integer");
  }
  const reader = new ByteReader(body, options.signal);
  const commands: ReceivePackCommand[] = [];
  const refs = new Set<string>();
  let reportStatus = false;
  try {
    for (;;) {
      const packet = await reader.readPkt();
      if (packet === null) throw new CorruptError("receive commands ended before flush");
      if (packet.kind === "flush") break;
      if (commands.length === MAX_RECEIVE_PACK_COMMANDS) {
        throw new GitError("E2BIG", "receive commands exceed the bounded publication set");
      }
      let text = serverPacketText(packet);
      const nul = text.indexOf("\0");
      if (nul >= 0) {
        if (commands.length !== 0) {
          throw new CorruptError("receive capabilities occur after the first command");
        }
        const capabilities = parseCapabilities(text.slice(nul + 1), RECEIVE_SERVER_CAPABILITIES);
        reportStatus = capabilities.has("report-status");
        text = text.slice(0, nul);
      }
      const fields = text.split(" ");
      const [oldOid, newOid, ref] = fields;
      if (
        fields.length !== 3 ||
        oldOid === undefined ||
        newOid === undefined ||
        ref === undefined
      ) {
        throw new CorruptError("malformed receive command");
      }
      requireServerOid(oldOid, true);
      requireServerOid(newOid, true);
      if (oldOid === ZERO_OID && newOid === ZERO_OID) {
        throw new CorruptError("receive command cannot both create and delete a ref");
      }
      requireServerRef(ref);
      if (refs.has(ref)) throw new CorruptError("duplicate receive destination");
      refs.add(ref);
      commands.push({ oldOid, newOid, ref });
    }
    return {
      commands,
      reportStatus,
      pack: readPack(
        reader,
        options.maxPackBytes,
        commands.some((command) => command.newOid !== ZERO_OID),
      ),
      release: () => reader.release(),
    };
  } catch (error) {
    await releaseReader(reader);
    throw error;
  }
}

async function* readPack(
  reader: ByteReader,
  maxBytes: number,
  acceptsPack: boolean,
): AsyncGenerator<Uint8Array> {
  let bytes = 0;
  for await (const chunk of reader.rest()) {
    if (!acceptsPack)
      throw new CorruptError("pack bytes follow a delete-only or empty receive request");
    if (chunk.length > maxBytes - bytes) {
      throw new GitError("E2BIG", "incoming pack exceeds the deployment storage limit");
    }
    bytes += chunk.length;
    yield chunk;
  }
}
