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
import { type ByteStream, concat, encode, line } from "./bytes.js";
import {
  BoundedFs,
  type Command,
  type CommandContext,
  DEFAULT_LIMITS,
  type Limits,
  ShellLimitError,
} from "./context.js";
import { compileGlob, sqlGlobFor } from "./glob.js";

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
  const errors: Uint8Array[] = [];
  let cwd = normalize(options.cwd);
  let exitCode = 0;

  try {
    for (const step of plan.steps) {
      const run = runPipeline(step.pipeline, {
        fs,
        cwd,
        commands: options.commands,
        out,
        errors,
        chdir: (path: string) => {
          cwd = path;
        },
      });
      exitCode = run;

      if (step.connector === "&&" && exitCode !== 0) break;
      if (step.connector === "||" && exitCode === 0) break;
    }
  } catch (error) {
    if (error instanceof ShellLimitError || error instanceof ShellSyntaxError) {
      errors.push(line(`kompjutr: ${error.message}`));
      exitCode = 2;
    } else {
      throw error;
    }
  }

  return {
    stdout: out.bytes(),
    stderr: concat(errors),
    exitCode,
    cwd,
    truncated: out.truncated,
    operations: fs.operations,
  };
}

interface PipelineEnvironment {
  readonly fs: BoundedFs;
  readonly cwd: string;
  readonly commands: ReadonlyMap<string, Command>;
  readonly out: Sink;
  readonly errors: Uint8Array[];
  chdir(path: string): void;
}

function runPipeline(pipeline: PlannedPipeline, env: PipelineEnvironment): number {
  let stream: ByteStream | null = null;
  const statuses: Array<() => number> = [];
  let redirected: { path: string; append: boolean } | null = null;

  for (let index = 0; index < pipeline.commands.length; index++) {
    const planned = pipeline.commands[index];
    if (planned === undefined) continue;

    const command = env.commands.get(planned.name);
    if (command === undefined) {
      env.errors.push(line(`kompjutr: ${planned.name}: command not found`));
      return 127;
    }

    const argv = expandArguments(planned.args, env.fs, env.cwd);

    if (planned.stdin !== null) {
      const path = resolve(env.cwd, single(planned.stdin, env.fs, env.cwd));
      stream = readWholeFile(env.fs, path);
    }

    const isLast = index === pipeline.commands.length - 1;
    if (isLast && planned.stdout !== null) {
      redirected = {
        path: resolve(env.cwd, single(planned.stdout.path, env.fs, env.cwd)),
        append: planned.stdout.append,
      };
    }

    const context = commandContext(planned, argv, stream, pipeline.limitHint, env);
    const produced = command(context);
    stream = produced.stdout;
    statuses.push(produced.status);
  }

  if (stream === null) return 0;

  if (redirected !== null) {
    writeStream(env.fs, redirected.path, redirected.append, stream);
  } else {
    env.out.write(stream);
  }

  // A pipeline's status is its last stage's, as in bash without pipefail.
  const last = statuses[statuses.length - 1];
  return last === undefined ? 0 : last();
}

function commandContext(
  planned: PlannedCommand,
  argv: readonly string[],
  stdin: ByteStream | null,
  limitHint: number | null,
  env: PipelineEnvironment,
): CommandContext {
  return {
    fs: env.fs,
    cwd: env.cwd,
    argv,
    stdin,
    limitHint,
    warn: (message: string) => {
      if (planned.stderr === "drop") return;
      const bytes = line(`${planned.name}: ${message}`);
      // `2>&1` puts the diagnostic in stdout, in order with the output.
      if (planned.stderr === "merge") env.out.writeBytes(bytes);
      else env.errors.push(bytes);
    },
    chdir: env.chdir,
  };
}

/**
 * Expand the arguments a command sees. A literal passes through; a glob
 * becomes zero or more paths.
 *
 * A glob that matches nothing is passed through as its own text, which is
 * bash's default (`nullglob` off) and is what makes `ls *.md` in an empty
 * directory report "no such file" rather than listing everything.
 */
function expandArguments(args: readonly Argument[], fs: BoundedFs, cwd: string): readonly string[] {
  const out: string[] = [];
  for (const arg of args) {
    if (arg.kind === "literal") {
      out.push(arg.value);
      continue;
    }
    const matches = expandGlob(arg.pattern, fs, cwd);
    if (matches.length === 0) out.push(arg.pattern);
    else out.push(...matches);
  }
  return out;
}

function single(arg: Argument, fs: BoundedFs, cwd: string): string {
  const expanded = expandArguments([arg], fs, cwd);
  const first = expanded[0];
  if (expanded.length !== 1 || first === undefined) {
    throw new ShellSyntaxError("redirection", "ambiguous redirect", 0);
  }
  return first;
}

/**
 * Paths matching `pattern`, relative to `cwd` when the pattern is relative.
 *
 * The SQL GLOB narrows and JS decides, because SQLite's `*` crosses `/` and
 * a shell's does not. Over the ceiling the narrowing is dropped and the
 * subtree is scanned instead — correct either way, only slower.
 */
function expandGlob(pattern: string, fs: BoundedFs, cwd: string): string[] {
  const absolute = pattern.startsWith("/") ? normalize(pattern) : join(cwd, pattern);
  const fixed = absolute.slice(0, Math.max(0, absolute.search(/[*?[]/)));
  const root = fixed.includes("/") ? fixed.slice(0, fixed.lastIndexOf("/")) || "/" : "/";
  const matcher = compileGlob(absolute);

  const sql = sqlGlobFor(absolute);
  if (sql !== null) {
    return fs.glob(root, sql, { limit: 10_000 }).filter((path) => matcher.test(path));
  }

  const found: string[] = [];
  let after: string | undefined;
  for (;;) {
    const page = fs.scan(root, after === undefined ? { limit: 1_000 } : { after, limit: 1_000 });
    for (const entry of page) {
      if (matcher.test(entry.path)) found.push(entry.path);
    }
    if (page.length < 1_000) break;
    after = page[page.length - 1]?.path;
    if (after === undefined) break;
  }
  return found;
}

export function resolve(cwd: string, path: string): string {
  return path.startsWith("/") ? normalize(path) : join(cwd, path);
}

function* readWholeFile(fs: BoundedFs, path: string): ByteStream {
  yield fs.readFile(path);
}

function writeStream(fs: BoundedFs, path: string, append: boolean, stream: ByteStream): void {
  const chunks = [...stream];
  const bytes = append ? concat([existing(fs, path), ...chunks]) : concat(chunks);
  fs.writeFiles([{ path, bytes }]);
}

function existing(fs: BoundedFs, path: string): Uint8Array {
  const stat = fs.stat(path);
  return stat === null ? encode("") : fs.readFile(path);
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
