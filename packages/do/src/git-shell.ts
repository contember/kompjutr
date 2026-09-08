import {
  GIT_CLI_MAX_COMBINED_OUTPUT_BYTES,
  type GitCliResult,
  type GitCliRunner,
  type GitCliRunOptions,
} from "@kompjutr/git";
import { close } from "./shell/exec/bytes.js";
import { type Command, ShellLimitError } from "./shell/exec/context.js";

const ENCODER = new TextEncoder();

/** Adapt the Git argv runner to one injected shell command. */
export function createGitCommand(runner: GitCliRunner): Command {
  return async (context) => {
    await close(context.stdin);
    const options = runOptions(context);
    let cliResult: GitCliResult;
    try {
      const input =
        context.env === undefined
          ? { argv: context.argv, cwd: context.cwd }
          : { argv: context.argv, cwd: context.cwd, env: context.env };
      cliResult = await runner.runCli(input, options);
    } catch (error) {
      const mapped = shellLimit(error);
      if (mapped === null) throw error;
      throw new ShellLimitError(mapped.limit, mapped.message);
    }

    const stdout = ENCODER.encode(cliResult.stdout);
    const stderr = ENCODER.encode(cliResult.stderr);
    const releaseStdout = context.fs.retained.retain(stdout.length, "git stdout");
    return {
      stdout: new GitOutput(stdout, stderr, context.diagnostic, releaseStdout),
      status: () => cliResult.exitCode,
      truncated: () => cliResult.truncated,
    };
  };
}

/** Own result bytes even when a downstream stage closes before the first pull. */
class GitOutput implements IterableIterator<Uint8Array, void, undefined> {
  #stdoutPending: boolean;
  #settled = false;

  constructor(
    private readonly stdout: Uint8Array,
    private readonly stderr: Uint8Array,
    private readonly diagnostic: (bytes: Uint8Array) => void,
    private readonly releaseStdout: () => void,
  ) {
    this.#stdoutPending = stdout.length > 0;
  }

  [Symbol.iterator](): IterableIterator<Uint8Array, void, undefined> {
    return this;
  }

  [Symbol.dispose](): void {
    this.#settle();
  }

  next(..._args: [] | [undefined]): IteratorResult<Uint8Array, void> {
    if (this.#settled) return { done: true, value: undefined };
    if (this.#stdoutPending) {
      this.#stdoutPending = false;
      return { done: false, value: this.stdout };
    }
    this.#settle();
    return { done: true, value: undefined };
  }

  return(_value?: undefined): IteratorResult<Uint8Array, void> {
    this.#settle();
    return { done: true, value: undefined };
  }

  throw(error: unknown): IteratorResult<Uint8Array, void> {
    this.#settle();
    throw error;
  }

  #settle(): void {
    if (this.#settled) return;
    this.#settled = true;
    try {
      this.diagnostic(this.stderr);
    } finally {
      this.releaseStdout();
    }
  }
}

function runOptions(context: Parameters<Command>[0]): GitCliRunOptions {
  const base: GitCliRunOptions = {
    maxStdoutBytes: Math.min(context.output.maxStdoutBytes, GIT_CLI_MAX_COMBINED_OUTPUT_BYTES),
    maxStderrBytes: Math.min(context.output.maxStderrBytes, GIT_CLI_MAX_COMBINED_OUTPUT_BYTES),
    maxCombinedOutputBytes: Math.min(
      context.output.maxCombinedOutputBytes,
      GIT_CLI_MAX_COMBINED_OUTPUT_BYTES,
    ),
    discardStderr: context.output.discardStderr,
  };
  return context.limitHint === null ? base : { ...base, logLimitHint: context.limitHint };
}

function shellLimit(
  error: unknown,
): { readonly limit: "arguments" | "output"; readonly message: string } | null {
  if (typeof error !== "object" || error === null || !("code" in error) || error.code !== "E2BIG") {
    return null;
  }
  if (!("message" in error) || typeof error.message !== "string") return null;
  const message = error.message;
  if (/^git CLI (stdout|stderr|combined output) exceeds /.test(message)) {
    return { limit: "output", message };
  }
  return { limit: "arguments", message };
}
