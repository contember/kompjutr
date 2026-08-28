// Repository config and the remotes described by it. Config is
// relational — one row per value, keyed by the dotted path — so there is
// no config file to parse and no section header to preserve.

import { GitError } from "../errors.js";
import { hasCanonicalRefSyntax } from "../ref-name.js";
import type { Repository } from "../repository.js";
import type { RemoteView } from "./kinds.js";

const REMOTE = "remote.";
/** Leaves `remote.<name>.url` within the shared 2,200-byte config-path ceiling. */
export const MAX_REMOTE_NAME_BYTES = 2_189;
export const MAX_REMOTE_URL_BYTES = 8_192;

export interface ConfigGetOptions {
  /** Dotted key, e.g. "user.email" or "remote.origin.url". */
  path: string;
  /** Return every value for a multi-valued key. */
  all?: boolean;
}

/** A missing key is `undefined`; `all` reports it as an empty list. */
export function configGet(
  repo: Repository,
  options: ConfigGetOptions,
): string | string[] | undefined {
  if (options.all === true) return repo.store.configGetAll(options.path);
  return repo.store.configGet(options.path);
}

export interface ConfigSetOptions {
  path: string;
  /** `undefined` unsets the key, matching `git config --unset`. */
  value: string | boolean | number | undefined;
  /** Append to a multi-valued key rather than replacing it. */
  append?: boolean;
}

export function configSet(repo: Repository, options: ConfigSetOptions): void {
  if (options.value === undefined) {
    repo.store.configUnset(options.path);
    return;
  }
  const value = String(options.value);
  if (options.append === true) repo.store.configAdd(options.path, value);
  else repo.store.configSet(options.path, value);
}

export interface RemoteAddOptions {
  name: string;
  url: string;
  force?: boolean;
}

export function remoteAdd(repo: Repository, options: RemoteAddOptions): void {
  const section = `${REMOTE}${options.name}`;
  if (options.force !== true && repo.store.configGet(`${section}.url`) !== undefined) {
    throw new GitError("EREMOTEFAIL", `remote ${options.name} already exists`);
  }
  repo.store.db.transactionSync(() => {
    repo.store.configSet(`${section}.url`, options.url);
    repo.store.configSet(`${section}.fetch`, `+refs/heads/*:refs/remotes/${options.name}/*`);
  });
}

export interface RemoteRemoveOptions {
  name: string;
}

export interface RemoteGetUrlOptions {
  name: string;
}

export interface RemoteSetUrlOptions {
  name: string;
  url: string;
}

export function remoteGetUrl(repo: Repository, options: RemoteGetUrlOptions): string {
  const name = requireRemoteName(options, "remote get-url");
  return requireSingleRemoteUrl(repo, name, `${REMOTE}${name}.url`);
}

export function remoteSetUrl(repo: Repository, options: RemoteSetUrlOptions): void {
  const input = requireRemoteSetUrlOptions(options);
  const path = `${REMOTE}${input.name}.url`;
  repo.store.db.transactionSync(() => {
    requireSingleRemoteUrl(repo, input.name, path);
    repo.store.configSet(path, input.url);
  });
}

function requireSingleRemoteUrl(repo: Repository, name: string, path: string): string {
  const result = repo.store.configGetSingleBounded(path, MAX_REMOTE_URL_BYTES);
  if (result.kind === "missing") {
    throw new GitError("EREMOTEFAIL", `no such remote: ${name}`);
  }
  if (result.kind === "multiple") {
    throw new GitError("EUNSUPPORTED", `multiple URLs for remote ${name} are not supported`);
  }
  return result.value;
}

function requireRemoteSetUrlOptions(options: unknown): { name: string; url: string } {
  const object = requireOptionsObject(options, "remote set-url");
  return {
    name: requireRemoteName(object, "remote set-url"),
    url: requireBoundedText(Reflect.get(object, "url"), "remote URL", MAX_REMOTE_URL_BYTES, true),
  };
}

function requireRemoteName(options: unknown, operation: string): string {
  const object = requireOptionsObject(options, operation);
  const name = requireBoundedText(
    Reflect.get(object, "name"),
    "remote name",
    MAX_REMOTE_NAME_BYTES,
  );
  if (!hasCanonicalRefSyntax(name)) {
    throw new GitError("EINVAL", `invalid remote name: ${name}`);
  }
  return name;
}

function requireOptionsObject(value: unknown, operation: string): object {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new GitError("EINVAL", `${operation} options must be an object`);
  }
  return value;
}

function requireBoundedText(
  value: unknown,
  label: string,
  limit: number,
  allowEmpty = false,
): string {
  if (typeof value !== "string" || (!allowEmpty && value === "")) {
    throw new GitError(
      "EINVAL",
      `${label} must be ${allowEmpty ? "a string" : "a non-empty string"}`,
    );
  }
  let bytes = 0;
  for (let index = 0; index < value.length; index++) {
    const unit = value.charCodeAt(index);
    if (unit === 0 || unit === 0x0a || unit === 0x0d) {
      throw new GitError("EINVAL", `${label} contains an invalid character`);
    }
    if (unit >= 0xd800 && unit <= 0xdbff) {
      if (index + 1 >= value.length) {
        throw new GitError("EINVAL", `${label} is not canonical text`);
      }
      const low = value.charCodeAt(index + 1);
      if (low < 0xdc00 || low > 0xdfff) {
        throw new GitError("EINVAL", `${label} is not canonical text`);
      }
      index++;
      bytes += 4;
    } else if (unit >= 0xdc00 && unit <= 0xdfff) {
      throw new GitError("EINVAL", `${label} is not canonical text`);
    } else {
      bytes += unit < 0x80 ? 1 : unit < 0x800 ? 2 : 3;
    }
    if (bytes > limit) {
      throw new GitError("E2BIG", `${label} exceeds ${limit} UTF-8 bytes`);
    }
  }
  return value;
}

/** Drops the config section. Remote-tracking refs are left alone. */
export function remoteRemove(repo: Repository, options: RemoteRemoveOptions): void {
  const paths = repo.store.configPaths(`${REMOTE}${options.name}.`);
  if (paths.length === 0) throw new GitError("EREMOTEFAIL", `no such remote: ${options.name}`);
  repo.store.db.transactionSync(() => {
    for (const path of paths) repo.store.configUnset(path);
  });
}

export function remoteList(repo: Repository): RemoteView[] {
  const out: RemoteView[] = [];
  for (const path of repo.store.configPaths(REMOTE)) {
    if (!path.endsWith(".url")) continue;
    const url = repo.store.configGet(path);
    if (url === undefined) continue;
    out.push({ name: path.slice(REMOTE.length, path.length - ".url".length), url });
  }
  return out;
}
