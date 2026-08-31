// The HTTP side of Smart HTTP. Kept behind an interface so tests can drive
// the client without a socket, and so a workspace can supply its own
// fetch (proxies, custom auth, egress policy).

import { GitError } from "../common/errors.js";
import { abortable, throwIfAborted } from "./stream.js";

export interface GitHttpRequest {
  url: string;
  method: "GET" | "POST";
  headers: Record<string, string>;
  body?: Uint8Array | AsyncIterable<Uint8Array>;
  signal?: AbortSignal;
}

export interface GitHttpResponse {
  status: number;
  statusText: string;
  headers: Record<string, string>;
  body: AsyncIterable<Uint8Array>;
}

export type GitHttpClient = (request: GitHttpRequest) => Promise<GitHttpResponse>;

export interface GitAuth {
  username?: string;
  password?: string;
  headers?: Record<string, string>;
}

export type AuthCallback = (
  url: string,
  auth: GitAuth,
) => GitAuth | undefined | Promise<GitAuth | undefined>;

export class HttpError extends GitError {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super("EHTTP", message);
    this.name = "HttpError";
  }
}

async function* streamOf(
  response: Response,
  signal: AbortSignal | undefined,
): AsyncGenerator<Uint8Array> {
  const body = response.body;
  if (body === null) return;
  const reader = body.getReader();
  let finished = false;
  try {
    for (;;) {
      const result = await reader.read().catch((error: unknown) => {
        throwIfAborted(signal);
        throw error;
      });
      const { done, value } = result;
      if (done) {
        finished = true;
        return;
      }
      if (value !== undefined && value.length > 0) yield value;
    }
  } finally {
    if (!finished) {
      try {
        await reader.cancel();
      } catch {
        // The source failure remains authoritative after cancellation.
      }
    }
    reader.releaseLock();
  }
}

function requestStream(body: AsyncIterable<Uint8Array>): ReadableStream<Uint8Array> {
  const iterator = body[Symbol.asyncIterator]();
  return new ReadableStream<Uint8Array>({
    async pull(controller) {
      try {
        const next = await iterator.next();
        if (next.done) controller.close();
        else controller.enqueue(next.value);
      } catch (error) {
        controller.error(error);
      }
    },
    async cancel() {
      await iterator.return?.();
    },
  });
}

interface StreamingRequestInit extends RequestInit {
  /** Required by Node's fetch; ignored by Workers. */
  duplex?: "half";
}

/** The default transport: the platform's global `fetch`. */
export const fetchHttpClient: GitHttpClient = async (request) => {
  throwIfAborted(request.signal);
  const streaming = request.body !== undefined && !(request.body instanceof Uint8Array);
  const init: StreamingRequestInit = {
    method: request.method,
    headers: request.headers,
    body:
      request.body === undefined
        ? undefined
        : request.body instanceof Uint8Array
          ? request.body
          : requestStream(request.body),
    redirect: "follow",
    signal: request.signal,
    ...(streaming ? { duplex: "half" } : {}),
  };
  let response: Response;
  try {
    response = await fetch(request.url, init);
  } catch (error) {
    throwIfAborted(request.signal);
    throw error;
  }
  const headers: Record<string, string> = {};
  response.headers.forEach((value, key) => {
    headers[key.toLowerCase()] = value;
  });
  return {
    status: response.status,
    statusText: response.statusText,
    headers,
    body: streamOf(response, request.signal),
  };
};

function basicAuth(auth: GitAuth): Record<string, string> {
  if (auth.username === undefined && auth.password === undefined) return {};
  const raw = `${auth.username ?? ""}:${auth.password ?? ""}`;
  return { Authorization: `Basic ${btoa(raw)}` };
}

export interface RemoteRequestOptions {
  http?: GitHttpClient;
  headers?: Record<string, string>;
  onAuth?: AuthCallback;
  signal?: AbortSignal;
}

export type GitHttpRequestFactory = () => GitHttpRequest;

function openRequest(request: GitHttpRequest | GitHttpRequestFactory): GitHttpRequest {
  return typeof request === "function" ? request() : request;
}

/** Credentials retained across one remote operation's discovery and POSTs. */
export class RemoteAuthSession {
  #auth: GitAuth | undefined;

  async request(
    request: GitHttpRequest | GitHttpRequestFactory,
    options: RemoteRequestOptions,
  ): Promise<GitHttpResponse> {
    const http = options.http ?? fetchHttpClient;
    const firstRequest = openRequest(request);
    const signal = firstRequest.signal ?? options.signal;
    throwIfAborted(signal);
    const headers = {
      ...firstRequest.headers,
      ...options.headers,
      ...(this.#auth === undefined ? {} : basicAuth(this.#auth)),
      ...this.#auth?.headers,
    };
    let first: GitHttpResponse;
    try {
      first = await abortable(http({ ...firstRequest, headers, signal }), signal);
    } catch (error) {
      throwIfAborted(signal);
      if (firstRequest.method !== "GET") throw error;
      const retryRequest = openRequest(request);
      first = await abortable(
        http({
          ...retryRequest,
          headers: { ...retryRequest.headers, ...headers },
          signal,
        }),
        signal,
      );
    }
    throwIfAborted(signal);
    if (first.status !== 401 || options.onAuth === undefined) return first;

    await drain(first.body, signal);
    throwIfAborted(signal);
    const auth = await abortable(
      Promise.resolve(options.onAuth(firstRequest.url, this.#auth ?? {})),
      signal,
    );
    throwIfAborted(signal);
    if (auth === undefined) return first;
    this.#auth = auth;

    const retryRequest = openRequest(request);
    const retryHeaders = {
      ...retryRequest.headers,
      ...options.headers,
      ...basicAuth(auth),
      ...auth.headers,
    };
    return abortable(http({ ...retryRequest, headers: retryHeaders, signal }), signal);
  }
}

async function drain(
  body: AsyncIterable<Uint8Array>,
  signal: AbortSignal | undefined,
): Promise<void> {
  try {
    const iterator = body[Symbol.asyncIterator]();
    try {
      for (;;) {
        const next = await abortable(iterator.next(), signal);
        if (next.done === true) break;
      }
    } finally {
      await iterator.return?.();
    }
  } catch {
    throwIfAborted(signal);
    // A rejected response may itself be truncated.
  }
}

/**
 * Git's auth contract: static headers always and one retry through `onAuth`.
 * An idempotent GET also retries one transport failure; a POST never does.
 */
export async function requestWithAuth(
  request: GitHttpRequest | GitHttpRequestFactory,
  options: RemoteRequestOptions,
  session = new RemoteAuthSession(),
): Promise<GitHttpResponse> {
  return session.request(request, options);
}

export async function readAll(body: AsyncIterable<Uint8Array>): Promise<string> {
  let text = "";
  const decoder = new TextDecoder();
  for await (const chunk of body) text += decoder.decode(chunk, { stream: true });
  return text + decoder.decode();
}
