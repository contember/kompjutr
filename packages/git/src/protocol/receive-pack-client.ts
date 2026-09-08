import { CorruptError, GitError, hasErrorCode } from "../common/errors.js";
import { findLocalPackFailure, prepareRequest, requestBody } from "./receive-pack-request.js";
import {
  parseStatus,
  readResponsePrefix,
  resolvedStatusLimits,
  sidebandBody,
} from "./receive-pack-status.js";
import type {
  PostCertainty,
  ReceivePackOptions,
  ReceivePackRequest,
  ReceivePackStatus,
} from "./receive-pack-types.js";
import { baseHeaders, normalizeRemoteUrl } from "./remote-base.js";
import { throwIfAborted } from "./stream.js";
import {
  fetchHttpClient,
  type GitAuth,
  type GitHttpResponse,
  HttpError,
  requestWithAuth,
} from "./transport.js";

function validCredentials(credentials: GitAuth | undefined): void {
  if (credentials === undefined) return;
  if (typeof credentials !== "object" || credentials === null || Array.isArray(credentials)) {
    throw new GitError("EAUTH", "remote authentication callback returned invalid credentials");
  }
  if (credentials.username !== undefined && typeof credentials.username !== "string") {
    throw new GitError("EAUTH", "remote authentication username must be a string");
  }
  if (credentials.password !== undefined && typeof credentials.password !== "string") {
    throw new GitError("EAUTH", "remote authentication password must be a string");
  }
  if (
    credentials.headers !== undefined &&
    (typeof credentials.headers !== "object" ||
      credentials.headers === null ||
      Array.isArray(credentials.headers))
  ) {
    throw new GitError("EAUTH", "remote authentication headers must be a string record");
  }
  for (const value of Object.values(credentials.headers ?? {})) {
    if (typeof value !== "string") {
      throw new GitError("EAUTH", "remote authentication headers must contain strings");
    }
  }
}

function authOptions(options: ReceivePackOptions): ReceivePackOptions {
  const onAuth = options.onAuth;
  if (onAuth === undefined) return options;
  return {
    ...options,
    onAuth: async (...input: Parameters<typeof onAuth>) => {
      let credentials: GitAuth | undefined;
      try {
        credentials = await onAuth(...input);
      } catch (cause) {
        throw new GitError("EAUTH", "remote authentication callback failed", { cause });
      }
      validCredentials(credentials);
      return credentials;
    },
  };
}

async function* tracked401Body(
  body: AsyncIterable<Uint8Array>,
  certainty: PostCertainty,
): AsyncGenerator<Uint8Array> {
  const iterator = body[Symbol.asyncIterator]();
  let complete = false;
  try {
    for (;;) {
      const next = await iterator.next();
      if (next.done === true) {
        complete = true;
        return;
      }
      yield next.value;
    }
  } finally {
    if (!complete) await iterator.return?.();
    certainty.safeAbort = true;
  }
}

function certaintyOptions(
  options: ReceivePackOptions,
  certainty: PostCertainty,
): ReceivePackOptions {
  const authenticated = authOptions(options);
  const upstream = authenticated.http ?? fetchHttpClient;
  return {
    ...authenticated,
    http: async (request) => {
      certainty.invoked = true;
      certainty.safeAbort = false;
      const response = await upstream(request);
      return response.status === 401
        ? { ...response, body: tracked401Body(response.body, certainty) }
        : response;
    },
  };
}

function uncertain(message: string, cause: unknown): GitError {
  return new GitError("EPUSHUNCERTAIN", message, { cause });
}

export async function receivePack(
  request: ReceivePackRequest,
  options: ReceivePackOptions = {},
): Promise<ReceivePackStatus> {
  const limits = resolvedStatusLimits(options.protocolLimits);
  const prepared = prepareRequest(request);
  const base = normalizeRemoteUrl(request.url);
  const certainty: PostCertainty = { invoked: false, safeAbort: false };
  let response: GitHttpResponse;
  try {
    response = await requestWithAuth(
      () => ({
        url: `${base}/git-receive-pack`,
        method: "POST",
        headers: {
          ...baseHeaders(),
          "Content-Type": "application/x-git-receive-pack-request",
          Accept: "application/x-git-receive-pack-result",
        },
        body: requestBody(prepared, prepared.pack),
      }),
      certaintyOptions(options, certainty),
      options.authSession,
    );
  } catch (error) {
    const localPackFailure = findLocalPackFailure(error);
    if (localPackFailure !== null) {
      const cause = localPackFailure.cause;
      if (hasErrorCode(cause, "E2BIG") || hasErrorCode(cause, "EPUSHLOCAL")) throw cause;
      throw new GitError("EPUSHLOCAL", "local receive-pack body generation failed", { cause });
    }
    if (hasErrorCode(error, "EAUTH")) throw error;
    if (hasErrorCode(error, "EABORTED") && (!certainty.invoked || certainty.safeAbort)) {
      throw error;
    }
    throw uncertain("receive-pack POST failed after the request may have been consumed", error);
  }

  if (response.status === 401) {
    let text = "";
    try {
      text = await readResponsePrefix(response.body, limits.inputBytes, options.signal);
      throwIfAborted(options.signal);
    } catch (cause) {
      if (hasErrorCode(cause, "EABORTED")) throw cause;
      throw new GitError("EHTTP", "git-receive-pack authentication failed", { cause });
    }
    throw new HttpError(
      response.status,
      `git-receive-pack failed: 401 ${response.statusText}${text === "" ? "" : ` — ${text}`}`,
    );
  }
  if (response.status !== 200) {
    let text: string;
    try {
      text = await readResponsePrefix(response.body, limits.inputBytes, options.signal);
    } catch (cause) {
      throw uncertain("receive-pack returned an uncertain HTTP response", cause);
    }
    const cause = new HttpError(
      response.status,
      `git-receive-pack failed: ${response.status} ${response.statusText}${text === "" ? "" : ` — ${text}`}`,
    );
    throw uncertain("receive-pack returned an uncertain HTTP response", cause);
  }
  const contentType = response.headers["content-type"] ?? "";
  const mediaType = contentType.split(";")[0]?.trim() ?? "";
  if (mediaType !== "application/x-git-receive-pack-result") {
    try {
      await readResponsePrefix(response.body, limits.inputBytes, options.signal);
    } catch (cause) {
      throw uncertain("receive-pack returned an uncertain malformed response", cause);
    }
    throw uncertain(
      "receive-pack returned an uncertain malformed response",
      new CorruptError(
        `invalid receive-pack content-type: ${contentType === "" ? "none" : contentType}`,
      ),
    );
  }
  const sideband = prepared.sideband
    ? sidebandBody(response.body, limits, prepared.onProgress, prepared.onMessage, options.signal)
    : null;
  const statusBody = sideband ?? response.body;
  try {
    return await parseStatus(
      statusBody,
      prepared.commands,
      prepared.atomic,
      limits,
      options.signal,
    );
  } catch (cause) {
    throw uncertain("receive-pack returned an incomplete or invalid status", cause);
  } finally {
    await sideband?.return(undefined);
  }
}
