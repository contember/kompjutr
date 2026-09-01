// Running a plan.
//
// Pull-based on purpose: a stage only advances when the stage after it asks
// for more, so a `head -20` that stops asking stops the search behind it,
// which stops the discovery pages behind that. R1's limit pushdown is not
// implemented here as a rewrite — it falls out of the laziness, and the
// planner's `limitHint` only sizes the first page.

import { join, normalize } from "../../fs/path.js";
import type { Filesystem } from "../../fs/types.js";
import { ShellSyntaxError } from "../parse/ast.js";
import type { Argument, Plan, PlannedCommand, PlannedPipeline } from "../plan/types.js";
import {
  type ByteStream,
  close,
  concat,
  isAsyncByteStream,
  line,
  withUnusedRestorer,
} from "./bytes.js";
import {
  BoundedFs,
  type Command,
  type CommandContext,
  type CommandResult,
  DEFAULT_LIMITS,
  type Limits,
  ShellLimitError,
} from "./context.js";
import { compileGlob, sqlGlobFor } from "./glob.js";

const ARGUMENT_COUNT_MAX = 10_000;
const ENV_ENTRY_MAX = 256;
const PATH_PAGE_MAX = 1_000;
const ENCODER = new TextEncoder();

export interface ExecOptions {
  readonly fs: Filesystem;
  readonly cwd: string;
  readonly commands: ReadonlyMap<string, Command>;
  readonly limits?: Limits;
  readonly stdin?: Uint8Array | string;
  readonly env?: Readonly<Record<string, string>>;
}

export interface ExecResult {
  readonly stdout: Uint8Array;
  readonly stderr: Uint8Array;
  readonly exitCode: number;
  /** The working directory after the run — `cd` is a builtin. */
  readonly cwd: string;
  /** True when `maxOutputBytes` stopped stdout or stderr early. */
  readonly truncated: boolean;
  readonly operations: number;
  /** Peak shell-owned intermediate bytes, excluding public stdout and stderr. */
  readonly peakRetainedBytes: number;
}

export async function execute(plan: Plan, options: ExecOptions): Promise<ExecResult> {
  const limits = options.limits ?? DEFAULT_LIMITS;
  const fs = new BoundedFs(options.fs, limits);
  const out = new Sink(limits.maxOutputBytes);
  const errors = new Sink(limits.maxOutputBytes);
  let cwd = normalize(options.cwd);
  let exitCode = 0;
  let previousConnector: "&&" | "||" | ";" | null = null;
  let runInput: RunInputOwner | null = null;
  let commandTruncated = false;

  try {
    try {
      runInput = prepareRunInput(options.stdin, options.env, fs);
      for (const step of plan.steps) {
        const selected =
          previousConnector === null ||
          previousConnector === ";" ||
          (previousConnector === "&&" ? exitCode === 0 : exitCode !== 0);
        if (selected) {
          const outcome = await runPipeline(step.pipeline, {
            fs,
            cwd,
            commands: options.commands,
            out,
            errors,
            inputs: runInput,
            currentStatus: exitCode,
            chdir: (path: string) => {
              cwd = path;
            },
          });
          exitCode = outcome.exitCode;
          commandTruncated ||= outcome.truncated;
          if (outcome.terminateRun) break;
        }
        previousConnector = step.connector;
      }
    } catch (error) {
      if (error instanceof ShellLimitError || error instanceof ShellSyntaxError) {
        errors.writeBytes(line(`kompjutr: ${error.message}`));
        exitCode = 2;
      } else {
        throw error;
      }
    }

    return {
      stdout: out.bytes(),
      stderr: errors.bytes(),
      exitCode,
      cwd,
      truncated: commandTruncated || out.truncated || errors.truncated,
      operations: fs.operations,
      peakRetainedBytes: fs.retained.peak,
    };
  } finally {
    runInput?.close();
  }
}

interface PipelineEnvironment {
  readonly fs: BoundedFs;
  readonly cwd: string;
  readonly commands: ReadonlyMap<string, Command>;
  readonly out: Sink;
  readonly errors: Sink;
  readonly inputs: RunInputOwner | null;
  readonly currentStatus: number;
  chdir(path: string): void;
}

interface PipelineResult {
  readonly exitCode: number;
  readonly truncated: boolean;
  readonly terminateRun: boolean;
}

interface FileDestination {
  readonly kind: "file";
  readonly path: string;
  readonly append: boolean;
  opened: boolean;
}

type OutputDestination =
  | { readonly kind: "output" }
  | { readonly kind: "diagnostic" }
  | { readonly kind: "drop" }
  | FileDestination;

interface ResolvedRedirections {
  readonly stdin: string | null;
  readonly output: OutputDestination;
  readonly stdout: OutputDestination;
  readonly stderr: OutputDestination;
  readonly files: readonly FileDestination[];
}

async function runPipeline(
  pipeline: PlannedPipeline,
  env: PipelineEnvironment,
): Promise<PipelineResult> {
  let stream: ByteStream | null = env.inputs?.borrow() ?? null;
  const results: CommandResult[] = [];
  let settled = false;

  try {
    for (let index = 0; index < pipeline.commands.length; index++) {
      const planned = pipeline.commands[index];
      if (planned === undefined) continue;

      const command = env.commands.get(planned.name);
      if (command === undefined) {
        env.errors.writeBytes(line(`kompjutr: ${planned.name}: command not found`));
        await close(stream);
        settled = true;
        return {
          exitCode: 127,
          truncated: results.some(commandResultTruncated),
          terminateRun: false,
        };
      }

      const expanded = expandArguments(planned.args, env.fs, env.cwd, env.inputs?.env);
      const argv = expanded.argv;

      let redirections: ResolvedRedirections;
      try {
        redirections = resolveRedirections(planned, env.fs, env.cwd);
        await openRedirectionFiles(redirections, env.fs);
      } catch (error) {
        expanded.release();
        if (isFilesystemError(error)) {
          env.errors.writeBytes(line(`${planned.name}: ${error.message}`));
          return {
            exitCode: 1,
            truncated: results.some(commandResultTruncated),
            terminateRun: false,
          };
        }
        throw error;
      }

      if (redirections.stdin !== null) {
        const priorInput = stream;
        stream = null;
        let priorClosed = false;
        const closePrior = async (): Promise<void> => {
          if (priorClosed) return;
          priorClosed = true;
          await close(priorInput);
        };
        try {
          await closePrior();
          stream = readWholeFile(env.fs, redirections.stdin);
        } catch (error) {
          try {
            await closePrior();
          } finally {
            expanded.release();
          }
          throw error;
        }
      }

      const routedDiagnostics = new Map<OutputDestination, HeldChunk[]>();
      const stageInput = stream;
      const context = commandContext(
        planned,
        redirections,
        index === pipeline.commands.length - 1,
        pipeline.commands.length === 1,
        argv,
        stageInput,
        pipeline.limitHint,
        env,
        routedDiagnostics,
      );
      let produced: CommandResult;
      try {
        produced = await command(context);
      } catch (error) {
        rethrowAfterCommandCleanup(error, expanded, routedDiagnostics);
      }
      const releaseStage = isAsyncByteStreamOrNull(stageInput)
        ? async (): Promise<void> => {
            try {
              await close(stageInput);
            } finally {
              expanded.release();
            }
          }
        : (): void => {
            try {
              stageInput?.return?.();
            } finally {
              expanded.release();
            }
          };
      const output = stageOutput(
        produced.stdout,
        diagnosticsFor(routedDiagnostics, redirections.stdout),
        releaseStage,
        isAsyncByteStreamOrNull(stageInput),
      );
      results.push(produced);
      try {
        stream = await routeStageOutput(output, redirections, routedDiagnostics, env);
      } catch (error) {
        await close(output);
        releaseDiagnostics(routedDiagnostics);
        if (error instanceof UpstreamError) throw error.original;
        if (isFilesystemError(error)) {
          env.errors.writeBytes(line(`${planned.name}: ${error.message}`));
          return {
            exitCode: 1,
            truncated: results.some(commandResultTruncated),
            terminateRun: false,
          };
        }
        throw error;
      }
      if (produced.control?.kind === "exit") {
        await env.out.write(stream);
        settled = true;
        return {
          exitCode: produced.status(),
          truncated: results.some(commandResultTruncated),
          terminateRun: produced.control.terminateRun,
        };
      }
    }

    if (stream === null) {
      settled = true;
      return { exitCode: 0, truncated: false, terminateRun: false };
    }
    await env.out.write(stream);
    settled = true;

    // A pipeline's status is its last stage's, as in bash without pipefail.
    const last = results[results.length - 1];
    return {
      exitCode: last === undefined ? 0 : last.status(),
      truncated: results.some(commandResultTruncated),
      terminateRun: false,
    };
  } finally {
    if (!settled) await close(stream);
  }
}

function commandResultTruncated(result: CommandResult): boolean {
  return result.truncated?.() ?? false;
}

function isAsyncByteStreamOrNull(
  stream: ByteStream | null,
): stream is AsyncIterableIterator<Uint8Array, void, undefined> {
  return stream !== null && isAsyncByteStream(stream);
}

/** Own caller inputs and their retained-memory reservation for one complete run. */
export class RunInputOwner {
  #closed = false;
  #offset = 0;

  constructor(
    private readonly source: Uint8Array | null,
    readonly env: Readonly<Record<string, string>> | undefined,
    private readonly release: () => void,
  ) {}

  /** A pipeline may close its borrow without closing the run-owned cursor. */
  borrow(): ByteStream | null {
    const source = this.source;
    if (source === null) return null;
    const start = this.#offset;
    const owner = this;
    const stream = (function* (): ByteStream {
      if (start >= source.length) return;
      owner.#offset = source.length;
      yield source.subarray(start);
    })();
    let restored = false;
    return withUnusedRestorer(stream, (unused) => {
      if (restored) return;
      restored = true;
      const suffixStart = source.length - unused.length;
      if (
        suffixStart < start ||
        unused.buffer !== source.buffer ||
        unused.byteOffset !== source.byteOffset + suffixStart
      ) {
        throw new Error("caller stdin restorer received a non-suffix view");
      }
      owner.#offset = suffixStart;
    });
  }

  close(): void {
    if (this.#closed) return;
    this.#closed = true;
    this.release();
  }
}

function prepareRunInput(
  stdin: Uint8Array | string | undefined,
  env: Readonly<Record<string, string>> | undefined,
  fs: BoundedFs,
): RunInputOwner | null {
  if (stdin === undefined && env === undefined) return null;
  const stdinSize = stdin === undefined ? 0 : stdinBytes(stdin);
  const environment = measureEnvironment(env);
  const release = fs.retained.retain(stdinSize + environment.bytes, "caller inputs");
  try {
    const stdinSnapshot =
      stdin === undefined
        ? null
        : typeof stdin === "string"
          ? ENCODER.encode(stdin)
          : stdin.slice();
    const envSnapshot = snapshotEnvironment(env, environment);
    return new RunInputOwner(stdinSnapshot, envSnapshot, release);
  } catch (error) {
    release();
    throw error;
  }
}

interface EnvironmentMeasurement {
  readonly entries: number;
  readonly bytes: number;
}

function measureEnvironment(
  env: Readonly<Record<string, string>> | undefined,
): EnvironmentMeasurement {
  if (env === undefined) return { entries: 0, bytes: 0 };
  if (typeof env !== "object" || env === null) {
    throw new ShellLimitError("arguments", "caller env must be an object with string values");
  }

  let entries = 0;
  let bytes = 0;
  for (const key in env) {
    if (!Object.hasOwn(env, key)) continue;
    entries++;
    if (entries > ENV_ENTRY_MAX) {
      throw new ShellLimitError("arguments", `caller env exceeds ${ENV_ENTRY_MAX} entries`);
    }
    const value = env[key];
    if (typeof value !== "string") {
      throw new ShellLimitError("arguments", "caller env values must be strings");
    }
    bytes = addUtf8Bytes(bytes, key, "caller env");
    bytes = addUtf8Bytes(bytes, value, "caller env");
  }
  return { entries, bytes };
}

function snapshotEnvironment(
  env: Readonly<Record<string, string>> | undefined,
  measured: EnvironmentMeasurement,
): Readonly<Record<string, string>> | undefined {
  if (env === undefined) return undefined;
  const entries: Array<readonly [string, string]> = [];
  let bytes = 0;
  for (const key in env) {
    if (!Object.hasOwn(env, key)) continue;
    if (entries.length >= measured.entries) {
      throw new ShellLimitError("arguments", "caller env changed while it was snapshotted");
    }
    const value = env[key];
    if (typeof value !== "string") {
      throw new ShellLimitError("arguments", "caller env values must be strings");
    }
    bytes = addUtf8Bytes(bytes, key, "caller env snapshot");
    bytes = addUtf8Bytes(bytes, value, "caller env snapshot");
    if (bytes > measured.bytes) {
      throw new ShellLimitError("arguments", "caller env changed while it was snapshotted");
    }
    entries.push([key, value]);
  }
  if (entries.length !== measured.entries || bytes !== measured.bytes) {
    throw new ShellLimitError("arguments", "caller env changed while it was snapshotted");
  }
  return Object.freeze(Object.fromEntries(entries));
}

function addUtf8Bytes(current: number, value: string, label: string): number {
  const bytes = utf8Bytes(value);
  if (bytes > Number.MAX_SAFE_INTEGER - current) {
    throw new ShellLimitError("arguments", `${label} has an invalid retained size`);
  }
  return current + bytes;
}

function stdinBytes(stdin: Uint8Array | string): number {
  if (typeof stdin !== "string") {
    if (!(stdin instanceof Uint8Array)) {
      throw new ShellLimitError("arguments", "caller stdin must be a string or Uint8Array");
    }
    return stdin.byteLength;
  }

  return utf8Bytes(stdin);
}

/** Match TextEncoder's replacement of unpaired surrogates without allocating. */
function utf8Bytes(value: string): number {
  let bytes = 0;
  for (let index = 0; index < value.length; index++) {
    const code = value.charCodeAt(index);
    if (code <= 0x7f) bytes += 1;
    else if (code <= 0x7ff) bytes += 2;
    else if (code >= 0xd800 && code <= 0xdbff) {
      const next = value.charCodeAt(index + 1);
      if (next >= 0xdc00 && next <= 0xdfff) {
        bytes += 4;
        index++;
      } else bytes += 3;
    } else bytes += 3;
  }
  return bytes;
}

class UpstreamError extends Error {
  constructor(readonly original: unknown) {
    super("redirect upstream failed");
  }
}

function protectUpstream(stream: ByteStream): ByteStream {
  if (!isAsyncByteStream(stream)) {
    return (function* (): ByteStream {
      try {
        yield* stream;
      } catch (error) {
        throw new UpstreamError(error);
      }
    })();
  }
  return (async function* (): ByteStream {
    try {
      for await (const chunk of stream) yield chunk;
    } catch (error) {
      throw new UpstreamError(error);
    }
  })();
}

function resolveRedirections(
  planned: PlannedCommand,
  fs: BoundedFs,
  cwd: string,
): ResolvedRedirections {
  const output: OutputDestination = { kind: "output" };
  const diagnostic: OutputDestination = { kind: "diagnostic" };
  let stdin: string | null = null;
  let stdout: OutputDestination = output;
  let stderr: OutputDestination = diagnostic;
  const files: FileDestination[] = [];

  for (const redirection of planned.redirections) {
    if (redirection.kind === "read") {
      stdin = resolve(cwd, single(redirection.path, fs, cwd));
      continue;
    }
    if (redirection.kind === "duplicate") {
      const destination: OutputDestination = redirection.targetFd === 1 ? stdout : stderr;
      if (redirection.fd === 1) stdout = destination;
      else stderr = destination;
      continue;
    }
    const path = resolve(cwd, single(redirection.path, fs, cwd));
    const destination: OutputDestination =
      path === "/dev/null"
        ? { kind: "drop" }
        : {
            kind: "file",
            path,
            append: redirection.append,
            opened: false,
          };
    if (destination.kind === "file") files.push(destination);
    if (redirection.fd === 1) stdout = destination;
    else stderr = destination;
  }

  return { stdin, output, stdout, stderr, files };
}

async function openRedirectionFiles(
  redirections: ResolvedRedirections,
  fs: BoundedFs,
): Promise<void> {
  const deferred =
    redirections.stdout.kind === "file"
      ? redirections.files[redirections.files.length - 1]
      : undefined;
  for (const file of redirections.files) {
    if (file === deferred) continue;
    await writeStream(fs, file.path, file.append, empty());
    file.opened = true;
  }
}

async function routeStageOutput(
  stdout: ByteStream,
  redirections: ResolvedRedirections,
  diagnostics: Map<OutputDestination, HeldChunk[]>,
  env: PipelineEnvironment,
): Promise<ByteStream> {
  if (redirections.stdout.kind === "output") {
    const sideFiles = activeSideFiles(redirections);
    if (sideFiles.length === 0) return stdout;
    return outputWithSideFiles(stdout, sideFiles, diagnostics, env.fs);
  }

  if (redirections.stdout.kind === "diagnostic") {
    await env.errors.write(stdout);
  } else if (redirections.stdout.kind === "drop") {
    await drain(stdout);
  } else {
    await writeStream(
      env.fs,
      redirections.stdout.path,
      redirections.stdout.append || redirections.stdout.opened,
      protectUpstream(stdout),
    );
    redirections.stdout.opened = true;
  }

  await flushSideFiles(activeSideFiles(redirections), diagnostics, env.fs);
  const pipelineDiagnostics = diagnosticsFor(diagnostics, redirections.output);
  releaseDiagnostics(diagnostics, pipelineDiagnostics);
  return stageOutput(empty(), pipelineDiagnostics, () => {}, false);
}

function activeSideFiles(redirections: ResolvedRedirections): FileDestination[] {
  if (redirections.stderr.kind !== "file" || redirections.stderr === redirections.stdout) return [];
  return [redirections.stderr];
}

function outputWithSideFiles(
  stdout: ByteStream,
  files: readonly FileDestination[],
  diagnostics: Map<OutputDestination, HeldChunk[]>,
  fs: BoundedFs,
): ByteStream {
  return (async function* (): ByteStream {
    try {
      for await (const chunk of stdout) yield chunk;
    } finally {
      try {
        await close(stdout);
        await flushSideFiles(files, diagnostics, fs);
      } finally {
        releaseDiagnostics(diagnostics);
      }
    }
  })();
}

async function flushSideFiles(
  files: readonly FileDestination[],
  diagnostics: Map<OutputDestination, HeldChunk[]>,
  fs: BoundedFs,
): Promise<void> {
  for (const file of files) {
    const chunks = diagnosticsFor(diagnostics, file);
    if (chunks.length === 0) continue;
    await writeStream(
      fs,
      file.path,
      true,
      stageOutput(empty(), chunks, () => {}, false),
    );
  }
}

async function drain(stream: ByteStream): Promise<void> {
  for await (const _chunk of stream) {
    // Pull to completion so lazy status and cleanup settle.
  }
}

function isFilesystemError(error: unknown): error is Error & { readonly code: string } {
  return (
    error instanceof Error &&
    "code" in error &&
    typeof error.code === "string" &&
    error.code.startsWith("E")
  );
}

function commandContext(
  planned: PlannedCommand,
  redirections: ResolvedRedirections,
  lastStage: boolean,
  mayExitRun: boolean,
  argv: readonly string[],
  stdin: ByteStream | null,
  limitHint: number | null,
  env: PipelineEnvironment,
  routedDiagnostics: Map<OutputDestination, HeldChunk[]>,
): CommandContext {
  const output = commandOutput(redirections, lastStage, env);
  const diagnostic = (bytes: Uint8Array): void => {
    if (bytes.length === 0 || redirections.stderr.kind === "drop") return;
    if (redirections.stderr.kind === "diagnostic") {
      env.errors.writeBytes(bytes);
    } else {
      diagnosticsFor(routedDiagnostics, redirections.stderr).push({
        bytes,
        release: env.fs.retained.retain(bytes.length, "routed diagnostic"),
      });
    }
  };
  const context: CommandContext = {
    fs: env.fs,
    cwd: env.cwd,
    argv,
    stdin,
    env: env.inputs?.env,
    currentStatus: env.currentStatus,
    mayExitRun,
    limitHint,
    output,
    diagnostic,
    warn: (message: string) => {
      if (redirections.stderr.kind === "drop") return;
      const bytes = line(`${planned.name}: ${message}`);
      diagnostic(bytes);
    },
    chdir: env.chdir,
    invoke: async (name: string, subArgv: readonly string[]): Promise<CommandResult | null> => {
      const command = env.commands.get(name);
      if (command === undefined) return null;
      // No stdin and no demand hint: the sub-invocation's arguments already
      // carry everything it is meant to see.
      return command({
        ...context,
        argv: subArgv,
        stdin: null,
        limitHint: null,
        mayExitRun: false,
      });
    },
  };
  return context;
}

function commandOutput(
  redirections: ResolvedRedirections,
  lastStage: boolean,
  env: PipelineEnvironment,
): CommandContext["output"] {
  const destination =
    redirections.stdout.kind === "output"
      ? lastStage
        ? "terminal"
        : "pipeline"
      : redirections.stdout.kind === "diagnostic"
        ? "terminal"
        : "redirect";
  const maxStdoutBytes = destinationLimit(redirections.stdout, lastStage, env);
  const maxStderrBytes = destinationLimit(redirections.stderr, lastStage, env);
  const discardStderr = redirections.stderr.kind === "drop";
  const maxCombinedOutputBytes =
    redirections.stdout === redirections.stderr
      ? Math.max(maxStdoutBytes, maxStderrBytes)
      : safeSum(maxStdoutBytes, maxStderrBytes);
  return {
    destination,
    maxStdoutBytes,
    maxStderrBytes,
    maxCombinedOutputBytes,
    discardStderr,
  };
}

function destinationLimit(
  destination: OutputDestination,
  lastStage: boolean,
  env: PipelineEnvironment,
): number {
  if (destination.kind === "drop") return 0;
  const available =
    destination.kind === "diagnostic"
      ? env.errors.remaining
      : destination.kind === "output" && lastStage
        ? env.out.remaining
        : Number.MAX_SAFE_INTEGER;
  return Math.min(available, env.fs.retained.available);
}

function safeSum(left: number, right: number): number {
  return Math.min(Number.MAX_SAFE_INTEGER, left + right);
}

interface HeldChunk {
  readonly bytes: Uint8Array;
  release(): void;
}

function diagnosticsFor(
  diagnostics: Map<OutputDestination, HeldChunk[]>,
  destination: OutputDestination,
): HeldChunk[] {
  const existing = diagnostics.get(destination);
  if (existing !== undefined) return existing;
  const created: HeldChunk[] = [];
  diagnostics.set(destination, created);
  return created;
}

function releaseDiagnostics(
  diagnostics: Map<OutputDestination, HeldChunk[]>,
  except?: HeldChunk[],
): void {
  for (const chunks of diagnostics.values()) {
    if (chunks === except) continue;
    for (const chunk of chunks) chunk.release();
  }
}

function rethrowAfterCommandCleanup(
  error: unknown,
  expanded: ExpandedArguments,
  diagnostics: Map<OutputDestination, HeldChunk[]>,
): never {
  try {
    expanded.release();
  } catch {
    // Cleanup must not replace the command's observable failure.
  }
  for (const chunks of diagnostics.values()) {
    for (const held of chunks) {
      try {
        held.release();
      } catch {
        // Keep releasing later owners, then rethrow the command failure.
      }
    }
  }
  throw error;
}

/** Interleave diagnostics emitted while pulling a command with its stdout. */
function stageOutput(
  stdout: ByteStream,
  mergedErrors: HeldChunk[],
  releaseStage: () => void | Promise<void>,
  asyncRelease: boolean,
): ByteStream {
  return isAsyncByteStream(stdout) || asyncRelease
    ? new AsyncStageOutput(stdout, mergedErrors, releaseStage)
    : new SyncStageOutput(stdout, mergedErrors, releaseStage);
}

/** A generator whose unstarted `return()` still closes its source and reservations. */
class SyncStageOutput implements IterableIterator<Uint8Array, void, undefined> {
  #warningIndex = 0;
  #pending: IteratorResult<Uint8Array, void> | null = null;
  #releaseYielded: (() => void) | null = null;
  #closed = false;

  constructor(
    private readonly stdout: IterableIterator<Uint8Array, void, undefined>,
    private readonly mergedErrors: HeldChunk[],
    private readonly releaseStage: () => void | Promise<void>,
  ) {}

  [Symbol.iterator](): IterableIterator<Uint8Array, void, undefined> {
    return this;
  }

  [Symbol.dispose](): void {
    this.#finish(true);
  }

  next(..._args: [] | [undefined]): IteratorResult<Uint8Array, void> {
    this.#releaseLastYield();
    if (this.#closed) return { done: true, value: undefined };
    try {
      if (this.#pending === null) this.#pending = this.stdout.next();
      const warning = this.mergedErrors[this.#warningIndex];
      if (warning !== undefined) {
        this.#warningIndex++;
        this.#releaseYielded = warning.release;
        return { done: false, value: warning.bytes };
      }
      const pending = this.#pending;
      this.#pending = null;
      if (pending.done) {
        this.#finish(false);
        return { done: true, value: undefined };
      }
      return pending;
    } catch (error) {
      this.#finish(true);
      throw error;
    }
  }

  return(_value: undefined): IteratorResult<Uint8Array, void> {
    this.#finish(true);
    return { done: true, value: undefined };
  }

  throw(error: unknown): IteratorResult<Uint8Array, void> {
    this.#finish(true);
    throw error;
  }

  #releaseLastYield(): void {
    this.#releaseYielded?.();
    this.#releaseYielded = null;
  }

  #finish(closeSource: boolean): void {
    if (this.#closed) return;
    this.#closed = true;
    this.#releaseLastYield();
    let closeError: { readonly value: unknown } | null = null;
    try {
      if (closeSource) this.stdout.return?.();
    } catch (error) {
      closeError = { value: error };
    }
    for (; this.#warningIndex < this.mergedErrors.length; this.#warningIndex++) {
      this.mergedErrors[this.#warningIndex]?.release();
    }
    const released = this.releaseStage();
    if (released instanceof Promise) {
      throw new Error("synchronous stage cleanup became asynchronous");
    }
    if (closeError !== null) throw closeError.value;
  }
}

class AsyncStageOutput implements AsyncIterableIterator<Uint8Array, void, undefined> {
  #warningIndex = 0;
  #pending: IteratorResult<Uint8Array, void> | null = null;
  #releaseYielded: (() => void) | null = null;
  #closed = false;

  constructor(
    private readonly stdout: ByteStream,
    private readonly mergedErrors: HeldChunk[],
    private readonly releaseStage: () => void | Promise<void>,
  ) {}

  [Symbol.asyncIterator](): AsyncIterableIterator<Uint8Array, void, undefined> {
    return this;
  }

  async next(..._args: [] | [undefined]): Promise<IteratorResult<Uint8Array, void>> {
    this.#releaseLastYield();
    if (this.#closed) return { done: true, value: undefined };
    try {
      if (this.#pending === null) this.#pending = await this.stdout.next();
      const warning = this.mergedErrors[this.#warningIndex];
      if (warning !== undefined) {
        this.#warningIndex++;
        this.#releaseYielded = warning.release;
        return { done: false, value: warning.bytes };
      }
      const pending = this.#pending;
      this.#pending = null;
      if (pending.done) {
        await this.#finish(false);
        return { done: true, value: undefined };
      }
      return pending;
    } catch (error) {
      await this.#finish(true);
      throw error;
    }
  }

  async return(_value?: undefined): Promise<IteratorResult<Uint8Array, void>> {
    await this.#finish(true);
    return { done: true, value: undefined };
  }

  async throw(error: unknown): Promise<IteratorResult<Uint8Array, void>> {
    await this.#finish(true);
    throw error;
  }

  #releaseLastYield(): void {
    this.#releaseYielded?.();
    this.#releaseYielded = null;
  }

  async #finish(closeSource: boolean): Promise<void> {
    if (this.#closed) return;
    this.#closed = true;
    this.#releaseLastYield();
    try {
      if (closeSource) await this.stdout.return?.();
    } finally {
      for (; this.#warningIndex < this.mergedErrors.length; this.#warningIndex++) {
        this.mergedErrors[this.#warningIndex]?.release();
      }
      await this.releaseStage();
    }
  }
}

function* empty(): ByteStream {
  // A redirected stage contributes no stdout to the following pipe.
}

interface ExpandedArguments {
  readonly argv: readonly string[];
  release(): void;
}

function expandArguments(
  args: readonly Argument[],
  fs: BoundedFs,
  cwd: string,
  env?: Readonly<Record<string, string>>,
): ExpandedArguments {
  const out: string[] = [];
  const releases: Array<() => void> = [];
  const push = (value: string): void => {
    if (out.length >= ARGUMENT_COUNT_MAX) {
      throw new ShellLimitError(
        "arguments",
        `E2BIG: expanded argv exceeds ${ARGUMENT_COUNT_MAX} entries`,
      );
    }
    const valueBytes = utf8Bytes(value);
    releases.push(fs.retained.retain(valueBytes, "command arguments"));
    out.push(value);
  };

  try {
    for (const arg of args) {
      for (const field of expandWord(arg, env)) {
        const value = fieldText(field);
        if (!fieldHasGlob(field)) {
          push(value);
          continue;
        }
        let matched = false;
        for (const match of expandGlob(fieldPattern(field), fs, cwd)) {
          push(match);
          matched = true;
        }
        if (!matched) push(value);
      }
    }
  } catch (error) {
    for (const release of releases) release();
    throw error;
  }
  return {
    argv: out,
    release: () => {
      for (const release of releases) release();
    },
  };
}

function single(arg: Argument, fs: BoundedFs, cwd: string): string {
  const expanded = expandArguments([arg], fs, cwd);
  try {
    const first = expanded.argv[0];
    if (expanded.argv.length !== 1 || first === undefined) {
      throw new ShellSyntaxError("redirection", "ambiguous redirect", 0);
    }
    return first;
  } finally {
    expanded.release();
  }
}

interface FieldPart {
  readonly value: string;
  readonly globActive: boolean;
}

type ExpandedField = readonly FieldPart[];

function* expandWord(
  argument: Argument,
  env: Readonly<Record<string, string>> | undefined,
): Generator<ExpandedField> {
  let field: FieldPart[] = [];
  let preserveEmpty = false;

  for (const part of argument.parts) {
    if (part.kind === "literal") {
      if (part.value !== "") field.push({ value: part.value, globActive: false });
      preserveEmpty ||= part.quoted;
      continue;
    }
    if (part.kind === "glob") {
      field.push({ value: part.value, globActive: true });
      continue;
    }

    const value = environmentValue(env, part.name);
    if (part.quoted) {
      if (value !== "") field.push({ value, globActive: false });
      preserveEmpty = true;
      continue;
    }

    let start = 0;
    for (let index = 0; index <= value.length; index++) {
      if (index < value.length && !isIfsWhitespace(value.charAt(index))) continue;
      if (index > start) {
        field.push({ value: value.slice(start, index), globActive: true });
      }
      if (index < value.length) {
        if (field.length > 0 || preserveEmpty) yield field;
        field = [];
        preserveEmpty = false;
        while (isIfsWhitespace(value.charAt(index + 1))) index++;
      }
      start = index + 1;
    }
  }

  if (field.length > 0 || preserveEmpty) yield field;
}

function environmentValue(env: Readonly<Record<string, string>> | undefined, name: string): string {
  if (env === undefined || !Object.hasOwn(env, name)) return "";
  return env[name] ?? "";
}

function isIfsWhitespace(value: string): boolean {
  return value === " " || value === "\t" || value === "\n";
}

function fieldText(field: ExpandedField): string {
  let value = "";
  for (const part of field) value += part.value;
  return value;
}

function fieldPattern(field: ExpandedField): string {
  let pattern = "";
  for (const part of field) {
    pattern += part.globActive ? part.value : escapeGlob(part.value);
  }
  return pattern;
}

function fieldHasGlob(field: ExpandedField): boolean {
  return field.some((part) => part.globActive && /[*?[]/.test(part.value));
}

function escapeGlob(value: string): string {
  return value.replace(/[*?[]/g, (match) => `[${match}]`);
}

/**
 * Paths matching `pattern`, relative to `cwd` when the pattern is relative.
 *
 * The SQL GLOB narrows and JS decides, because SQLite's `*` crosses `/` and
 * a shell's does not. Over the ceiling the narrowing is dropped and the
 * subtree is scanned instead — correct either way, only slower.
 */
function* expandGlob(pattern: string, fs: BoundedFs, cwd: string): Generator<string> {
  const isAbsolute = pattern.startsWith("/");
  const absolute = isAbsolute ? normalize(pattern) : join(cwd, pattern);
  const fixed = absolute.slice(0, Math.max(0, absolute.search(/[*?[]/)));
  const root = fixed.includes("/") ? fixed.slice(0, fixed.lastIndexOf("/")) || "/" : "/";
  const matcher = compileGlob(absolute);
  const displayRoot = isAbsolute ? null : relativeGlobRoot(pattern);

  const sql = sqlGlobFor(absolute);
  if (sql !== null) {
    let after: string | undefined;
    for (;;) {
      const page = fs.globPage(
        root,
        sql,
        after === undefined ? { limit: PATH_PAGE_MAX } : { after, limit: PATH_PAGE_MAX },
      );
      for (const path of page.paths) {
        if (matcher.test(path)) yield projectGlobMatch(path, root, displayRoot);
      }
      if (page.next === null) return;
      after = page.next;
    }
  }

  let after: string | undefined;
  for (;;) {
    const page = fs.scan(
      root,
      after === undefined ? { limit: PATH_PAGE_MAX } : { after, limit: PATH_PAGE_MAX },
    );
    for (const entry of page) {
      if (matcher.test(entry.path)) yield projectGlobMatch(entry.path, root, displayRoot);
    }
    if (page.length < PATH_PAGE_MAX) return;
    after = page[page.length - 1]?.path;
    if (after === undefined) return;
  }
}

function relativeGlobRoot(pattern: string): string {
  const metacharacter = pattern.search(/[*?[]/);
  const fixed = pattern.slice(0, Math.max(0, metacharacter));
  const slash = fixed.lastIndexOf("/");
  return slash === -1 ? "" : fixed.slice(0, slash);
}

function projectGlobMatch(path: string, root: string, displayRoot: string | null): string {
  if (displayRoot === null) return path;
  const suffix = root === "/" ? path.slice(1) : path.slice(root.length + 1);
  if (displayRoot === "") return suffix;
  return `${displayRoot}/${suffix}`;
}

export function resolve(cwd: string, path: string): string {
  return path.startsWith("/") ? normalize(path) : join(cwd, path);
}

function* readWholeFile(fs: BoundedFs, path: string): ByteStream {
  const stat = fs.statTarget(path);
  if (stat === null || stat.type !== "file") {
    // Preserve the stable filesystem error shape from the read surface.
    yield fs.readFile(path);
    return;
  }
  let offset = 0;
  while (offset < stat.size) {
    if (fs.retained.available === 0) fs.retained.retain(1, "stdin redirect");
    const length = Math.min(
      fs.readBudget,
      Math.max(1, Math.floor(fs.retained.available / 2)),
      stat.size - offset,
    );
    const release = fs.retained.retain(length, "stdin redirect");
    try {
      yield fs.readRange(path, offset, length);
    } finally {
      release();
    }
    offset += length;
  }
}

async function writeStream(
  fs: BoundedFs,
  path: string,
  append: boolean,
  stream: ByteStream,
): Promise<void> {
  if (path === "/dev/null") {
    for await (const _chunk of stream) {
      // Drain so lazy status and diagnostics still settle.
    }
    return;
  }
  if (!isAsyncByteStream(stream)) {
    fs.writeFileStream(path, stream, { append });
    return;
  }
  const chunks: Uint8Array[] = [];
  const releases: Array<() => void> = [];
  try {
    for await (const chunk of stream) {
      releases.push(fs.retained.retain(chunk.length, "async redirect"));
      chunks.push(chunk.slice());
    }
    fs.writeFileStream(path, chunks, { append });
  } finally {
    for (const release of releases) release();
  }
}

/** stdout, with the ceiling enforced as it is written rather than after. */
class Sink {
  #chunks: Uint8Array[] = [];
  #size = 0;
  truncated = false;

  constructor(private readonly max: number) {}

  get remaining(): number {
    return this.max - this.#size;
  }

  writeBytes(chunk: Uint8Array): void {
    if (this.truncated) return;
    const room = this.max - this.#size;
    if (chunk.length <= room) {
      this.#chunks.push(chunk);
      this.#size += chunk.length;
      return;
    }
    if (room > 0) {
      this.#chunks.push(chunk.subarray(0, room));
      this.#size += room;
    }
    this.truncated = true;
  }

  async write(stream: ByteStream): Promise<void> {
    for await (const chunk of stream) {
      this.writeBytes(chunk);
      // Stop pulling: the source stops issuing queries with it.
      if (this.truncated) return;
    }
  }

  bytes(): Uint8Array {
    return concat(this.#chunks);
  }
}
