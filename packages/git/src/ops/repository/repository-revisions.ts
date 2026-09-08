import { isAbbreviatedOid, isOid } from "../../common/bytes.js";
import {
  CorruptError,
  GitError,
  ObjectNotFoundError,
  RefNotFoundError,
} from "../../common/errors.js";
import {
  type Commit,
  type ObjectType,
  parseCommit,
  parseTag,
  parseTree,
  type RawObject,
  type TreeEntry,
  typeForMode,
} from "../../common/objects.js";
import type { CheckoutStore, SharedRepoStore } from "../../store/index.js";

const MAX_REVISION_TRAVERSALS = 32;
const MAX_HEAD_REFLOG_INDEX = 1_023;

function boundedDecimal(digits: string, maximum: number): number | null {
  if (digits === "") return null;
  let value = 0;
  for (let index = 0; index < digits.length; index++) {
    const digit = digits.charCodeAt(index) - 0x30;
    if (digit < 0 || digit > 9) return null;
    if (value > Math.floor((maximum - digit) / 10)) return null;
    value = value * 10 + digit;
  }
  return value;
}

export interface RevisionResolution {
  oid: string;
  /** Present only for `<revision>:<path>` resolution. */
  mode?: string;
}

interface RevisionState {
  oid: string;
  /** Stored metadata or a previously-read object promises this oid exists. */
  promised: boolean;
  /** A bare resolved ref or prefix must still authenticate its final oid. */
  verifyFinal?: boolean;
  /** Authenticated metadata retained when payload bytes are unnecessary. */
  type?: ObjectType;
  /** One authenticated current object avoids repeating a suffix read. */
  object?: RawObject;
}

interface RevisionStateResolution {
  state: RevisionState;
  mode?: string;
}

type RevisionSuffix =
  | { kind: "ancestor"; count: number }
  | { kind: "parent"; which: number }
  | { kind: "peel"; want: ObjectType | null };

interface RevisionRepository {
  readonly checkout: Pick<CheckoutStore, "reflog">;
  readonly store: Pick<
    SharedRepoStore,
    "promisedMissing" | "read" | "resolvePrefix" | "typeAndSize"
  >;
  peel(oid: string, want?: ObjectType): string;
  readCommit(oid: string): Commit;
  resolveRef(name: string): string | null;
  resolveTreePath(treeOid: string, path: string): TreeEntry | null;
  typeOf(oid: string): ObjectType;
}

/** Resolve the bounded `gitrevisions(7)` subset and retain path mode. */
export function resolveRevision(repo: RevisionRepository, expression: string): RevisionResolution {
  const resolved = tryResolveRevision(repo, expression);
  if (resolved === undefined) throw new RefNotFoundError(expression);
  return resolved;
}

/** Return undefined only when a syntactically valid revision is absent. */
export function tryResolveRevision(
  repo: RevisionRepository,
  expression: string,
): RevisionResolution | undefined {
  const resolved = tryResolveRevisionState(repo, expression);
  if (resolved === undefined) return undefined;
  return resolved.mode === undefined
    ? { oid: resolved.state.oid }
    : { oid: resolved.state.oid, mode: resolved.mode };
}

/** Resolve one tree-ish without repeating suffix authentication in its caller. */
export function resolveTreeRevision(repo: RevisionRepository, expression: string): string {
  const resolved = tryResolveRevisionState(repo, expression);
  if (resolved === undefined) throw new RefNotFoundError(expression);
  const state = resolved.state;
  let type =
    resolved.mode === undefined ? (state.object?.type ?? state.type) : typeForMode(resolved.mode);
  if (type === undefined) {
    const metadata = repo.store.typeAndSize(state.oid);
    if (metadata === null) throw new ObjectNotFoundError(state.oid);
    type = metadata.type;
  }
  if (type === "tree") return state.oid;
  if (type === "commit") {
    return state.object === undefined
      ? repo.readCommit(state.oid).tree
      : parseCommit(state.object.data).tree;
  }
  if (type === "tag") {
    const peeled = repo.peel(state.oid, "commit");
    const peeledType = repo.typeOf(peeled);
    if (peeledType === "tree") return peeled;
    if (peeledType === "commit") return repo.readCommit(peeled).tree;
  }
  throw new ObjectNotFoundError(state.oid);
}

function tryResolveRevisionState(
  repo: RevisionRepository,
  expression: string,
): RevisionStateResolution | undefined {
  const trimmed = expression.trim();
  if (trimmed === "") return undefined;

  const colon = trimmed.indexOf(":");
  const revision = colon === -1 ? trimmed : trimmed.slice(0, colon);
  const path = colon === -1 ? undefined : trimmed.slice(colon + 1);
  if (revision === "") throw invalidRevision(expression);

  let split = revision.length;
  for (let index = 0; index < revision.length; index++) {
    const char = revision[index]!;
    if (char === "^" || char === "~") {
      split = index;
      break;
    }
  }
  const base = revision.slice(0, split);
  const suffix = revision.slice(split);
  const operations = parseRevisionSuffix(suffix, expression);

  let state = resolveRevisionBase(repo, base, expression);
  if (state === undefined) return undefined;
  for (const operation of operations) {
    if (operation.kind === "peel") {
      state = peelRevision(repo, state, operation.want, expression);
      if (state === undefined) return undefined;
      continue;
    }
    if (operation.kind === "ancestor") {
      state = peelRevision(repo, state, "commit", expression);
      if (state === undefined) return undefined;
      for (let index = 0; index < operation.count; index++) {
        const parent = revisionParent(repo, state, 1, expression);
        if (parent === undefined) return undefined;
        state = parent;
      }
      continue;
    }
    if (operation.which === 0) {
      state = peelRevision(repo, state, "commit", expression);
      if (state === undefined) return undefined;
      continue;
    }
    const parent = revisionParent(repo, state, operation.which, expression);
    if (parent === undefined) return undefined;
    state = parent;
  }

  if (path !== undefined) return resolveRevisionPath(repo, state, path, expression);
  if (state.verifyFinal === true && state.object === undefined) {
    const metadata = repo.store.typeAndSize(state.oid);
    if (metadata === null) throw new ObjectNotFoundError(state.oid);
    state = { ...state, type: metadata.type };
  }
  return { state };
}

function parseRevisionSuffix(suffix: string, expression: string): RevisionSuffix[] {
  const operations: RevisionSuffix[] = [];
  let position = 0;
  let traversals = 0;
  const reserve = (count: number): void => {
    if (count > MAX_REVISION_TRAVERSALS - traversals) {
      throw new GitError("E2BIG", "revision expression exceeds 32 traversal operations");
    }
    traversals += count;
  };
  while (position < suffix.length) {
    const operator = suffix[position++]!;
    if (operator !== "^" && operator !== "~") throw invalidRevision(expression);
    if (operator === "^" && suffix[position] === "{") {
      const close = suffix.indexOf("}", position + 1);
      if (close === -1) throw invalidRevision(expression);
      const type = suffix.slice(position + 1, close);
      if (
        type !== "" &&
        type !== "commit" &&
        type !== "tree" &&
        type !== "blob" &&
        type !== "tag"
      ) {
        throw invalidRevision(expression);
      }
      reserve(1);
      operations.push({ kind: "peel", want: type === "" ? null : type });
      position = close + 1;
      continue;
    }
    const digitsStart = position;
    while (position < suffix.length && suffix[position]! >= "0" && suffix[position]! <= "9") {
      position++;
    }
    const digits = suffix.slice(digitsStart, position);
    const value = digits === "" ? 1 : boundedDecimal(digits, Number.MAX_SAFE_INTEGER);
    if (value === null) {
      throw new GitError("E2BIG", "revision expression exceeds 32 traversal operations");
    }
    if (operator === "~") {
      reserve(Math.max(1, value));
      operations.push({ kind: "ancestor", count: value });
    } else {
      reserve(1);
      operations.push({ kind: "parent", which: value });
    }
  }
  return operations;
}

function resolveRevisionBase(
  repo: RevisionRepository,
  base: string,
  expression: string,
): RevisionState | undefined {
  if (base === "") throw invalidRevision(expression);
  const selectorStart = base.indexOf("@{");
  if (selectorStart !== -1) {
    if (!base.startsWith("HEAD@{") || !base.endsWith("}")) {
      throw new RefNotFoundError(expression);
    }
    const digits = base.slice(6, -1);
    const index = boundedDecimal(digits, MAX_HEAD_REFLOG_INDEX);
    if (index === null) throw new RefNotFoundError(expression);
    const entry = repo.checkout.reflog("HEAD")[index];
    if (entry?.newOid === undefined || entry.newOid === null) return undefined;
    return { oid: entry.newOid, promised: true };
  }
  const oid = repo.resolveRef(base);
  if (oid !== null) return { oid, promised: true, verifyFinal: true };
  if (isOid(base)) return { oid: base, promised: false };
  if (isAbbreviatedOid(base)) {
    const resolved = repo.store.resolvePrefix(base);
    if (resolved !== null) return { oid: resolved, promised: true, verifyFinal: true };
  }
  return undefined;
}

function revisionParent(
  repo: RevisionRepository,
  state: RevisionState,
  which: number,
  expression: string,
): RevisionState | undefined {
  const commitState = peelRevision(repo, state, "commit", expression);
  if (commitState === undefined) return undefined;
  const object = readRevisionObject(repo, commitState);
  if (object === undefined) return undefined;
  if (object.type !== "commit") throw new CorruptError(`${commitState.oid} is not a commit`);
  const parent = parseCommit(object.data).parent[which - 1];
  if (parent === undefined) throw new RefNotFoundError(expression);
  const parentState: RevisionState = { oid: parent, promised: true };
  const parentObject = readRevisionObject(repo, parentState);
  if (parentObject === undefined) throw new ObjectNotFoundError(parent);
  if (parentObject.type !== "commit") {
    throw new CorruptError(`parent ${parent} is a ${parentObject.type}, not a commit`);
  }
  parseCommit(parentObject.data);
  return { ...parentState, object: parentObject };
}

function peelRevision(
  repo: RevisionRepository,
  initial: RevisionState,
  want: ObjectType | null,
  expression: string,
): RevisionState | undefined {
  let state = initial;
  let expected: ObjectType | undefined;
  for (let hops = 0; hops < 16; hops++) {
    const object = readRevisionObject(repo, state);
    if (object === undefined) return undefined;
    if (expected !== undefined && object.type !== expected) {
      throw new CorruptError(`tag target ${state.oid} is a ${object.type}, not a ${expected}`);
    }
    validateRevisionObject(object);
    if (want === null && object.type !== "tag") return { ...state, object };
    if (object.type === want) return { ...state, object };
    if (want === "tree" && object.type === "commit") {
      const tree = parseCommit(object.data).tree;
      const treeState: RevisionState = { oid: tree, promised: true };
      const treeObject = readRevisionObject(repo, treeState);
      if (treeObject === undefined) throw new ObjectNotFoundError(tree);
      if (treeObject.type !== "tree") {
        throw new CorruptError(`commit tree ${tree} is a ${treeObject.type}, not a tree`);
      }
      parseTree(treeObject.data);
      return { ...treeState, object: treeObject };
    }
    if (object.type !== "tag") throw new RefNotFoundError(expression);
    const tag = parseTag(object.data);
    expected = tag.type;
    state = { oid: tag.object, promised: true };
  }
  throw new CorruptError(`tag chain from ${initial.oid} is too deep`);
}

function resolveRevisionPath(
  repo: RevisionRepository,
  state: RevisionState,
  path: string,
  expression: string,
): RevisionStateResolution | undefined {
  const treeState = peelRevision(repo, state, "tree", expression);
  if (treeState === undefined) return undefined;
  if (path === "") return { state: treeState, mode: "40000" };
  const entry = repo.resolveTreePath(treeState.oid, path);
  if (entry === null) return undefined;
  const expected = typeForMode(entry.mode);
  if (expected === "blob") {
    const metadata = repo.store.typeAndSize(entry.oid);
    if (metadata === null) {
      if (repo.store.promisedMissing([entry.oid]).length === 0) {
        throw new ObjectNotFoundError(entry.oid);
      }
    } else if (metadata.type !== expected) {
      throw new CorruptError(`tree entry ${entry.oid} is a ${metadata.type}, not a ${expected}`);
    }
    return {
      state: { oid: entry.oid, promised: true, type: expected },
      mode: entry.mode,
    };
  }
  const object = readRevisionObject(repo, { oid: entry.oid, promised: true });
  if (object === undefined) throw new ObjectNotFoundError(entry.oid);
  if (object.type !== expected) {
    throw new CorruptError(`tree entry ${entry.oid} is a ${object.type}, not a ${expected}`);
  }
  validateRevisionObject(object);
  return {
    state: { oid: entry.oid, promised: true, object },
    mode: entry.mode,
  };
}

function readRevisionObject(repo: RevisionRepository, state: RevisionState): RawObject | undefined {
  if (state.object !== undefined) return state.object;
  const object = repo.store.read(state.oid);
  if (object !== null) return object;
  if (state.promised) throw new ObjectNotFoundError(state.oid);
  return undefined;
}

function validateRevisionObject(object: RawObject): void {
  if (object.type === "commit") parseCommit(object.data);
  else if (object.type === "tree") parseTree(object.data);
  else if (object.type === "tag") parseTag(object.data);
}

function invalidRevision(expression: string): GitError {
  return new GitError("EINVAL", `invalid revision expression: ${expression}`);
}
