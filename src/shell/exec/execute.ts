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
import { type ByteStream, concat, line } from "./bytes.js";
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
const ARGUMENT_BYTES_MAX = 1_000_000;
const STDIN_BYTES_MAX = 1024 * 1024;
const ENV_ENTRY_MAX = 256;
const ENV_BYTES_MAX = 1024 * 1024;
const PATH_PAGE_MAX = 1_000;
// Filesystem.writeFileStream enforces this atomically before publishing a redirect.
const ATOMIC_REDIRECT_BYTES_MAX = 96 * 1024 * 1024;
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

export function execute(plan: Plan, options: ExecOptions): ExecResult {
  const limits = options.limits ?? DEFAULT_LIMITS;
  const fs = new BoundedFs(options.fs, limits);
  const out = new Sink(limits.maxOutputBytes);
  const errors = new Sink(limits.maxOutputBytes);
  let cwd = normalize(options.cwd);
  let exitCode = 0;
  let previousConnector: "&&" | "||" | ";" | null = null;
  let runInput: RunInputOwner | null = null;

  try {
    try {
      runInput = prepareRunInput(options.stdin, options.env, fs);
      for (const step of plan.steps) {
        const selected =
          previousConnector === null ||
          previousConnector === ";" ||
          (previousConnector === "&&" ? exitCode === 0 : exitCode !== 0);
        if (selected) {
          exitCode = runPipeline(step.pipeline, {
            fs,
            cwd,
            commands: options.commands,
            out,
            errors,
            inputs: runInput,
            chdir: (path: string) => {
              cwd = path;
            },
          });
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
      truncated: out.truncated || errors.truncated,
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
  chdir(path: string): void;
}

function runPipeline(pipeline: PlannedPipeline, env: PipelineEnvironment): number {
  let stream: ByteStream | null = env.inputs?.borrow() ?? null;
  const statuses: Array<() => number> = [];
  let settled = false;

  try {
    for (let index = 0; index < pipeline.commands.length; index++) {
      const planned = pipeline.commands[index];
      if (planned === undefined) continue;

      const command = env.commands.get(planned.name);
      if (command === undefined) {
        env.errors.writeBytes(line(`kompjutr: ${planned.name}: command not found`));
        return 127;
      }

      const expanded = expandArguments(planned.args, env.fs, env.cwd);
      const argv = expanded.argv;

      if (planned.stdin !== null) {
        const priorInput = stream;
        stream = null;
        let priorClosed = false;
        const closePrior = (): void => {
          if (priorClosed) return;
          priorClosed = true;
          priorInput?.return();
        };
        try {
          const path = resolve(env.cwd, single(planned.stdin, env.fs, env.cwd));
          closePrior();
          stream = readWholeFile(env.fs, path);
        } catch (error) {
          try {
            closePrior();
          } finally {
            expanded.release();
          }
          throw error;
        }
      }

      const mergedErrors: HeldChunk[] = [];
      const stageInput = stream;
      const context = commandContext(
        planned,
        index === pipeline.commands.length - 1,
        argv,
        stageInput,
        pipeline.limitHint,
        env,
        mergedErrors,
      );
      let produced: CommandResult;
      try {
        produced = command(context);
      } catch (error) {
        expanded.release();
        throw error;
      }
      const output = stageOutput(produced.stdout, mergedErrors, () => {
        try {
          stageInput?.return();
        } finally {
          expanded.release();
        }
      });
      if (planned.stdout === null) {
        stream = output;
      } else {
        let target: string;
        try {
          target = resolve(env.cwd, single(planned.stdout.path, env.fs, env.cwd));
        } catch (error) {
          output.return();
          throw error;
        }
        try {
          writeStream(env.fs, target, planned.stdout.append, protectUpstream(output));
        } catch (error) {
          output.return();
          if (error instanceof UpstreamError) throw error.original;
          if (
            error instanceof Error &&
            "code" in error &&
            typeof error.code === "string" &&
            error.code.startsWith("E")
          ) {
            env.errors.writeBytes(line(`${planned.name}: ${error.message}`));
            return 1;
          }
          throw error;
        }
        stream = empty();
      }
      statuses.push(produced.status);
    }

    if (stream === null) {
      settled = true;
      return 0;
    }
    env.out.write(stream);
    settled = true;

    // A pipeline's status is its last stage's, as in bash without pipefail.
    const last = statuses[statuses.length - 1];
    return last === undefined ? 0 : last();
  } finally {
    if (!settled) stream?.return();
  }
}

/** Own caller inputs and their retained-memory reservation for one complete run. */
export class RunInputOwner {
  #closed = false;

  constructor(
    private readonly source: ByteStream | null,
    readonly env: Readonly<Record<string, string>> | undefined,
    private readonly release: () => void,
  ) {}

  /** A pipeline may close its borrow without closing the run-owned cursor. */
  borrow(): ByteStream | null {
    const source = this.source;
    if (source === null) return null;
    return (function* (): ByteStream {
      for (;;) {
        const next = source.next();
        if (next.done) return;
        yield next.value;
      }
    })();
  }

  close(): void {
    if (this.#closed) return;
    this.#closed = true;
    try {
      this.source?.return();
    } finally {
      this.release();
    }
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
    return new RunInputOwner(
      stdinSnapshot === null ? null : singleChunk(stdinSnapshot),
      envSnapshot,
      release,
    );
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
    bytes = addUtf8Bytes(bytes, key, ENV_BYTES_MAX, "caller env");
    bytes = addUtf8Bytes(bytes, value, ENV_BYTES_MAX, "caller env");
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
    bytes = addUtf8Bytes(bytes, key, measured.bytes, "caller env snapshot");
    bytes = addUtf8Bytes(bytes, value, measured.bytes, "caller env snapshot");
    entries.push([key, value]);
  }
  return Object.freeze(Object.fromEntries(entries));
}

function addUtf8Bytes(current: number, value: string, maximum: number, label: string): number {
  const bytes = boundedUtf8Bytes(value, maximum - current);
  if (bytes === null) {
    throw new ShellLimitError("arguments", `${label} exceeds ${maximum} bytes`);
  }
  return current + bytes;
}

function stdinBytes(stdin: Uint8Array | string): number {
  if (typeof stdin !== "string") {
    if (!(stdin instanceof Uint8Array)) {
      throw new ShellLimitError("arguments", "caller stdin must be a string or Uint8Array");
    }
    if (stdin.byteLength > STDIN_BYTES_MAX) {
      throw new ShellLimitError("arguments", `caller stdin exceeds ${STDIN_BYTES_MAX} bytes`);
    }
    return stdin.byteLength;
  }

  const bytes = boundedUtf8Bytes(stdin, STDIN_BYTES_MAX);
  if (bytes === null) {
    throw new ShellLimitError("arguments", `caller stdin exceeds ${STDIN_BYTES_MAX} bytes`);
  }
  return bytes;
}

/** Match TextEncoder's replacement of unpaired surrogates without allocating. */
function boundedUtf8Bytes(value: string, maximum: number): number | null {
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
    if (bytes > maximum) return null;
  }
  return bytes;
}

function* singleChunk(bytes: Uint8Array): ByteStream {
  if (bytes.length > 0) yield bytes;
}

class UpstreamError extends Error {
  constructor(readonly original: unknown) {
    super("redirect upstream failed");
  }
}

function* protectUpstream(stream: ByteStream): ByteStream {
  try {
    yield* stream;
  } catch (error) {
    throw new UpstreamError(error);
  }
}

function commandContext(
  planned: PlannedCommand,
  lastStage: boolean,
  argv: readonly string[],
  stdin: ByteStream | null,
  limitHint: number | null,
  env: PipelineEnvironment,
  mergedErrors: HeldChunk[],
): CommandContext {
  const output = commandOutput(planned, lastStage, env);
  const diagnostic = (bytes: Uint8Array): void => {
    if (planned.stderr === "drop" || bytes.length === 0) return;
    if (planned.stderr === "merge") {
      mergedErrors.push({
        bytes,
        release: env.fs.retained.retain(bytes.length, "merged stderr"),
      });
    } else env.errors.writeBytes(bytes);
  };
  const context: CommandContext = {
    fs: env.fs,
    cwd: env.cwd,
    argv,
    stdin,
    env: env.inputs?.env,
    limitHint,
    output,
    diagnostic,
    warn: (message: string) => {
      if (planned.stderr === "drop") return;
      const bytes = line(`${planned.name}: ${message}`);
      diagnostic(bytes);
    },
    chdir: env.chdir,
    invoke: (name: string, subArgv: readonly string[]): CommandResult | null => {
      const command = env.commands.get(name);
      if (command === undefined) return null;
      // No stdin and no demand hint: the sub-invocation's arguments already
      // carry everything it is meant to see.
      return command({ ...context, argv: subArgv, stdin: null, limitHint: null });
    },
  };
  return context;
}

function commandOutput(
  planned: PlannedCommand,
  lastStage: boolean,
  env: PipelineEnvironment,
): CommandContext["output"] {
  const destination = planned.stdout !== null ? "redirect" : lastStage ? "terminal" : "pipeline";
  const destinationBytes =
    destination === "terminal"
      ? env.out.remaining
      : destination === "redirect"
        ? ATOMIC_REDIRECT_BYTES_MAX
        : Number.MAX_SAFE_INTEGER;
  const maxStdoutBytes = Math.min(destinationBytes, env.fs.retained.available);
  const discardStderr = planned.stderr === "drop";
  const maxStderrBytes = discardStderr
    ? 0
    : planned.stderr === "merge"
      ? maxStdoutBytes
      : env.errors.remaining;
  const maxCombinedOutputBytes =
    discardStderr || planned.stderr === "merge"
      ? maxStdoutBytes
      : safeSum(maxStdoutBytes, maxStderrBytes);
  return {
    destination,
    maxStdoutBytes,
    maxStderrBytes,
    maxCombinedOutputBytes,
    discardStderr,
  };
}

function safeSum(left: number, right: number): number {
  return Math.min(Number.MAX_SAFE_INTEGER, left + right);
}

interface HeldChunk {
  readonly bytes: Uint8Array;
  release(): void;
}

/** Interleave diagnostics emitted while pulling a command with its stdout. */
function stageOutput(
  stdout: ByteStream,
  mergedErrors: HeldChunk[],
  releaseStage: () => void,
): ByteStream {
  return new StageOutput(stdout, mergedErrors, releaseStage);
}

/** A generator whose unstarted `return()` still closes its source and reservations. */
class StageOutput implements ByteStream {
  #warningIndex = 0;
  #pending: IteratorResult<Uint8Array, void> | null = null;
  #releaseYielded: (() => void) | null = null;
  #closed = false;

  constructor(
    private readonly stdout: ByteStream,
    private readonly mergedErrors: HeldChunk[],
    private readonly releaseStage: () => void,
  ) {}

  [Symbol.iterator](): ByteStream {
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
    try {
      if (closeSource) this.stdout.return();
    } finally {
      for (; this.#warningIndex < this.mergedErrors.length; this.#warningIndex++) {
        this.mergedErrors[this.#warningIndex]?.release();
      }
      this.releaseStage();
    }
  }
}

function* empty(): ByteStream {
  // A redirected stage contributes no stdout to the following pipe.
}

/**
 * Expand the arguments a command sees. A literal passes through; a glob
 * becomes zero or more paths.
 *
 * A glob that matches nothing is passed through as its own text, which is
 * bash's default (`nullglob` off) and is what makes `ls *.md` in an empty
 * directory report "no such file" rather than listing everything.
 */
interface ExpandedArguments {
  readonly argv: readonly string[];
  release(): void;
}

function expandArguments(args: readonly Argument[], fs: BoundedFs, cwd: string): ExpandedArguments {
  const out: string[] = [];
  const releases: Array<() => void> = [];
  let bytes = 0;
  const push = (value: string): void => {
    const valueBytes = ENCODER.encode(value).byteLength;
    const nextBytes = bytes + valueBytes;
    if (out.length >= ARGUMENT_COUNT_MAX || nextBytes > ARGUMENT_BYTES_MAX) {
      throw new ShellLimitError(
        "arguments",
        `E2BIG: expanded argv exceeds ${ARGUMENT_COUNT_MAX} entries or ${ARGUMENT_BYTES_MAX} bytes`,
      );
    }
    releases.push(fs.retained.retain(valueBytes, "command arguments"));
    out.push(value);
    bytes = nextBytes;
  };

  try {
    for (const arg of args) {
      if (arg.kind === "literal") {
        push(arg.value);
        continue;
      }
      let matched = false;
      for (const match of expandGlob(arg.pattern, fs, cwd)) {
        push(match);
        matched = true;
      }
      if (!matched) push(arg.pattern);
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

/**
 * Paths matching `pattern`, relative to `cwd` when the pattern is relative.
 *
 * The SQL GLOB narrows and JS decides, because SQLite's `*` crosses `/` and
 * a shell's does not. Over the ceiling the narrowing is dropped and the
 * subtree is scanned instead — correct either way, only slower.
 */
function* expandGlob(pattern: string, fs: BoundedFs, cwd: string): Generator<string> {
  const absolute = pattern.startsWith("/") ? normalize(pattern) : join(cwd, pattern);
  const fixed = absolute.slice(0, Math.max(0, absolute.search(/[*?[]/)));
  const root = fixed.includes("/") ? fixed.slice(0, fixed.lastIndexOf("/")) || "/" : "/";
  const matcher = compileGlob(absolute);

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
        if (matcher.test(path)) yield path;
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
      if (matcher.test(entry.path)) yield entry.path;
    }
    if (page.length < PATH_PAGE_MAX) return;
    after = page[page.length - 1]?.path;
    if (after === undefined) return;
  }
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

function writeStream(fs: BoundedFs, path: string, append: boolean, stream: ByteStream): void {
  if (path === "/dev/null") {
    for (const _chunk of stream) {
      // Drain so lazy status and diagnostics still settle.
    }
    return;
  }
  fs.writeFileStream(path, stream, { append });
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

  write(stream: ByteStream): void {
    for (const chunk of stream) {
      this.writeBytes(chunk);
      // Stop pulling: the source stops issuing queries with it.
      if (this.truncated) return;
    }
  }

  bytes(): Uint8Array {
    return concat(this.#chunks);
  }
}
