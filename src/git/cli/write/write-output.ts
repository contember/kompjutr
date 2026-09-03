import { GitError } from "../../common/errors.js";
import { type GitCliOutputContext, gitCliUtf8ByteLength } from "../result.js";
import type { ResolvedGitCliRunOptions } from "../types.js";

const SUMMARY_REPOSITORY_BYTES = 8 * 1024 * 1024;
const SUMMARY_MIN_RETAINED_BYTES = 64 * 1024;

export class SummaryRetainedBudget {
  #bytes = 0;
  readonly #maximum: number;

  constructor(maximum: number) {
    this.#maximum = summaryRetainedCeiling(maximum);
  }

  addPath(path: string): void {
    this.add(96 + gitCliUtf8ByteLength(path, "git CLI commit summary path", true) * 2);
  }

  addString(value: string): void {
    this.add(48 + gitCliUtf8ByteLength(value, "git CLI commit summary detail", false) * 2);
  }

  private add(bytes: number): void {
    if (bytes > this.#maximum - this.#bytes) {
      throw new GitError("E2BIG", `git CLI commit summary exceeds ${this.#maximum} retained bytes`);
    }
    this.#bytes += bytes;
  }
}

export function summaryRetainedCeiling(maximum: number): number {
  return Math.min(SUMMARY_REPOSITORY_BYTES, Math.max(SUMMARY_MIN_RETAINED_BYTES, maximum * 4));
}

export function retainedStdoutCeiling(
  options: ResolvedGitCliRunOptions,
  stderrBytes: number,
): number {
  const retainedStderr = options.discardStderr ? 0 : stderrBytes;
  return Math.min(
    options.maxStdoutBytes,
    Math.max(0, options.maxCombinedOutputBytes - retainedStderr),
  );
}

export function retainedStderrCeiling(options: ResolvedGitCliRunOptions): number {
  if (options.discardStderr) return Number.MAX_SAFE_INTEGER;
  return Math.min(options.maxStderrBytes, options.maxCombinedOutputBytes);
}

export function boundedFailureStderr(value: string, options: ResolvedGitCliRunOptions): string {
  if (options.discardStderr) return "";
  const out = new BoundedSummaryOutput(retainedStderrCeiling(options), "git CLI failure stderr");
  out.append(value);
  return out.finish();
}

export function outputContext(options: ResolvedGitCliRunOptions): GitCliOutputContext {
  return { options };
}

export class BoundedSummaryOutput {
  #bytes = 0;
  #output = "";

  constructor(
    private readonly maximum: number,
    private readonly label: string,
  ) {}

  append(value: string): void {
    const bytes = gitCliUtf8ByteLength(value, this.label, false);
    if (bytes > this.maximum - this.#bytes) {
      throw new GitError("E2BIG", `${this.label} exceeds ${this.maximum} bytes`);
    }
    this.#bytes += bytes;
    this.#output += value;
  }

  finish(): string {
    return this.#output;
  }
}
