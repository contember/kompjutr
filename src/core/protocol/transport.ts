// The HTTP side of Smart HTTP. Kept behind an interface so tests can drive
// the client without a socket, and so a workspace can supply its own
// fetch (proxies, custom auth, egress policy).

import { GitError } from "../errors.js";

export interface GitHttpRequest {
  url: string;
  method: "GET" | "POST";
  headers: Record<string, string>;
  body?: Uint8Array | AsyncIterable<Uint8Array>;
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

async function* streamOf(response: Response): AsyncGenerator<Uint8Array> {
  const body = response.body;
  if (body === null) return;
  const reader = body.getReader();
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) return;
      if (value !== undefined && value.length > 0) yield value;
    }
  } finally {
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
    ...(streaming ? { duplex: "half" } : {}),
  };
  const response = await fetch(request.url, init);
  const headers: Record<string, string> = {};
  response.headers.forEach((value, key) => {
    headers[key.toLowerCase()] = value;
  });
  return {
    status: response.status,
    statusText: response.statusText,
    headers,
    body: streamOf(response),
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
    const headers = {
      ...firstRequest.headers,
      ...options.headers,
      ...(this.#auth === undefined ? {} : basicAuth(this.#auth)),
      ...this.#auth?.headers,
    };
    let first: GitHttpResponse;
    try {
      first = await http({ ...firstRequest, headers });
    } catch (error) {
      if (firstRequest.method !== "GET") throw error;
      const retryRequest = openRequest(request);
      first = await http({ ...retryRequest, headers: { ...retryRequest.headers, ...headers } });
    }
    if (first.status !== 401 || options.onAuth === undefined) return first;

    await drain(first.body);
    const auth = await options.onAuth(firstRequest.url, this.#auth ?? {});
    if (auth === undefined) return first;
    this.#auth = auth;

    const retryRequest = openRequest(request);
    const retryHeaders = {
      ...retryRequest.headers,
      ...options.headers,
      ...basicAuth(auth),
      ...auth.headers,
    };
    return http({ ...retryRequest, headers: retryHeaders });
  }
}

async function drain(body: AsyncIterable<Uint8Array>): Promise<void> {
  try {
    for await (const _chunk of body) {
      // discard
    }
  } catch {
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
