// Repository config and the remotes described by it. Config is
// relational — one row per value, keyed by the dotted path — so there is
// no config file to parse and no section header to preserve.

import { GitError } from "../errors.js";
import type { Repository } from "../repository.js";
import type { RemoteView } from "./kinds.js";

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
