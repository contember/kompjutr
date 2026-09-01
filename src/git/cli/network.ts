import { GitError, hasErrorCode } from "../common/errors.js";
import { joinPath, normalizePath } from "../common/paths.js";
import { remoteAdd, remoteGetUrl, remoteList, remoteRemove, remoteSetUrl } from "../ops/config.js";
import { findRepository, type GitContext, openRepository } from "../ops/context.js";
import { initRepository } from "../ops/init.js";
import { lsRemote } from "../ops/ls-remote.js";
import { clone, type FetchOptions, fetchInto } from "../ops/network.js";
import { pull, resolvePull } from "../ops/pull.js";
import { push } from "../ops/push.js";
import type { PushLeaseExpectation, PushResult } from "../ops/refspec.js";
import type { Repository } from "../ops/repository.js";
import {
  boundedGitCliResult,
  boundedPublishedGitCliResult,
  gitCliResult,
  gitCliStdoutPartsResult,
  gitCliUtf8ByteLength,
} from "./result.js";
import type {
  GitCliFetchCommand,
  GitCliHandlers,
  GitCliPushCommand,
  GitCliResult,
  ResolvedGitCliRunOptions,
} from "./types.js";

type NetworkHandlers = Pick<
  GitCliHandlers,
  "init" | "clone" | "remote" | "lsRemote" | "fetch" | "pull" | "push"
>;

export function createGitCliNetworkHandlers(context: GitContext): NetworkHandlers {
  return {
    init(invocation, options) {
      const root = resolveDirectory(invocation.cwd, invocation.command.directory);
      const repositoryPath = invocation.command.bare
        ? `${root === "/" ? "" : root}/`
        : `${root === "/" ? "" : root}/.git/`;
      const result = gitCliResult(`Initialized empty Git repository in ${repositoryPath}\n`, "", 0);
      try {
        return context.database.db.transactionSync(() => {
          const bounded = boundedGitCliResult(result, options);
          initRepository(context, {
            dir: root,
            ...(invocation.command.defaultBranch === undefined
              ? {}
              : { defaultBranch: invocation.command.defaultBranch }),
            ...(invocation.command.bare ? { bare: true } : {}),
          });
          return bounded;
        });
      } catch (error) {
        if (hasErrorCode(error, "E2BIG")) throw error;
        return boundedGitCliResult(mapFailure(error), options);
      }
    },
    async clone(invocation, options) {
      const command = invocation.command;
      let output: NetworkOutput | undefined;
      try {
        requireCliHttpUrl(command.url);
        const inferredDirectory = cloneDirectory(command.url);
        const root = resolveDirectory(invocation.cwd, command.directory ?? inferredDirectory);
        const display = command.directory ?? inferredDirectory;
        const cloneOutput = new NetworkOutput(options, `Cloning into '${display}'...\n`, true);
        output = cloneOutput;
        await clone(context, {
          url: command.url,
          dir: root,
          ...(command.depth === undefined ? {} : { depth: command.depth }),
          ...(command.singleBranch === undefined ? {} : { singleBranch: command.singleBranch }),
          ...(command.noTags ? { noTags: true } : {}),
          ...(command.ref === undefined ? {} : { ref: command.ref }),
          ...(command.remote === undefined ? {} : { remote: command.remote }),
          ...(command.filter === undefined ? {} : { filter: command.filter }),
          ...networkBinding(context),
          onMessage: (message) => cloneOutput.append(message),
        });
        return cloneOutput.published(0);
      } catch (error) {
        if (hasErrorCode(error, "E2BIG") || hasErrorCode(error, "EABORTED")) throw error;
        if (output === undefined) return boundedGitCliResult(mapFailure(error), options);
        return networkFailure(error, output, false);
      }
    },
    remote(invocation, options) {
      let repo: Repository;
      try {
        repo = openRepository(context, invocation.cwd);
      } catch (error) {
        return boundedGitCliResult(mapFailure(error), options);
      }
      const command = invocation.command;
      if (command.action === "list") {
        return gitCliStdoutPartsResult(
          remoteList(repo).map((remote) =>
            command.verbose
              ? `${remote.name}\t${remote.url} (fetch)\n${remote.name}\t${remote.url} (push)\n`
              : `${remote.name}\n`,
          ),
          Math.min(options.maxStdoutBytes, options.maxCombinedOutputBytes),
        );
      }
      if (command.action === "get-url") {
        if (command.name === undefined) throw new Error("parsed remote get-url lost its name");
        let url: string;
        try {
          url = remoteGetUrl(repo, { name: command.name });
        } catch (error) {
          return boundedGitCliResult(mapFailure(error), options);
        }
        return boundedGitCliResult(gitCliResult(`${url}\n`, "", 0), options);
      }
      try {
        return repo.store.db.transactionSync(() => {
          if (command.name === undefined) throw new Error("parsed remote mutation lost its name");
          if (command.action === "add") {
            if (command.url === undefined) throw new Error("parsed remote add lost its URL");
            requireCliHttpUrl(command.url);
            remoteAdd(repo, {
              name: command.name,
              url: command.url,
            });
          } else if (command.action === "remove") remoteRemove(repo, { name: command.name });
          else {
            if (command.url === undefined) throw new Error("parsed remote set-url lost its URL");
            requireCliHttpUrl(command.url);
            remoteSetUrl(repo, { name: command.name, url: command.url });
          }
          return boundedGitCliResult(gitCliResult("", "", 0), options);
        });
      } catch (error) {
        repo.store.revalidateStorageCaches();
        if (hasErrorCode(error, "E2BIG")) throw error;
        return boundedGitCliResult(mapFailure(error), options);
      }
    },
    async lsRemote(invocation, options) {
      try {
        const target = remoteTarget(invocation.command.target);
        const repo =
          "url" in target
            ? findRepository(context, invocation.cwd)
            : openRepository(context, invocation.cwd);
        if (repo !== null) requireConfiguredCliUrl(repo, invocation.command.target, false);
        const result = await lsRemote(context, repo, {
          ...target,
          patterns: invocation.command.patterns,
          ...networkBinding(context),
        });
        return gitCliStdoutPartsResult(
          formatLsRemote(result.refs),
          Math.min(options.maxStdoutBytes, options.maxCombinedOutputBytes),
        );
      } catch (error) {
        if (hasErrorCode(error, "E2BIG") || hasErrorCode(error, "EABORTED")) throw error;
        return boundedGitCliResult(mapFailure(error), options);
      }
    },
    async fetch(invocation, options) {
      const command = invocation.command;
      const output = new NetworkOutput(options, "", true);
      let published = false;
      try {
        const repo = openRepository(context, invocation.cwd);
        repo.checkout.requireNoOperationState();
        requireConfiguredCliUrl(repo, command.target, false);
        const target = remoteTarget(command.target);
        const common = {
          ...target,
          ...networkBinding(context),
          ...(command.filter === undefined ? {} : { filter: command.filter }),
          onMessage: (message: string) => output.append(message),
        };
        const checkpoint = {
          checkpoint(
            stage:
              | "before-discovery"
              | "after-discovery"
              | "before-upload"
              | "before-ingest"
              | "pack-ingest"
              | "after-ingest"
              | "after-shallow-response"
              | "before-ref-publication"
              | "after-ref-publication",
          ) {
            if (stage === "after-ref-publication") published = true;
            return undefined;
          },
        };
        let result: Awaited<ReturnType<typeof fetchInto>>;
        if (command.refspecs === undefined) {
          const selection = {
            ...(command.selector === undefined
              ? {}
              : { ref: command.selector, remoteRef: command.selector }),
            ...(command.singleBranch ? { singleBranch: true } : {}),
            ...(command.prune ? { prune: true } : {}),
            ...(command.tags === undefined ? {} : { tags: command.tags }),
          };
          let fetchOptions: FetchOptions;
          if (command.depth !== undefined)
            fetchOptions = { ...common, ...selection, depth: command.depth };
          else if (command.deepen !== undefined)
            fetchOptions = { ...common, ...selection, deepen: command.deepen };
          else if (command.unshallow) fetchOptions = { ...common, ...selection, unshallow: true };
          else fetchOptions = { ...common, ...selection };
          result = await fetchInto(context, repo, fetchOptions, "fetch", checkpoint);
        } else {
          result = await fetchInto(
            context,
            repo,
            { ...common, refspecs: command.refspecs },
            "fetch",
            checkpoint,
          );
        }
        const formatted = formatFetch(command, result);
        if (published) {
          output.appendPublished(formatted);
          return output.published(0);
        }
        output.append(formatted);
        return output.preflight(0);
      } catch (error) {
        return networkFailure(error, output, published);
      }
    },
    async pull(invocation, options) {
      const command = invocation.command;
      const output = new NetworkOutput(options, "", true);
      let published = false;
      try {
        const repo = openRepository(context, invocation.cwd);
        repo.checkout.requireNoOperationState();
        const pullOptions = {
          ...(command.remote === undefined ? {} : { remote: command.remote }),
          ...(command.branch === undefined ? {} : { remoteRef: command.branch }),
          ...(command.fastForward === undefined ? {} : { fastForward: command.fastForward }),
          ...(command.fastForwardOnly ? { fastForwardOnly: true } : {}),
          ...networkBinding(context),
          onMessage: (message: string) => output.append(message),
          env: environmentRecord(invocation.env),
        };
        requireCliHttpUrl(resolvePull(repo, pullOptions).url);
        const result = await pull(context, repo, context.worktree, pullOptions, {
          afterFetch: () => (published = true),
        });
        published = true;
        if (result.conflicted)
          output.appendPublished(
            "Automatic merge failed; fix conflicts and then commit the result.\n",
          );
        else if (result.alreadyMerged) output.appendPublished("Already up to date.\n");
        else if (result.fastForward) output.appendPublished("Fast-forward\n");
        return output.published(result.conflicted ? 1 : 0);
      } catch (error) {
        return networkFailure(error, output, published);
      }
    },
    async push(invocation, options) {
      const command = invocation.command;
      const destination = command.target ?? "origin";
      try {
        if (command.target !== undefined && hasUrlScheme(command.target)) {
          requireCliHttpUrl(command.target);
        }
      } catch (error) {
        return boundedGitCliResult(mapFailure(error), options);
      }
      const output = new NetworkOutput(options, `To ${displayTarget(destination)}\n`, false);
      try {
        const repo = openRepository(context, invocation.cwd);
        repo.checkout.requireNoOperationState();
        requireConfiguredCliUrl(repo, command.target, true);
        const target = remoteTarget(command.target);
        const leases = pushLeases(command);
        const common = {
          ...target,
          ...networkBinding(context),
          ...(command.atomic ? { atomic: true } : {}),
          ...(leases === undefined ? {} : { leases }),
          ...(command.pushOptions.length === 0 ? {} : { pushOptions: command.pushOptions }),
          onMessage: (message: string) => output.append(message),
        };
        const result =
          command.refspecs === undefined
            ? await push(context, repo, {
                ...common,
                ...(command.selector === undefined || command.delete
                  ? {}
                  : { ref: command.selector }),
                ...(command.force ? { force: true } : {}),
                ...(command.delete ? { delete: true, remoteRef: command.selector } : {}),
              })
            : await push(context, repo, { ...common, refspecs: command.refspecs });
        output.appendPublished(formatPush(result));
        return output.published(result.ok ? 0 : 1);
      } catch (error) {
        if (hasErrorCode(error, "EABORTED")) throw error;
        if (hasErrorCode(error, "EPUSHUNCERTAIN")) {
          output.appendPublished(mapFailure(error).stderr);
          throw new GitCliPushUncertainError(error, output.published(128));
        }
        return networkFailure(error, output, false);
      }
    },
  };
}

function networkBinding(context: GitContext) {
  const binding = context.cliNetwork;
  const signal = binding?.signal?.();
  return {
    ...(binding?.headers === undefined ? {} : { headers: binding.headers }),
    ...(binding?.onAuth === undefined ? {} : { onAuth: binding.onAuth }),
    ...(signal === undefined ? {} : { signal }),
  };
}

function resolveDirectory(cwd: string, directory: string | undefined): string {
  if (directory === undefined) return normalizePath(cwd);
  return directory.startsWith("/") ? normalizePath(directory) : joinPath(cwd, directory);
}

function cloneDirectory(url: string): string {
  let pathname: string;
  try {
    pathname = new URL(url).pathname;
  } catch {
    throw new GitError("EINVAL", "clone URL is invalid");
  }
  const slash = pathname.lastIndexOf("/");
  const raw = pathname.slice(slash + 1).replace(/\.git$/, "");
  if (raw === "") throw new GitError("EINVAL", "clone URL has no repository name");
  return raw;
}

function remoteTarget(target: string | undefined): { remote?: string } | { url: string } {
  if (target === undefined) return {};
  if (!hasUrlScheme(target)) return { remote: target };
  requireCliHttpUrl(target);
  return { url: target };
}

function requireConfiguredCliUrl(
  repo: Repository,
  target: string | undefined,
  push: boolean,
): void {
  if (target !== undefined && isHttpUrl(target)) return;
  const remote = target ?? "origin";
  const pushUrl = push ? repo.store.configGet(`remote.${remote}.pushurl`) : undefined;
  const url = pushUrl ?? repo.store.configGet(`remote.${remote}.url`);
  if (url !== undefined) requireCliHttpUrl(url);
}

function requireCliHttpUrl(value: string): void {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new GitError("EINVAL", "remote URL is invalid");
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new GitError("EURLSCHEME", "remote URL uses an unsupported scheme");
  }
  if (url.username !== "" || url.password !== "") {
    throw new GitError("EAUTH", "CLI credentials must be supplied through the network binding");
  }
}

function displayTarget(target: string): string {
  if (!isHttpUrl(target)) return target;
  try {
    const url = new URL(target);
    url.username = "";
    url.password = "";
    return url.toString().replace(/\/$/, "");
  } catch {
    return target;
  }
}

function isHttpUrl(value: string): boolean {
  return /^https?:/i.test(value);
}

function hasUrlScheme(value: string): boolean {
  return /^[a-z][a-z0-9+.-]*:/i.test(value);
}

function formatFetch(
  command: GitCliFetchCommand,
  result: Awaited<ReturnType<typeof fetchInto>>,
): string {
  const target = displayTarget(command.target ?? "origin");
  if (result.mode === "legacy") {
    return result.fetchHead === null
      ? `From ${target}\n`
      : `From ${target}\n * branch            ${command.selector ?? "HEAD"} -> FETCH_HEAD\n`;
  }
  let output = `From ${target}\n`;
  for (const update of result.updates)
    output += ` * [new ref]         ${update.source} -> ${update.destination}\n`;
  return output;
}

function pushLeases(command: GitCliPushCommand): Record<string, PushLeaseExpectation> | undefined {
  if (command.leases.length === 0) return undefined;
  const leases: Record<string, PushLeaseExpectation> = {};
  for (const lease of command.leases) {
    leases[lease.destination] = lease.tracking
      ? { tracking: true }
      : { expected: lease.expected ?? null };
  }
  return leases;
}

function formatPush(result: PushResult): string {
  let output = "";
  for (const ref of result.refs) {
    output += ref.ok
      ? `   ${ref.ref}\n`
      : ` ! [remote rejected] ${ref.ref} (${ref.error ?? "rejected"})\n`;
  }
  if (result.tracking.outcome === "failed") {
    output += `warning: tracking reconciliation failed: ${result.tracking.message}\n`;
  } else if (result.tracking.outcome === "stale" || result.tracking.outcome === "deferred") {
    output += `warning: tracking reconciliation ${result.tracking.outcome}\n`;
  }
  return output;
}

function networkFailure(error: unknown, output: NetworkOutput, published: boolean): GitCliResult {
  if (hasErrorCode(error, "EABORTED") || hasErrorCode(error, "EPUSHUNCERTAIN")) throw error;
  const overflow = errorByCode(error, "E2BIG");
  if (overflow !== null && !published) throw overflow;
  const mapped = mapFailure(error);
  if (published) {
    output.appendPublished(mapped.stderr);
    return output.published(mapped.exitCode);
  }
  output.appendStrict(mapped.stderr);
  return output.preflight(mapped.exitCode);
}

function errorByCode(error: unknown, code: string, depth = 0): unknown | null {
  if (depth > 4 || typeof error !== "object" || error === null) return null;
  if (hasErrorCode(error, code)) return error;
  return errorByCode(Reflect.get(error, "cause"), code, depth + 1);
}

class GitCliPushUncertainError extends GitError {
  constructor(
    cause: unknown,
    readonly result: GitCliResult,
  ) {
    super("EPUSHUNCERTAIN", errorMessage(cause), { cause });
    this.name = "GitCliPushUncertainError";
  }
}

function mapFailure(error: unknown): GitCliResult {
  if (
    typeof error !== "object" ||
    error === null ||
    !("code" in error) ||
    typeof error.code !== "string"
  )
    throw error;
  return gitCliResult("", `fatal: ${errorMessage(error)}\n`, 128);
}

function errorMessage(error: unknown): string {
  if (typeof error !== "object" || error === null) return "network operation failed";
  const message = Reflect.get(error, "message");
  if (typeof message === "string") return message;
  const code = Reflect.get(error, "code");
  return typeof code === "string" ? code : "network operation failed";
}

function* formatLsRemote(
  refs: readonly { readonly oid: string; readonly name: string }[],
): Generator<string> {
  for (const ref of refs) yield `${ref.oid}\t${ref.name}\n`;
}

function environmentRecord(
  environment: Parameters<NonNullable<GitCliHandlers["pull"]>>[0]["env"],
): Record<string, string> {
  const record: Record<string, string> = {};
  for (const [key, value] of Object.entries(environment))
    if (value !== undefined) record[key] = value;
  return record;
}

class NetworkOutput {
  #stderr = "";
  #bytes = 0;
  #truncated = false;

  constructor(
    private readonly options: ResolvedGitCliRunOptions,
    initial: string,
    private readonly failBeforePublication: boolean,
  ) {
    this.append(initial);
    if (!failBeforePublication) boundedGitCliResult(gitCliResult("", initial, 0), options);
  }

  append(value: string): void {
    if (this.options.discardStderr) return;
    const maximum = Math.min(this.options.maxStderrBytes, this.options.maxCombinedOutputBytes);
    const bytes = gitCliUtf8ByteLength(value, "git CLI network stderr", false);
    if (bytes <= maximum - this.#bytes) {
      this.#stderr += value;
      this.#bytes += bytes;
      return;
    }
    if (this.failBeforePublication) {
      throw new GitError("E2BIG", `git CLI stderr exceeds ${maximum} bytes`);
    }
    this.appendPublished(value);
  }

  appendPublished(value: string): void {
    if (this.options.discardStderr) return;
    const maximum = Math.min(this.options.maxStderrBytes, this.options.maxCombinedOutputBytes);
    const room = Math.max(0, maximum - this.#bytes);
    const prefix = utf8Prefix(value, room);
    this.#stderr += prefix;
    this.#bytes += gitCliUtf8ByteLength(prefix, "git CLI network stderr", false);
    if (prefix !== value) this.#truncated = true;
  }

  appendStrict(value: string): void {
    if (this.options.discardStderr) return;
    const maximum = Math.min(this.options.maxStderrBytes, this.options.maxCombinedOutputBytes);
    const bytes = gitCliUtf8ByteLength(value, "git CLI network stderr", false);
    if (bytes > maximum - this.#bytes) {
      throw new GitError("E2BIG", `git CLI stderr exceeds ${maximum} bytes`);
    }
    this.#stderr += value;
    this.#bytes += bytes;
  }

  preflight(exitCode: number): GitCliResult {
    return boundedGitCliResult(gitCliResult("", this.#stderr, exitCode), this.options);
  }

  published(exitCode: number): GitCliResult {
    return boundedPublishedGitCliResult(
      { stdout: "", stderr: this.#stderr, exitCode, truncated: this.#truncated },
      this.options,
    );
  }
}

function utf8Prefix(value: string, maximum: number): string {
  if (gitCliUtf8ByteLength(value, "git CLI network output", false) <= maximum) return value;
  const bytes = new TextEncoder().encode(value);
  const decoder = new TextDecoder("utf-8", { fatal: true });
  for (let end = Math.min(maximum, bytes.length); end >= 0; end--) {
    try {
      return decoder.decode(bytes.subarray(0, end));
    } catch {
      // Continue to the prior complete UTF-8 boundary.
    }
  }
  return "";
}
