import { GitError } from "../common/errors.js";
import { normalizeRemoteUrl } from "../protocol/remote.js";
import { type GitAuth, RemoteAuthSession } from "../protocol/transport.js";
import type { GitContext } from "./context.js";
import type { FetchOperationOptions, RemoteAuthOptions } from "./network-types.js";
import type { Repository } from "./repository.js";

export function validateAbortableNetworkOptions(options: unknown): void {
  if (typeof options !== "object" || options === null || Array.isArray(options)) {
    throw new GitError("EINVAL", "network options must be an object");
  }
  const signal = Reflect.get(options, "signal");
  if (signal !== undefined && !(signal instanceof AbortSignal)) {
    throw new GitError("EINVAL", "network signal must be an AbortSignal");
  }
}

/** Validate the static remote/auth callback surface before any network request. */
export function validateRemoteAuthOptions(options: unknown): void {
  if (typeof options !== "object" || options === null || Array.isArray(options)) {
    throw new GitError("EINVAL", "remote options must be an object");
  }
  validateFetchHeaders(Reflect.get(options, "headers"), "EINVAL");
  for (const field of ["onAuth", "onProgress", "onMessage"]) {
    const callback = Reflect.get(options, field);
    if (callback !== undefined && typeof callback !== "function") {
      throw new GitError("EINVAL", `remote ${field} must be a function`);
    }
  }
}

export function validateFetchOptions(options: unknown): void {
  if (typeof options !== "object" || options === null || Array.isArray(options)) {
    throw new GitError("EINVAL", "fetch options must be an object");
  }
  validateRemoteAuthOptions(options);
  validateAbortableNetworkOptions(options);
  validateLegacyDeepeningOptions(options);
  const remote = Reflect.get(options, "remote");
  const url = Reflect.get(options, "url");
  if (remote !== undefined && url !== undefined) {
    throw new GitError("EINVAL", "fetch accepts either remote or url, not both");
  }
  if (remote !== undefined && (typeof remote !== "string" || remote === "")) {
    throw new GitError("EINVAL", "fetch remote must be a non-empty string");
  }
  if (url !== undefined && typeof url !== "string") {
    throw new GitError("EINVAL", "fetch url must be a string");
  }
  const refspecs = Reflect.get(options, "refspecs");
  const filter = Reflect.get(options, "filter");
  if (filter !== undefined && filter !== "blob:none") {
    throw new GitError("EUNSUPPORTED", "fetch filter is not supported");
  }
  if (refspecs !== undefined) {
    if (!Array.isArray(refspecs)) throw new GitError("EINVAL", "fetch refspecs must be an array");
    for (const field of [
      "depth",
      "deepen",
      "unshallow",
      "ref",
      "remoteRef",
      "singleBranch",
      "prune",
      "tags",
    ]) {
      if (Reflect.get(options, field) !== undefined) {
        throw new GitError("EINVAL", `mapped fetch cannot set ${field}`);
      }
    }
  }
}

export function validateLegacyDeepeningOptions(options: object): void {
  const depth = Reflect.get(options, "depth");
  const deepen = Reflect.get(options, "deepen");
  const unshallow = Reflect.get(options, "unshallow");
  const selected = [depth, deepen, unshallow].filter((value) => value !== undefined).length;
  if (selected > 1) {
    throw new GitError("EINVAL", "fetch depth, deepen, and unshallow are mutually exclusive");
  }
  if (deepen !== undefined && (!Number.isSafeInteger(deepen) || deepen <= 0)) {
    throw new GitError("EINVAL", "fetch deepen must be a positive safe integer");
  }
  if (unshallow !== undefined && typeof unshallow !== "boolean") {
    throw new GitError("EINVAL", "fetch unshallow must be a boolean");
  }
}

export function remoteUrlFor(repo: Repository, remote: string): string | undefined {
  return repo.store.configGet(`remote.${remote}.url`);
}

function validateFetchHeaders(headers: unknown, code: "EAUTH" | "EINVAL"): void {
  if (headers === undefined) return;
  if (typeof headers !== "object" || headers === null || Array.isArray(headers)) {
    throw new GitError(code, "remote authentication headers must be a string record");
  }
  for (const value of Object.values(headers)) {
    if (typeof value !== "string") {
      throw new GitError(code, "remote authentication headers must contain strings");
    }
  }
}

function validateFetchCredentials(credentials: GitAuth | undefined): void {
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
  validateFetchHeaders(credentials.headers, "EAUTH");
}

/** A URL stored for a remote that is not an HTTP remote can never be this fetch's target. */
export function sameRemoteUrl(configured: string, url: string): boolean {
  try {
    return normalizeRemoteUrl(configured) === normalizeRemoteUrl(url);
  } catch {
    return false;
  }
}

/** Build one authenticated remote session. */
export function createRemoteAuth(
  context: GitContext,
  options: RemoteAuthOptions,
  signal?: AbortSignal,
) {
  validateRemoteAuthOptions(options);
  const onAuth = options.onAuth;
  return {
    ...(context.http === undefined ? {} : { http: context.http }),
    ...(options.headers === undefined ? {} : { headers: options.headers }),
    ...(signal === undefined ? {} : { signal }),
    ...(onAuth === undefined
      ? {}
      : {
          onAuth: async (...input: Parameters<typeof onAuth>) => {
            let credentials: GitAuth | undefined;
            try {
              credentials = await onAuth(...input);
            } catch (cause) {
              throw new GitError("EAUTH", "remote authentication callback failed", { cause });
            }
            validateFetchCredentials(credentials);
            return credentials;
          },
        }),
    authSession: new RemoteAuthSession(),
  };
}

export function fetchAuth(context: GitContext, options: FetchOperationOptions) {
  return createRemoteAuth(context, options, options.signal);
}
