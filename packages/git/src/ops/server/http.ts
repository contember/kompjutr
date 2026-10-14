import { errorCode, GitError } from "../../common/errors.js";
import { parseReceivePackRequest, parseUploadPackRequest } from "../../protocol/server/index.js";
import { abortable, abortedError, throwIfAborted } from "../../protocol/stream.js";
import type { SharedRepoStore } from "../../store/index.js";
import { requireCompleteRepository } from "../../store/transfer/lifetime.js";
import { discoverServer } from "./discovery.js";
import { receivePack } from "./receive.js";
import type { GitServerOptions, ServerRuntime } from "./runtime.js";
import { uploadPack } from "./upload.js";

const NO_CACHE = {
  "Cache-Control": "no-cache, no-store, must-revalidate",
  Pragma: "no-cache",
  Expires: "0",
};

function failure(
  status: number,
  message: string,
  headers: Readonly<Record<string, string>> = {},
): Response {
  return new Response(`${message}\n`, {
    status,
    headers: { ...NO_CACHE, "Content-Type": "text/plain; charset=utf-8", ...headers },
  });
}

async function* requestBody(request: Request): AsyncGenerator<Uint8Array> {
  const body =
    request.headers.get("Content-Encoding")?.trim().toLowerCase() === "gzip"
      ? request.body?.pipeThrough(new DecompressionStream("gzip"))
      : request.body;
  const reader = body?.getReader();
  if (reader === undefined) return;
  try {
    for (;;) {
      const next = await abortable(reader.read(), request.signal);
      if (next.done) return;
      yield next.value;
    }
  } catch (error) {
    if (errorCode(error) === "EABORTED") throw error;
    throw new GitError("EBADREQUEST", "invalid Git request body encoding", { cause: error });
  } finally {
    try {
      await reader.cancel();
    } catch {
      // Preserve the body/parser failure when cancellation repeats a stream error.
    } finally {
      reader.releaseLock();
    }
  }
}

function responseBody(
  source: Iterable<Uint8Array> | AsyncIterable<Uint8Array>,
  signal: AbortSignal,
): ReadableStream<Uint8Array> {
  const iterator =
    Symbol.asyncIterator in source ? source[Symbol.asyncIterator]() : source[Symbol.iterator]();
  let finished = false;
  let release: Promise<unknown> | undefined;
  const close = () => {
    signal.removeEventListener("abort", aborted);
    release ??= Promise.resolve().then(() => iterator.return?.());
    return release;
  };
  let controller: ReadableStreamDefaultController<Uint8Array>;
  const aborted = () => {
    if (finished) return;
    finished = true;
    controller.error(abortedError(signal));
    void close().catch(() => {});
  };
  return new ReadableStream<Uint8Array>(
    {
      start(stream) {
        controller = stream;
        signal.addEventListener("abort", aborted, { once: true });
        if (signal.aborted) aborted();
      },
      async pull(stream) {
        try {
          throwIfAborted(signal);
          const next = await iterator.next();
          if (finished) return;
          if (next.done === true) {
            finished = true;
            await close();
            stream.close();
          } else stream.enqueue(next.value);
        } catch (error) {
          if (!finished) {
            finished = true;
            stream.error(error);
          }
          await close();
        }
      },
      async cancel() {
        finished = true;
        await close();
      },
    },
    { highWaterMark: 0 },
  );
}

function result(
  source: Iterable<Uint8Array> | AsyncIterable<Uint8Array>,
  contentType: string,
  signal: AbortSignal,
): Response {
  return new Response(responseBody(source, signal), {
    headers: { ...NO_CACHE, "Content-Type": contentType },
  });
}

export async function serveGitRequest(
  store: SharedRepoStore,
  options: GitServerOptions,
  request: Request,
): Promise<Response> {
  try {
    const url = new URL(request.url);
    const discovery = url.pathname === "/info/refs";
    const service = discovery ? url.searchParams.get("service") : url.pathname.slice(1);
    if (!discovery && service !== "git-upload-pack" && service !== "git-receive-pack")
      return failure(404, "Unknown Git endpoint");
    const method = discovery ? "GET" : "POST";
    if (request.method !== method)
      return failure(405, "Unsupported Git request method", { Allow: method });
    if (service !== "git-upload-pack" && service !== "git-receive-pack")
      return failure(400, "Unsupported Git service");
    if (discovery && url.searchParams.getAll("service").length !== 1)
      return failure(400, "Expected exactly one Git service");
    if (service === "git-receive-pack" && options.receivePack === false)
      return failure(403, "Receive service is disabled");
    const encoding = request.headers.get("Content-Encoding")?.trim().toLowerCase();
    if (!discovery && encoding !== undefined && encoding !== "identity" && encoding !== "gzip") {
      return failure(415, "Unsupported Git request content encoding");
    }
    throwIfAborted(request.signal);
    requireCompleteRepository(store);
    if (discovery)
      return result(
        discoverServer(store, service),
        `application/x-${service}-advertisement`,
        request.signal,
      );
    if (
      request.headers.get("Content-Type")?.split(";")[0]?.trim().toLowerCase() !==
      `application/x-${service}-request`
    )
      return failure(415, "Unsupported Git request media type");
    const runtime: ServerRuntime = {
      now: options.now ?? Date.now,
      yieldNow: options.yieldNow ?? (() => new Promise<void>((resolve) => setTimeout(resolve, 0))),
      signal: request.signal,
    };
    const body = requestBody(request);
    const output =
      service === "git-receive-pack"
        ? await receivePack(
            store,
            await parseReceivePackRequest(body, {
              maxPackBytes: options.maxPackBytes,
              signal: request.signal,
            }),
            runtime,
          )
        : await uploadPack(store, await parseUploadPackRequest(body, request.signal), runtime);
    return result(output, `application/x-${service}-result`, request.signal);
  } catch (error) {
    const code = errorCode(error);
    if (code === "E2BIG") return failure(413, "Git request exceeds a storage or metadata limit");
    if (code === "EBUSY" || code === "ESTALE")
      return failure(409, "Git repository operation conflicts with another request");
    if (code === "EABORTED") return failure(400, "Git request was aborted");
    if (code === "ENOTFOUND")
      return failure(404, "Git repository or requested object is unavailable");
    if (["EBADREQUEST", "ECORRUPT", "EINVAL", "EINVALIDREF", "EUNSUPPORTED"].includes(code ?? ""))
      return failure(400, "Invalid or unsupported Git request");
    return failure(500, "Git server operation failed");
  }
}

export function validateServerOptions(store: SharedRepoStore, options: GitServerOptions): void {
  if (store.kind !== "bare") throw new GitError("EINVAL", "Git server requires a bare repository");
  if (!Number.isSafeInteger(options.maxPackBytes) || options.maxPackBytes < 0)
    throw new GitError("EINVAL", "maxPackBytes must be a nonnegative safe integer");
  if (options.receivePack !== undefined && typeof options.receivePack !== "boolean")
    throw new GitError("EINVAL", "receivePack must be a boolean");
  if (options.now !== undefined && typeof options.now !== "function")
    throw new GitError("EINVAL", "now must be a function");
  if (options.yieldNow !== undefined && typeof options.yieldNow !== "function")
    throw new GitError("EINVAL", "yieldNow must be a function");
}
