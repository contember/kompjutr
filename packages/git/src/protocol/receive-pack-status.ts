import { CorruptError, GitError } from "../common/errors.js";
import { MAX_PKT_PAYLOAD_BYTES } from "./pktline.js";
import {
  MAX_RECEIVE_PACK_STATUS_PACKETS,
  type ReceivePackCommand,
  type ReceivePackRefStatus,
  type ReceivePackStatus,
  type ResolvedStatusLimits,
} from "./receive-pack-types.js";
import type { ProtocolMemoryLimits } from "./remote-base.js";
import { ByteReader, type Pkt } from "./stream.js";

const RESULT_FIXED_BYTES = 192;
const STATUS_FIXED_BYTES = 96;
const ERROR_PREFIX_BYTES = 800;
const ERROR_PREFIX_CHARACTERS = 200;
const strictUtf8Decoder = new TextDecoder("utf-8", { fatal: true });
const lossyUtf8Decoder = new TextDecoder();

function resultStringBytes(value: string): number {
  return 48 + value.length * 2;
}

type ParsedStatusLine =
  | { readonly kind: "unpack"; readonly text: string }
  | { readonly kind: "ok"; readonly ref: string }
  | { readonly kind: "ng"; readonly ref: string; readonly text: string };

class StatusWireBudget {
  #entries = 0;
  #inputBytes = 0;

  constructor(private readonly limits: ResolvedStatusLimits) {}

  packet(packet: Pkt): void {
    if (packet.kind !== "line") return;
    if (packet.payload.length > this.limits.lineBytes) this.#tooLarge("pkt-line text");
    if (this.#entries >= this.limits.entries) this.#tooLarge("packet count");
    const inputLimit = this.limits.inputBytes;
    const bytes = packet.payload.length + 4;
    if (inputLimit !== undefined && bytes > inputLimit - this.#inputBytes) {
      this.#tooLarge("input");
    }
    this.#entries++;
    if (inputLimit !== undefined) this.#inputBytes += bytes;
  }

  #tooLarge(part: string): never {
    throw new GitError("E2BIG", `receive-pack ${part} exceeds its bounded limit`);
  }
}

class ResultBudget {
  constructor(private readonly limit: number | undefined) {}

  validateLogical(bytes: number): void {
    if (this.limit !== undefined && bytes > this.limit) this.#tooLarge();
  }

  #tooLarge(): never {
    throw new GitError("E2BIG", "receive-pack result exceeds its bounded retained-state limit");
  }
}

export function resolvedStatusLimits(
  overrides: ProtocolMemoryLimits | undefined,
): ResolvedStatusLimits {
  return {
    ...(overrides?.retainedBytes === undefined
      ? {}
      : { retainedBytes: positiveLimit(overrides.retainedBytes) }),
    ...(overrides?.inputBytes === undefined
      ? {}
      : { inputBytes: positiveLimit(overrides.inputBytes) }),
    entries: boundedLimit(overrides?.entries, MAX_RECEIVE_PACK_STATUS_PACKETS),
    lineBytes: boundedLimit(overrides?.lineBytes, MAX_PKT_PAYLOAD_BYTES),
  };
}

function positiveLimit(value: number): number {
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new RangeError("receive-pack protocol limits must be positive safe integers");
  }
  return value;
}

function boundedLimit(value: number | undefined, ceiling: number): number {
  if (value === undefined) return ceiling;
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new RangeError("receive-pack protocol limits must be positive safe integers");
  }
  return Math.min(value, ceiling);
}

function decodeLine(packet: Pkt, context: string): string {
  if (packet.kind !== "line" || packet.payload.length === 0) {
    throw new CorruptError(`receive-pack ${context} contains an unexpected pkt-line control`);
  }
  if (packet.payload[packet.payload.length - 1] !== 0x0a) {
    throw new CorruptError(`receive-pack ${context} line is missing its newline`);
  }
  let text: string;
  try {
    text = strictUtf8Decoder.decode(packet.payload.subarray(0, -1));
  } catch (cause) {
    throw new CorruptError(`receive-pack ${context} contains malformed UTF-8`, { cause });
  }
  if (text.includes("\0") || text.includes("\r") || text.includes("\n")) {
    throw new CorruptError(`receive-pack ${context} contains invalid text`);
  }
  return text;
}

function parseStatusLine(text: string): ParsedStatusLine {
  if (text.startsWith("unpack ")) {
    const result = text.slice("unpack ".length);
    if (result === "") throw new CorruptError("malformed receive-pack unpack status");
    return { kind: "unpack", text: result };
  }
  if (text.startsWith("ok ")) {
    const ref = text.slice(3);
    if (ref === "" || ref.includes(" ")) {
      throw new CorruptError("malformed receive-pack ref status");
    }
    return { kind: "ok", ref };
  }
  if (text.startsWith("ng ")) {
    const separator = text.indexOf(" ", 3);
    if (separator < 4 || separator === text.length - 1) {
      throw new CorruptError("malformed receive-pack rejection");
    }
    return { kind: "ng", ref: text.slice(3, separator), text: text.slice(separator + 1) };
  }
  throw new CorruptError(`unexpected receive-pack status: ${text.slice(0, 64)}`);
}

async function requireStreamEnd(reader: ByteReader, context: string): Promise<void> {
  const trailing = await reader.readPkt();
  if (trailing !== null) throw new CorruptError(`receive-pack ${context} has trailing packets`);
}

export async function* sidebandBody(
  source: AsyncIterable<Uint8Array>,
  limits: ResolvedStatusLimits,
  onProgress: ((message: string) => void) | undefined,
  onMessage: ((message: string) => void) | undefined,
  signal: AbortSignal | undefined,
): AsyncGenerator<Uint8Array> {
  const reader = new ByteReader(source, signal);
  const budget = new StatusWireBudget(limits);
  let flushed = false;
  try {
    for (;;) {
      const frame = await reader.readPkt();
      if (frame === null) break;
      if (frame.kind === "flush") {
        flushed = true;
        break;
      }
      budget.packet(frame);
      if (frame.kind !== "line" || frame.payload.length === 0) {
        throw new CorruptError("receive-pack returned an invalid sideband frame");
      }
      const band = frame.payload[0];
      const payload = frame.payload.subarray(1);
      if (band === 1) {
        if (payload.length > 0) yield payload;
      } else if (band === 2) {
        let message: string;
        try {
          message = strictUtf8Decoder.decode(payload);
        } catch (cause) {
          throw new CorruptError("receive-pack progress contains malformed UTF-8", { cause });
        }
        onProgress?.(message);
        onMessage?.(message);
      } else if (band === 3) {
        let message: string;
        try {
          message = strictUtf8Decoder.decode(payload).trim();
        } catch (cause) {
          throw new CorruptError("receive-pack fatal message contains malformed UTF-8", {
            cause,
          });
        }
        throw new GitError("EPUSHREJECTED", message === "" ? "receive-pack fatal error" : message);
      } else {
        throw new CorruptError("receive-pack returned an invalid sideband");
      }
    }
    if (!flushed) throw new CorruptError("truncated receive-pack sideband");
    await requireStreamEnd(reader, "sideband");
  } finally {
    await reader.release();
  }
}

export async function parseStatus(
  body: AsyncIterable<Uint8Array>,
  commands: readonly ReceivePackCommand[],
  atomic: boolean,
  limits: ResolvedStatusLimits,
  signal: AbortSignal | undefined,
): Promise<ReceivePackStatus> {
  const reader = new ByteReader(body, signal);
  const wireBudget = new StatusWireBudget(limits);
  const resultBudget = new ResultBudget(limits.retainedBytes);
  const expected = new Set<string>();
  for (const command of commands) expected.add(command.ref);
  const received = new Map<string, ReceivePackRefStatus>();
  let unpack: string | null = null;
  let flushed = false;
  try {
    for (;;) {
      const packet = await reader.readPkt();
      if (packet === null) break;
      if (packet.kind === "flush") {
        flushed = true;
        break;
      }
      wireBudget.packet(packet);
      const line = decodeLine(packet, "status");
      const status = parseStatusLine(line);
      if (status.kind === "unpack") {
        if (unpack !== null) throw new CorruptError("duplicate receive-pack unpack status");
        if (received.size > 0) {
          throw new CorruptError("receive-pack unpack status is out of order");
        }
        unpack = status.text;
        continue;
      }
      if (unpack === null) {
        throw new CorruptError("receive-pack ref status precedes unpack status");
      }
      const ref = status.ref;
      if (!expected.has(ref)) throw new CorruptError(`unexpected receive-pack status for ${ref}`);
      if (received.has(ref)) throw new CorruptError(`duplicate receive-pack status for ${ref}`);
      if (status.kind === "ok") received.set(ref, { ok: true });
      else received.set(ref, { ok: false, error: status.text });
    }
    if (!flushed) throw new CorruptError("truncated receive-pack status");
    await requireStreamEnd(reader, "status");
    if (unpack === null) throw new CorruptError("receive-pack omitted unpack status");
    if (received.size !== commands.length) {
      const missing = commands.find((command) => !received.has(command.ref));
      throw new CorruptError(
        missing === undefined
          ? "receive-pack returned an invalid status count"
          : `receive-pack omitted status for ${missing.ref}`,
      );
    }

    let successes = 0;
    let failures = 0;
    let logicalResultBytes = RESULT_FIXED_BYTES + resultStringBytes(unpack);
    for (const command of commands) {
      const status = received.get(command.ref);
      if (status === undefined) {
        throw new CorruptError(`receive-pack omitted status for ${command.ref}`);
      }
      const statusBytes =
        STATUS_FIXED_BYTES +
        (status.ok || status.error === undefined ? 0 : resultStringBytes(status.error));
      logicalResultBytes += statusBytes + resultStringBytes(command.ref);
      if (status.ok) successes++;
      else failures++;
    }
    if (unpack !== "ok" && successes > 0) {
      throw new CorruptError("receive-pack reported successful refs after unpack failure");
    }
    if (atomic && successes > 0 && failures > 0) {
      throw new CorruptError("atomic receive-pack returned mixed ref statuses");
    }
    resultBudget.validateLogical(logicalResultBytes);

    const refs = new Map<string, ReceivePackRefStatus>();
    for (const command of commands) {
      const status = received.get(command.ref);
      if (status === undefined) {
        throw new CorruptError(`receive-pack omitted status for ${command.ref}`);
      }
      refs.set(command.ref, status);
    }
    expected.clear();
    received.clear();
    return { unpack, refs };
  } finally {
    await reader.release();
  }
}

export async function readResponsePrefix(
  body: AsyncIterable<Uint8Array>,
  inputLimit: number | undefined,
  signal: AbortSignal | undefined,
): Promise<string> {
  const prefix = new Uint8Array(ERROR_PREFIX_BYTES);
  let retained = 0;
  let input = 0;
  const reader = new ByteReader(body, signal);
  try {
    for await (const chunk of reader.rest()) {
      if (inputLimit !== undefined && chunk.length > inputLimit - input) {
        throw new GitError("E2BIG", "receive-pack error response exceeds its bounded input limit");
      }
      if (inputLimit !== undefined) input += chunk.length;
      if (retained >= prefix.length) continue;
      const take = Math.min(chunk.length, prefix.length - retained);
      prefix.set(chunk.subarray(0, take), retained);
      retained += take;
    }
  } finally {
    await reader.release();
  }
  return lossyUtf8Decoder.decode(prefix.subarray(0, retained)).slice(0, ERROR_PREFIX_CHARACTERS);
}
