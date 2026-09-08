import { isOid, utf8, ZERO_OID } from "../common/bytes.js";
import { GitError, hasErrorCode } from "../common/errors.js";
import { checkRefText, hasCanonicalRefSyntax } from "../common/ref-name.js";
import { FLUSH, MAX_PKT_PAYLOAD_BYTES, pkt } from "./pktline.js";
import {
  MAX_PUSH_OPTIONS,
  MAX_RECEIVE_PACK_COMMANDS,
  type PreparedRequest,
  type ReceivePackCommand,
  type ReceivePackRequest,
} from "./receive-pack-types.js";

interface LocalPackFailure {
  readonly cause: unknown;
}

const localPackBodyErrors = new WeakSet<object>();

class LocalPackBodyError extends Error {
  constructor(cause: unknown) {
    super("local pack generation failed", { cause });
    localPackBodyErrors.add(this);
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

export function prepareRequest(request: ReceivePackRequest): PreparedRequest {
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

export async function* requestBody(
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

export function findLocalPackFailure(error: unknown): LocalPackFailure | null {
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
