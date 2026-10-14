import { isOid, ZERO_OID } from "../../common/bytes.js";
import { CorruptError, GitError } from "../../common/errors.js";
import { checkRefText, hasCanonicalRefSyntax, MAX_REF_NAME_BYTES } from "../../common/ref-name.js";
import type { Pkt } from "../stream.js";

const decoder = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true });

export function serverPacketText(packet: Pkt): string {
  if (packet.kind !== "line") throw new CorruptError("unexpected server request control packet");
  let text: string;
  try {
    text = decoder.decode(packet.payload);
  } catch (cause) {
    throw new CorruptError("server request contains malformed UTF-8", { cause });
  }
  if (text.endsWith("\n")) text = text.slice(0, -1);
  if (text.includes("\n") || text.includes("\r")) {
    throw new CorruptError("server request contains multiple command lines");
  }
  return text;
}

export function requireServerRef(ref: string): void {
  const checked = checkRefText(ref, MAX_REF_NAME_BYTES);
  if (checked.problem === "too-long") {
    throw new GitError("E2BIG", "server ref exceeds stored ref-name capacity");
  }
  if (
    checked.problem !== null ||
    !(ref.startsWith("refs/heads/") || ref.startsWith("refs/tags/")) ||
    !hasCanonicalRefSyntax(ref)
  ) {
    throw new GitError("EINVALIDREF", "server accepts only canonical heads and tags");
  }
}

export function requireServerOid(oid: string, allowZero = false): void {
  if (!isOid(oid) || (!allowZero && oid === ZERO_OID)) {
    throw new CorruptError("server request contains an invalid SHA-1 object id");
  }
}

export function parseCapabilities(text: string, supported: readonly string[]): Set<string> {
  const selected = new Set<string>();
  if (text === "") return selected;
  // Native send-pack prefixes the selected capabilities with a space after NUL.
  const tokens = text.replace(/^ +| +$/g, "").split(" ");
  for (const token of tokens) {
    if (token === "" || selected.has(token)) {
      throw new CorruptError("server request contains duplicate or malformed capabilities");
    }
    if (!supported.includes(token)) {
      throw new GitError("EUNSUPPORTED", `unsupported server capability ${token}`);
    }
    selected.add(token);
  }
  return selected;
}
