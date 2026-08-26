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
const PATH_PAGE_MAX = 1_000;
const ENCODER = new TextEncoder();

export interface ExecOptions {
  readonly fs: Filesystem;
  readonly cwd: string;
  readonly commands: ReadonlyMap<string, Command>;
  readonly limits?: Limits;
}

export interface ExecResult {
  readonly stdout: Uint8Array;
  readonly stderr: Uint8Array;
  readonly exitCode: number;
  /** The working directory after the run — `cd` is a builtin. */
  readonly cwd: string;
  /** True when `maxOutputBytes` stopped the output early. */
  readonly truncated: boolean;
  readonly operations: number;
}

export function execute(plan: Plan, options: ExecOptions): ExecResult {
  const limits = options.limits ?? DEFAULT_LIMITS;
  const fs = new BoundedFs(options.fs, limits);
  const out = new Sink(limits.maxOutputBytes);
  const errors = new Sink(limits.maxOutputBytes);
  let cwd = normalize(options.cwd);
  let exitCode = 0;
  let previousConnector: "&&" | "||" | ";" | null = null;

  try {
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
  };
}

interface PipelineEnvironment {
  readonly fs: BoundedFs;
  readonly cwd: string;
  readonly commands: ReadonlyMap<string, Command>;
  readonly out: Sink;
  readonly errors: Sink;
  chdir(path: string): void;
}

function runPipeline(pipeline: PlannedPipeline, env: PipelineEnvironment): number {
  let stream: ByteStream | null = null;
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
        try {
          const path = resolve(env.cwd, single(planned.stdin, env.fs, env.cwd));
          stream = readWholeFile(env.fs, path);
        } catch (error) {
          expanded.release();
          throw error;
        }
      }

      const mergedErrors: HeldChunk[] = [];
      const context = commandContext(planned, argv, stream, pipeline.limitHint, env, mergedErrors);
      let produced: CommandResult;
      try {
        produced = command(context);
      } catch (error) {
        expanded.release();
        throw error;
      }
      const output = stageOutput(produced.stdout, mergedErrors, expanded.release);
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
  argv: readonly string[],
  stdin: ByteStream | null,
  limitHint: number | null,
  env: PipelineEnvironment,
  mergedErrors: HeldChunk[],
): CommandContext {
  const context: CommandContext = {
    fs: env.fs,
    cwd: env.cwd,
    argv,
    stdin,
    limitHint,
    warn: (message: string) => {
      if (planned.stderr === "drop") return;
      const bytes = line(`${planned.name}: ${message}`);
      // `2>&1` joins this stage before any downstream pipe consumes it.
      if (planned.stderr === "merge") {
        mergedErrors.push({
          bytes,
          release: env.fs.retained.retain(bytes.length, "merged stderr"),
        });
      } else env.errors.writeBytes(bytes);
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

interface HeldChunk {
  readonly bytes: Uint8Array;
  release(): void;
}

/** Interleave diagnostics emitted while pulling a command with its stdout. */
function* stageOutput(
  stdout: ByteStream,
  mergedErrors: HeldChunk[],
  releaseStage: () => void,
): ByteStream {
  let warningIndex = 0;
  let done = false;
  try {
    for (;;) {
      const next = stdout.next();
      while (warningIndex < mergedErrors.length) {
        const warning = mergedErrors[warningIndex];
        warningIndex++;
        if (warning === undefined) continue;
        try {
          yield warning.bytes;
        } finally {
          warning.release();
        }
      }
      if (next.done) {
        done = true;
        return;
      }
      yield next.value;
    }
  } finally {
    for (; warningIndex < mergedErrors.length; warningIndex++) {
      mergedErrors[warningIndex]?.release();
    }
    if (!done) stdout.return();
    releaseStage();
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
