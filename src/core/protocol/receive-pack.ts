// Smart HTTP receive-pack: one ref command, an optional streamed pack,
// and a strict report-status result.

import { isOid, utf8Decoder } from "../bytes.js";
import { CorruptError, GitError } from "../errors.js";
import { FLUSH, pkt } from "./pktline.js";
import {
  baseHeaders,
  drain,
  normalizeRemoteUrl,
  type ProtocolRequestOptions,
  readErrorPrefix,
} from "./remote.js";
import { ByteReader, pktText } from "./stream.js";
import { HttpError, requestWithAuth } from "./transport.js";

const ZERO = "0".repeat(40);
const MAX_STATUS_PACKETS = 16_384;
const MAX_STATUS_INPUT_BYTES = 16 * 1024 * 1024;

export interface ReceivePackRequest {
  url: string;
  oldOid: string;
  newOid: string;
  ref: string;
  advertised: Set<string>;
  pack?: () => AsyncIterable<Uint8Array>;
  onProgress?: (message: string) => void;
  onMessage?: (message: string) => void;
}

export interface ReceivePackStatus {
  unpack: string | null;
  refs: Map<string, { ok: boolean; error?: string }>;
}

function hasInvalidRefCharacter(ref: string): boolean {
  for (const character of ref) {
    const code = character.charCodeAt(0);
    if (code <= 0x20 || code === 0x7f || "~^:?*[".includes(character)) return true;
  }
  return false;
}

/** The branch-only ref subset accepted by the first push implementation. */
export function requireBranchRef(ref: string): string {
  if (
    !ref.startsWith("refs/heads/") ||
    ref.length === "refs/heads/".length ||
    ref.endsWith("/") ||
    ref.endsWith(".") ||
    ref.includes("//") ||
    ref.includes("..") ||
    ref.includes("@{") ||
    ref.includes("\\") ||
    hasInvalidRefCharacter(ref)
  ) {
    throw new GitError("EINVALIDREF", `invalid branch ref ${ref}`);
  }
  for (const component of ref.split("/")) {
    if (
      component === "" ||
      component === "." ||
      component === ".." ||
      component.startsWith(".") ||
      component.endsWith(".lock")
    ) {
      throw new GitError("EINVALIDREF", `invalid branch ref ${ref}`);
    }
  }
  return ref;
}

function requestedCapabilities(advertised: Set<string>): string[] {
  if (!advertised.has("report-status")) {
    throw new GitError("EUNSUPPORTED", "remote does not support receive-pack report-status");
  }
  return ["report-status", ...(advertised.has("side-band-64k") ? ["side-band-64k"] : [])];
}

async function* requestBody(
  command: Uint8Array,
  pack: (() => AsyncIterable<Uint8Array>) | undefined,
): AsyncGenerator<Uint8Array> {
  yield command;
  yield FLUSH;
  if (pack !== undefined) yield* pack();
}

async function* sidebandBody(
  source: AsyncIterable<Uint8Array>,
  onProgress: ((message: string) => void) | undefined,
  onMessage: ((message: string) => void) | undefined,
): AsyncGenerator<Uint8Array> {
  const reader = new ByteReader(source);
  let packets = 0;
  let inputBytes = 0;
  for (;;) {
    const frame = await reader.readPkt();
    if (frame === null || frame.kind === "flush") return;
    if (++packets > MAX_STATUS_PACKETS) {
      throw new GitError("E2BIG", "receive-pack sideband exceeds the bounded packet limit");
    }
    inputBytes += frame.payload.length + 4;
    if (inputBytes > MAX_STATUS_INPUT_BYTES) {
      throw new GitError("E2BIG", "receive-pack sideband exceeds the bounded input limit");
    }
    if (frame.kind !== "line" || frame.payload.length === 0) continue;
    const band = frame.payload[0];
    const payload = frame.payload.subarray(1);
    if (band === 1) {
      if (payload.length > 0) yield payload;
    } else if (band === 2) {
      const message = utf8Decoder.decode(payload);
      onProgress?.(message);
      onMessage?.(message);
    } else if (band === 3) {
      throw new GitError("EPUSHREJECTED", utf8Decoder.decode(payload).trim());
    } else {
      throw new CorruptError("receive-pack returned an invalid sideband");
    }
  }
}

async function parseStatus(
  body: AsyncIterable<Uint8Array>,
  expectedRef: string,
): Promise<ReceivePackStatus> {
  const reader = new ByteReader(body);
  let unpack: string | null = null;
  const refs = new Map<string, { ok: boolean; error?: string }>();
  let packets = 0;
  let inputBytes = 0;
  for (;;) {
    const packet = await reader.readPkt();
    if (packet === null || packet.kind === "flush") break;
    if (++packets > MAX_STATUS_PACKETS) {
      throw new GitError("E2BIG", "receive-pack status exceeds the bounded packet limit");
    }
    inputBytes += packet.payload.length + 4;
    if (inputBytes > MAX_STATUS_INPUT_BYTES) {
      throw new GitError("E2BIG", "receive-pack status exceeds the bounded input limit");
    }
    if (packet.kind !== "line") throw new CorruptError("unexpected receive-pack delimiter");
    const text = pktText(packet);
    if (text.startsWith("unpack ")) {
      if (unpack !== null) throw new CorruptError("duplicate receive-pack unpack status");
      unpack = text.slice("unpack ".length);
      continue;
    }
    if (text.startsWith("ok ")) {
      const ref = text.slice(3);
      if (refs.has(ref)) throw new CorruptError(`duplicate receive-pack status for ${ref}`);
      refs.set(ref, { ok: true });
      continue;
    }
    if (text.startsWith("ng ")) {
      const space = text.indexOf(" ", 3);
      if (space < 0) throw new CorruptError("malformed receive-pack rejection");
      const ref = text.slice(3, space);
      if (refs.has(ref)) throw new CorruptError(`duplicate receive-pack status for ${ref}`);
      refs.set(ref, { ok: false, error: text.slice(space + 1) });
      continue;
    }
    throw new CorruptError(`unexpected receive-pack status: ${text.slice(0, 64)}`);
  }
  if (unpack === null) throw new CorruptError("receive-pack omitted unpack status");
  if (refs.size !== 1 || !refs.has(expectedRef)) {
    throw new CorruptError(`receive-pack omitted status for ${expectedRef}`);
  }
  return { unpack, refs };
}

export async function receivePack(
  request: ReceivePackRequest,
  options: ProtocolRequestOptions = {},
): Promise<ReceivePackStatus> {
  if (!isOid(request.oldOid) || !isOid(request.newOid)) {
    throw new CorruptError("invalid receive-pack object id");
  }
  const ref = requireBranchRef(request.ref);
  const capabilities = requestedCapabilities(request.advertised);
  if (request.newOid === ZERO && !request.advertised.has("delete-refs")) {
    throw new GitError("EUNSUPPORTED", "remote does not support deleting refs");
  }
  const command = pkt(`${request.oldOid} ${request.newOid} ${ref}\0${capabilities.join(" ")}\n`);
  const base = normalizeRemoteUrl(request.url);
  const response = await requestWithAuth(
    () => ({
      url: `${base}/git-receive-pack`,
      method: "POST",
      headers: {
        ...baseHeaders(),
        "Content-Type": "application/x-git-receive-pack-request",
        Accept: "application/x-git-receive-pack-result",
      },
      body: requestBody(command, request.pack),
    }),
    options,
    options.authSession,
  );
  if (response.status !== 200) {
    const text = await readErrorPrefix(response.body);
    throw new HttpError(
      response.status,
      `git-receive-pack failed: ${response.status} ${response.statusText}${text === "" ? "" : ` — ${text}`}`,
    );
  }
  const contentType = response.headers["content-type"] ?? "";
  const mediaType = contentType.split(";")[0]?.trim() ?? "";
  if (mediaType !== "application/x-git-receive-pack-result") {
    await drain(response.body);
    throw new CorruptError(
      `invalid receive-pack content-type: ${contentType === "" ? "none" : contentType}`,
    );
  }
  const statusBody = capabilities.includes("side-band-64k")
    ? sidebandBody(response.body, request.onProgress, request.onMessage)
    : response.body;
  return parseStatus(statusBody, ref);
}

export const ZERO_OID = ZERO;
