// Smart HTTP, client side, protocol v0.
//
// v0 is what every server still speaks, and a single round trip that ends
// in `done` is enough for both clone and incremental fetch: the server
// computes the common set from the haves it was given. Nothing here needs
// multi-ack.

import { isOid, utf8Decoder } from "../bytes.js";
import { CorruptError, GitError } from "../errors.js";
import { FLUSH, pkt } from "./pktline.js";
import { ByteReader, MAX_PKT_FRAME_BYTES, type Pkt, pktText } from "./stream.js";
import { HttpError, type RemoteRequestOptions, requestWithAuth } from "./transport.js";

export const AGENT = "kompjutr/0.0.0";

export type Service = "git-upload-pack" | "git-receive-pack";

export interface RemoteRef {
  name: string;
  oid: string;
}

export interface Advertisement {
  refs: RemoteRef[];
  capabilities: Set<string>;
  /** The branch HEAD points at, when the server advertises a symref. */
  headRef: string | null;
}

const ZERO = "0".repeat(40);

/** Retained refs, capabilities, symrefs and shallow boundaries per response. */
export const MAX_PROTOCOL_RETAINED_BYTES = 4 * 1024 * 1024;
export const MAX_PROTOCOL_NEGOTIATION_INPUT_BYTES = 16 * 1024 * 1024;
export const MAX_PROTOCOL_NEGOTIATION_ENTRIES = 16_384;
export const MAX_PROTOCOL_TEXT_BYTES = MAX_PKT_FRAME_BYTES - 4;

const STRING_FIXED_BYTES = 48;
const ADVERTISEMENT_FIXED_BYTES = 256;
const UPLOAD_RESULT_FIXED_BYTES = 192;
const REF_FIXED_BYTES = 96;
const CAPABILITY_FIXED_BYTES = 64;
const HEAD_REF_FIXED_BYTES = 16;
const BOUNDARY_FIXED_BYTES = 56;
const ERROR_PREFIX_BYTES = 800;
const ERROR_PREFIX_CHARACTERS = 200;

export interface ProtocolMemoryLimits {
  /** Test seam; callers may lower but never raise the production ceiling. */
  retainedBytes?: number;
  inputBytes?: number;
  entries?: number;
  lineBytes?: number;
}

interface ResolvedProtocolMemoryLimits {
  retainedBytes: number;
  inputBytes: number;
  entries: number;
  lineBytes: number;
}

interface ProtocolRequestOptions extends RemoteRequestOptions {
  protocolLimits?: ProtocolMemoryLimits;
}

class NegotiationBudget {
  #retained: number;
  #input = 0;
  #entries = 0;

  constructor(
    private readonly limits: ResolvedProtocolMemoryLimits,
    fixedBytes: number,
  ) {
    if (fixedBytes > limits.retainedBytes) this.#tooLarge("retained state");
    this.#retained = fixedBytes;
  }

  packet(packet: Pkt): void {
    if (packet.payload.length > this.limits.lineBytes) this.#tooLarge("pkt-line text");
    const bytes = packet.payload.length + 4;
    if (bytes > this.limits.inputBytes - this.#input) this.#tooLarge("negotiation input");
    this.#input += bytes;
  }

  reserve(bytes: number, entries = 1): void {
    if (entries > this.limits.entries - this.#entries) this.#tooLarge("entry count");
    if (bytes > this.limits.retainedBytes - this.#retained) this.#tooLarge("retained state");
    this.#entries += entries;
    this.#retained += bytes;
  }

  #tooLarge(part: string): never {
    throw new GitError("E2BIG", `protocol ${part} exceeds its bounded limit`);
  }
}

class UploadRequestBudget {
  #bytes = 0;

  constructor(private readonly limits: ResolvedProtocolMemoryLimits) {}

  line(text: string): void {
    if (text.length > this.limits.lineBytes) this.#tooLarge("pkt-line text");
    this.frame(text.length + 4);
  }

  frame(bytes: number): void {
    if (bytes > this.limits.inputBytes - this.#bytes) this.#tooLarge("negotiation input");
    this.#bytes += bytes;
  }

  entries(entries: number): void {
    if (entries > this.limits.entries) this.#tooLarge("entry count");
  }

  #tooLarge(part: string): never {
    throw new GitError("E2BIG", `protocol ${part} exceeds its bounded limit`);
  }
}

function stringRetainedBytes(value: string): number {
  return STRING_FIXED_BYTES + value.length * 2;
}

function resolvedProtocolLimits(
  overrides: ProtocolMemoryLimits | undefined,
): ResolvedProtocolMemoryLimits {
  return {
    retainedBytes: boundedLimit(
      overrides?.retainedBytes,
      MAX_PROTOCOL_RETAINED_BYTES,
      "retainedBytes",
    ),
    inputBytes: boundedLimit(
      overrides?.inputBytes,
      MAX_PROTOCOL_NEGOTIATION_INPUT_BYTES,
      "inputBytes",
    ),
    entries: boundedLimit(overrides?.entries, MAX_PROTOCOL_NEGOTIATION_ENTRIES, "entries"),
    lineBytes: boundedLimit(overrides?.lineBytes, MAX_PROTOCOL_TEXT_BYTES, "lineBytes"),
  };
}

function boundedLimit(value: number | undefined, ceiling: number, name: string): number {
  if (value === undefined) return ceiling;
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new RangeError(`${name} must be a positive safe integer`);
  }
  return Math.min(value, ceiling);
}

async function readErrorPrefix(body: AsyncIterable<Uint8Array>): Promise<string> {
  const prefix = new Uint8Array(ERROR_PREFIX_BYTES);
  let length = 0;
  try {
    for await (const chunk of body) {
      if (length >= prefix.length) continue;
      const take = Math.min(chunk.length, prefix.length - length);
      prefix.set(chunk.subarray(0, take), length);
      length += take;
    }
  } catch {
    // The retained prefix is still useful when the error body is truncated.
  }
  return utf8Decoder.decode(prefix.subarray(0, length)).slice(0, ERROR_PREFIX_CHARACTERS);
}

/** Accepts what real git accepts over HTTP, and nothing else. */
export function normalizeRemoteUrl(url: string): string {
  if (!/^https?:\/\//.test(url)) {
    throw new GitError("EURLSCHEME", `unsupported URL scheme: ${url}`);
  }
  return url.replace(/\/+$/, "");
}

function baseHeaders(): Record<string, string> {
  return {
    "User-Agent": `git/${AGENT}`,
    Accept: "*/*",
    "Accept-Encoding": "identity",
    Pragma: "no-cache",
  };
}

export async function discover(
  url: string,
  service: Service,
  options: ProtocolRequestOptions = {},
): Promise<Advertisement> {
  const budget = new NegotiationBudget(
    resolvedProtocolLimits(options.protocolLimits),
    ADVERTISEMENT_FIXED_BYTES,
  );
  const base = normalizeRemoteUrl(url);
  const response = await requestWithAuth(
    {
      url: `${base}/info/refs?service=${service}`,
      method: "GET",
      headers: baseHeaders(),
    },
    options,
  );
  if (response.status !== 200) {
    const body = await readErrorPrefix(response.body);
    throw new HttpError(
      response.status,
      `${service} discovery failed: ${response.status} ${response.statusText}${body === "" ? "" : ` — ${body.slice(0, 200)}`}`,
    );
  }

  // A dumb-HTTP or plain-web server answers 200 with something that is not
  // pkt-lines. Its content-type is the only reliable way to say so before
  // the framing desynchronises on arbitrary bytes.
  const contentType = response.headers["content-type"] ?? "";
  const mediaType = contentType.split(";")[0]?.trim() ?? "";
  if (!mediaType.startsWith(`application/x-${service}-advertisement`)) {
    await drain(response.body);
    throw new CorruptError(
      `not a smart HTTP ref advertisement (content-type: ${contentType === "" ? "none" : contentType})`,
    );
  }

  const reader = new ByteReader(response.body);
  try {
    const first = await reader.readPkt();
    if (first === null) throw new CorruptError("empty ref advertisement");
    budget.packet(first);
    const header = first.kind === "line" ? pktText(first) : "";
    if (header.startsWith("ERR ")) throw new GitError("EFETCHFAIL", header.slice(4));
    if (!header.startsWith("# service=")) {
      throw new CorruptError("not a smart HTTP ref advertisement");
    }
    const afterHeader = await reader.readPkt();
    if (afterHeader === null || afterHeader.kind !== "flush") {
      throw new CorruptError("malformed ref advertisement header");
    }
    budget.packet(afterHeader);
    return await parseAdvertisement(reader, budget);
  } finally {
    // The advertisement is the whole response; leaving its tail unread
    // would hold the connection open.
    await drain(response.body);
  }
}

async function drain(body: AsyncIterable<Uint8Array>): Promise<void> {
  try {
    for await (const _chunk of body) {
      // discard
    }
  } catch {
    // A remote that hung up has nothing left to drain.
  }
}

async function parseAdvertisement(
  reader: ByteReader,
  budget: NegotiationBudget,
): Promise<Advertisement> {
  const refs: RemoteRef[] = [];
  const capabilities = new Set<string>();
  let headRef: string | null = null;
  let first = true;

  for (;;) {
    const line: Pkt | null = await reader.readPkt();
    if (line === null) break;
    budget.packet(line);
    if (line.kind === "flush") break;
    if (line.kind !== "line") continue;
    let text = utf8Decoder.decode(line.payload);
    if (text.endsWith("\n")) text = text.slice(0, -1);
    if (first) {
      first = false;
      const nul = text.indexOf("\0");
      if (nul >= 0) {
        let start = nul + 1;
        while (start < text.length) {
          while (text[start] === " ") start++;
          if (start >= text.length) break;
          let end = text.indexOf(" ", start);
          if (end < 0) end = text.length;
          const capability = text.slice(start, end);
          const capabilityBytes = capabilities.has(capability)
            ? 0
            : CAPABILITY_FIXED_BYTES + stringRetainedBytes(capability);
          const symref = capability.startsWith("symref=HEAD:")
            ? capability.slice("symref=HEAD:".length)
            : null;
          budget.reserve(
            capabilityBytes +
              (symref === null ? 0 : HEAD_REF_FIXED_BYTES + stringRetainedBytes(symref)),
          );
          capabilities.add(capability);
          if (symref !== null) headRef = symref;
          start = end + 1;
        }
        text = text.slice(0, nul);
      }
    }
    if (text.startsWith("ERR ")) throw new GitError("EFETCHFAIL", text.slice(4));
    const space = text.indexOf(" ");
    if (space < 0) continue;
    const oid = text.slice(0, space);
    const name = text.slice(space + 1);
    // An empty repository advertises only the capabilities line.
    if (oid === ZERO && name.startsWith("capabilities^{}")) continue;
    budget.reserve(REF_FIXED_BYTES + stringRetainedBytes(name) + stringRetainedBytes(oid));
    refs.push({ name, oid });
  }
  return { refs, capabilities, headRef };
}

export interface UploadPackRequest {
  url: string;
  wants: string[];
  haves?: string[];
  /** Shallow boundary commits this client already has. */
  shallows?: string[];
  depth?: number;
  /** Ask for tags pointing at fetched objects. */
  includeTag?: boolean;
  advertised: Set<string>;
  onProgress?: (message: string) => void;
  onMessage?: (message: string) => void;
}

export interface UploadPackResult {
  /** New shallow boundaries the server declared. */
  shallow: string[];
  unshallow: string[];
  /** The packfile, as it arrives. Never assembled. */
  pack: AsyncIterable<Uint8Array>;
}

function negotiate(advertised: Set<string>, wanted: string[]): string[] {
  return wanted.filter((capability) => advertised.has(capability));
}

export async function uploadPack(
  request: UploadPackRequest,
  options: ProtocolRequestOptions = {},
): Promise<UploadPackResult> {
  const limits = resolvedProtocolLimits(options.protocolLimits);
  const base = normalizeRemoteUrl(request.url);
  const wanted = ["side-band-64k", "thin-pack", "ofs-delta", "no-done"];
  if (request.includeTag === true) wanted.push("include-tag");
  const shallows = request.shallows ?? [];
  if (request.depth !== undefined || shallows.length > 0) wanted.push("shallow");
  if (request.onProgress === undefined) wanted.push("no-progress");
  const capabilities = negotiate(request.advertised, wanted);
  capabilities.push(`agent=${AGENT}`);

  if (request.wants.length === 0) throw new GitError("ENOWANT", "nothing to fetch");
  const haves = request.haves ?? [];
  const requestBudget = new UploadRequestBudget(limits);
  requestBudget.entries(request.wants.length + shallows.length + haves.length);
  for (const oid of [...request.wants, ...shallows, ...haves]) {
    if (!isOid(oid)) throw new CorruptError(`invalid upload-pack object id ${oid}`);
  }
  if (request.depth !== undefined && (!Number.isSafeInteger(request.depth) || request.depth <= 0)) {
    throw new RangeError("upload-pack depth must be a positive safe integer");
  }

  const body: Uint8Array[] = [];
  const pushLine = (text: string): void => {
    requestBudget.line(text);
    body.push(pkt(text));
  };
  request.wants.forEach((oid, index) => {
    pushLine(index === 0 ? `want ${oid} ${capabilities.join(" ")}\n` : `want ${oid}\n`);
  });
  for (const oid of shallows) pushLine(`shallow ${oid}\n`);
  if (request.depth !== undefined) pushLine(`deepen ${request.depth}\n`);
  requestBudget.frame(FLUSH.length);
  body.push(FLUSH);
  for (const oid of haves) pushLine(`have ${oid}\n`);
  pushLine("done\n");

  const response = await requestWithAuth(
    {
      url: `${base}/git-upload-pack`,
      method: "POST",
      headers: {
        ...baseHeaders(),
        "Content-Type": "application/x-git-upload-pack-request",
        Accept: "application/x-git-upload-pack-result",
      },
      body: concatBody(body),
    },
    options,
  );
  if (response.status !== 200) {
    const text = await readErrorPrefix(response.body);
    throw new HttpError(
      response.status,
      `git-upload-pack failed: ${response.status} ${response.statusText}${text === "" ? "" : ` — ${text.slice(0, 200)}`}`,
    );
  }

  const reader = new ByteReader(response.body);
  const shallow: string[] = [];
  const unshallow: string[] = [];
  const budget = new NegotiationBudget(limits, UPLOAD_RESULT_FIXED_BYTES);
  const useSideband = capabilities.includes("side-band-64k");

  // Acknowledgement and shallow sections, then the pack. `done` was sent,
  // so the server answers in one shot and the ack details do not change
  // what arrives.
  for (;;) {
    const line = await reader.readPkt();
    if (line === null) throw new CorruptError("upload-pack response ended before the pack");
    budget.packet(line);
    if (line.kind !== "line") continue;
    if (useSideband && isBandFrame(line.payload)) {
      return {
        shallow,
        unshallow,
        pack: sideband(reader, line.payload, request.onProgress, request.onMessage),
      };
    }
    const text = pktText(line);
    if (text.startsWith("shallow ")) {
      const oid = text.slice(8).trim();
      budget.reserve(BOUNDARY_FIXED_BYTES + stringRetainedBytes(oid));
      shallow.push(oid);
      continue;
    }
    if (text.startsWith("unshallow ")) {
      const oid = text.slice(10).trim();
      budget.reserve(BOUNDARY_FIXED_BYTES + stringRetainedBytes(oid));
      unshallow.push(oid);
      continue;
    }
    if (text.startsWith("ERR ")) throw new GitError("EFETCHFAIL", text.slice(4));
    if (text.startsWith("ACK") || text.startsWith("NAK")) {
      if (useSideband) continue;
      // Unwrapped, the packfile follows the acknowledgement as raw bytes:
      // one more pkt-line read would try to frame "PACK" as a length.
      return { shallow, unshallow, pack: rawPack(reader) };
    }
    throw new CorruptError(`unexpected upload-pack response: ${text.slice(0, 64)}`);
  }
}

/** Band frames lead with 1, 2 or 3; every ASCII status line starts above 0x20. */
function isBandFrame(payload: Uint8Array): boolean {
  const band = payload[0];
  return band !== undefined && band >= 1 && band <= 3;
}

async function* rawPack(reader: ByteReader): AsyncGenerator<Uint8Array> {
  yield* reader.rest();
}

async function* sideband(
  reader: ByteReader,
  first: Uint8Array,
  onProgress?: (message: string) => void,
  onMessage?: (message: string) => void,
): AsyncGenerator<Uint8Array> {
  let frame: Uint8Array | null = first;
  for (;;) {
    if (frame === null) {
      const line = await reader.readPkt();
      if (line === null || line.kind === "flush") return;
      if (line.kind !== "line") continue;
      frame = line.payload;
    }
    const band = frame[0];
    const payload = frame.subarray(1);
    if (band === 1) {
      if (payload.length > 0) yield payload;
    } else if (band === 2) {
      onProgress?.(utf8Decoder.decode(payload));
    } else if (band === 3) {
      throw new GitError("EFETCHFAIL", utf8Decoder.decode(payload).trim());
    } else {
      onMessage?.(utf8Decoder.decode(frame));
    }
    frame = null;
  }
}

function concatBody(parts: Uint8Array[]): Uint8Array {
  let length = 0;
  for (const part of parts) length += part.length;
  const out = new Uint8Array(length);
  let offset = 0;
  for (const part of parts) {
    out.set(part, offset);
    offset += part.length;
  }
  return out;
}
