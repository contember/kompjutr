import { sharedRepoStoreMutations } from "../../store/repository/shared.js";
// Repository config and the remotes described by it. Config is
// relational — one row per value, keyed by the dotted path — so there is
// no config file to parse and no section header to preserve.

import { GitError } from "../../common/errors.js";
import { hasCanonicalRefSyntax } from "../../common/ref-name.js";
import type { RemoteView } from "../core/kinds.js";
import type { Repository } from "../repository/repository.js";

const REMOTE = "remote.";

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
    sharedRepoStoreMutations(repo.store).configUnsetOwned(options.path);
    return;
  }
  const value = String(options.value);
  if (options.append === true)
    sharedRepoStoreMutations(repo.store).configAddOwned(options.path, value);
  else sharedRepoStoreMutations(repo.store).configSetOwned(options.path, value);
}

export interface RemoteAddOptions {
  name: string;
  url: string;
  force?: boolean;
}

export function remoteAdd(repo: Repository, options: RemoteAddOptions): void {
  const name = requireRemoteName(options, "remote add");
  const url = requireText(options.url, "remote URL", true);
  const section = `${REMOTE}${name}`;
  const urlPath = `${section}.url`;
  const fetchPath = `${section}.fetch`;
  const fetch = `+refs/heads/*:refs/remotes/${name}/*`;
  if (options.force !== true && repo.store.configCardinality(urlPath) !== "missing") {
    throw new GitError("EREMOTEFAIL", `remote ${name} already exists`);
  }
  repo.store.db.transactionSync(() => {
    sharedRepoStoreMutations(repo.store).configSetOwned(urlPath, url);
    sharedRepoStoreMutations(repo.store).configSetOwned(fetchPath, fetch);
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
    sharedRepoStoreMutations(repo.store).configSetOwned(path, input.url);
  });
}

function requireSingleRemoteUrl(repo: Repository, name: string, path: string): string {
  const result = repo.store.configGetSingleBounded(path);
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
    url: requireText(Reflect.get(object, "url"), "remote URL", true),
  };
}

function requireRemoteName(options: unknown, operation: string): string {
  const object = requireOptionsObject(options, operation);
  const name = requireText(Reflect.get(object, "name"), "remote name");
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

function requireText(value: unknown, label: string, allowEmpty = false): string {
  if (typeof value !== "string" || (!allowEmpty && value === "")) {
    throw new GitError(
      "EINVAL",
      `${label} must be ${allowEmpty ? "a string" : "a non-empty string"}`,
    );
  }
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
    } else if (unit >= 0xdc00 && unit <= 0xdfff) {
      throw new GitError("EINVAL", `${label} is not canonical text`);
    }
  }
  return value;
}

/** Drops the config section. Remote-tracking refs are left alone. */
export function remoteRemove(repo: Repository, options: RemoteRemoveOptions): void {
  const name = requireRemoteName(options, "remote remove");
  const paths = repo.store.configPaths(`${REMOTE}${name}.`);
  if (paths.length === 0) throw new GitError("EREMOTEFAIL", `no such remote: ${name}`);
  repo.store.db.transactionSync(() => {
    for (const path of paths) sharedRepoStoreMutations(repo.store).configUnsetOwned(path);
  });
}

export function remoteList(repo: Repository): RemoteView[] {
  const out: RemoteView[] = [];
  for (const path of repo.store.configPaths(REMOTE)) {
    if (!path.endsWith(".url")) continue;
    const url = repo.store.configGetBounded(path);
    if (url === undefined) continue;
    const name = path.slice(REMOTE.length, path.length - ".url".length);
    out.push({ name, url });
  }
  return out;
}
