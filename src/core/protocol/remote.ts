// Smart HTTP, client side, protocol v0.
//
// v0 is what every server still speaks, and a single round trip that ends
// in `done` is enough for both clone and incremental fetch: the server
// computes the common set from the haves it was given. Nothing here needs
// multi-ack.

import { isOid, utf8Decoder } from "../bytes.js";
import { CorruptError, GitError } from "../errors.js";
import type { TransportOperationBudget } from "../ops/transport-budget.js";
import { checkRefText, hasCanonicalRefSyntax } from "../ref-name.js";
import { retainedStringBytes } from "../retained.js";
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

const ADVERTISEMENT_FIXED_BYTES = 256;
const UPLOAD_RESULT_FIXED_BYTES = 192;
const UPLOAD_REQUEST_FIXED_BYTES = 256;
const UPLOAD_REQUEST_FRAME_BYTES = 32;
const REF_FIXED_BYTES = 96;
const CAPABILITY_FIXED_BYTES = 64;
const HEAD_REF_FIXED_BYTES = 16;
const BOUNDARY_FIXED_BYTES = 56;
const ERROR_PREFIX_BYTES = 800;
const ERROR_PREFIX_CHARACTERS = 200;
const PARSE_FIXED_BYTES = 128;
const STRING_FIXED_BYTES = 48;
const REF_NAME_INDEX_FIXED_BYTES = 48;
const strictUtf8Decoder = new TextDecoder("utf-8", { fatal: true });

export interface ProtocolMemoryLimits {
  /** Receive-pack test seams; upload-pack admits actual live memory instead. */
  retainedBytes?: number;
  inputBytes?: number;
  entries?: number;
  lineBytes?: number;
}

export interface ProtocolRequestOptions extends RemoteRequestOptions {
  protocolLimits?: ProtocolMemoryLimits;
  authSession?: RemoteAuthSession;
  operationBudget?: TransportOperationBudget;
}

type DiscoveryRequestOptions = ProtocolRequestOptions;

class NegotiationBudget {
  #retained: number;
  #parseBytes = 0;
  #indexBytes = 0;
  #entries = 0;
  readonly #operationBase: number;
  readonly #parsePart: string;
  readonly #indexPart: string;

  constructor(
    private readonly entryLimit: number,
    fixedBytes: number,
    private readonly operationBudget?: TransportOperationBudget,
    private readonly memoryPart = "protocol-negotiation",
  ) {
    this.#operationBase = operationBudget?.memory(memoryPart) ?? 0;
    this.#parsePart = `${memoryPart}-parse`;
    this.#indexPart = `${memoryPart}-index`;
    operationBudget?.setMemory(memoryPart, this.#operationBase + fixedBytes);
    this.#retained = fixedBytes;
  }

  parseText(payloadBytes: number): void {
    this.#setParse(PARSE_FIXED_BYTES + stringAllocationBytes(payloadBytes));
  }

  settleText(text: string): void {
    this.#setParse(PARSE_FIXED_BYTES + retainedStringBytes(text));
  }

  admitParsed(bytes: number): void {
    if (bytes > Number.MAX_SAFE_INTEGER - this.#parseBytes) this.#tooLarge("parse state");
    this.#setParse(this.#parseBytes + bytes);
  }

  releaseParsed(bytes: number): void {
    if (bytes > this.#parseBytes) throw new Error("protocol parse accounting is corrupt");
    this.#setParse(this.#parseBytes - bytes);
  }

  retainParsed(bytes: number): void {
    if (bytes > this.#parseBytes) throw new Error("protocol parse accounting is corrupt");
    if (bytes > Number.MAX_SAFE_INTEGER - this.#retained) this.#tooLarge("retained state");
    const previousParse = this.#parseBytes;
    this.#setParse(previousParse - bytes);
    try {
      this.operationBudget?.setMemory(
        this.memoryPart,
        this.#operationBase + this.#retained + bytes,
      );
    } catch (error) {
      this.#setParse(previousParse);
      throw error;
    }
    this.#retained += bytes;
  }

  retainIndexParsed(bytes: number): void {
    if (bytes > this.#parseBytes) throw new Error("protocol parse accounting is corrupt");
    if (bytes > Number.MAX_SAFE_INTEGER - this.#indexBytes) this.#tooLarge("ref index");
    const previousParse = this.#parseBytes;
    this.#setParse(previousParse - bytes);
    try {
      this.operationBudget?.setMemory(this.#indexPart, this.#indexBytes + bytes);
    } catch (error) {
      this.#setParse(previousParse);
      throw error;
    }
    this.#indexBytes += bytes;
  }

  countEntry(): void {
    if (this.#entries >= this.entryLimit) this.#tooLarge("entry count");
    this.#entries++;
  }

  errorPrefix(length?: number): void {
    const decodedBytes = length === undefined ? 0 : stringAllocationBytes(length);
    const resultBytes =
      length === undefined ? 0 : stringAllocationBytes(Math.min(length, ERROR_PREFIX_CHARACTERS));
    this.#setParse(PARSE_FIXED_BYTES + ERROR_PREFIX_BYTES + decodedBytes + resultBytes);
  }

  clearParse(): void {
    this.#setParse(0);
  }

  clearIndex(): void {
    this.operationBudget?.clearMemory(this.#indexPart);
    this.#indexBytes = 0;
  }

  reserve(bytes: number, entries = 1): void {
    if (entries > this.entryLimit - this.#entries) this.#tooLarge("entry count");
    if (bytes > Number.MAX_SAFE_INTEGER - this.#retained) this.#tooLarge("retained state");
    this.operationBudget?.setMemory(this.memoryPart, this.#operationBase + this.#retained + bytes);
    this.#entries += entries;
    this.#retained += bytes;
  }

  rollback(): void {
    this.clearParse();
    this.clearIndex();
    this.operationBudget?.setMemory(this.memoryPart, this.#operationBase);
  }

  #setParse(bytes: number): void {
    this.operationBudget?.setMemory(this.#parsePart, bytes);
    this.#parseBytes = bytes;
  }

  #tooLarge(part: string): never {
    throw new GitError("E2BIG", `protocol ${part} exceeds its bounded limit`);
  }
}

function stringAllocationBytes(codeUnits: number): number {
  return STRING_FIXED_BYTES + 2 * codeUnits;
}

class UploadRequestBudget {
  #bytes = 0;
  #frames = 0;
  #textBytes = 0;

  constructor(
    private readonly entryLimit: number,
    private readonly operationBudget?: TransportOperationBudget,
  ) {
    operationBudget?.setMemory("protocol-upload-request", UPLOAD_REQUEST_FIXED_BYTES);
  }

  admitText(bytes: number): void {
    if (this.#textBytes !== 0) throw new Error("upload request text accounting is corrupt");
    this.operationBudget?.setMemory("protocol-upload-request", this.#retainedMemory() + bytes);
    this.#textBytes = bytes;
  }

  pktLine(text: string): Uint8Array {
    const payloadBytes = utf8Length(text);
    const frameBytes = payloadBytes + 4;
    const retained = this.#retainedMemory();
    this.operationBudget?.setMemory(
      "protocol-upload-request",
      retained + this.#textBytes + payloadBytes + 4 + frameBytes + UPLOAD_REQUEST_FRAME_BYTES,
    );
    return pkt(text);
  }

  retainLine(frame: Uint8Array): void {
    const nextBytes = this.#bytes + frame.length;
    const nextFrames = this.#frames + 1;
    this.operationBudget?.setMemory(
      "protocol-upload-request",
      UPLOAD_REQUEST_FIXED_BYTES + nextBytes + nextFrames * UPLOAD_REQUEST_FRAME_BYTES,
    );
    this.#bytes = nextBytes;
    this.#frames = nextFrames;
    this.#textBytes = 0;
  }

  cancelLine(): void {
    this.#textBytes = 0;
    this.operationBudget?.setMemory("protocol-upload-request", this.#retainedMemory());
  }

  retainFrame(frame: Uint8Array): void {
    const nextBytes = this.#bytes + frame.length;
    const nextFrames = this.#frames + 1;
    this.operationBudget?.setMemory(
      "protocol-upload-request",
      UPLOAD_REQUEST_FIXED_BYTES + nextBytes + nextFrames * UPLOAD_REQUEST_FRAME_BYTES,
    );
    this.#bytes = nextBytes;
    this.#frames = nextFrames;
  }

  entries(entries: number): void {
    if (entries > this.entryLimit) this.#tooLarge("entry count");
  }

  concatenate(): void {
    this.operationBudget?.setMemory(
      "protocol-upload-request",
      this.#retainedMemory() + this.#bytes + UPLOAD_REQUEST_FRAME_BYTES,
    );
  }

  clear(): void {
    this.operationBudget?.clearMemory("protocol-upload-request");
  }

  #tooLarge(part: string): never {
    throw new GitError("E2BIG", `protocol ${part} exceeds its bounded limit`);
  }

  #retainedMemory(): number {
    return UPLOAD_REQUEST_FIXED_BYTES + this.#bytes + this.#frames * UPLOAD_REQUEST_FRAME_BYTES;
  }
}

function utf8Length(text: string): number {
  let bytes = 0;
  for (let index = 0; index < text.length; index++) {
    const unit = text.charCodeAt(index);
    if (unit >= 0xd800 && unit <= 0xdbff) {
      const low = text.charCodeAt(index + 1);
      if (low >= 0xdc00 && low <= 0xdfff) {
        bytes += 4;
        index++;
      } else {
        bytes += 3;
      }
    } else if (unit >= 0xdc00 && unit <= 0xdfff) {
      bytes += 3;
    } else {
      bytes += unit < 0x80 ? 1 : unit < 0x800 ? 2 : 3;
    }
  }
  return bytes;
}

function resolvedProtocolEntryLimit(value: number | undefined): number {
  if (value === undefined) return MAX_PROTOCOL_NEGOTIATION_ENTRIES;
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new RangeError("entries must be a positive safe integer");
  }
  return Math.min(value, MAX_PROTOCOL_NEGOTIATION_ENTRIES);
}

async function readErrorPrefix(
  body: AsyncIterable<Uint8Array>,
  budget?: NegotiationBudget,
): Promise<string> {
  budget?.errorPrefix();
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
  budget?.errorPrefix(length);
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

function ownedPktText(packet: Pkt, budget: NegotiationBudget): string {
  budget.parseText(packet.payload.length);
  if (packet.payload[packet.payload.length - 1] === 0x0a) {
    budget.admitParsed(stringAllocationBytes(Math.max(0, packet.payload.length - 1)));
  }
  const text = pktText(packet);
  budget.settleText(text);
  return text;
}

export async function discover(
  url: string,
  service: Service,
  options: DiscoveryRequestOptions = {},
): Promise<Advertisement> {
  const budget = new NegotiationBudget(
    resolvedProtocolEntryLimit(options.protocolLimits?.entries),
    ADVERTISEMENT_FIXED_BYTES,
    options.operationBudget,
    "protocol-discovery",
  );
  try {
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
      const body = await readErrorPrefix(response.body, budget);
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

    const reader = new ByteReader(
      response.body,
      options.operationBudget,
      "protocol-discovery-frame",
    );
    try {
      const first = await reader.readPkt();
      if (first === null) throw new CorruptError("empty ref advertisement");
      const header = first.kind === "line" ? ownedPktText(first, budget) : "";
      if (header.startsWith("ERR ")) {
        budget.admitParsed(stringAllocationBytes(header.length - 4));
        throw serviceError(service, header.slice(4));
      }
      if (!header.startsWith("# service=")) {
        throw new CorruptError("not a smart HTTP ref advertisement");
      }
      budget.clearParse();
      const afterHeader = await reader.readPkt();
      if (afterHeader === null || afterHeader.kind !== "flush") {
        throw new CorruptError("malformed ref advertisement header");
      }
      return await parseAdvertisement(reader, budget, service);
    } finally {
      budget.clearParse();
      await releaseReader(reader);
    }
  } catch (error) {
    budget.rollback();
    throw error;
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
    budget.parseText(line.payload.length);
    let text: string;
    try {
      text = strictUtf8Decoder.decode(line.payload);
    } catch (error) {
      throw new CorruptError("ref advertisement contains malformed UTF-8", { cause: error });
    }
    budget.settleText(text);
    if (text.endsWith("\n")) {
      const previousTextBytes = retainedStringBytes(text);
      const nextTextBytes = stringAllocationBytes(text.length - 1);
      budget.admitParsed(nextTextBytes);
      text = text.slice(0, -1);
      budget.releaseParsed(previousTextBytes);
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
          const capabilityBytes = CAPABILITY_FIXED_BYTES + stringAllocationBytes(end - start);
          budget.admitParsed(capabilityBytes);
          const capability = text.slice(start, end);
          if (capability.includes("\0")) {
            throw new CorruptError("ref advertisement has malformed capabilities");
          }
          const duplicateCapability = capabilities.has(capability);
          if (capability.startsWith("symref=HEAD")) {
            if (!capability.startsWith("symref=HEAD:")) {
              throw new CorruptError("ref advertisement has a malformed HEAD symref");
            }
            const symrefLength = capability.length - "symref=HEAD:".length;
            const symrefBytes =
              stringAllocationBytes(symrefLength) + (headRef === null ? HEAD_REF_FIXED_BYTES : 0);
            budget.admitParsed(symrefBytes);
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
              budget.retainParsed(symrefBytes);
            } else {
              budget.releaseParsed(symrefBytes);
            }
          }
          capabilities.add(capability);
          if (duplicateCapability) budget.releaseParsed(capabilityBytes);
          else budget.retainParsed(capabilityBytes);
          start = end + 1;
        }
        const previousTextBytes = retainedStringBytes(text);
        const nextTextBytes = stringAllocationBytes(nul);
        budget.admitParsed(nextTextBytes);
        text = text.slice(0, nul);
        budget.releaseParsed(previousTextBytes);
      }
    }
    if (text.startsWith("ERR ")) {
      budget.admitParsed(stringAllocationBytes(text.length - 4));
      throw serviceError(service, text.slice(4));
    }
    const space = text.indexOf(" ");
    if (space < 0) throw new CorruptError("ref advertisement has a malformed row");
    const nameStart = space + 1;
    const oidBytes = stringAllocationBytes(space);
    const nameBytes = stringAllocationBytes(text.length - nameStart);
    const synthetic =
      space === ZERO.length &&
      text.startsWith(ZERO) &&
      text.length - nameStart === "capabilities^{}".length &&
      text.startsWith("capabilities^{}", nameStart);
    const refBytes =
      oidBytes + nameBytes + (synthetic ? REF_NAME_INDEX_FIXED_BYTES : REF_FIXED_BYTES);
    budget.admitParsed(refBytes);
    const oid = text.slice(0, space);
    const name = text.slice(nameStart);
    if (!isOid(oid)) throw new CorruptError(`ref advertisement has an invalid oid for ${name}`);
    if (refNames.has(name)) throw new CorruptError(`ref advertisement has duplicate row ${name}`);
    refNames.add(name);
    // An empty repository advertises only the capabilities line.
    if (synthetic) {
      budget.retainIndexParsed(REF_NAME_INDEX_FIXED_BYTES + nameBytes);
      budget.releaseParsed(oidBytes);
      budget.clearParse();
      continue;
    }
    budget.countEntry();
    const checked = checkRefText(name);
    if (checked.problem !== null || !advertisedRefName(name)) {
      throw new CorruptError(`ref advertisement has an invalid ref name ${name}`);
    }
    refs.push({ name, oid });
    budget.retainParsed(refBytes);
    if (name === "HEAD") headOid = oid;
    budget.clearParse();
  }
  if (!flushed) throw new CorruptError("truncated ref advertisement");
  if (headRef !== null && headOid !== null) {
    const targetOid = refs.find((ref) => ref.name === headRef)?.oid;
    if (targetOid !== undefined && targetOid !== headOid) {
      throw new CorruptError("advertised HEAD does not match its symref target");
    }
  }
  budget.clearIndex();
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
  const entryLimit = resolvedProtocolEntryLimit(options.protocolLimits?.entries);
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

  const requestBudget = new UploadRequestBudget(entryLimit, options.operationBudget);
  let response: GitHttpResponse;
  try {
    requestBudget.entries(entries);
    const body: Uint8Array[] = [];
    const pushLine = (allocationBytes: number, createText: () => string): void => {
      requestBudget.admitText(allocationBytes);
      try {
        const frame = requestBudget.pktLine(createText());
        body.push(frame);
        requestBudget.retainLine(frame);
      } catch (error) {
        requestBudget.cancelLine();
        throw error;
      }
    };
    request.wants.forEach((oid, index) => {
      if (index === 0) {
        const capabilitiesLength = capabilities.reduce(
          (length, capability, capabilityIndex) =>
            length + capability.length + (capabilityIndex === 0 ? 0 : 1),
          0,
        );
        const lineLength = 5 + oid.length + 1 + capabilitiesLength + 1;
        pushLine(
          stringAllocationBytes(capabilitiesLength) + stringAllocationBytes(lineLength),
          () => `want ${oid} ${capabilities.join(" ")}\n`,
        );
        return;
      }
      pushLine(stringAllocationBytes(5 + oid.length + 1), () => `want ${oid}\n`);
    });
    for (const oid of shallows) {
      pushLine(stringAllocationBytes(8 + oid.length + 1), () => `shallow ${oid}\n`);
    }
    if (request.depth !== undefined) {
      let depthDigits = 1;
      for (let threshold = 10; request.depth >= threshold; threshold *= 10) depthDigits++;
      pushLine(
        stringAllocationBytes(depthDigits) + stringAllocationBytes(7 + depthDigits + 1),
        () => `deepen ${request.depth}\n`,
      );
    }
    requestBudget.retainFrame(FLUSH);
    body.push(FLUSH);
    for (const oid of haves) {
      pushLine(stringAllocationBytes(5 + oid.length + 1), () => `have ${oid}\n`);
    }
    pushLine(0, () => "done\n");
    requestBudget.concatenate();
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
  } finally {
    requestBudget.clear();
  }
  const budget = new NegotiationBudget(
    entryLimit,
    UPLOAD_RESULT_FIXED_BYTES,
    options.operationBudget,
    "protocol-upload-result",
  );
  const reader = new ByteReader(response.body, options.operationBudget, "protocol-upload-frame");
  const shallow: string[] = [];
  const unshallow: string[] = [];
  const useSideband = capabilities.includes("side-band-64k");

  try {
    if (response.status !== 200) {
      const text = await readErrorPrefix(response.body, budget);
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
          pack: sideband(reader, line.payload, budget, request.onProgress, request.onMessage),
        };
      }
      const text = ownedPktText(line, budget);
      if (text.startsWith("shallow ")) {
        const retainedBytes = BOUNDARY_FIXED_BYTES + stringAllocationBytes(text.length - 8);
        budget.countEntry();
        budget.admitParsed(retainedBytes);
        const oid = text.slice(8);
        shallow.push(oid);
        budget.retainParsed(retainedBytes);
        budget.clearParse();
        continue;
      }
      if (text.startsWith("unshallow ")) {
        const retainedBytes = BOUNDARY_FIXED_BYTES + stringAllocationBytes(text.length - 10);
        budget.countEntry();
        budget.admitParsed(retainedBytes);
        const oid = text.slice(10);
        unshallow.push(oid);
        budget.retainParsed(retainedBytes);
        budget.clearParse();
        continue;
      }
      if (text.startsWith("ERR ")) throw new GitError("EFETCHFAIL", text.slice(4));
      if (text.startsWith("ACK") || text.startsWith("NAK")) {
        budget.clearParse();
        if (useSideband) continue;
        // Unwrapped, the packfile follows the acknowledgement as raw bytes:
        // one more pkt-line read would try to frame "PACK" as a length.
        return { shallow, unshallow, pack: rawPack(reader, budget) };
      }
      throw new CorruptError(`unexpected upload-pack response: ${text.slice(0, 64)}`);
    }
  } catch (error) {
    budget.rollback();
    await releaseReader(reader);
    throw error;
  }
}

/** Band frames lead with 1, 2 or 3; every ASCII status line starts above 0x20. */
function isBandFrame(payload: Uint8Array): boolean {
  const band = payload[0];
  return band !== undefined && band >= 1 && band <= 3;
}

async function* rawPack(reader: ByteReader, budget: NegotiationBudget): AsyncGenerator<Uint8Array> {
  try {
    yield* reader.rest();
  } catch (error) {
    budget.rollback();
    throw error;
  }
}

async function* sideband(
  reader: ByteReader,
  first: Uint8Array,
  budget: NegotiationBudget,
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
        budget.parseText(payload.length);
        try {
          onProgress(utf8Decoder.decode(payload));
        } finally {
          budget.clearParse();
        }
      } else if (band === 3) {
        budget.parseText(payload.length);
        throw new GitError("EFETCHFAIL", utf8Decoder.decode(payload).trim());
      } else if (band !== 2 && onMessage !== undefined) {
        budget.parseText(frame.length);
        try {
          onMessage(utf8Decoder.decode(frame));
        } finally {
          budget.clearParse();
        }
      }
      frame = null;
    }
  } catch (error) {
    budget.rollback();
    throw error;
  } finally {
    budget.clearParse();
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
