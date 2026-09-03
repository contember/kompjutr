// Pure structural planning for a three-way integration. Blob content is left
// to the bounded content phase; this layer only compares tree identities.

import { isOid } from "../common/bytes.js";
import { CorruptError, GitError } from "../common/errors.js";
import { MODE_COMMIT, MODE_EXECUTABLE, MODE_FILE, MODE_SYMLINK } from "../common/objects.js";
import { comparePaths, joinSorted3 } from "../common/streams.js";
import type { Repository } from "./repository.js";
import { type TargetEntry, treeStream } from "./tree-stream.js";

export const MAX_INTEGRATION_STRUCTURE_ROWS = 200_000;
export const MAX_INTEGRATION_STRUCTURE_ENTRIES = 65_536;

const PLAN_ENTRY_BYTES = 192;
const IDENTITY_BYTES = 128;
const PREFIX_STATE_BYTES = 128;

import type {
  ClassifiedRow,
  ConflictStructuralEntry,
  IntegrationIdentity,
  IntegrationStages,
  IntegrationStructureInput,
  IntegrationStructureLimits,
  PrefixCandidate,
  ResolvedLimits,
  StructuralConflictKind,
  StructuralIntegrationEntry,
  StructuralIntegrationPlan,
} from "./integration-structure-types.js";

export type {
  CleanStructuralEntry,
  ConflictStructuralEntry,
  ContentStructuralEntry,
  IntegrationIdentity,
  IntegrationStages,
  IntegrationStructureInput,
  IntegrationStructureLimits,
  StructuralConflictKind,
  StructuralIntegrationEntry,
  StructuralIntegrationPlan,
} from "./integration-structure-types.js";

class PlanBudget {
  #entries = 0;
  #planBytes = 0;
  #prefixBytes = 0;

  constructor(private readonly limits: ResolvedLimits) {}

  add(entry: StructuralIntegrationEntry): void {
    if (this.#entries >= this.limits.maxEntries) {
      throw new GitError(
        "E2BIG",
        `integration structure exceeds ${this.limits.maxEntries} plan entries`,
      );
    }
    const bytes = retainedEntryBytes(entry);
    if (
      this.limits.maxRetainedBytes !== undefined &&
      bytes > this.limits.maxRetainedBytes - this.#planBytes - this.#prefixBytes
    ) {
      throw new GitError(
        "E2BIG",
        `integration structure exceeds ${this.limits.maxRetainedBytes} retained bytes`,
      );
    }
    this.#entries++;
    this.#planBytes += bytes;
  }

  replace(before: StructuralIntegrationEntry, after: StructuralIntegrationEntry): void {
    const beforeBytes = retainedEntryBytes(before);
    const afterBytes = retainedEntryBytes(after);
    if (
      this.limits.maxRetainedBytes !== undefined &&
      afterBytes >
        this.limits.maxRetainedBytes - (this.#planBytes - beforeBytes) - this.#prefixBytes
    ) {
      throw new GitError(
        "E2BIG",
        `integration structure exceeds ${this.limits.maxRetainedBytes} retained bytes`,
      );
    }
    this.#planBytes += afterBytes - beforeBytes;
  }

  addPrefix(bytes: number): void {
    if (
      this.limits.maxRetainedBytes !== undefined &&
      bytes > this.limits.maxRetainedBytes - this.#planBytes - this.#prefixBytes
    ) {
      throw new GitError(
        "E2BIG",
        `integration structure exceeds ${this.limits.maxRetainedBytes} retained bytes`,
      );
    }
    this.#prefixBytes += bytes;
  }

  removePrefix(bytes: number): void {
    this.#prefixBytes -= bytes;
  }

  finish(): void {
    this.#prefixBytes = 0;
  }

  clear(): void {
    this.#entries = 0;
    this.#planBytes = 0;
    this.#prefixBytes = 0;
  }
}

function retainedEntryBytes(entry: StructuralIntegrationEntry): number {
  const pathBytes = 48 + entry.path.length * 2;
  if (entry.kind === "clean") {
    return (
      PLAN_ENTRY_BYTES +
      pathBytes +
      (entry.before === null ? 0 : IDENTITY_BYTES) +
      (entry.result === null ? 0 : IDENTITY_BYTES)
    );
  }
  if (entry.kind === "content") return PLAN_ENTRY_BYTES + pathBytes + IDENTITY_BYTES * 3;
  let identities = 0;
  if (entry.stages.base !== null) identities++;
  if (entry.stages.current !== null) identities++;
  if (entry.stages.incoming !== null) identities++;
  return PLAN_ENTRY_BYTES + pathBytes + identities * IDENTITY_BYTES;
}

function retainedPrefixBytes(
  path: string,
  base: TargetEntry | undefined,
  current: TargetEntry | undefined,
  incoming: TargetEntry | undefined,
): number {
  let identities = 0;
  if (base !== undefined) identities++;
  if (current !== undefined) identities++;
  if (incoming !== undefined) identities++;
  return PREFIX_STATE_BYTES + 48 + path.length * 2 + identities * IDENTITY_BYTES;
}

function boundedLimit(value: number | undefined, ceiling: number, label: string): number {
  if (value === undefined) return ceiling;
  if (!Number.isSafeInteger(value) || value < 0 || value > ceiling) {
    throw new RangeError(`invalid integration structure ${label} limit`);
  }
  return value;
}

function optionalByteLimit(value: number | undefined): number | undefined {
  if (value !== undefined && (!Number.isSafeInteger(value) || value < 0)) {
    throw new RangeError("invalid integration structure retained-byte limit");
  }
  return value;
}

function resolveLimits(limits: IntegrationStructureLimits | undefined): ResolvedLimits {
  return {
    maxRows: boundedLimit(limits?.maxRows, MAX_INTEGRATION_STRUCTURE_ROWS, "row"),
    maxEntries: boundedLimit(limits?.maxEntries, MAX_INTEGRATION_STRUCTURE_ENTRIES, "entry"),
    maxRetainedBytes: optionalByteLimit(limits?.maxRetainedBytes),
  };
}

function same(left: TargetEntry | undefined, right: TargetEntry | undefined): boolean {
  if (left === undefined || right === undefined) return left === right;
  return left.mode === right.mode && left.oid === right.oid;
}

function identity(entry: TargetEntry | undefined): IntegrationIdentity | null {
  return entry === undefined ? null : { mode: entry.mode, oid: entry.oid };
}

function stages(
  base: TargetEntry | undefined,
  current: TargetEntry | undefined,
  incoming: TargetEntry | undefined,
): IntegrationStages {
  return { base: identity(base), current: identity(current), incoming: identity(incoming) };
}

function clean(
  path: string,
  current: TargetEntry | undefined,
  result: TargetEntry | undefined,
): ClassifiedRow {
  return {
    entry: { kind: "clean", path, before: identity(current), result: identity(result) },
    occupiesPath: result !== undefined,
  };
}

function conflict(
  path: string,
  kind: StructuralConflictKind,
  base: TargetEntry | undefined,
  current: TargetEntry | undefined,
  incoming: TargetEntry | undefined,
): ClassifiedRow {
  return {
    entry: { kind: "conflict", path, conflict: kind, stages: stages(base, current, incoming) },
    occupiesPath: base !== undefined || current !== undefined || incoming !== undefined,
  };
}

function isRegular(mode: string): boolean {
  return mode === MODE_FILE || mode === MODE_EXECUTABLE;
}

function resolveDimension(base: string, current: string, incoming: string): string | null {
  if (current === incoming) return current;
  if (base === current) return incoming;
  if (base === incoming) return current;
  return null;
}

function classifyRow(
  path: string,
  base: TargetEntry | undefined,
  current: TargetEntry | undefined,
  incoming: TargetEntry | undefined,
): ClassifiedRow {
  // Identical sides and incoming-only identity with the base need no content.
  if (same(current, incoming) || same(base, incoming)) {
    return { entry: null, occupiesPath: current !== undefined };
  }
  if (same(base, current)) return clean(path, current, incoming);

  if (base === undefined) return conflict(path, "add/add", base, current, incoming);
  if (current === undefined || incoming === undefined) {
    return conflict(path, "modify/delete", base, current, incoming);
  }

  if (base.mode === MODE_COMMIT || current.mode === MODE_COMMIT || incoming.mode === MODE_COMMIT) {
    return conflict(path, "gitlink", base, current, incoming);
  }
  if (
    base.mode === MODE_SYMLINK ||
    current.mode === MODE_SYMLINK ||
    incoming.mode === MODE_SYMLINK
  ) {
    return conflict(path, "symlink", base, current, incoming);
  }
  if (!isRegular(base.mode) || !isRegular(current.mode) || !isRegular(incoming.mode)) {
    return conflict(path, "mode", base, current, incoming);
  }

  const resultMode = resolveDimension(base.mode, current.mode, incoming.mode);
  if (resultMode === null) return conflict(path, "mode", base, current, incoming);
  const resultOid = resolveDimension(base.oid, current.oid, incoming.oid);
  if (resultOid !== null) {
    const result = { path, mode: resultMode, oid: resultOid };
    return same(current, result)
      ? { entry: null, occupiesPath: true }
      : clean(path, current, result);
  }
  return {
    entry: {
      kind: "content",
      path,
      base: { mode: base.mode, oid: base.oid },
      current: { mode: current.mode, oid: current.oid },
      incoming: { mode: incoming.mode, oid: incoming.oid },
      resultMode,
    },
    occupiesPath: true,
  };
}

function validatePath(path: string, source: string): void {
  if (
    path.length === 0 ||
    path.startsWith("/") ||
    path.endsWith("/") ||
    path.includes("//") ||
    path.includes("\0")
  ) {
    throw new CorruptError(`${source} tree yielded invalid path '${path}'`);
  }
}

function validateEntry(entry: TargetEntry, source: string): void {
  validatePath(entry.path, source);
  if (
    entry.mode !== MODE_FILE &&
    entry.mode !== MODE_EXECUTABLE &&
    entry.mode !== MODE_SYMLINK &&
    entry.mode !== MODE_COMMIT
  ) {
    throw new CorruptError(`${source} tree yielded invalid mode '${entry.mode}'`);
  }
  if (!isOid(entry.oid))
    throw new CorruptError(`${source} tree yielded invalid oid '${entry.oid}'`);
}

function* validated(entries: Iterable<TargetEntry>, source: string): Generator<TargetEntry> {
  let previous: string | null = null;
  for (const entry of entries) {
    validateEntry(entry, source);
    if (previous !== null && comparePaths(previous, entry.path) >= 0) {
      throw new CorruptError(`${source} tree paths are not strictly ordered`);
    }
    previous = entry.path;
    yield entry;
  }
}

function isDescendant(path: string, parent: string): boolean {
  return path.length > parent.length && path.startsWith(parent) && path[parent.length] === "/";
}

function fileDirectoryEntry(path: string, rowStages: IntegrationStages): ConflictStructuralEntry {
  return { kind: "conflict", path, conflict: "file/directory", stages: rowStages };
}

function replaceEntry(
  entries: StructuralIntegrationEntry[],
  index: number,
  entry: StructuralIntegrationEntry,
  budget: PlanBudget,
): void {
  const before = entries[index];
  if (before === undefined) throw new CorruptError("integration prefix state is inconsistent");
  budget.replace(before, entry);
  entries[index] = entry;
}

/**
 * Classify three already path-ordered leaf streams. This is exported so the
 * content phase can reuse the pure join without constructing repositories.
 */
export function classifyStructuralStreams(
  baseEntries: Iterable<TargetEntry>,
  currentEntries: Iterable<TargetEntry>,
  incomingEntries: Iterable<TargetEntry>,
  limits?: IntegrationStructureLimits,
): StructuralIntegrationPlan {
  const resolved = resolveLimits(limits);
  const budget = new PlanBudget(resolved);
  const entries: StructuralIntegrationEntry[] = [];
  const prefixes: PrefixCandidate[] = [];
  let sourceRows = 0;

  try {
    for (const row of joinSorted3(
      validated(baseEntries, "base"),
      validated(currentEntries, "current"),
      validated(incomingEntries, "incoming"),
      { a: (entry) => entry.path, b: (entry) => entry.path, c: (entry) => entry.path },
    )) {
      if (sourceRows >= resolved.maxRows) {
        throw new GitError(
          "E2BIG",
          `integration structure exceeds ${resolved.maxRows} source rows`,
        );
      }
      sourceRows++;
      while (prefixes.length > 0) {
        const candidate = prefixes[prefixes.length - 1];
        if (candidate !== undefined && isDescendant(row.path, candidate.path)) break;
        const expired = prefixes.pop();
        if (expired !== undefined) budget.removePrefix(expired.retainedBytes);
      }

      const classified = classifyRow(row.path, row.a, row.b, row.c);
      let entryIndex: number | null = null;

      if (classified.occupiesPath && prefixes.length > 0) {
        for (const prefix of prefixes) {
          const replacement = fileDirectoryEntry(prefix.path, prefix.stages);
          if (prefix.entryIndex === null) {
            budget.add(replacement);
            prefix.entryIndex = entries.length;
            entries.push(replacement);
          } else {
            replaceEntry(entries, prefix.entryIndex, replacement, budget);
          }
        }
        const replacement = fileDirectoryEntry(row.path, stages(row.a, row.b, row.c));
        budget.add(replacement);
        entryIndex = entries.length;
        entries.push(replacement);
      } else if (classified.entry !== null) {
        budget.add(classified.entry);
        entryIndex = entries.length;
        entries.push(classified.entry);
      }

      const canPrefixAnotherSide =
        row.a === undefined || row.b === undefined || row.c === undefined;
      if (classified.occupiesPath && canPrefixAnotherSide) {
        const retainedBytes = retainedPrefixBytes(row.path, row.a, row.b, row.c);
        budget.addPrefix(retainedBytes);
        prefixes.push({
          path: row.path,
          stages: stages(row.a, row.b, row.c),
          entryIndex,
          retainedBytes,
        });
      }
    }

    budget.finish();
    return { entries, sourceRows };
  } catch (error) {
    budget.clear();
    throw error;
  }
}

/** Build a mutation-free structural delta from three authoritative tree cursors. */
export function classifyIntegrationStructure(
  repo: Repository,
  input: IntegrationStructureInput,
): StructuralIntegrationPlan {
  resolveLimits(input.limits);
  if (
    input.currentTreeOid === input.incomingTreeOid ||
    input.baseTreeOid === input.incomingTreeOid
  ) {
    const roots: string[] = [];
    const seen = new Set<string>();
    for (const treeOid of [input.baseTreeOid, input.currentTreeOid, input.incomingTreeOid]) {
      if (treeOid === null || seen.has(treeOid)) continue;
      seen.add(treeOid);
      roots.push(treeOid);
    }
    for (const info of repo.store.objectInfo(roots)) {
      if (info.type !== "tree") throw new CorruptError(`${info.oid} is a ${info.type}, not a tree`);
      const stream = treeStream(repo, info.oid);
      try {
        stream.next();
      } finally {
        stream.return(undefined);
      }
    }
    return { entries: [], sourceRows: 0 };
  }
  return classifyStructuralStreams(
    treeStream(repo, input.baseTreeOid),
    treeStream(repo, input.currentTreeOid),
    treeStream(repo, input.incomingTreeOid),
    input.limits,
  );
}
