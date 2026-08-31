// Smart HTTP, client side, protocol v0.
//
// v0 is what every server still speaks, and a single round trip that ends
// in `done` is enough for both clone and incremental fetch: the server
// computes the common set from the haves it was given. Nothing here needs
// multi-ack.

import { isOid, utf8Decoder } from "../common/bytes.js";
import { CorruptError, GitError } from "../common/errors.js";
import { checkRefText, hasCanonicalRefSyntax } from "../common/ref-name.js";
import { FLUSH, pkt } from "./pktline.js";
import { ByteReader, type Pkt, pktText } from "./stream.js";
import {
  type GitHttpResponse,
  HttpError,
  type RemoteAuthSession,
  type RemoteRequestOptions,
  requestWithAuth,
} from "./transport.js";

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

export const MAX_PROTOCOL_NEGOTIATION_ENTRIES = 16_384;

const ERROR_PREFIX_BYTES = 800;
const ERROR_PREFIX_CHARACTERS = 200;
const strictUtf8Decoder = new TextDecoder("utf-8", { fatal: true });

export interface ProtocolMemoryLimits {
  /** Receive-pack test seams for structural input and result limits. */
  retainedBytes?: number;
  inputBytes?: number;
  entries?: number;
  lineBytes?: number;
}

export interface ProtocolRequestOptions extends RemoteRequestOptions {
  protocolLimits?: ProtocolMemoryLimits;
  authSession?: RemoteAuthSession;
}

type DiscoveryRequestOptions = ProtocolRequestOptions;

class NegotiationBudget {
  #entries = 0;
  constructor(private readonly entryLimit: number) {}

  countEntry(): void {
    if (this.#entries >= this.entryLimit) this.#tooLarge("entry count");
    this.#entries++;
  }

  reserve(entries = 1): void {
    if (entries > this.entryLimit - this.#entries) this.#tooLarge("entry count");
    this.#entries += entries;
  }

  #tooLarge(part: string): never {
    throw new GitError("E2BIG", `protocol ${part} exceeds its bounded limit`);
  }
}

function resolvedProtocolEntryLimit(value: number | undefined): number {
  if (value === undefined) return MAX_PROTOCOL_NEGOTIATION_ENTRIES;
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new RangeError("entries must be a positive safe integer");
  }
  return Math.min(value, MAX_PROTOCOL_NEGOTIATION_ENTRIES);
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

export function baseHeaders(): Record<string, string> {
  return {
    "User-Agent": `git/${AGENT}`,
    Accept: "*/*",
    "Accept-Encoding": "identity",
    Pragma: "no-cache",
  };
}

async function releaseReader(reader: ByteReader): Promise<void> {
  try {
    await reader.release();
  } catch {
    // The primary protocol result is authoritative after local cleanup.
  }
}

function ownedPktText(packet: Pkt): string {
  return pktText(packet);
}

export async function discover(
  url: string,
  service: Service,
  options: DiscoveryRequestOptions = {},
): Promise<Advertisement> {
  const budget = new NegotiationBudget(resolvedProtocolEntryLimit(options.protocolLimits?.entries));
  const base = normalizeRemoteUrl(url);
  const response = await requestWithAuth(
    {
      url: `${base}/info/refs?service=${service}`,
      method: "GET",
      headers: baseHeaders(),
    },
    options,
    options.authSession,
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
    const header = first.kind === "line" ? ownedPktText(first) : "";
    if (header.startsWith("ERR ")) {
      throw serviceError(service, header.slice(4));
    }
    if (!header.startsWith("# service=")) {
      throw new CorruptError("not a smart HTTP ref advertisement");
    }
    const afterHeader = await reader.readPkt();
    if (afterHeader === null || afterHeader.kind !== "flush") {
      throw new CorruptError("malformed ref advertisement header");
    }
    return await parseAdvertisement(reader, budget, service);
  } finally {
    await releaseReader(reader);
  }
}

export async function drain(body: AsyncIterable<Uint8Array>): Promise<void> {
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
  service: Service,
): Promise<Advertisement> {
  const refs: RemoteRef[] = [];
  const capabilities = new Set<string>();
  const refNames = new Set<string>();
  let headRef: string | null = null;
  let headOid: string | null = null;
  let first = true;
  let flushed = false;

  for (;;) {
    const line: Pkt | null = await reader.readPkt();
    if (line === null) break;
    if (line.kind === "flush") {
      flushed = true;
      break;
    }
    if (line.kind !== "line") {
      throw new CorruptError("ref advertisement contains an unexpected pkt-line control");
    }
    let text: string;
    try {
      text = strictUtf8Decoder.decode(line.payload);
    } catch (error) {
      throw new CorruptError("ref advertisement contains malformed UTF-8", { cause: error });
    }
    if (text.endsWith("\n")) {
      text = text.slice(0, -1);
    }
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
          budget.countEntry();
          const capability = text.slice(start, end);
          if (capability.includes("\0")) {
            throw new CorruptError("ref advertisement has malformed capabilities");
          }
          if (capability.startsWith("symref=HEAD")) {
            if (!capability.startsWith("symref=HEAD:")) {
              throw new CorruptError("ref advertisement has a malformed HEAD symref");
            }
            const symref = capability.slice("symref=HEAD:".length);
            const checked = checkRefText(symref);
            if (
              checked.problem !== null ||
              !symref.startsWith("refs/") ||
              !hasCanonicalRefSyntax(symref)
            ) {
              throw new CorruptError("ref advertisement has a malformed HEAD symref");
            }
            if (headRef !== null && headRef !== symref) {
              throw new CorruptError("ref advertisement has conflicting HEAD symrefs");
            }
            if (headRef === null) {
              headRef = symref;
            }
          }
          capabilities.add(capability);
          start = end + 1;
        }
        text = text.slice(0, nul);
      }
    }
    if (text.startsWith("ERR ")) {
      throw serviceError(service, text.slice(4));
    }
    const space = text.indexOf(" ");
    if (space < 0) throw new CorruptError("ref advertisement has a malformed row");
    const nameStart = space + 1;
    const synthetic =
      space === ZERO.length &&
      text.startsWith(ZERO) &&
      text.length - nameStart === "capabilities^{}".length &&
      text.startsWith("capabilities^{}", nameStart);
    const oid = text.slice(0, space);
    const name = text.slice(nameStart);
    if (!isOid(oid)) throw new CorruptError(`ref advertisement has an invalid oid for ${name}`);
    if (refNames.has(name)) throw new CorruptError(`ref advertisement has duplicate row ${name}`);
    refNames.add(name);
    // An empty repository advertises only the capabilities line.
    if (synthetic) {
      continue;
    }
    budget.countEntry();
    const checked = checkRefText(name);
    if (checked.problem !== null || !advertisedRefName(name)) {
      throw new CorruptError(`ref advertisement has an invalid ref name ${name}`);
    }
    refs.push({ name, oid });
    if (name === "HEAD") headOid = oid;
  }
  if (!flushed) throw new CorruptError("truncated ref advertisement");
  if (headRef !== null && headOid !== null) {
    const targetOid = refs.find((ref) => ref.name === headRef)?.oid;
    if (targetOid !== undefined && targetOid !== headOid) {
      throw new CorruptError("advertised HEAD does not match its symref target");
    }
  }
  return { refs, capabilities, headRef };
}

function serviceError(service: Service, message: string): GitError {
  return new GitError(service === "git-receive-pack" ? "EPUSHREJECTED" : "EFETCHFAIL", message);
}

function advertisedRefName(name: string): boolean {
  if (name === "HEAD") return true;
  if (name.endsWith("^{}")) {
    const baseEnd = name.length - 3;
    return name.startsWith("refs/tags/") && hasCanonicalRefSyntax(name, 0, baseEnd);
  }
  return name.startsWith("refs/") && hasCanonicalRefSyntax(name);
}

export type UploadPackFilter = "blob:none";

export interface UploadPackRequest {
  url: string;
  wants: string[];
  haves?: string[];
  /** Shallow boundary commits this client already has. */
  shallows?: string[];
  depth?: number;
  /** Ask for tags pointing at fetched objects. */
  includeTag?: boolean;
  /** Limit the server response to objects allowed by this partial-clone filter. */
  filter?: UploadPackFilter;
  /** Ask for a thin pack. Defaults to true. */
  thinPack?: boolean;
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

function uploadPackFilter(filter: unknown): UploadPackFilter | undefined {
  if (filter === undefined || filter === "blob:none") return filter;
  throw new GitError("EUNSUPPORTED", "unsupported upload-pack filter");
}

export async function uploadPack(
  request: UploadPackRequest,
  options: ProtocolRequestOptions = {},
): Promise<UploadPackResult> {
  const entryLimit = resolvedProtocolEntryLimit(options.protocolLimits?.entries);
  const base = normalizeRemoteUrl(request.url);
  const filter = uploadPackFilter(request.filter);
  if (filter !== undefined && !request.advertised.has("filter")) {
    throw new GitError("EUNSUPPORTED", "remote does not support upload-pack filter");
  }
  const wanted = ["side-band-64k"];
  if (request.thinPack !== false) wanted.push("thin-pack");
  wanted.push("ofs-delta", "no-done");
  if (request.includeTag === true) wanted.push("include-tag");
  const shallows = request.shallows ?? [];
  if (request.depth !== undefined || shallows.length > 0) wanted.push("shallow");
  if (request.onProgress === undefined) wanted.push("no-progress");
  if (filter !== undefined) wanted.push("filter");
  const capabilities = negotiate(request.advertised, wanted);
  capabilities.push(`agent=${AGENT}`);

  if (request.wants.length === 0) throw new GitError("ENOWANT", "nothing to fetch");
  const haves = request.haves ?? [];
  const entries = request.wants.length + shallows.length + haves.length;
  if (entries > entryLimit) {
    throw new GitError("E2BIG", "protocol entry count exceeds its bounded limit");
  }
  for (const oid of [...request.wants, ...shallows, ...haves]) {
    if (!isOid(oid)) throw new CorruptError(`invalid upload-pack object id ${oid}`);
  }
  if (request.depth !== undefined && (!Number.isSafeInteger(request.depth) || request.depth <= 0)) {
    throw new RangeError("upload-pack depth must be a positive safe integer");
  }

  let response: GitHttpResponse;
  {
    const body: Uint8Array[] = [];
    const pushLine = (createText: () => string): void => {
      body.push(pkt(createText()));
    };
    request.wants.forEach((oid, index) => {
      if (index === 0) {
        pushLine(() => `want ${oid} ${capabilities.join(" ")}\n`);
        return;
      }
      pushLine(() => `want ${oid}\n`);
    });
    for (const oid of shallows) {
      pushLine(() => `shallow ${oid}\n`);
    }
    if (request.depth !== undefined) {
      pushLine(() => `deepen ${request.depth}\n`);
    }
    if (filter !== undefined) {
      pushLine(() => `filter ${filter}\n`);
    }
    body.push(FLUSH);
    for (const oid of haves) {
      pushLine(() => `have ${oid}\n`);
    }
    pushLine(() => "done\n");
    const requestBody = concatBody(body);
    response = await requestWithAuth(
      {
        url: `${base}/git-upload-pack`,
        method: "POST",
        headers: {
          ...baseHeaders(),
          "Content-Type": "application/x-git-upload-pack-request",
          Accept: "application/x-git-upload-pack-result",
        },
        body: requestBody,
      },
      options,
      options.authSession,
    );
  }
  const budget = new NegotiationBudget(entryLimit);
  const reader = new ByteReader(response.body);
  const shallow: string[] = [];
  const unshallow: string[] = [];
  const useSideband = capabilities.includes("side-band-64k");

  try {
    if (response.status !== 200) {
      const text = await readErrorPrefix(response.body);
      throw new HttpError(
        response.status,
        `git-upload-pack failed: ${response.status} ${response.statusText}${text === "" ? "" : ` — ${text.slice(0, 200)}`}`,
      );
    }

    // Acknowledgement and shallow sections, then the pack. `done` was sent,
    // so the server answers in one shot and the ack details do not change
    // what arrives.
    for (;;) {
      const line = await reader.readPkt();
      if (line === null) throw new CorruptError("upload-pack response ended before the pack");
      if (line.kind !== "line") continue;
      if (useSideband && isBandFrame(line.payload)) {
        return {
          shallow,
          unshallow,
          pack: sideband(reader, line.payload, request.onProgress, request.onMessage),
        };
      }
      const text = ownedPktText(line);
      if (text.startsWith("shallow ")) {
        budget.countEntry();
        const oid = text.slice(8);
        shallow.push(oid);
        continue;
      }
      if (text.startsWith("unshallow ")) {
        budget.countEntry();
        const oid = text.slice(10);
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
  } catch (error) {
    await releaseReader(reader);
    throw error;
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
  try {
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
      } else if (band === 2 && onProgress !== undefined) {
        onProgress(utf8Decoder.decode(payload));
      } else if (band === 3) {
        throw new GitError("EFETCHFAIL", utf8Decoder.decode(payload).trim());
      } else if (band !== 2 && onMessage !== undefined) {
        onMessage(utf8Decoder.decode(frame));
      }
      frame = null;
    }
  } finally {
    await releaseReader(reader);
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
