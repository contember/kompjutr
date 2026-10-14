import { ZERO_OID } from "../../common/bytes.js";
import { GitError } from "../../common/errors.js";
import { comparePaths } from "../../common/paths.js";
import { FLUSH, pkt } from "../pktline.js";
import type { Service } from "../remote-base.js";
import { requireServerOid, requireServerRef } from "./validation.js";

export const RECEIVE_SERVER_CAPABILITIES: readonly string[] = [
  "report-status",
  "delete-refs",
  "no-thin",
];
export const UPLOAD_SERVER_CAPABILITIES: readonly string[] = [
  "multi_ack_detailed",
  "side-band-64k",
];

export interface ServerAdvertisedRef {
  readonly name: string;
  readonly oid: string;
  readonly peeledOid?: string;
}

export interface ServerAdvertisement {
  /** Heads/tags in strictly increasing comparePaths (UTF-8 byte) order. */
  readonly refs: Iterable<ServerAdvertisedRef>;
  /** Repository-owned default branch; null OID denotes an unborn branch. */
  readonly head: { readonly ref: string; readonly oid: string | null } | null;
}

export function* encodeAdvertisement(
  service: Service,
  advertisement: ServerAdvertisement,
): Generator<Uint8Array> {
  const upload = service === "git-upload-pack";
  const head = advertisement.head;
  if (head !== null) {
    requireServerRef(head.ref);
    if (!head.ref.startsWith("refs/heads/")) {
      throw new GitError("EINVALIDREF", "server HEAD must target a branch");
    }
    if (head.oid !== null) requireServerOid(head.oid);
  }
  const capabilities = upload
    ? [...UPLOAD_SERVER_CAPABILITIES, ...(head === null ? [] : [`symref=HEAD:${head.ref}`])]
    : RECEIVE_SERVER_CAPABILITIES;
  yield pkt(`# service=${service}\n`);
  yield FLUSH;
  let first = true;
  if (upload && head !== null && head.oid !== null) {
    yield pkt(`${head.oid} HEAD\0${capabilities.join(" ")}\n`);
    first = false;
  }
  let previous: string | null = null;
  for (const ref of advertisement.refs) {
    requireServerRef(ref.name);
    requireServerOid(ref.oid);
    if (previous !== null && comparePaths(previous, ref.name) >= 0) {
      throw new GitError("EINVAL", "advertised refs must be unique and ordered by UTF-8 bytes");
    }
    previous = ref.name;
    if (ref.name === head?.ref && ref.oid !== head.oid) {
      throw new GitError("EINVAL", "advertised HEAD differs from its branch");
    }
    const suffix = first ? `\0${capabilities.join(" ")}` : "";
    yield pkt(`${ref.oid} ${ref.name}${suffix}\n`);
    first = false;
    if (ref.peeledOid !== undefined) {
      if (!ref.name.startsWith("refs/tags/")) {
        throw new GitError("EINVAL", "only advertised tags may have peeled targets");
      }
      requireServerOid(ref.peeledOid);
      if (upload) yield pkt(`${ref.peeledOid} ${ref.name}^{}\n`);
    }
  }
  if (first) yield pkt(`${ZERO_OID} capabilities^{}\0${capabilities.join(" ")}\n`);
  yield FLUSH;
}
