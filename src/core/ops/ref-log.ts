// Typed operation metadata for the atomic ref-mutation seam.

import type {
  RefLogActor,
  RefLogEntry,
  RefLogMetadata,
  RefLogReadOptions as StoreRefLogReadOptions,
} from "../../sqlite/store.js";
import type { GitContext, GitIdentity } from "../context.js";
import { GitError, hasErrorCode, ObjectNotFoundError, RefNotFoundError } from "../errors.js";
import type { Person } from "../objects.js";
import type { Repository } from "../repository.js";

const MAX_IDENTITY_BYTES = 1_024;
export const MAX_CONFIGURED_REFLOG_IDENTITY_SQL_STATEMENTS = 4;

export type RefLogReason =
  | "commit (initial)"
  | "commit"
  | "commit (amend)"
  | "branch: create"
  | "branch: reset"
  | "branch: delete"
  | "tag: create"
  | "tag: update"
  | "tag: delete"
  | "checkout"
  | "reset: hard"
  | "merge: fast-forward"
  | "merge: commit"
  | "pull: fast-forward"
  | "pull: merge"
  | "cherry-pick"
  | "revert"
  | "rebase: fast-forward"
  | "rebase: replay"
  | "fetch"
  | "clone: fetch"
  | "clone: checkout"
  | "push"
  | "update-ref"
  | "recover-ref";

export interface OptionalRefLogIdentity {
  identity?: GitIdentity;
  env?: Record<string, string>;
}

export type { RefLogEntry } from "../../sqlite/store.js";

export interface RefLogReadOptions extends StoreRefLogReadOptions {
  /** Exact stored ref name. Defaults to HEAD. */
  ref?: string;
}

export type RefLogEndpoint = "old" | "new";

export interface RefLogRecoverySource {
  ref: string;
  ordinal: number;
  endpoint: RefLogEndpoint;
}

export interface RecoverRefOptions {
  /** Direct destination under refs/. */
  ref: string;
  source: RefLogRecoverySource;
  /** Exact raw destination value observed by the caller, including absence. */
  expectedCurrent: string | null;
}

export function reflog(repo: Repository, options: RefLogReadOptions = {}): RefLogEntry[] {
  return repo.reflog(options.ref ?? "HEAD", {
    limit: options.limit ?? 100,
    before: options.before,
  });
}

export function recoverRef(
  context: GitContext,
  repo: Repository,
  options: RecoverRefOptions,
): void {
  if (!options.ref.startsWith("refs/") || options.ref.length === "refs/".length) {
    throw new GitError("EINVAL", "recovery destination must be a direct refs/* name");
  }
  if (
    typeof options.source !== "object" ||
    options.source === null ||
    typeof options.source.ref !== "string" ||
    options.source.ref === "" ||
    !Number.isSafeInteger(options.source.ordinal) ||
    options.source.ordinal < 1 ||
    (options.source.endpoint !== "old" && options.source.endpoint !== "new")
  ) {
    throw new GitError("EINVAL", "reflog recovery source is invalid");
  }

  repo.store.db.transactionSync(() => {
    repo.checkout.requireNoOperationState();
    const entry = repo
      .reflog(options.source.ref)
      .find((candidate) => candidate.ordinal === options.source.ordinal);
    if (entry === undefined) {
      throw new RefNotFoundError(`${options.source.ref}@{${options.source.ordinal}}`);
    }
    const oid = options.source.endpoint === "old" ? entry.oldOid : entry.newOid;
    if (oid === null) {
      throw new RefNotFoundError(`${options.source.ref}@{${options.source.ordinal}}`);
    }
    if (!repo.has(oid)) throw new ObjectNotFoundError(oid);
    const changed = repo.mutateRefs(
      {
        puts: [{ name: options.ref, target: oid }],
        expected: { name: options.ref, target: options.expectedCurrent },
      },
      operationRefLogMetadata(context, repo, "recover-ref"),
    );
    if (!changed) throw new GitError("EINVAL", `ref ${options.ref} already has the selected value`);
  });
}

/** Best optional actor, followed by a timestamp captured at publication. */
export function operationRefLogMetadata(
  context: GitContext,
  repo: Repository,
  reason: RefLogReason,
  sources: OptionalRefLogIdentity = {},
): RefLogMetadata {
  const env = sources.env ?? {};
  let actor = validActor(sources.identity);
  actor ??= validActor({
    name: env.GIT_COMMITTER_NAME ?? env.GIT_AUTHOR_NAME,
    email: env.GIT_COMMITTER_EMAIL ?? env.GIT_AUTHOR_EMAIL,
  });
  actor ??= configuredIdentity(repo);
  actor ??= validActor(context.defaultIdentity);
  return stampedMetadata(context, actor, reason);
}

/** Reuse the exact committer stamp that became part of a published commit. */
export function committerRefLogMetadata(committer: Person, reason: RefLogReason): RefLogMetadata {
  return {
    actor: { name: committer.name, email: committer.email },
    timestamp: committer.timestamp,
    timezoneOffset: committer.timezoneOffset,
    reason,
  };
}

/** Keep a journaled actor stable across restart while stamping publication now. */
export function persistedRefLogMetadata(
  context: GitContext,
  identity: GitIdentity | null,
  reason: RefLogReason,
): RefLogMetadata {
  return stampedMetadata(context, validActor(identity), reason);
}

function stampedMetadata(
  context: GitContext,
  actor: RefLogActor | null,
  reason: RefLogReason,
): RefLogMetadata {
  return {
    actor,
    timestamp: Math.floor(context.now() / 1_000),
    timezoneOffset: context.timezoneOffset(),
    reason,
  };
}

function configuredIdentity(repo: Repository): RefLogActor | null {
  let name: string | undefined;
  let email: string | undefined;
  try {
    name = repo.store.configGetBounded("user.name", MAX_IDENTITY_BYTES);
    email = repo.store.configGetBounded("user.email", MAX_IDENTITY_BYTES);
  } catch (error) {
    // Oversized optional identity is absent; structural SQL corruption is not.
    if (hasErrorCode(error, "E2BIG")) return null;
    throw error;
  }
  return validActor({ name, email });
}

function validActor(
  identity: { name?: string; email?: string } | undefined | null,
): RefLogActor | null {
  if (identity === undefined || identity === null) return null;
  if (!validIdentityText(identity.name) || !validIdentityText(identity.email)) return null;
  return { name: identity.name, email: identity.email };
}

function validIdentityText(value: string | undefined): value is string {
  if (value === undefined || value === "") return false;
  let bytes = 0;
  for (let index = 0; index < value.length; index++) {
    const unit = value.charCodeAt(index);
    if (unit === 0 || unit === 0x0a || unit === 0x0d || unit === 0x3c || unit === 0x3e) {
      return false;
    }
    if (unit >= 0xd800 && unit <= 0xdbff) {
      const low = value.charCodeAt(index + 1);
      if (low < 0xdc00 || low > 0xdfff) return false;
      index++;
      bytes += 4;
    } else if (unit >= 0xdc00 && unit <= 0xdfff) return false;
    else bytes += unit < 0x80 ? 1 : unit < 0x800 ? 2 : 3;
    if (bytes > MAX_IDENTITY_BYTES) return false;
  }
  return true;
}
