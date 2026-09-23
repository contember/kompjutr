import { GitError } from "../../common/errors.js";
import {
  bool,
  callable,
  instanceOf,
  int,
  OptionsSchema,
  optional,
  record,
  text,
  unknownArray,
  unknownValue,
} from "../../common/rows.js";
import { normalizeRemoteUrl } from "../../protocol/remote.js";
import { type GitAuth, RemoteAuthSession } from "../../protocol/transport.js";
import type { GitContext } from "../core/context.js";
import type { Repository } from "../repository/repository.js";
import type { FetchOperationOptions, RemoteAuthOptions } from "./network-types.js";

const SIGNAL = optional(instanceOf(AbortSignal, "network signal must be an AbortSignal"));
const HEADERS = optional(
  record(
    text("remote authentication headers must contain strings"),
    "remote authentication headers must be a string record",
  ),
);

const ABORTABLE_OPTIONS = new OptionsSchema(
  { signal: SIGNAL },
  "network options must be an object",
);

const REMOTE_AUTH_OPTIONS = new OptionsSchema(
  {
    headers: HEADERS,
    onAuth: optional(callable("remote onAuth must be a function")),
    onProgress: optional(callable("remote onProgress must be a function")),
    onMessage: optional(callable("remote onMessage must be a function")),
  },
  "remote options must be an object",
);

const FETCH_TARGET_OPTIONS = new OptionsSchema(
  {
    remote: optional(
      text("fetch remote must be a non-empty string").where(
        (remote) => remote !== "",
        "fetch remote must be a non-empty string",
      ),
    ),
    url: optional(text("fetch url must be a string")),
    refspecs: optional(unknownArray("fetch refspecs must be an array")),
    filter: unknownValue(),
    depth: unknownValue(),
    deepen: unknownValue(),
    unshallow: unknownValue(),
    ref: unknownValue(),
    remoteRef: unknownValue(),
    singleBranch: unknownValue(),
    prune: unknownValue(),
    tags: unknownValue(),
  },
  "fetch options must be an object",
);
const MAPPED_FETCH_EXCLUDED = [
  "depth",
  "deepen",
  "unshallow",
  "ref",
  "remoteRef",
  "singleBranch",
  "prune",
  "tags",
] as const;

const DEEPENING_OPTIONS = new OptionsSchema(
  {
    depth: unknownValue(),
    deepen: optional(
      int(1, Number.MAX_SAFE_INTEGER, "fetch deepen must be a positive safe integer"),
    ),
    unshallow: optional(bool("fetch unshallow must be a boolean")),
  },
  "fetch options must be an object",
);

const CREDENTIALS = new OptionsSchema(
  {
    username: optional(text("remote authentication username must be a string")),
    password: optional(text("remote authentication password must be a string")),
    headers: HEADERS,
  },
  "remote authentication callback returned invalid credentials",
  "EAUTH",
);

export function validateAbortableNetworkOptions(options: unknown): void {
  ABORTABLE_OPTIONS.decode(options);
}

/** Validate the static remote/auth callback surface before any network request. */
export function validateRemoteAuthOptions(options: unknown): void {
  REMOTE_AUTH_OPTIONS.decode(options);
}

export function validateFetchOptions(options: unknown): void {
  const target = FETCH_TARGET_OPTIONS.decode(options);
  validateRemoteAuthOptions(options);
  validateAbortableNetworkOptions(options);
  validateLegacyDeepeningOptions(options);
  if (target.remote !== undefined && target.url !== undefined) {
    throw new GitError("EINVAL", "fetch accepts either remote or url, not both");
  }
  if (target.filter !== undefined && target.filter !== "blob:none") {
    throw new GitError("EUNSUPPORTED", "fetch filter is not supported");
  }
  if (target.refspecs !== undefined) {
    for (const field of MAPPED_FETCH_EXCLUDED) {
      if (target[field] !== undefined) {
        throw new GitError("EINVAL", `mapped fetch cannot set ${field}`);
      }
    }
  }
}

export function validateLegacyDeepeningOptions(options: unknown): void {
  const { depth, deepen, unshallow } = DEEPENING_OPTIONS.decode(options);
  const selected = [depth, deepen, unshallow].filter((value) => value !== undefined).length;
  if (selected > 1) {
    throw new GitError("EINVAL", "fetch depth, deepen, and unshallow are mutually exclusive");
  }
}

export function remoteUrlFor(repo: Repository, remote: string): string | undefined {
  return repo.store.configGet(`remote.${remote}.url`);
}

function validateFetchCredentials(credentials: GitAuth | undefined): void {
  if (credentials !== undefined) CREDENTIALS.decode(credentials);
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
