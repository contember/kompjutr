import { isOid } from "../common/bytes.js";
import { GitError } from "../common/errors.js";
import { isCanonicalGitPath } from "../common/paths.js";
import {
  blob,
  bool,
  int,
  nullable,
  object,
  oneOf,
  optional,
  RowShape,
  text,
  unknownArray,
} from "../common/rows.js";
import { comparePaths } from "../common/streams.js";
import type { IndexEntry } from "../store/index.js";
import type { SelectedPathResult, SelectedWorktreeFact } from "./sparse-workspace.js";
import { structuralStringBytes } from "./staging-rm.js";
import { hasExactSelectedIndexPath } from "./staging-selected-shared.js";

const SELECTED_RESULT_FIXED_BYTES = 64;
const SELECTED_ARRAY_FIXED_BYTES = 64;
const SELECTED_ARRAY_SLOT_BYTES = 8;
const SELECTED_INDEX_FIXED_BYTES = 320;
const SELECTED_WORKTREE_FIXED_BYTES = 512;
const SELECTED_ANCESTOR_RESULT_FIXED_BYTES = 64;
const SELECTED_ANCESTOR_ARRAY_FIXED_BYTES = 64;
const SELECTED_ANCESTOR_FACT_FIXED_BYTES = 64;
const SELECTED_ANCESTOR_SLOT_BYTES = 8;
const TYPED_ARRAY_BYTE_LENGTH_GETTER: unknown = Object.getOwnPropertyDescriptor(
  Object.getPrototypeOf(Uint8Array.prototype),
  "byteLength",
)?.get;

export interface AvailableSelectedPaths extends Extract<SelectedPathResult, { available: true }> {
  structuralBytes: number;
  trusted: boolean;
}

const MALFORMED_SELECTED_INDEX_ROW = "selected add index source returned a malformed row";
const SELECTED_INDEX_ROW = new RowShape(
  {
    path: text(MALFORMED_SELECTED_INDEX_ROW).where(
      isCanonicalGitPath,
      MALFORMED_SELECTED_INDEX_ROW,
    ),
    stage: int(0, 3, MALFORMED_SELECTED_INDEX_ROW),
    mode: int(Number.MIN_SAFE_INTEGER, Number.MAX_SAFE_INTEGER, MALFORMED_SELECTED_INDEX_ROW).where(
      (mode) => [0o100644, 0o100755, 0o120000, 0o160000].includes(mode),
      MALFORMED_SELECTED_INDEX_ROW,
    ),
    oid: text(MALFORMED_SELECTED_INDEX_ROW).where(isOid, MALFORMED_SELECTED_INDEX_ROW),
    size: nullable(int(0, Number.MAX_SAFE_INTEGER, MALFORMED_SELECTED_INDEX_ROW)),
    mtime: nullable(
      int(Number.MIN_SAFE_INTEGER, Number.MAX_SAFE_INTEGER, MALFORMED_SELECTED_INDEX_ROW),
    ),
    ino: nullable(int(1, Number.MAX_SAFE_INTEGER, MALFORMED_SELECTED_INDEX_ROW)),
    rev: optional(nullable(int(0, Number.MAX_SAFE_INTEGER, MALFORMED_SELECTED_INDEX_ROW))),
  },
  MALFORMED_SELECTED_INDEX_ROW,
);

const MALFORMED_SELECTED_WORKTREE_ROW = "selected add worktree source returned a malformed row";
const SELECTED_WORKTREE_ROW = new RowShape(
  {
    path: text(MALFORMED_SELECTED_WORKTREE_ROW).where(
      isCanonicalGitPath,
      MALFORMED_SELECTED_WORKTREE_ROW,
    ),
    stat: object(
      {
        type: oneOf(["file", "dir", "symlink"], MALFORMED_SELECTED_WORKTREE_ROW),
        mode: int(0, 0o7777, MALFORMED_SELECTED_WORKTREE_ROW),
        size: int(0, Number.MAX_SAFE_INTEGER, MALFORMED_SELECTED_WORKTREE_ROW),
        mtime: int(
          Number.MIN_SAFE_INTEGER,
          Number.MAX_SAFE_INTEGER,
          MALFORMED_SELECTED_WORKTREE_ROW,
        ),
        ino: int(1, Number.MAX_SAFE_INTEGER, MALFORMED_SELECTED_WORKTREE_ROW),
        nlink: int(1, Number.MAX_SAFE_INTEGER, MALFORMED_SELECTED_WORKTREE_ROW),
        rev: int(0, Number.MAX_SAFE_INTEGER, MALFORMED_SELECTED_WORKTREE_ROW),
        target: nullable(text(MALFORMED_SELECTED_WORKTREE_ROW)),
        contentId: nullable(blob(MALFORMED_SELECTED_WORKTREE_ROW)),
      },
      MALFORMED_SELECTED_WORKTREE_ROW,
    ),
  },
  MALFORMED_SELECTED_WORKTREE_ROW,
);

const MALFORMED_SELECTED_ANCESTOR_FACT = "selected add ancestor source returned malformed facts";
const SELECTED_ANCESTOR_FACT_ROW = new RowShape(
  {
    path: text(MALFORMED_SELECTED_ANCESTOR_FACT).where(
      isCanonicalGitPath,
      MALFORMED_SELECTED_ANCESTOR_FACT,
    ),
    exact: bool(MALFORMED_SELECTED_ANCESTOR_FACT),
    descendant: bool(MALFORMED_SELECTED_ANCESTOR_FACT),
  },
  MALFORMED_SELECTED_ANCESTOR_FACT,
);

interface ValidatedSelectedAncestorFact {
  path: string;
  exact: boolean;
  descendant: boolean;
}

export interface ValidatedSelectedAncestorResult {
  facts: ValidatedSelectedAncestorFact[];
  structuralBytes: number;
}

export function validateSelectedAncestorResult(
  result: unknown,
  expected: readonly string[],
  exactIndex: readonly IndexEntry[],
  retainedLimit: number,
): ValidatedSelectedAncestorResult | null {
  const decoded = new RowShape(
    {
      facts: unknownArray("selected add ancestor source returned invalid state"),
    },
    "selected add ancestor source returned a malformed result",
  ).decode(result);
  const factsLength = decoded.facts.length;
  if (factsLength !== expected.length) {
    throw new GitError("ECORRUPT", "selected add ancestor source returned invalid state");
  }
  let minimumRetained = SELECTED_ANCESTOR_RESULT_FIXED_BYTES + SELECTED_ANCESTOR_ARRAY_FIXED_BYTES;
  minimumRetained = addSelectedStructuralBytes(
    minimumRetained,
    factsLength * SELECTED_ANCESTOR_SLOT_BYTES,
  );
  if (minimumRetained > retainedLimit) return null;
  const snapshot: ValidatedSelectedAncestorFact[] = [];
  let previous: string | undefined;
  for (let ordinal = 0; ordinal < factsLength; ordinal++) {
    if (!Object.hasOwn(decoded.facts, ordinal)) {
      throw new GitError("ECORRUPT", "selected add ancestor source returned sparse facts");
    }
    const fact = SELECTED_ANCESTOR_FACT_ROW.decode(decoded.facts[ordinal]);
    const expectedPath = expected[ordinal];
    if (
      expectedPath === undefined ||
      fact.path !== expectedPath ||
      fact.exact !== hasExactSelectedIndexPath(exactIndex, fact.path) ||
      (previous !== undefined && comparePaths(previous, fact.path) >= 0)
    ) {
      throw new GitError("ECORRUPT", "selected add ancestor source returned malformed facts");
    }
    minimumRetained = addSelectedStructuralBytes(
      minimumRetained,
      SELECTED_ANCESTOR_FACT_FIXED_BYTES + fact.path.length * 2,
    );
    if (minimumRetained > retainedLimit) return null;
    snapshot.push(fact);
    previous = fact.path;
  }
  return { facts: snapshot, structuralBytes: minimumRetained };
}

export function validateSelectedAddResult(
  selected: unknown,
  matches: (path: string) => boolean,
  maxIndexRows: number,
  maxWorktreeRows: number,
  maxStructuralBytes: number,
): AvailableSelectedPaths | null {
  const availability = new RowShape(
    { available: bool("selected add source returned invalid availability") },
    "selected add source returned a malformed result",
  ).decode(selected);
  if (!availability.available) return null;
  const decoded = new RowShape(
    {
      index: unknownArray("selected add source returned invalid state"),
      worktree: unknownArray("selected add source returned invalid state"),
    },
    "selected add source returned a malformed result",
  ).decode(selected);
  const indexLength = decoded.index.length;
  const worktreeLength = decoded.worktree.length;
  if (indexLength > maxIndexRows || worktreeLength > maxWorktreeRows) {
    throw new GitError("ECORRUPT", "selected add source returned excessive facts");
  }
  let minimumRetained = SELECTED_RESULT_FIXED_BYTES + SELECTED_ARRAY_FIXED_BYTES * 2;
  minimumRetained = addSelectedStructuralBytes(
    minimumRetained,
    (indexLength + worktreeLength) * SELECTED_ARRAY_SLOT_BYTES,
  );
  if (minimumRetained > maxStructuralBytes) return null;
  const snapshotIndex: IndexEntry[] = [];
  let previousIndex: IndexEntry | undefined;
  for (let ordinal = 0; ordinal < indexLength; ordinal++) {
    if (!Object.hasOwn(decoded.index, ordinal)) {
      throw new GitError("ECORRUPT", "selected add index source returned sparse rows");
    }
    const entry = SELECTED_INDEX_ROW.decode(decoded.index[ordinal]);
    if (
      !matches(entry.path) ||
      (previousIndex !== undefined &&
        (comparePaths(previousIndex.path, entry.path) > 0 ||
          (previousIndex.path === entry.path && previousIndex.stage >= entry.stage)))
    ) {
      throw new GitError("ECORRUPT", "selected add index source returned an unrelated path");
    }
    minimumRetained = addSelectedStructuralBytes(
      minimumRetained,
      SELECTED_INDEX_FIXED_BYTES +
        structuralStringBytes(entry.path) +
        structuralStringBytes(entry.oid),
    );
    if (minimumRetained > maxStructuralBytes) return null;
    snapshotIndex.push(entry);
    previousIndex = entry;
  }
  const snapshotWorktree: SelectedWorktreeFact[] = [];
  let previousWorktree: SelectedWorktreeFact | undefined;
  for (let ordinal = 0; ordinal < worktreeLength; ordinal++) {
    if (!Object.hasOwn(decoded.worktree, ordinal)) {
      throw new GitError("ECORRUPT", "selected add worktree source returned sparse rows");
    }
    const fields = decodeSelectedWorktreeFields(decoded.worktree[ordinal]);
    if (
      !matches(fields.path) ||
      (previousWorktree !== undefined && comparePaths(previousWorktree.path, fields.path) >= 0)
    ) {
      throw new GitError("ECORRUPT", "selected add worktree source returned an unrelated path");
    }
    minimumRetained = addSelectedStructuralBytes(
      minimumRetained,
      SELECTED_WORKTREE_FIXED_BYTES +
        structuralStringBytes(fields.path) +
        structuralStringBytes(fields.target ?? "") +
        fields.contentBytes,
    );
    if (minimumRetained > maxStructuralBytes) return null;
    const entry = snapshotSelectedWorktreeFact(fields);
    snapshotWorktree.push(entry);
    previousWorktree = entry;
  }
  return {
    available: true,
    index: snapshotIndex,
    worktree: snapshotWorktree,
    structuralBytes: minimumRetained,
    trusted: false,
  };
}

function addSelectedStructuralBytes(current: number, added: number): number {
  if (!Number.isSafeInteger(added) || added < 0 || current > Number.MAX_SAFE_INTEGER - added) {
    throw new GitError("E2BIG", "selected add state is too large");
  }
  return current + added;
}

function selectedUtf8Bytes(value: string): number | null {
  let bytes = 0;
  for (let index = 0; index < value.length; index++) {
    const unit = value.charCodeAt(index);
    if (unit === 0) return null;
    if (unit < 0x80) bytes++;
    else if (unit < 0x800) bytes += 2;
    else if (unit >= 0xd800 && unit <= 0xdbff) {
      const next = value.charCodeAt(++index);
      if (next < 0xdc00 || next > 0xdfff) return null;
      bytes += 4;
    } else if (unit >= 0xdc00 && unit <= 0xdfff) return null;
    else bytes += 3;
    if (!Number.isSafeInteger(bytes)) return null;
  }
  return bytes;
}

interface ValidatedSelectedWorktreeFields {
  path: string;
  type: "file" | "dir" | "symlink";
  mode: number;
  size: number;
  mtime: number;
  ino: number;
  nlink: number;
  rev: number;
  target: string | null;
  contentId: Uint8Array | null;
  contentBytes: number;
}

function decodeSelectedWorktreeFields(value: unknown): ValidatedSelectedWorktreeFields {
  const row = SELECTED_WORKTREE_ROW.decode(value);
  const { path, stat } = row;
  const { type, mode, size, mtime, ino, nlink, rev, target, contentId } = stat;
  if (type === "dir" && (size !== 0 || target !== null || contentId !== null)) {
    throw new GitError("ECORRUPT", MALFORMED_SELECTED_WORKTREE_ROW);
  }
  if (type === "file" && target !== null) {
    throw new GitError("ECORRUPT", MALFORMED_SELECTED_WORKTREE_ROW);
  }
  if (
    type === "symlink" &&
    (typeof target !== "string" || selectedUtf8Bytes(target) !== size || contentId !== null)
  ) {
    throw new GitError("ECORRUPT", MALFORMED_SELECTED_WORKTREE_ROW);
  }
  const contentBytes = contentId === null ? 0 : selectedContentIdBytes(contentId);
  if (contentBytes === null) {
    throw new GitError("ECORRUPT", MALFORMED_SELECTED_WORKTREE_ROW);
  }
  return {
    path,
    type,
    mode,
    size,
    mtime,
    ino,
    nlink,
    rev,
    target,
    contentId,
    contentBytes,
  };
}

function selectedContentIdBytes(value: Uint8Array): number | null {
  if (typeof TYPED_ARRAY_BYTE_LENGTH_GETTER !== "function") return null;
  let bytes: unknown;
  try {
    bytes = Reflect.apply(TYPED_ARRAY_BYTE_LENGTH_GETTER, value, []);
  } catch {
    return null;
  }
  return typeof bytes === "number" && Number.isSafeInteger(bytes) && bytes >= 0 ? bytes : null;
}

function snapshotSelectedWorktreeFact(
  fields: ValidatedSelectedWorktreeFields,
): SelectedWorktreeFact {
  return {
    path: fields.path,
    stat: {
      type: fields.type,
      mode: fields.mode,
      size: fields.size,
      mtime: fields.mtime,
      ino: fields.ino,
      nlink: fields.nlink,
      rev: fields.rev,
      target: fields.target,
      contentId: fields.contentId === null ? null : new Uint8Array(fields.contentId),
    },
  };
}
