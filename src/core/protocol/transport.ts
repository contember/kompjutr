// The HTTP side of Smart HTTP. Kept behind an interface so tests can drive
// the client without a socket, and so a workspace can supply its own
// fetch (proxies, custom auth, egress policy).

import { GitError } from "../errors.js";

export interface GitHttpRequest {
  url: string;
  method: "GET" | "POST";
  headers: Record<string, string>;
  body?: Uint8Array;
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

export type AuthCallback = (url: string, auth: GitAuth) => GitAuth | undefined | Promise<GitAuth | undefined>;

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

/** The default transport: the platform's global `fetch`. */
export const fetchHttpClient: GitHttpClient = async (request) => {
  const response = await fetch(request.url, {
    method: request.method,
    headers: request.headers,
    body: request.body === undefined ? undefined : request.body,
    redirect: "follow",
  });
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

/**
 * One request with git's auth contract: static headers always, and one
 * retry through `onAuth` when the remote answers 401.
 */
export async function requestWithAuth(
  request: GitHttpRequest,
  options: RemoteRequestOptions,
): Promise<GitHttpResponse> {
  const http = options.http ?? fetchHttpClient;
  const headers = { ...request.headers, ...options.headers };
  const first = await http({ ...request, headers });
  if (first.status !== 401 || options.onAuth === undefined) return first;

  // Drain the rejected response so the connection is not left hanging.
  for await (const _chunk of first.body) {
    // discard
  }
  const auth = await options.onAuth(request.url, {});
  if (auth === undefined) return first;
  const retryHeaders = { ...headers, ...basicAuth(auth), ...auth.headers };
  return http({ ...request, headers: retryHeaders });
}

export async function readAll(body: AsyncIterable<Uint8Array>): Promise<string> {
  let text = "";
  const decoder = new TextDecoder();
  for await (const chunk of body) text += decoder.decode(chunk, { stream: true });
  return text + decoder.decode();
}
