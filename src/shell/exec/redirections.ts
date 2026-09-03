import type { PlannedCommand } from "../plan/types.js";
import { resolve, single } from "./arguments.js";
import { type ByteStream, close, isAsyncByteStream } from "./bytes.js";
import type { BoundedFs } from "./context.js";
import type { PipelineEnvironment } from "./execution-types.js";
import type {
  FileDestination,
  HeldChunk,
  OutputDestination,
  ResolvedRedirections,
} from "./routing-types.js";
import { diagnosticsFor, releaseDiagnostics, stageOutput } from "./stage-output.js";

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

export function resolveRedirections(
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
    await writeStream(fs, file.path, file.append, empty());
    file.opened = true;
  }
}

export async function routeStageOutput(
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
