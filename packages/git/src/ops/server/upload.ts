import { GitError } from "../../common/errors.js";
import {
  encodeAck,
  encodePackResponse,
  type ServerUploadRequest,
} from "../../protocol/server/index.js";
import { abortable } from "../../protocol/stream.js";
import type { SharedRepoStore } from "../../store/index.js";
import { serverRefSnapshot } from "../../store/refs/server-refs.js";
import { transferMembers } from "../../store/transfer/access.js";
import type { TransferOwner, TransferRoot } from "../../store/transfer/lifetime.js";
import type { ServerRuntime } from "./runtime.js";
import { streamTransferPack } from "./transfer-stream.js";
import { UploadLifetime } from "./upload/lifetime.js";

export type UploadRuntime = ServerRuntime;

function acceptedRoots(store: SharedRepoStore, wants: readonly string[]): TransferRoot[] {
  const roots: TransferRoot[] = [];
  const allowed = new Set<string>();
  for (const ref of serverRefSnapshot(store).refs) {
    roots.push({ oid: ref.oid });
    allowed.add(ref.oid);
    if (ref.peeledOid !== undefined) allowed.add(ref.peeledOid);
  }
  for (const oid of wants) {
    if (!allowed.has(oid)) throw new GitError("EINVALIDREF", "upload want is not advertised");
  }
  return roots;
}

async function* acknowledgement(
  request: ServerUploadRequest,
  common: readonly string[],
): AsyncGenerator<Uint8Array> {
  if (request.detailedAck) {
    for (const oid of common) yield encodeAck(oid, "common");
  }
  const last = common.at(-1) ?? null;
  if (request.done) {
    yield encodeAck(last);
  } else {
    if (request.detailedAck && last !== null) yield encodeAck(last, "ready");
    // A bare ACK would make a stateless client expect a pack in a continuation response.
    yield encodeAck(null);
  }
}

/** Each POST proves its own common closure; discovery and earlier rounds retain no session. */
export async function uploadPack(
  store: SharedRepoStore,
  request: ServerUploadRequest,
  runtime: UploadRuntime,
): Promise<AsyncIterable<Uint8Array>> {
  const lifetime = new UploadLifetime(store, runtime);
  try {
    const exposed = acceptedRoots(store, request.wants);
    let access: TransferOwner | undefined;
    let common: string[] = [];
    if (request.haves.length > 0 && (request.done || request.detailedAck)) {
      // Snapshot roots become maintenance roots before the first planning await.
      access = lifetime.create({ wanted: exposed });
      await lifetime.plan(access);
      common = transferMembers(store, access, request.haves, runtime.now());
    }
    let pack: TransferOwner | undefined;
    if (request.done) {
      pack = lifetime.create({
        wanted: request.wants.map((oid) => ({ oid })),
        common: common.map((oid) => ({ oid })),
      });
    }
    if (access !== undefined) lifetime.release(access);
    if (pack !== undefined) await lifetime.plan(pack);
    const selected = pack;
    async function* response(): AsyncGenerator<Uint8Array> {
      yield* acknowledgement(request, common);
      if (selected !== undefined) {
        yield* encodePackResponse(
          streamTransferPack(store, selected, {
            now: runtime.now,
            yieldNow: () => abortable(runtime.yieldNow(), runtime.signal),
          }),
          request.sideband,
        );
      }
    }
    return lifetime.response(response());
  } catch (error) {
    lifetime.close();
    throw error;
  }
}
