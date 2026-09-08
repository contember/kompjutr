import { GitError, hasErrorCode } from "../../common/errors.js";
import {
  boundedGitCliResult,
  boundedPublishedGitCliResult,
  gitCliResult,
  gitCliUtf8ByteLength,
} from "../result.js";
import type { GitCliHandlers, GitCliResult, ResolvedGitCliRunOptions } from "../types.js";

export function networkFailure(
  error: unknown,
  output: NetworkOutput,
  published: boolean,
): GitCliResult {
  if (hasErrorCode(error, "EABORTED") || hasErrorCode(error, "EPUSHUNCERTAIN")) throw error;
  const overflow = errorByCode(error, "E2BIG");
  if (overflow !== null && !published) throw overflow;
  const mapped = mapFailure(error);
  if (published) {
    output.appendPublished(mapped.stderr);
    return output.published(mapped.exitCode);
  }
  output.appendStrict(mapped.stderr);
  return output.preflight(mapped.exitCode);
}

function errorByCode(error: unknown, code: string, depth = 0): unknown | null {
  if (depth > 4 || typeof error !== "object" || error === null) return null;
  if (hasErrorCode(error, code)) return error;
  return errorByCode(Reflect.get(error, "cause"), code, depth + 1);
}

export class GitCliPushUncertainError extends GitError {
  constructor(
    cause: unknown,
    readonly result: GitCliResult,
  ) {
    super("EPUSHUNCERTAIN", errorMessage(cause), { cause });
    this.name = "GitCliPushUncertainError";
  }
}

export function mapFailure(error: unknown): GitCliResult {
  if (
    typeof error !== "object" ||
    error === null ||
    !("code" in error) ||
    typeof error.code !== "string"
  )
    throw error;
  return gitCliResult("", `fatal: ${errorMessage(error)}\n`, 128);
}

function errorMessage(error: unknown): string {
  if (typeof error !== "object" || error === null) return "network operation failed";
  const message = Reflect.get(error, "message");
  if (typeof message === "string") return message;
  const code = Reflect.get(error, "code");
  return typeof code === "string" ? code : "network operation failed";
}

export function* formatLsRemote(
  refs: readonly { readonly oid: string; readonly name: string }[],
): Generator<string> {
  for (const ref of refs) yield `${ref.oid}\t${ref.name}\n`;
}

export function environmentRecord(
  environment: Parameters<NonNullable<GitCliHandlers["pull"]>>[0]["env"],
): Record<string, string> {
  const record: Record<string, string> = {};
  for (const [key, value] of Object.entries(environment))
    if (value !== undefined) record[key] = value;
  return record;
}

export class NetworkOutput {
  #stderr = "";
  #bytes = 0;
  #truncated = false;

  constructor(
    private readonly options: ResolvedGitCliRunOptions,
    initial: string,
    private readonly failBeforePublication: boolean,
  ) {
    this.append(initial);
    if (!failBeforePublication) boundedGitCliResult(gitCliResult("", initial, 0), options);
  }

  append(value: string): void {
    if (this.options.discardStderr) return;
    const maximum = Math.min(this.options.maxStderrBytes, this.options.maxCombinedOutputBytes);
    const bytes = gitCliUtf8ByteLength(value, "git CLI network stderr", false);
    if (bytes <= maximum - this.#bytes) {
      this.#stderr += value;
      this.#bytes += bytes;
      return;
    }
    if (this.failBeforePublication) {
      throw new GitError("E2BIG", `git CLI stderr exceeds ${maximum} bytes`);
    }
    this.appendPublished(value);
  }

  appendPublished(value: string): void {
    if (this.options.discardStderr) return;
    const maximum = Math.min(this.options.maxStderrBytes, this.options.maxCombinedOutputBytes);
    const room = Math.max(0, maximum - this.#bytes);
    const prefix = utf8Prefix(value, room);
    this.#stderr += prefix;
    this.#bytes += gitCliUtf8ByteLength(prefix, "git CLI network stderr", false);
    if (prefix !== value) this.#truncated = true;
  }

  appendStrict(value: string): void {
    if (this.options.discardStderr) return;
    const maximum = Math.min(this.options.maxStderrBytes, this.options.maxCombinedOutputBytes);
    const bytes = gitCliUtf8ByteLength(value, "git CLI network stderr", false);
    if (bytes > maximum - this.#bytes) {
      throw new GitError("E2BIG", `git CLI stderr exceeds ${maximum} bytes`);
    }
    this.#stderr += value;
    this.#bytes += bytes;
  }

  preflight(exitCode: number): GitCliResult {
    return boundedGitCliResult(gitCliResult("", this.#stderr, exitCode), this.options);
  }

  published(exitCode: number): GitCliResult {
    return boundedPublishedGitCliResult(
      { stdout: "", stderr: this.#stderr, exitCode, truncated: this.#truncated },
      this.options,
    );
  }
}

function utf8Prefix(value: string, maximum: number): string {
  if (gitCliUtf8ByteLength(value, "git CLI network output", false) <= maximum) return value;
  const bytes = new TextEncoder().encode(value);
  const decoder = new TextDecoder("utf-8", { fatal: true });
  for (let end = Math.min(maximum, bytes.length); end >= 0; end--) {
    try {
      return decoder.decode(bytes.subarray(0, end));
    } catch {
      // Continue to the prior complete UTF-8 boundary.
    }
  }
  return "";
}
