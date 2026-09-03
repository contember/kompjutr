import { isOid, utf8Decoder } from "../common/bytes.js";
import { CorruptError, GitError } from "../common/errors.js";
import { FLUSH, pkt } from "./pktline.js";
import {
  AGENT,
  baseHeaders,
  NegotiationBudget,
  normalizeRemoteUrl,
  ownedPktText,
  type ProtocolRequestOptions,
  readErrorPrefix,
  releaseReader,
  resolvedProtocolEntryLimit,
} from "./remote-base.js";
import { ByteReader, throwIfAborted } from "./stream.js";
import { type GitHttpResponse, HttpError, requestWithAuth } from "./transport.js";

export type UploadPackFilter = "blob:none";

export interface UploadPackRequest {
  url: string;
  wants: string[];
  haves?: string[];
  /** Shallow boundary commits this client already has. */
  shallows?: string[];
  depth?: number;
  /** Interpret `depth` relative to the client's existing shallow boundary. */
  deepenRelative?: boolean;
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
  const shallowRequested = request.depth !== undefined || shallows.length > 0;
  if (shallowRequested) {
    if (!request.advertised.has("shallow")) {
      throw new GitError("EUNSUPPORTED", "remote does not support shallow fetches");
    }
    wanted.push("shallow");
  }
  if (request.deepenRelative === true) {
    if (request.depth === undefined) {
      throw new GitError("EINVAL", "relative deepening requires an upload-pack depth");
    }
    if (!request.advertised.has("deepen-relative")) {
      throw new GitError("EUNSUPPORTED", "remote does not support relative deepening");
    }
    wanted.push("deepen-relative");
  } else if (request.deepenRelative !== undefined && request.deepenRelative !== false) {
    throw new GitError("EINVAL", "upload-pack deepenRelative must be a boolean");
  }
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
  if (response.status !== 200) {
    const text = await readErrorPrefix(response.body, options.signal);
    throw new HttpError(
      response.status,
      `git-upload-pack failed: ${response.status} ${response.statusText}${text === "" ? "" : ` — ${text.slice(0, 200)}`}`,
    );
  }
  const budget = new NegotiationBudget(entryLimit);
  const reader = new ByteReader(response.body, options.signal);
  const shallow: string[] = [];
  const unshallow: string[] = [];
  const shallowSet = new Set<string>();
  const unshallowSet = new Set<string>();
  const requestedShallows = new Set(shallows);
  const useSideband = capabilities.includes("side-band-64k");

  try {
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
          pack: sideband(
            reader,
            line.payload,
            request.onProgress,
            request.onMessage,
            options.signal,
          ),
        };
      }
      const text = ownedPktText(line);
      if (text.startsWith("shallow ")) {
        budget.countEntry();
        const oid = text.slice(8);
        if (!isOid(oid)) throw new CorruptError(`invalid shallow object id ${oid}`);
        if (!shallowRequested) throw new CorruptError("unsolicited shallow response");
        if (unshallowSet.has(oid)) {
          throw new CorruptError(`upload-pack both shallowed and unshallowed ${oid}`);
        }
        shallowSet.add(oid);
        shallow.push(oid);
        continue;
      }
      if (text.startsWith("unshallow ")) {
        budget.countEntry();
        const oid = text.slice(10);
        if (!isOid(oid)) throw new CorruptError(`invalid unshallow object id ${oid}`);
        if (!requestedShallows.has(oid)) {
          throw new CorruptError(`upload-pack unshallowed an uncaptured object id ${oid}`);
        }
        if (shallowSet.has(oid)) {
          throw new CorruptError(`upload-pack both shallowed and unshallowed ${oid}`);
        }
        unshallowSet.add(oid);
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
  signal?: AbortSignal,
): AsyncGenerator<Uint8Array> {
  try {
    let frame: Uint8Array | null = first;
    for (;;) {
      throwIfAborted(signal);
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
