import type { PlannedRedirection } from "../plan/types.js";
import { ExpansionFailure, expandTarget, expandText, resolve } from "./arguments.js";
import { type ByteStream, close, isAsyncByteStream } from "./bytes.js";
import type { DiagnosticPort } from "./compound/frame.js";
import type { BoundedFs } from "./context.js";
import { strerror } from "./errno.js";
import { DROPPED, type ShellExpansion } from "./expansion/shell-expansion.js";
import type {
  FileDestination,
  HeldChunk,
  OutputDestination,
  ResolvedRedirections,
  StdinSource,
} from "./routing-types.js";
import { diagnosticsFor, releaseDiagnostics, stageOutput } from "./stage-output.js";

const ENCODER = new TextEncoder();

/** A redirection target the filesystem refused; keeps the error's `code`. */
export class RedirectionFailure extends Error {
  readonly code: string;

  constructor(
    readonly operand: string,
    failure: Error & { readonly code: string },
  ) {
    super(failure.message);
    this.code = failure.code;
  }
}

/** Bash names a refused target as typed; other failures keep the command's prefix. */
export function redirectionDiagnostic(
  error: Error & { readonly code: string },
  label: { readonly name: string; readonly line: number },
): string {
  if (error instanceof RedirectionFailure) {
    return `bash: line ${label.line}: ${error.operand}: ${strerror(error)}`;
  }
  return `${label.name}: ${error.message}`;
}

export class UpstreamError extends Error {
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

/**
 * An unquoted target expanded to no field or several; Bash names it as typed,
 * on the stderr bound so far: the shell's own, or dropped by `2>/dev/null`.
 */
export class AmbiguousRedirect extends Error {
  constructor(
    readonly spelling: string,
    readonly dropped: boolean,
  ) {
    super(`${spelling}: ambiguous redirect`);
  }
}

/**
 * A target that could not expand. Bash ends the shell for an output target
 * but only fails the command for an input target or here-text.
 */
export class TargetExpansionFailure extends Error {
  constructor(
    readonly failure: ExpansionFailure,
    readonly fatal: boolean,
  ) {
    super(failure.message);
  }
}

/**
 * Binds descriptors left to right. A substitution in a target, and an
 * ambiguous target, report to the stderr bound at that point; the planner
 * admits only the shell's own stderr or `2>/dev/null` there.
 */
export async function resolveRedirections(
  planned: { readonly redirections: readonly PlannedRedirection[] },
  expansion: ShellExpansion,
): Promise<ResolvedRedirections> {
  const output: OutputDestination = { kind: "output" };
  const diagnostic: OutputDestination = { kind: "diagnostic" };
  let stdin: StdinSource | null = null;
  let stdout: OutputDestination = output;
  let stderr: OutputDestination = diagnostic;
  const files: FileDestination[] = [];
  const cwd = expansion.cwd;

  for (const redirection of planned.redirections) {
    if (redirection.kind === "duplicate") {
      const destination: OutputDestination = redirection.targetFd === 1 ? stdout : stderr;
      if (redirection.fd === 1) stdout = destination;
      else stderr = destination;
      continue;
    }
    const bound: ShellExpansion = stderr.kind === "drop" ? expansion.reporting(DROPPED) : expansion;
    if (redirection.kind === "text") {
      const text = await expandOrFail(expandText(redirection.text, bound), false);
      stdin = { kind: "text", text: redirection.newline ? `${text}\n` : text };
      continue;
    }
    const operand: string | null = await expandOrFail(
      expandTarget(redirection.path, bound),
      redirection.kind === "write",
    );
    if (operand === null) throw new AmbiguousRedirect(redirection.spelling, stderr.kind === "drop");
    if (operand === "") {
      throw new RedirectionFailure(
        operand,
        Object.assign(new Error("no such file or directory"), { code: "ENOENT" }),
      );
    }
    const path = resolve(cwd, operand);
    if (redirection.kind === "read") {
      stdin = path === "/dev/null" ? { kind: "text", text: "" } : { kind: "file", path };
      continue;
    }
    const destination: OutputDestination =
      path === "/dev/null"
        ? { kind: "drop" }
        : {
            kind: "file",
            path,
            operand,
            append: redirection.append,
            opened: false,
          };
    if (destination.kind === "file") files.push(destination);
    if (redirection.fd === 1) stdout = destination;
    else stderr = destination;
  }

  return { stdin, output, stdout, stderr, files };
}

async function expandOrFail<T>(expanded: Promise<T>, fatal: boolean): Promise<T> {
  try {
    return await expanded;
  } catch (error) {
    if (error instanceof ExpansionFailure) throw new TargetExpansionFailure(error, fatal);
    throw error;
  }
}

export async function openRedirectionFiles(
  redirections: ResolvedRedirections,
  fs: BoundedFs,
): Promise<void> {
  const deferred =
    redirections.stdout.kind === "file"
      ? redirections.files[redirections.files.length - 1]
      : undefined;
  for (const file of redirections.files) {
    if (file === deferred) continue;
    await writeFile(fs, file, file.append, empty());
    file.opened = true;
  }
}

export async function routeStageOutput(
  stdout: ByteStream,
  redirections: ResolvedRedirections,
  diagnostics: Map<OutputDestination, HeldChunk[]>,
  fs: BoundedFs,
  stderr: DiagnosticPort,
): Promise<ByteStream> {
  if (redirections.stdout.kind === "output") {
    const sideFiles = activeSideFiles(redirections);
    if (sideFiles.length === 0) return stdout;
    return outputWithSideFiles(stdout, sideFiles, diagnostics, fs);
  }

  if (redirections.stdout.kind === "diagnostic") {
    await stderr.write(stdout);
  } else if (redirections.stdout.kind === "drop") {
    await drain(stdout);
  } else {
    await writeFile(
      fs,
      redirections.stdout,
      redirections.stdout.append || redirections.stdout.opened,
      protectUpstream(stdout),
    );
    redirections.stdout.opened = true;
  }

  await flushSideFiles(activeSideFiles(redirections), diagnostics, fs);
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
    await writeFile(
      fs,
      file,
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

export function isFilesystemError(error: unknown): error is Error & { readonly code: string } {
  return (
    error instanceof Error &&
    "code" in error &&
    typeof error.code === "string" &&
    error.code.startsWith("E")
  );
}

export function* readWholeFile(fs: BoundedFs, path: string): ByteStream {
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

/** A here-document or here-string body, reserved against the retained budget while live. */
export function* readText(fs: BoundedFs, text: string): ByteStream {
  const bytes = ENCODER.encode(text);
  const release = fs.retained.retain(bytes.length, "here-document");
  try {
    if (bytes.length > 0) yield bytes;
  } finally {
    release();
  }
}

async function writeFile(
  fs: BoundedFs,
  file: FileDestination,
  append: boolean,
  stream: ByteStream,
): Promise<void> {
  try {
    await writeStream(fs, file.path, append, stream);
  } catch (error) {
    if (isFilesystemError(error)) throw new RedirectionFailure(file.operand, error);
    throw error;
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

function* empty(): ByteStream {
  // A redirected stage contributes no stdout to the following pipe.
}
