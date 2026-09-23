import {
  type GitCliOutputContext,
  gitCliResult,
  gitCliUtf8ByteLength,
  utf8Prefix,
} from "../result.js";
import type { GitCliResult, ResolvedGitCliRunOptions } from "../types.js";

export function stdoutOutput(options: ResolvedGitCliRunOptions): TruncatingOutput {
  return new TruncatingOutput(Math.min(options.maxStdoutBytes, options.maxCombinedOutputBytes));
}

/** With `discardStderr`, stderr is neither retained nor reported as truncated. */
export function stderrOutput(options: ResolvedGitCliRunOptions): TruncatingOutput {
  if (options.discardStderr) return new TruncatingOutput(0, true);
  return new TruncatingOutput(Math.min(options.maxStderrBytes, options.maxCombinedOutputBytes));
}

export function outputContext(options: ResolvedGitCliRunOptions): GitCliOutputContext {
  return { options };
}

/** Keeps the UTF-8 prefix that fits one output stream, so retained text never exceeds it. */
export class TruncatingOutput {
  #bytes = 0;
  #output = "";
  #truncated = false;

  constructor(
    readonly maximum: number,
    private readonly discard = false,
  ) {}

  get truncated(): boolean {
    return this.#truncated;
  }

  append(value: string): void {
    if (this.discard || this.#truncated) return;
    const bytes = gitCliUtf8ByteLength(value, "git CLI output", false);
    if (bytes <= this.maximum - this.#bytes) {
      this.#bytes += bytes;
      this.#output += value;
      return;
    }
    this.#output += utf8Prefix(value, this.maximum - this.#bytes);
    this.#bytes = this.maximum;
    this.#truncated = true;
  }

  appendOutput(other: TruncatingOutput): void {
    this.append(other.finish());
    if (other.truncated) this.#truncated = true;
  }

  finish(): string {
    return this.#output;
  }
}

export function truncatedResult(
  stdout: TruncatingOutput | undefined,
  stderr: TruncatingOutput | undefined,
  exitCode: number,
): GitCliResult {
  return {
    ...gitCliResult(stdout?.finish() ?? "", stderr?.finish() ?? "", exitCode),
    truncated: stdout?.truncated === true || stderr?.truncated === true,
  };
}
