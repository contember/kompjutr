import { CorruptError, GitError } from "../../common/errors.js";
import { MAX_PROTOCOL_NEGOTIATION_ENTRIES } from "../../protocol/remote-base.js";
import type { ServerAdvertisedRef, ServerAdvertisement } from "../../protocol/server/index.js";
import { requireServerRef } from "../../protocol/server/validation.js";
import { requireObjectInfo, scanHeaders } from "../graph/semantic-headers.js";
import type { SharedRepoStore } from "../index.js";
import { requireCompleteRepository } from "../transfer/lifetime.js";
import { resolveRawRef } from "./refs.js";

function peelTag(store: SharedRepoStore, start: string): string | undefined {
  let oid = start;
  for (let depth = 0; depth < 16; depth++) {
    const info = requireObjectInfo(store, oid);
    if (info.type !== "tag") return oid === start ? undefined : oid;
    const header = scanHeaders(store, info, "tag", 0, 0);
    if (header.tagOid === null) throw new CorruptError("advertised tag has no target");
    oid = header.tagOid;
  }
  throw new CorruptError("advertised tag chain exceeds the repository tag-resolution depth");
}

/** Snapshot names synchronously: no SQLite cursor survives an HTTP await. */
export function serverRefSnapshot(store: SharedRepoStore): ServerAdvertisement {
  return store.db.transactionSync(() => {
    requireCompleteRepository(store);
    const refs: ServerAdvertisedRef[] = [];
    const defaultBranch = store.defaultBranch();
    requireServerRef(defaultBranch);
    let headOid: string | null = null;
    for (const row of store.iterateRefs()) {
      if (!(row.name.startsWith("refs/heads/") || row.name.startsWith("refs/tags/"))) continue;
      requireServerRef(row.name);
      // Ref-name bytes and this entry ceiling bound the retained advertisement snapshot.
      if (refs.length === MAX_PROTOCOL_NEGOTIATION_ENTRIES) {
        throw new GitError("E2BIG", "served refs exceed the bounded advertisement snapshot");
      }
      const oid = resolveRawRef(row.target, (name) => store.getRef(name));
      if (oid === null) continue;
      const peeledOid = row.name.startsWith("refs/tags/") ? peelTag(store, oid) : undefined;
      refs.push({ name: row.name, oid, ...(peeledOid === undefined ? {} : { peeledOid }) });
      if (row.name === defaultBranch) headOid = oid;
    }
    return { refs, head: { ref: defaultBranch, oid: headOid } };
  });
}
