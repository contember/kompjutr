// Smart HTTP, client side, protocol v0.
//
// v0 is what every server still speaks, and a single round trip that ends
// in `done` is enough for both clone and incremental fetch: the server
// computes the common set from the haves it was given. Nothing here needs
// multi-ack.

import { utf8Decoder } from "../bytes.js";
import { CorruptError, GitError } from "../errors.js";
import { FLUSH, pkt } from "./pktline.js";
import { ByteReader, type Pkt, pktText } from "./stream.js";
import { HttpError, type RemoteRequestOptions, readAll, requestWithAuth } from "./transport.js";

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
  options: RemoteRequestOptions = {},
): Promise<Advertisement> {
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
    const body = await readAll(response.body).catch(() => "");
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
    const header = first.kind === "line" ? pktText(first) : "";
    if (header.startsWith("ERR ")) throw new GitError("EFETCHFAIL", header.slice(4));
    if (!header.startsWith("# service=")) {
      throw new CorruptError("not a smart HTTP ref advertisement");
    }
    const afterHeader = await reader.readPkt();
    if (afterHeader === null || afterHeader.kind !== "flush") {
      throw new CorruptError("malformed ref advertisement header");
    }
    return await parseAdvertisement(reader);
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

async function parseAdvertisement(reader: ByteReader): Promise<Advertisement> {
  const refs: RemoteRef[] = [];
  const capabilities = new Set<string>();
  let headRef: string | null = null;
  let first = true;

  for (;;) {
    const line: Pkt | null = await reader.readPkt();
    if (line === null || line.kind === "flush") break;
    if (line.kind !== "line") continue;
    let text = utf8Decoder.decode(line.payload);
    if (text.endsWith("\n")) text = text.slice(0, -1);
    if (first) {
      first = false;
      const nul = text.indexOf("\0");
      if (nul >= 0) {
        for (const capability of text.slice(nul + 1).split(" ")) {
          if (capability === "") continue;
          capabilities.add(capability);
          if (capability.startsWith("symref=HEAD:")) {
            headRef = capability.slice("symref=HEAD:".length);
          }
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
  options: RemoteRequestOptions = {},
): Promise<UploadPackResult> {
  const base = normalizeRemoteUrl(request.url);
  const wanted = ["side-band-64k", "thin-pack", "ofs-delta", "no-done"];
  if (request.includeTag === true) wanted.push("include-tag");
  const shallows = request.shallows ?? [];
  if (request.depth !== undefined || shallows.length > 0) wanted.push("shallow");
  if (request.onProgress === undefined) wanted.push("no-progress");
  const capabilities = negotiate(request.advertised, wanted);
  capabilities.push(`agent=${AGENT}`);

  const body: Uint8Array[] = [];
  request.wants.forEach((oid, index) => {
    body.push(pkt(index === 0 ? `want ${oid} ${capabilities.join(" ")}\n` : `want ${oid}\n`));
  });
  if (body.length === 0) throw new GitError("ENOWANT", "nothing to fetch");
  for (const oid of shallows) body.push(pkt(`shallow ${oid}\n`));
  if (request.depth !== undefined) body.push(pkt(`deepen ${request.depth}\n`));
  body.push(FLUSH);
  for (const oid of request.haves ?? []) body.push(pkt(`have ${oid}\n`));
  body.push(pkt("done\n"));

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
    const text = await readAll(response.body).catch(() => "");
    throw new HttpError(
      response.status,
      `git-upload-pack failed: ${response.status} ${response.statusText}${text === "" ? "" : ` — ${text.slice(0, 200)}`}`,
    );
  }

  const reader = new ByteReader(response.body);
  const shallow: string[] = [];
  const unshallow: string[] = [];
  const useSideband = capabilities.includes("side-band-64k");

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
    const text = pktText(line);
    if (text.startsWith("shallow ")) {
      shallow.push(text.slice(8).trim());
      continue;
    }
    if (text.startsWith("unshallow ")) {
      unshallow.push(text.slice(10).trim());
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
