import { GitError, hasErrorCode } from "../../common/errors.js";
import {
  boundedPublishedGitCliResult,
  gitCliResult,
  gitCliUtf8ByteLength,
  utf8Prefix,
} from "../result.js";
import type { GitCliHandlers, GitCliResult, ResolvedGitCliRunOptions } from "../types.js";

export function networkFailure(error: unknown, output: NetworkOutput): GitCliResult {
  if (hasErrorCode(error, "EABORTED") || hasErrorCode(error, "EPUSHUNCERTAIN")) throw error;
  const mapped = mapFailure(error);
  output.append(mapped.stderr);
  return output.result(mapped.exitCode);
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
  ) {
    this.append(initial);
  }

  append(value: string): void {
    if (this.options.discardStderr) return;
    const maximum = Math.min(this.options.maxStderrBytes, this.options.maxCombinedOutputBytes);
    const room = Math.max(0, maximum - this.#bytes);
    const prefix = utf8Prefix(value, room);
    this.#stderr += prefix;
    this.#bytes += gitCliUtf8ByteLength(prefix, "git CLI network stderr", false);
    if (prefix !== value) this.#truncated = true;
  }

  result(exitCode: number): GitCliResult {
    return boundedPublishedGitCliResult(
      { stdout: "", stderr: this.#stderr, exitCode, truncated: this.#truncated },
      this.options,
    );
  }
}
