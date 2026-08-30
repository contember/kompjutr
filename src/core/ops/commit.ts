// Recording a commit: the index becomes trees, the trees become a commit,
// and the ref HEAD points at moves to it.

import type { MemoryReservation } from "../../memory.js";
import { snapshotCommitTreeOwned } from "../../sqlite/sparse-workspace.js";
import {
  configGetOwned,
  createRefMutationMemoryOwner,
  indexScanOwned,
  type RefMutationMemoryOwner,
  writeObjectsOwned,
} from "../../sqlite/store.js";
import type { GitContext, GitIdentity } from "../context.js";
import { GitError, hasErrorCode, MissingIdentityError } from "../errors.js";
import { type Commit, hashObject, type Person, serializeCommit } from "../objects.js";
import { type Repository, type ResolvedHead, resolveHeadOwned } from "../repository.js";
import { retainedStringBytes } from "../retained.js";
import type { CommitResult } from "./kinds.js";
import { committerRefLogMetadata, type RefLogReason } from "./ref-log.js";
import {
  buildTreeInBatch,
  planSparseTreeBuild,
  type SparseTreeBuildPlan,
  writeSparseTreePlanInBatch,
} from "./tree-build.js";

const EMPTY_TREE_OID = hashObject("tree", new Uint8Array());

/** Native commit options; Computer-compatible fields plus explicit empty-commit policy. */
export interface CommitOptions {
  message: string;
  author?: GitIdentity;
  committer?: GitIdentity;
  amend?: boolean;
  /** Permit an ordinary commit whose tree is identical to its first parent. */
  allowEmpty?: boolean;
  /** Read for GIT_AUTHOR_* / GIT_COMMITTER_*; never pulled from `process.env`. */
  env?: Record<string, string>;
}

export interface CommitIdentities {
  author: Person;
  committer: Person;
}

export interface IndexedCommitOptions {
  message: string;
  parent: readonly string[];
  identities: CommitIdentities;
  expectedHead: ResolvedHead;
  refLogReason: RefLogReason;
}

export interface UnpublishedCommitOptions {
  message: string;
  parent: readonly string[];
  identities: CommitIdentities;
}

export interface UnpublishedCommitResult {
  oid: string;
  tree: string;
}

type CommitMessage = { mode: "clean"; value: string } | { mode: "exact"; value: string };
type PublishedCommitContext = Pick<GitContext, "commitTrees" | "indexTracker">;

const COMMIT_OPERATION_FIXED_BYTES = 1_024;
const COMMIT_VALUE_FIXED_BYTES = 256;
const COMMIT_OPERATION_VALUE_COUNT = 12;
const COMMIT_ARRAY_FIXED_BYTES = 64;
const COMMIT_ARRAY_SLOT_BYTES = 8;

export function commit(
  context: GitContext,
  repo: Repository,
  options: CommitOptions,
): CommitResult {
  const owner = createRefMutationMemoryOwner(repo.store);
  const lifetime = owner.memoryReservation().scope();
  try {
    validatePublishedMessage(options.message, lifetime);
    lifetime.set("commit", commitLifetimeBytes(0));
    return repo.store.db.transactionSync(() => {
      if (repo.checkout.hasConflicts()) {
        throw new GitError("EUNMERGED", "cannot commit: the index has unmerged paths");
      }

      const head = resolveHeadOwned(repo, owner);
      const amended =
        options.amend === true ? readAmended(repo, head, owner.memoryReservation()) : undefined;
      const parentCount = amended?.parent.length ?? (head.oid === null ? 0 : 1);
      lifetime.set("commit", commitLifetimeBytes(parentCount));
      const parent = amended !== undefined ? amended.parent : head.oid === null ? [] : [head.oid];
      retainParents(owner, parent);
      const headTree = ownNullable(
        owner,
        amended?.tree ??
          (head.oid === null
            ? null
            : readCommitOwned(repo, head.oid, owner.memoryReservation()).tree),
      );
      const baselineTree =
        amended !== undefined ? undefined : headTree === null ? EMPTY_TREE_OID : headTree;
      const identities = ownIdentities(
        owner,
        resolveIdentityOwned(context, repo, options, amended, owner),
      );
      const message = cleanPublishedMessage(owner, options.message);
      const result = ownCommitResult(
        owner,
        writeCommitObjects(
          repo,
          { parent, identities },
          { mode: "exact", value: message },
          context,
          headTree,
          owner.memoryReservation(),
        ),
      );
      if (
        baselineTree !== undefined &&
        options.allowEmpty !== true &&
        result.tree === baselineTree
      ) {
        throw new GitError("EEMPTYCOMMIT", "cannot commit: the index tree is unchanged");
      }
      const reason: RefLogReason =
        options.amend === true
          ? "commit (amend)"
          : head.oid === null
            ? "commit (initial)"
            : "commit";
      return publishCommitResult(
        repo,
        head,
        result,
        ownRefLogMetadata(owner, committerRefLogMetadata(identities.committer, reason)),
        context,
        owner,
      );
    });
  } finally {
    lifetime.dispose();
    owner.dispose();
  }
}

/** Build the stage-zero index and move only the HEAD observed by the caller. */
export function commitIndex(
  repo: Repository,
  options: IndexedCommitOptions,
  context?: PublishedCommitContext,
): CommitResult {
  const owner = createRefMutationMemoryOwner(repo.store);
  const lifetime = owner.memoryReservation().scope();
  try {
    validatePublishedMessage(options.message, lifetime);
    retainParents(owner, options.parent);
    ownIdentities(owner, options.identities);
    retainResolvedHead(owner, options.expectedHead);
    lifetime.set("commit", commitLifetimeBytes(options.parent.length));
    return repo.store.db.transactionSync(() => {
      const head = resolveHeadOwned(repo, owner);
      if (head.ref !== options.expectedHead.ref || head.oid !== options.expectedHead.oid) {
        throw new GitError("ESTALEHEAD", "HEAD changed while the commit was being prepared");
      }
      const headTree = ownNullable(
        owner,
        head.oid === null ? null : readCommitOwned(repo, head.oid, owner.memoryReservation()).tree,
      );
      return publishCommit(repo, options, context, headTree, owner);
    });
  } finally {
    lifetime.dispose();
    owner.dispose();
  }
}

/** Caller owns the transaction; this writes authoritative objects but never publishes a ref. */
export function writeUnpublishedCommit(
  repo: Repository,
  options: UnpublishedCommitOptions,
): UnpublishedCommitResult {
  return writeCommitObjects(repo, options, { mode: "exact", value: options.message });
}

/** Caller owns the transaction and has authenticated the explicit tree and parents. */
export function writeUnpublishedCommitFromTree(
  repo: Repository,
  tree: string,
  options: UnpublishedCommitOptions,
  owningReservation?: MemoryReservation,
): string {
  const reservation = owningReservation ?? repo.store.reserveMemory();
  try {
    return writeObjectsOwned(repo.store, reservation, (batch) =>
      writeSerializedCommit(
        batch.write,
        options,
        { mode: "exact", value: options.message },
        tree,
        reservation,
      ),
    );
  } finally {
    if (owningReservation === undefined) reservation.dispose();
  }
}

/** Materialize the stage-zero index through one shared object encoder. */
function writeCommitObjects(
  repo: Repository,
  options: Pick<UnpublishedCommitOptions, "parent" | "identities">,
  message: CommitMessage,
  context?: PublishedCommitContext,
  baselineTreeOid?: string | null,
  owningReservation?: MemoryReservation,
): UnpublishedCommitResult {
  const reservation = owningReservation ?? repo.store.reserveMemory();
  try {
    const sparse =
      context === undefined || baselineTreeOid === undefined
        ? null
        : sparseTreePlan(context, repo, baselineTreeOid, reservation);
    if (sparse !== null) {
      const tree = sparse.tree;
      return writeObjectsOwned(repo.store, reservation, (batch) => {
        writeSparseTreePlanInBatch(batch, sparse);
        return {
          oid: writeSerializedCommit(batch.write, options, message, tree, reservation),
          tree,
        };
      });
    }
    // A paged scan, so the index never exists as one array alongside the build.
    return writeObjectsOwned(repo.store, reservation, (batch) => {
      const tree = buildTreeInBatch(
        batch,
        indexScanOwned(repo.checkout, reservation, { pageSize: 2048 }),
        reservation,
      );
      const oid = writeSerializedCommit(batch.write, options, message, tree, reservation);
      return { oid, tree };
    });
  } finally {
    if (owningReservation === undefined) reservation.dispose();
  }
}

function writeSerializedCommit(
  write: (type: "commit", data: Uint8Array) => string,
  options: Pick<UnpublishedCommitOptions, "parent" | "identities">,
  message: CommitMessage,
  tree: string,
  reservation: MemoryReservation,
): string {
  const serialization = reservation.scope();
  try {
    serialization.set("commit", commitSerializationBytes(options, message.value, tree));
    return write("commit", serializedCommit(options, message, tree));
  } finally {
    serialization.dispose();
  }
}

function serializedCommit(
  options: Pick<UnpublishedCommitOptions, "parent" | "identities">,
  message: CommitMessage,
  tree: string,
): Uint8Array {
  return serializeCommit({
    tree,
    parent: [...options.parent],
    author: options.identities.author,
    committer: options.identities.committer,
    message: message.mode === "clean" ? cleanMessage(message.value) : message.value,
  });
}

function sparseTreePlan(
  context: PublishedCommitContext,
  repo: Repository,
  baselineTreeOid: string | null,
  reservation: MemoryReservation,
): Extract<SparseTreeBuildPlan, { available: true }> | null {
  const source = context.commitTrees;
  if (source === undefined) return null;
  try {
    const snapshot = snapshotCommitTreeOwned(
      source,
      {
        repoId: repo.store.repoId,
        checkoutId: repo.checkout.checkoutId,
        root: repo.root,
        baselineTreeOid,
      },
      reservation,
    );
    if (!snapshot.available) return null;
    const plan = planSparseTreeBuild(snapshot, baselineTreeOid, reservation);
    return plan.available ? plan : null;
  } catch (error) {
    if (hasErrorCode(error, "E2BIG")) return null;
    throw error;
  }
}

/** Caller owns the transaction and has already validated `expectedHead`. */
function publishCommit(
  repo: Repository,
  options: IndexedCommitOptions,
  context: PublishedCommitContext | undefined,
  baselineTreeOid: string | null,
  owner: RefMutationMemoryOwner,
): CommitResult {
  const message = cleanPublishedMessage(owner, options.message);
  const result = ownCommitResult(
    owner,
    writeCommitObjects(
      repo,
      options,
      { mode: "exact", value: message },
      context,
      baselineTreeOid,
      owner.memoryReservation(),
    ),
  );
  return publishCommitResult(
    repo,
    options.expectedHead,
    result,
    ownRefLogMetadata(
      owner,
      committerRefLogMetadata(options.identities.committer, options.refLogReason),
    ),
    context,
    owner,
  );
}

function publishCommitResult(
  repo: Repository,
  expectedHead: ResolvedHead,
  result: UnpublishedCommitResult,
  metadata: ReturnType<typeof committerRefLogMetadata>,
  context: PublishedCommitContext | undefined,
  owner: RefMutationMemoryOwner,
): CommitResult {
  // A symbolic HEAD on an unborn branch creates the branch here.
  if (expectedHead.ref === null) {
    repo.mutateRefs({ head: result.oid }, metadata, owner);
  } else {
    repo.mutateRefs({ puts: [{ name: expectedHead.ref, target: result.oid }] }, metadata, owner);
  }
  // A false result leaves the prior baseline mismatched, so sparse readers safely use full scans.
  context?.indexTracker?.advanceBaseline?.(repo.checkout.checkoutId, result.tree);
  return { oid: result.oid };
}

function validatePublishedMessage(message: string, reservation: MemoryReservation): void {
  const validation = reservation.scope();
  try {
    validation.set("commit", checkedCommitBytes(256, 2 * retainedStringBytes(message)));
    if (message.trim() === "") throw new GitError("EMSG", "commit message is required");
  } finally {
    validation.dispose();
  }
}

function cleanPublishedMessage(owner: RefMutationMemoryOwner, message: string): string {
  const transient = owner.memoryReservation().scope();
  try {
    transient.set(
      "commit",
      checkedCommitBytes(512, 4 * retainedStringBytes(message), 3 * (message.length + 1)),
    );
    return owner.construct(message.length + 1, () => cleanMessage(message));
  } finally {
    transient.dispose();
  }
}

function ownCommitResult(
  owner: RefMutationMemoryOwner,
  result: UnpublishedCommitResult,
): UnpublishedCommitResult {
  return { oid: ownString(owner, result.oid), tree: ownString(owner, result.tree) };
}

function retainResolvedHead(owner: RefMutationMemoryOwner, head: ResolvedHead): void {
  ownNullable(owner, head.ref);
  ownNullable(owner, head.oid);
}

function ownIdentities(
  owner: RefMutationMemoryOwner,
  identities: CommitIdentities,
): CommitIdentities {
  ownPerson(owner, identities.author);
  ownPerson(owner, identities.committer);
  return identities;
}

function ownPerson(owner: RefMutationMemoryOwner, person: Person): void {
  ownString(owner, person.name);
  ownString(owner, person.email);
}

function retainParents(owner: RefMutationMemoryOwner, parents: readonly string[]): void {
  for (const parent of parents) ownString(owner, parent);
}

function ownRefLogMetadata(
  owner: RefMutationMemoryOwner,
  metadata: ReturnType<typeof committerRefLogMetadata>,
): ReturnType<typeof committerRefLogMetadata> {
  ownString(owner, metadata.reason);
  if (metadata.actor !== null) {
    ownString(owner, metadata.actor.name);
    ownString(owner, metadata.actor.email);
  }
  return metadata;
}

function ownNullable(owner: RefMutationMemoryOwner, value: string | null): string | null {
  return value === null ? null : ownString(owner, value);
}

function ownString(owner: RefMutationMemoryOwner, value: string): string {
  return owner.owns(value) ? value : owner.retain(value);
}

function commitLifetimeBytes(parentCount: number): number {
  return checkedCommitBytes(
    COMMIT_OPERATION_FIXED_BYTES,
    COMMIT_OPERATION_VALUE_COUNT * COMMIT_VALUE_FIXED_BYTES,
    2 * COMMIT_ARRAY_FIXED_BYTES,
    2 * parentCount * COMMIT_ARRAY_SLOT_BYTES,
  );
}

function commitSerializationBytes(
  options: Pick<UnpublishedCommitOptions, "parent" | "identities">,
  message: string,
  tree: string,
): number {
  const textUnits =
    256 +
    tree.length +
    message.length +
    options.identities.author.name.length +
    options.identities.author.email.length +
    options.identities.committer.name.length +
    options.identities.committer.email.length +
    options.parent.reduce((units, parent) => units + parent.length + 8, 0);
  return checkedCommitBytes(
    1_024,
    checkedCommitProduct(4, checkedCommitBytes(48, checkedCommitProduct(2, textUnits))),
    checkedCommitProduct(3, textUnits),
    (options.parent.length + 8) * COMMIT_ARRAY_SLOT_BYTES,
  );
}

function readCommitOwned(repo: Repository, oid: string, reservation: MemoryReservation): Commit {
  return repo.readAuthenticatedCommitOwned(oid, reservation);
}

function checkedCommitProduct(left: number, right: number): number {
  if (
    !Number.isSafeInteger(left) ||
    left < 0 ||
    !Number.isSafeInteger(right) ||
    right < 0 ||
    (left !== 0 && right > Math.floor(Number.MAX_SAFE_INTEGER / left))
  ) {
    throw new GitError("E2BIG", "commit memory accounting overflows");
  }
  return left * right;
}

function checkedCommitBytes(...values: number[]): number {
  let total = 0;
  for (const value of values) {
    if (!Number.isSafeInteger(value) || value < 0 || value > Number.MAX_SAFE_INTEGER - total) {
      throw new GitError("E2BIG", "commit memory accounting overflows");
    }
    total += value;
  }
  return total;
}

/**
 * Author and committer, in the precedence Computer documents: explicit
 * option, then `env`, then local `user.name` / `user.email`, then
 * `context.defaultIdentity`. There is no global `~/.gitconfig` fallback.
 *
 * Amending inserts the amended commit's own author just below the explicit
 * option and keeps its author date, the way `git commit --amend` does; the
 * committer is always re-stamped with the current time.
 */
export function resolveIdentity(
  context: GitContext,
  repo: Repository,
  options: Pick<CommitOptions, "author" | "committer" | "env">,
  amended?: Commit,
  maxIdentityBytes?: number,
): CommitIdentities {
  const sources = identitySources(context, options, amended);
  const config =
    maxIdentityBytes !== undefined &&
    sources.authorBeforeConfig !== null &&
    sources.committerBeforeConfig !== null
      ? null
      : identityOf(
          maxIdentityBytes === undefined
            ? repo.store.configGet("user.name")
            : repo.store.configGetBounded("user.name", maxIdentityBytes),
          maxIdentityBytes === undefined
            ? repo.store.configGet("user.email")
            : repo.store.configGetBounded("user.email", maxIdentityBytes),
        );
  return completeIdentity(context, amended, sources, config);
}

export function resolveIdentityOwned(
  context: GitContext,
  repo: Repository,
  options: Pick<CommitOptions, "author" | "committer" | "env">,
  amended: Commit | undefined,
  owner: RefMutationMemoryOwner,
): CommitIdentities {
  const sources = identitySources(context, options, amended);
  const config =
    sources.authorBeforeConfig !== null && sources.committerBeforeConfig !== null
      ? null
      : identityOf(
          configGetOwned(repo.store, "user.name", owner),
          configGetOwned(repo.store, "user.email", owner),
        );
  return ownIdentities(owner, completeIdentity(context, amended, sources, config));
}

interface IdentitySources {
  authorBeforeConfig: GitIdentity | null;
  committerBeforeConfig: GitIdentity | null;
  fallback: GitIdentity | null;
}

function identitySources(
  context: GitContext,
  options: Pick<CommitOptions, "author" | "committer" | "env">,
  amended?: Commit,
): IdentitySources {
  const env = options.env ?? {};
  const explicitAuthor = identityOf(options.author?.name, options.author?.email);
  const amendedAuthor = identityOf(amended?.author.name, amended?.author.email);
  const environmentAuthor = identityOf(env.GIT_AUTHOR_NAME, env.GIT_AUTHOR_EMAIL);
  const explicitCommitter = identityOf(options.committer?.name, options.committer?.email);
  const environmentCommitter = identityOf(
    env.GIT_COMMITTER_NAME ?? env.GIT_AUTHOR_NAME,
    env.GIT_COMMITTER_EMAIL ?? env.GIT_AUTHOR_EMAIL,
  );
  const authorBeforeConfig = explicitAuthor ?? amendedAuthor ?? environmentAuthor;
  const committerBeforeConfig = explicitCommitter ?? environmentCommitter;
  const fallback = identityOf(context.defaultIdentity?.name, context.defaultIdentity?.email);
  return { authorBeforeConfig, committerBeforeConfig, fallback };
}

function completeIdentity(
  context: GitContext,
  amended: Commit | undefined,
  sources: IdentitySources,
  config: GitIdentity | null,
): CommitIdentities {
  const author = sources.authorBeforeConfig ?? config ?? sources.fallback;
  if (author === null) throw new MissingIdentityError();

  const committer = sources.committerBeforeConfig ?? config ?? sources.fallback ?? author;

  const now = stamp(context);
  return {
    author: {
      ...author,
      timestamp: amended?.author.timestamp ?? now.timestamp,
      timezoneOffset: amended?.author.timezoneOffset ?? now.timezoneOffset,
    },
    committer: { ...committer, ...now },
  };
}

function readAmended(repo: Repository, head: ResolvedHead, reservation: MemoryReservation): Commit {
  if (head.oid === null) {
    throw new GitError("ENOCOMMIT", "cannot amend: HEAD does not point at a commit yet");
  }
  return readCommitOwned(repo, head.oid, reservation);
}

/** A source only wins when it supplies both halves of an identity. */
function identityOf(name: string | undefined, email: string | undefined): GitIdentity | null {
  if (name === undefined || name === "" || email === undefined || email === "") return null;
  return { name, email };
}

function stamp(context: GitContext): { timestamp: number; timezoneOffset: number } {
  return {
    timestamp: Math.floor(context.now() / 1000),
    timezoneOffset: context.timezoneOffset(),
  };
}

/** git's message cleanup: no CRs, no surrounding blank lines, exactly one trailing newline. */
function cleanMessage(message: string): string {
  return `${message.replace(/\r/g, "").replace(/^\n+/, "").replace(/\n+$/, "")}\n`;
}
