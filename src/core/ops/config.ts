// Repository config and the remotes described by it. Config is
// relational — one row per value, keyed by the dotted path — so there is
// no config file to parse and no section header to preserve.

import { GitError } from "../errors.js";
import { hasCanonicalRefSyntax } from "../ref-name.js";
import type { Repository } from "../repository.js";
import { retainedStringBytes } from "../retained.js";
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
  const name = requireRemoteName(options, "remote add");
  const url = requireText(options.url, "remote URL", true);
  const owner = new ConfigStringOwner(repo);
  try {
    const section = owner.construct(REMOTE.length + name.length, () => `${REMOTE}${name}`);
    const urlPath = owner.construct(section.length + ".url".length, () => `${section}.url`);
    const fetchPath = owner.construct(section.length + ".fetch".length, () => `${section}.fetch`);
    const fetch = owner.construct(
      "+refs/heads/*:refs/remotes//*".length + name.length,
      () => `+refs/heads/*:refs/remotes/${name}/*`,
    );
    if (options.force !== true && repo.store.configCardinality(urlPath) !== "missing") {
      throw new GitError("EREMOTEFAIL", `remote ${name} already exists`);
    }
    repo.store.db.transactionSync(() => {
      repo.store.configSet(urlPath, url);
      repo.store.configSet(fetchPath, fetch);
    });
  } finally {
    owner.dispose();
  }
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
  const owner = new ConfigStringOwner(repo);
  try {
    const path = owner.construct(
      REMOTE.length + name.length + ".url".length,
      () => `${REMOTE}${name}.url`,
    );
    return requireSingleRemoteUrl(repo, name, path);
  } finally {
    owner.dispose();
  }
}

export function remoteSetUrl(repo: Repository, options: RemoteSetUrlOptions): void {
  const input = requireRemoteSetUrlOptions(options);
  const owner = new ConfigStringOwner(repo);
  try {
    const path = owner.construct(
      REMOTE.length + input.name.length + ".url".length,
      () => `${REMOTE}${input.name}.url`,
    );
    repo.store.db.transactionSync(() => {
      requireSingleRemoteUrl(repo, input.name, path);
      repo.store.configSet(path, input.url);
    });
  } finally {
    owner.dispose();
  }
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
  const owner = new ConfigStringOwner(repo);
  try {
    const prefix = owner.construct(REMOTE.length + name.length + 1, () => `${REMOTE}${name}.`);
    const paths = repo.store.configPaths(prefix);
    for (const path of paths) owner.retain(path);
    if (paths.length === 0) throw new GitError("EREMOTEFAIL", `no such remote: ${name}`);
    repo.store.db.transactionSync(() => {
      for (const path of paths) repo.store.configUnset(path);
    });
  } finally {
    owner.dispose();
  }
}

export function remoteList(repo: Repository): RemoteView[] {
  const owner = new ConfigStringOwner(repo);
  try {
    const out: RemoteView[] = [];
    for (const path of repo.store.configPaths(REMOTE)) {
      owner.retain(path);
      if (!path.endsWith(".url")) continue;
      const url = repo.store.configGetBounded(path);
      if (url === undefined) continue;
      owner.retain(url);
      const name = owner.construct(path.length - REMOTE.length - ".url".length, () =>
        path.slice(REMOTE.length, path.length - ".url".length),
      );
      owner.addFixed(96);
      out.push({ name, url });
    }
    return out;
  } finally {
    owner.dispose();
  }
}

class ConfigStringOwner {
  readonly #reservation;
  #retained = 256;

  constructor(repo: Repository) {
    this.#reservation = repo.store.reserveMemory();
    this.#reservation.set("other", this.#retained);
  }

  construct<T extends string>(units: number, construct: () => T): T {
    this.#reservation.set("other", this.#retained + 48 + 2 * units);
    const value = construct();
    this.#retained += retainedStringBytes(value);
    this.#reservation.set("other", this.#retained);
    return value;
  }

  retain(value: string): void {
    this.#retained += retainedStringBytes(value);
    this.#reservation.set("other", this.#retained);
  }

  addFixed(bytes: number): void {
    this.#retained += bytes;
    this.#reservation.set("other", this.#retained);
  }

  dispose(): void {
    this.#reservation.dispose();
  }
}
