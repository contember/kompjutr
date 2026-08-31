// Smart HTTP receive-pack: a bounded ordered command set, one replayable
// request body, and a complete report-status result.

import { isOid, utf8, ZERO_OID } from "../common/bytes.js";
import { CorruptError, GitError, hasErrorCode } from "../common/errors.js";
import { checkRefText, hasCanonicalRefSyntax } from "../common/ref-name.js";
import { FLUSH, MAX_PKT_PAYLOAD_BYTES, pkt } from "./pktline.js";
import {
  baseHeaders,
  normalizeRemoteUrl,
  type ProtocolMemoryLimits,
  type ProtocolRequestOptions,
} from "./remote.js";
import { ByteReader, type Pkt } from "./stream.js";
import { type GitAuth, type GitHttpResponse, HttpError, requestWithAuth } from "./transport.js";

export const MAX_RECEIVE_PACK_COMMANDS = 1_024;
export const MAX_PUSH_OPTIONS = 64;
export const MAX_RECEIVE_PACK_STATUS_PACKETS = 16_384;

const RESULT_FIXED_BYTES = 192;
const STATUS_FIXED_BYTES = 96;
const ERROR_PREFIX_BYTES = 800;
const ERROR_PREFIX_CHARACTERS = 200;
const strictUtf8Decoder = new TextDecoder("utf-8", { fatal: true });
const lossyUtf8Decoder = new TextDecoder();

function resultStringBytes(value: string): number {
  return 48 + value.length * 2;
}

export interface ReceivePackCommand {
  readonly oldOid: string;
  readonly newOid: string;
  readonly ref: string;
}

export interface ReceivePackRequest {
  readonly url: string;
  readonly commands: readonly ReceivePackCommand[];
  readonly advertised: Set<string>;
  readonly atomic?: boolean;
  readonly pushOptions?: readonly string[];
  readonly pack?: () => AsyncIterable<Uint8Array>;
  readonly onProgress?: (message: string) => void;
  readonly onMessage?: (message: string) => void;
}

export interface ReceivePackRefStatus {
  readonly ok: boolean;
  readonly error?: string;
}

export interface ReceivePackStatus {
  readonly unpack: string;
  readonly refs: Map<string, ReceivePackRefStatus>;
}

export interface ReceivePackOptions extends ProtocolRequestOptions {}

interface PreparedRequest {
  readonly commands: readonly ReceivePackCommand[];
  readonly commandFrames: readonly Uint8Array[];
  readonly optionFrames: readonly Uint8Array[];
  readonly hasNonDeletion: boolean;
  readonly sideband: boolean;
  readonly atomic: boolean;
  readonly pack?: () => AsyncIterable<Uint8Array>;
  readonly onProgress?: (message: string) => void;
  readonly onMessage?: (message: string) => void;
}

interface ResolvedStatusLimits {
  readonly retainedBytes?: number;
  readonly inputBytes?: number;
  readonly entries: number;
  readonly lineBytes: number;
}

interface LocalPackFailure {
  readonly cause: unknown;
}

type ParsedStatusLine =
  | { readonly kind: "unpack"; readonly text: string }
  | { readonly kind: "ok"; readonly ref: string }
  | { readonly kind: "ng"; readonly ref: string; readonly text: string };

const localPackBodyErrors = new WeakSet<object>();

class LocalPackBodyError extends Error {
  constructor(cause: unknown) {
    super("local pack generation failed", { cause });
    localPackBodyErrors.add(this);
  }
}

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

/** The branch-only ref subset accepted by the legacy push operation. */
export function requireBranchRef(ref: string): string {
  const checked = checkRefText(ref);
  if (
    checked.problem !== null ||
    !ref.startsWith("refs/heads/") ||
    ref.length === "refs/heads/".length ||
    !hasCanonicalRefSyntax(ref)
  ) {
    throw new GitError("EINVALIDREF", `invalid branch ref ${ref}`);
  }
  return ref;
}

function resolvedStatusLimits(overrides: ProtocolMemoryLimits | undefined): ResolvedStatusLimits {
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

function validateCommand(command: ReceivePackCommand, index: number): ReceivePackCommand {
  if (typeof command !== "object" || command === null || Array.isArray(command)) {
    throw new GitError("EINVAL", `receive-pack command ${index} must be an object`);
  }
  if (typeof command.oldOid !== "string" || typeof command.newOid !== "string") {
    throw new GitError("EINVAL", `receive-pack command ${index} object ids must be strings`);
  }
  if (!isOid(command.oldOid) || !isOid(command.newOid)) {
    throw new GitError("EINVAL", `receive-pack command ${index} has an invalid object id`);
  }
  if (typeof command.ref !== "string") {
    throw new GitError("EINVALIDREF", `receive-pack command ${index} ref must be a string`);
  }
  const checked = checkRefText(command.ref);
  if (
    checked.problem !== null ||
    !command.ref.startsWith("refs/") ||
    command.ref.length === "refs/".length ||
    !hasCanonicalRefSyntax(command.ref)
  ) {
    throw new GitError("EINVALIDREF", `invalid receive-pack destination ${command.ref}`);
  }
  return { oldOid: command.oldOid, newOid: command.newOid, ref: command.ref };
}

function pushOptionBytes(option: string): number {
  let bytes = 0;
  for (let index = 0; index < option.length; index++) {
    const unit = option.charCodeAt(index);
    if (unit === 0 || unit === 0x0a) {
      throw new GitError("EINVAL", "push option contains invalid text");
    }
    if (unit >= 0xd800 && unit <= 0xdbff) {
      const low = option.charCodeAt(index + 1);
      if (index + 1 >= option.length || low < 0xdc00 || low > 0xdfff) {
        throw new GitError("EINVAL", "push option contains malformed UTF-16");
      }
      index++;
      bytes += 4;
    } else if (unit >= 0xdc00 && unit <= 0xdfff) {
      throw new GitError("EINVAL", "push option contains malformed UTF-16");
    } else {
      bytes += unit < 0x80 ? 1 : unit < 0x800 ? 2 : 3;
    }
    if (bytes > MAX_PKT_PAYLOAD_BYTES) {
      throw new GitError("E2BIG", "push option exceeds the pkt-line payload limit");
    }
  }
  return bytes;
}

function validatePushOption(option: string, index: number): number {
  if (typeof option !== "string") {
    throw new GitError("EINVAL", `push option ${index} must be a string`);
  }
  try {
    return pushOptionBytes(option);
  } catch (cause) {
    if (hasErrorCode(cause, "E2BIG")) {
      throw new GitError("E2BIG", `push option ${index} exceeds the pkt-line payload limit`, {
        cause,
      });
    }
    throw new GitError("EINVAL", `push option ${index} contains invalid text`, { cause });
  }
}

function validatePushOptionList(pushOptions: unknown): void {
  if (pushOptions !== undefined && !Array.isArray(pushOptions)) {
    throw new GitError("EINVAL", "receive-pack push options must be an array");
  }
  if (Array.isArray(pushOptions) && pushOptions.length > MAX_PUSH_OPTIONS) {
    throw new GitError("E2BIG", `push option count exceeds ${MAX_PUSH_OPTIONS}`);
  }
}

/** Validate push-option text and return each value's exact UTF-8 wire size. */
export function validatePushOptions(pushOptions: unknown): readonly number[] {
  validatePushOptionList(pushOptions);
  if (!Array.isArray(pushOptions)) return [];

  const optionBytes: number[] = [];
  for (const [index, option] of pushOptions.entries()) {
    const bytes = validatePushOption(option, index);
    optionBytes.push(bytes);
  }
  return optionBytes;
}

function requireCapability(advertised: Set<string>, capability: string): void {
  if (!advertised.has(capability)) {
    throw new GitError("EUNSUPPORTED", `remote does not support receive-pack ${capability}`);
  }
}

function prepareRequest(request: ReceivePackRequest): PreparedRequest {
  if (!Array.isArray(request.commands) || request.commands.length === 0) {
    throw new GitError("EINVAL", "receive-pack requires at least one command");
  }
  if (request.commands.length > MAX_RECEIVE_PACK_COMMANDS) {
    throw new GitError("E2BIG", `receive-pack command count exceeds ${MAX_RECEIVE_PACK_COMMANDS}`);
  }
  validatePushOptionList(request.pushOptions);
  if (request.atomic !== undefined && typeof request.atomic !== "boolean") {
    throw new GitError("EINVAL", "receive-pack atomic must be a boolean");
  }
  if (request.pack !== undefined && typeof request.pack !== "function") {
    throw new GitError("EINVAL", "receive-pack pack must be a function");
  }
  if (request.onProgress !== undefined && typeof request.onProgress !== "function") {
    throw new GitError("EINVAL", "receive-pack progress callback must be a function");
  }
  if (request.onMessage !== undefined && typeof request.onMessage !== "function") {
    throw new GitError("EINVAL", "receive-pack message callback must be a function");
  }
  const pushOptions = request.pushOptions ?? [];

  const commands: ReceivePackCommand[] = [];
  const destinations = new Set<string>();
  let deleting = false;
  let hasNonDeletion = false;
  for (const [index, input] of request.commands.entries()) {
    const command = validateCommand(input, index);
    if (destinations.has(command.ref)) {
      throw new GitError("EINVAL", `duplicate receive-pack destination ${command.ref}`);
    }
    destinations.add(command.ref);
    commands.push(command);
    if (command.newOid === ZERO_OID) deleting = true;
    else hasNonDeletion = true;
  }

  validatePushOptions(pushOptions);

  requireCapability(request.advertised, "report-status");
  if (deleting) requireCapability(request.advertised, "delete-refs");
  if (request.atomic === true) requireCapability(request.advertised, "atomic");
  if (pushOptions.length > 0) requireCapability(request.advertised, "push-options");

  const capabilities = [
    "report-status",
    ...(request.advertised.has("side-band-64k") ? ["side-band-64k"] : []),
    ...(request.atomic === true ? ["atomic"] : []),
    ...(pushOptions.length > 0 ? ["push-options"] : []),
  ];
  const commandFrames: Uint8Array[] = [];
  for (const [index, command] of commands.entries()) {
    const suffix = index === 0 ? `\0${capabilities.join(" ")}` : "";
    const refBytes = checkRefText(command.ref).bytes;
    const payloadBytes = 40 + 1 + 40 + 1 + refBytes + utf8.encode(suffix).length + 1;
    if (payloadBytes > MAX_PKT_PAYLOAD_BYTES) {
      throw new GitError(
        "E2BIG",
        `receive-pack command ${index} exceeds the pkt-line payload limit`,
      );
    }
    const text = `${command.oldOid} ${command.newOid} ${command.ref}${suffix}\n`;
    const frame = pkt(text);
    commandFrames.push(frame);
  }
  const optionFrames: Uint8Array[] = [];
  for (const option of pushOptions) optionFrames.push(pkt(option));
  return {
    commands,
    commandFrames,
    optionFrames,
    hasNonDeletion,
    sideband: capabilities.includes("side-band-64k"),
    atomic: request.atomic === true,
    ...(request.pack === undefined ? {} : { pack: request.pack }),
    ...(request.onProgress === undefined ? {} : { onProgress: request.onProgress }),
    ...(request.onMessage === undefined ? {} : { onMessage: request.onMessage }),
  };
}

async function* requestBody(
  prepared: PreparedRequest,
  pack: (() => AsyncIterable<Uint8Array>) | undefined,
): AsyncGenerator<Uint8Array> {
  for (const frame of prepared.commandFrames) yield frame;
  yield FLUSH;
  if (prepared.optionFrames.length > 0) {
    for (const frame of prepared.optionFrames) yield frame;
    yield FLUSH;
  }
  if (!prepared.hasNonDeletion || pack === undefined) return;
  try {
    yield* pack();
  } catch (cause) {
    throw new LocalPackBodyError(cause);
  }
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

async function* sidebandBody(
  source: AsyncIterable<Uint8Array>,
  limits: ResolvedStatusLimits,
  onProgress: ((message: string) => void) | undefined,
  onMessage: ((message: string) => void) | undefined,
): AsyncGenerator<Uint8Array> {
  const reader = new ByteReader(source);
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

async function parseStatus(
  body: AsyncIterable<Uint8Array>,
  commands: readonly ReceivePackCommand[],
  atomic: boolean,
  limits: ResolvedStatusLimits,
): Promise<ReceivePackStatus> {
  const reader = new ByteReader(body);
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

function validCredentials(credentials: GitAuth | undefined): void {
  if (credentials === undefined) return;
  if (typeof credentials !== "object" || credentials === null || Array.isArray(credentials)) {
    throw new GitError("EAUTH", "remote authentication callback returned invalid credentials");
  }
  if (credentials.username !== undefined && typeof credentials.username !== "string") {
    throw new GitError("EAUTH", "remote authentication username must be a string");
  }
  if (credentials.password !== undefined && typeof credentials.password !== "string") {
    throw new GitError("EAUTH", "remote authentication password must be a string");
  }
  if (
    credentials.headers !== undefined &&
    (typeof credentials.headers !== "object" ||
      credentials.headers === null ||
      Array.isArray(credentials.headers))
  ) {
    throw new GitError("EAUTH", "remote authentication headers must be a string record");
  }
  for (const value of Object.values(credentials.headers ?? {})) {
    if (typeof value !== "string") {
      throw new GitError("EAUTH", "remote authentication headers must contain strings");
    }
  }
}

function authOptions(options: ReceivePackOptions): ReceivePackOptions {
  const onAuth = options.onAuth;
  if (onAuth === undefined) return options;
  return {
    ...options,
    onAuth: async (...input: Parameters<typeof onAuth>) => {
      let credentials: GitAuth | undefined;
      try {
        credentials = await onAuth(...input);
      } catch (cause) {
        throw new GitError("EAUTH", "remote authentication callback failed", { cause });
      }
      validCredentials(credentials);
      return credentials;
    },
  };
}

function findLocalPackFailure(error: unknown): LocalPackFailure | null {
  const seen = new Set<object>();
  let current = error;
  for (let depth = 0; depth < 16; depth++) {
    if (typeof current !== "object" || current === null || seen.has(current)) return null;
    if (localPackBodyErrors.has(current)) {
      return { cause: "cause" in current ? current.cause : current };
    }
    seen.add(current);
    try {
      if (!("cause" in current)) return null;
      current = current.cause;
    } catch {
      return null;
    }
  }
  return null;
}

function uncertain(message: string, cause: unknown): GitError {
  return new GitError("EPUSHUNCERTAIN", message, { cause });
}

async function readResponsePrefix(
  body: AsyncIterable<Uint8Array>,
  inputLimit: number | undefined,
): Promise<string> {
  const prefix = new Uint8Array(ERROR_PREFIX_BYTES);
  let retained = 0;
  let input = 0;
  for await (const chunk of body) {
    if (inputLimit !== undefined && chunk.length > inputLimit - input) {
      throw new GitError("E2BIG", "receive-pack error response exceeds its bounded input limit");
    }
    if (inputLimit !== undefined) input += chunk.length;
    if (retained >= prefix.length) continue;
    const take = Math.min(chunk.length, prefix.length - retained);
    prefix.set(chunk.subarray(0, take), retained);
    retained += take;
  }
  return lossyUtf8Decoder.decode(prefix.subarray(0, retained)).slice(0, ERROR_PREFIX_CHARACTERS);
}

export async function receivePack(
  request: ReceivePackRequest,
  options: ReceivePackOptions = {},
): Promise<ReceivePackStatus> {
  const limits = resolvedStatusLimits(options.protocolLimits);
  const prepared = prepareRequest(request);
  const base = normalizeRemoteUrl(request.url);
  let response: GitHttpResponse;
  try {
    response = await requestWithAuth(
      () => ({
        url: `${base}/git-receive-pack`,
        method: "POST",
        headers: {
          ...baseHeaders(),
          "Content-Type": "application/x-git-receive-pack-request",
          Accept: "application/x-git-receive-pack-result",
        },
        body: requestBody(prepared, prepared.pack),
      }),
      authOptions(options),
      options.authSession,
    );
  } catch (error) {
    const localPackFailure = findLocalPackFailure(error);
    if (localPackFailure !== null) {
      const cause = localPackFailure.cause;
      if (hasErrorCode(cause, "E2BIG") || hasErrorCode(cause, "EPUSHLOCAL")) throw cause;
      throw new GitError("EPUSHLOCAL", "local receive-pack body generation failed", { cause });
    }
    if (hasErrorCode(error, "EAUTH")) throw error;
    throw uncertain("receive-pack POST failed after the request may have been consumed", error);
  }

  if (response.status === 401) {
    let text = "";
    try {
      text = await readResponsePrefix(response.body, limits.inputBytes);
    } catch (cause) {
      throw new GitError("EHTTP", "git-receive-pack authentication failed", { cause });
    }
    throw new HttpError(
      response.status,
      `git-receive-pack failed: 401 ${response.statusText}${text === "" ? "" : ` — ${text}`}`,
    );
  }
  if (response.status !== 200) {
    let text: string;
    try {
      text = await readResponsePrefix(response.body, limits.inputBytes);
    } catch (cause) {
      throw uncertain("receive-pack returned an uncertain HTTP response", cause);
    }
    const cause = new HttpError(
      response.status,
      `git-receive-pack failed: ${response.status} ${response.statusText}${text === "" ? "" : ` — ${text}`}`,
    );
    throw uncertain("receive-pack returned an uncertain HTTP response", cause);
  }
  const contentType = response.headers["content-type"] ?? "";
  const mediaType = contentType.split(";")[0]?.trim() ?? "";
  if (mediaType !== "application/x-git-receive-pack-result") {
    try {
      await readResponsePrefix(response.body, limits.inputBytes);
    } catch (cause) {
      throw uncertain("receive-pack returned an uncertain malformed response", cause);
    }
    throw uncertain(
      "receive-pack returned an uncertain malformed response",
      new CorruptError(
        `invalid receive-pack content-type: ${contentType === "" ? "none" : contentType}`,
      ),
    );
  }
  const sideband = prepared.sideband
    ? sidebandBody(response.body, limits, prepared.onProgress, prepared.onMessage)
    : null;
  const statusBody = sideband ?? response.body;
  try {
    return await parseStatus(statusBody, prepared.commands, prepared.atomic, limits);
  } catch (cause) {
    throw uncertain("receive-pack returned an incomplete or invalid status", cause);
  } finally {
    await sideband?.return(undefined);
  }
}

export { ZERO_OID };
