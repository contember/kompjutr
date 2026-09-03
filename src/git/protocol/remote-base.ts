import { utf8Decoder } from "../common/bytes.js";
import { GitError } from "../common/errors.js";
import { ByteReader, type Pkt, pktText } from "./stream.js";
import type { RemoteAuthSession, RemoteRequestOptions } from "./transport.js";

export const AGENT = "kompjutr/0.0.0";

export type Service = "git-upload-pack" | "git-receive-pack";

export const MAX_PROTOCOL_NEGOTIATION_ENTRIES = 16_384;

const ERROR_PREFIX_BYTES = 800;
const ERROR_PREFIX_CHARACTERS = 200;
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

export class NegotiationBudget {
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

export function resolvedProtocolEntryLimit(value: number | undefined): number {
  if (value === undefined) return MAX_PROTOCOL_NEGOTIATION_ENTRIES;
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new RangeError("entries must be a positive safe integer");
  }
  return Math.min(value, MAX_PROTOCOL_NEGOTIATION_ENTRIES);
}

export async function readErrorPrefix(
  body: AsyncIterable<Uint8Array>,
  signal: AbortSignal | undefined,
): Promise<string> {
  const prefix = new Uint8Array(ERROR_PREFIX_BYTES);
  let length = 0;
  const reader = new ByteReader(body, signal);
  try {
    for await (const chunk of reader.rest()) {
      if (length >= prefix.length) continue;
      const take = Math.min(chunk.length, prefix.length - length);
      prefix.set(chunk.subarray(0, take), length);
      length += take;
    }
  } catch (error) {
    if (signal?.aborted === true) throw error;
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

export async function releaseReader(reader: ByteReader): Promise<void> {
  try {
    await reader.release();
  } catch {
    // The primary protocol result is authoritative after local cleanup.
  }
}

export function ownedPktText(packet: Pkt): string {
  return pktText(packet);
}

export async function drain(body: AsyncIterable<Uint8Array>, signal?: AbortSignal): Promise<void> {
  const reader = new ByteReader(body, signal);
  try {
    for await (const _chunk of reader.rest()) {
      // discard
    }
  } catch (error) {
    if (signal?.aborted === true) throw error;
    // A remote that hung up has nothing left to drain.
  }
}
