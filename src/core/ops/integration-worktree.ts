// Shared bounded index, worktree, projection, and commit preflight for integration operations.

import type { MemoryReservation } from "../../memory.js";
import { type IndexEntry, indexScanOwned } from "../../sqlite/store.js";
import { GitError } from "../errors.js";
import { MODE_EXECUTABLE, MODE_FILE, MODE_SYMLINK } from "../objects.js";
import type { Repository } from "../repository.js";
import { comparePaths, joinSorted } from "../streams.js";
import type { Worktree } from "../worktree.js";
import type { IntegrationPlan } from "./integration.js";
import type { ProjectedMergeEntry } from "./merge-projection.js";
import { projectMergePlan } from "./merge-projection.js";
import type { MergeTouchedPath } from "./merge-state.js";
import { checkoutBlockersAgainstOwned, checkoutBlockersOwned } from "./refs.js";
import {
  MAX_TREE_BUILD_LEAF_ENTRIES,
  MAX_TREE_BUILD_OBJECTS,
  preflightTreeBuild,
  type TreeBuildPreflightStats,
} from "./tree-build.js";
import { treeStream } from "./tree-stream.js";
import {
  type DirtyPathLimits,
  dirtyPathStreamOwned,
  walkWorktreeEntriesStreamOwned,
} from "./worktree-io.js";

export const MAX_INTEGRATION_INDEX_ENTRIES = MAX_TREE_BUILD_LEAF_ENTRIES;
export const MAX_INTEGRATION_TREE_OBJECTS = MAX_TREE_BUILD_OBJECTS;
const MAX_REPOSITORY_ROWS = 50_000;
const MAX_RELOCATION_COLLISIONS = 1_000;
const COLLISION_COLLECTION_BYTES = 128;
const COLLISION_ARRAY_SLOT_BYTES = 8;
const COLLISION_SET_ENTRY_BYTES = 96;
const COLLISION_STRING_BYTES = 48;
const PROJECTED_ENTRY_BYTES = 512;
const TOUCHED_COLLECTION_BYTES = 128;
const TOUCHED_ARRAY_SLOT_BYTES = 8;
const TOUCHED_MAP_ENTRY_BYTES = 128;
const TOUCHED_SHAPE_BYTES = 128;
const TOUCHED_STRING_BYTES = 48;
const NO_OMITTED_PATHS: ReadonlySet<string> = new Set();

function dirtyPathLimits(): DirtyPathLimits {
  return {
    maxIndexRows: MAX_INTEGRATION_INDEX_ENTRIES,
    indexRows: 0,
    maxWorktreeRows: MAX_REPOSITORY_ROWS,
    worktreeRows: 0,
    maxHashCandidates: MAX_INTEGRATION_INDEX_ENTRIES,
    hashCandidates: 0,
  };
}

export type IntegrationOperation = "merge" | "cherry-pick" | "revert" | "rebase";

function indexEntry(path: string, mode: string, oid: string): IndexEntry {
  return {
    path,
    stage: 0,
    mode: Number.parseInt(mode, 8),
    oid,
    size: null,
    mtime: null,
    ino: null,
    rev: null,
  };
}

export function requireBoundedIntegrationTree(
  repo: Repository,
  source: Iterable<IndexEntry> | ((reservation: MemoryReservation) => Iterable<IndexEntry>),
  owningReservation?: MemoryReservation,
): TreeBuildPreflightStats {
  if (owningReservation !== undefined && !repo.store.ownsMemoryReservation(owningReservation)) {
    throw new GitError("EINVAL", "integration tree reservation belongs to another repository");
  }
  const reservation = owningReservation?.scope() ?? repo.store.reserveMemory();
  try {
    const entries = typeof source === "function" ? source(reservation) : source;
    return preflightTreeBuild(
      entries,
      {
        maxEntriesPerTree: MAX_INTEGRATION_INDEX_ENTRIES,
        maxTreeObjects: MAX_INTEGRATION_TREE_OBJECTS,
      },
      reservation,
    );
  } finally {
    reservation.dispose();
  }
}

function projectedIdentity(entry: ProjectedMergeEntry): { mode: string; oid: string } | null {
  if (entry.stageZero !== null) return entry.stageZero;
  if (entry.stages === null) return null;
  return entry.stages.current ?? entry.stages.incoming ?? entry.stages.base;
}

export function* prospectiveIntegrationIndexEntries(
  repo: Repository,
  projected: readonly ProjectedMergeEntry[],
  reservation: MemoryReservation,
): Generator<IndexEntry> {
  const shapeMemory = reservation.scope();
  try {
    const owned = projectedTouchedShape(projected, shapeMemory);
    let ownedIndex = 0;
    for (const row of joinSorted(indexScanOwned(repo.checkout, reservation), projected, {
      left: (entry) => entry.path,
      right: (entry) => entry.path,
    })) {
      if (row.right !== undefined) {
        const identity = projectedIdentity(row.right);
        if (identity !== null) yield indexEntry(row.right.path, identity.mode, identity.oid);
        continue;
      }
      if (row.left === undefined) continue;
      while (
        owned[ownedIndex] !== undefined &&
        comparePaths(owned[ownedIndex]?.path ?? "", row.left.path) < 0
      ) {
        ownedIndex++;
      }
      if (owned[ownedIndex]?.path !== row.left.path) yield row.left;
    }
  } finally {
    shapeMemory.dispose();
  }
}

function* continuationIndexEntries(
  repo: Repository,
  reservation: MemoryReservation,
): Generator<IndexEntry> {
  let previous: string | null = null;
  for (const entry of indexScanOwned(repo.checkout, reservation)) {
    if (entry.path === previous) continue;
    previous = entry.path;
    yield entry.stage === 0 ? entry : { ...entry, stage: 0 };
  }
}

export function requireBoundedIntegrationIndex(
  repo: Repository,
  reservation?: MemoryReservation,
): TreeBuildPreflightStats {
  return requireBoundedIntegrationTree(
    repo,
    (owner) => continuationIndexEntries(repo, owner),
    reservation,
  );
}

export function reserveIntegrationPlan(
  repo: Repository,
  plan: IntegrationPlan,
  callerRetainedBytes = 0,
): ReturnType<Repository["store"]["reserveMemory"]> {
  if (!Number.isSafeInteger(callerRetainedBytes) || callerRetainedBytes < 0) {
    throw new GitError("EINVAL", "integration caller retained bytes are invalid");
  }
  const planReservation = plan.reservation;
  if (planReservation === undefined) {
    const reservation = repo.store.reserveMemory();
    reservation.set("other", callerRetainedBytes + plan.retainedBytes);
    return reservation;
  }
  if (planReservation.disposed || !repo.store.ownsMemoryReservation(planReservation)) {
    throw new GitError("EINVAL", "integration plan reservation is unavailable");
  }
  if (callerRetainedBytes > 0) {
    const caller = planReservation.scope();
    try {
      caller.set("other", callerRetainedBytes);
    } catch (error) {
      caller.dispose();
      throw error;
    }
  }
  return planReservation;
}

export function reserveIntegrationExecution(
  repo: Repository,
  owningReservation?: MemoryReservation,
): ReturnType<Repository["store"]["reserveMemory"]> {
  if (owningReservation !== undefined && !repo.store.ownsMemoryReservation(owningReservation)) {
    throw new GitError("EINVAL", "integration execution reservation belongs to another repository");
  }
  return owningReservation?.scope() ?? repo.store.reserveMemory();
}

export function requireCleanIntegrationIndex(
  repo: Repository,
  headTree: string,
  operation: IntegrationOperation,
): void {
  if (repo.checkout.hasConflicts()) {
    throw new GitError("EUNMERGED", `cannot ${operation} with unmerged index entries`);
  }
  for (const row of joinSorted(treeStream(repo, headTree), repo.checkout.indexScan(), {
    left: (entry) => entry.path,
    right: (entry) => entry.path,
  })) {
    const tree = row.left;
    const index = row.right;
    if (
      tree === undefined ||
      index === undefined ||
      index.stage !== 0 ||
      index.oid !== tree.oid ||
      index.mode !== Number.parseInt(tree.mode, 8)
    ) {
      throw new GitError("ECHECKOUTFAIL", `cannot ${operation}: the index contains staged changes`);
    }
  }
}

export function integrationIndexMatchesTree(repo: Repository, treeOid: string): boolean {
  if (repo.checkout.hasConflicts()) return false;
  for (const row of joinSorted(treeStream(repo, treeOid), repo.checkout.indexScan(), {
    left: (entry) => entry.path,
    right: (entry) => entry.path,
  })) {
    if (
      row.left === undefined ||
      row.right === undefined ||
      row.right.stage !== 0 ||
      row.right.oid !== row.left.oid ||
      row.right.mode !== Number.parseInt(row.left.mode, 8)
    ) {
      return false;
    }
  }
  return true;
}

export function requireCleanIntegrationWorktree(
  repo: Repository,
  worktree: Worktree,
  operation: IntegrationOperation,
  excludeRoots: string[] = [],
  owningReservation?: MemoryReservation,
): void {
  if (owningReservation !== undefined && !repo.store.ownsMemoryReservation(owningReservation)) {
    throw new GitError("EINVAL", "integration worktree reservation belongs to another repository");
  }
  const reservation = owningReservation?.scope() ?? repo.store.reserveMemory();
  const iterator = dirtyPathStreamOwned(
    repo,
    worktree,
    reservation,
    undefined,
    dirtyPathLimits(),
    excludeRoots,
  );
  try {
    const dirty = iterator.next();
    if (dirty.done !== true) {
      throw new GitError(
        "ECHECKOUTFAIL",
        `cannot ${operation}: tracked working tree changes are present at ${dirty.value}`,
      );
    }
  } finally {
    try {
      iterator.return(undefined);
    } finally {
      reservation.dispose();
    }
  }
}

export function requireSafeIntegrationWorktree(
  repo: Repository,
  worktree: Worktree,
  incomingTree: string | null,
  entries: readonly { path: string }[],
  operation: IntegrationOperation,
  baselineTree?: string | null,
  owningReservation?: MemoryReservation,
): void {
  if (entries.length === 0) return;
  if (owningReservation !== undefined && !repo.store.ownsMemoryReservation(owningReservation)) {
    throw new GitError("EINVAL", "integration worktree reservation belongs to another repository");
  }
  const reservation = owningReservation?.scope() ?? repo.store.reserveMemory();
  const pathMemory = reservation.scope();
  try {
    pathMemory.set("other", TOUCHED_COLLECTION_BYTES + entries.length * TOUCHED_ARRAY_SLOT_BYTES);
    const paths = entries.map((entry) => entry.path);
    const limits = {
      maxRows: MAX_REPOSITORY_ROWS,
      rows: 0,
      maxHashCandidates: 1_000,
      hashCandidates: 0,
    };
    const blockers =
      baselineTree === undefined
        ? checkoutBlockersOwned(repo, worktree, incomingTree, paths, true, reservation, limits)
        : checkoutBlockersAgainstOwned(
            repo,
            worktree,
            baselineTree,
            incomingTree,
            paths,
            true,
            reservation,
            limits,
          );
    if (blockers.tracked.length > 0) {
      throw new GitError(
        "ECHECKOUTFAIL",
        `local changes to ${blockers.tracked.join(", ")} would be overwritten by ${operation}`,
      );
    }
    if (blockers.untracked.length > 0) {
      throw new GitError(
        "ECHECKOUTFAIL",
        `untracked working tree files would be overwritten by ${operation}: ${blockers.untracked.join(", ")}`,
      );
    }
  } finally {
    pathMemory.dispose();
    reservation.dispose();
  }
}

function collisionCandidateEnd(base: string, path: string): number | null {
  if (path === base || (path.startsWith(base) && path[base.length] === "/")) return base.length;
  if (!path.startsWith(base) || path[base.length] !== "_") return null;
  let end = base.length + 1;
  while (end < path.length && path.charCodeAt(end) >= 0x30 && path.charCodeAt(end) <= 0x39) end++;
  if (end === base.length + 1 || (end < path.length && path.charCodeAt(end) !== 0x2f)) return null;
  return end;
}

function retainCollision(
  path: string,
  bases: readonly string[],
  collisions: Set<string>,
  operation: IntegrationOperation,
  reservation: MemoryReservation,
  retained: { bytes: number },
): void {
  for (const base of bases) {
    const end = collisionCandidateEnd(base, path);
    if (end === null) continue;
    const candidateStringBytes = COLLISION_STRING_BYTES + end * 2;
    const candidateBytes =
      COLLISION_SET_ENTRY_BYTES + (end === base.length ? 0 : candidateStringBytes);
    const admissionBytes = COLLISION_SET_ENTRY_BYTES + candidateStringBytes;
    reservation.set("other", retained.bytes + admissionBytes);
    const candidate = end === base.length ? base : path.slice(0, end);
    if (collisions.has(candidate)) {
      reservation.set("other", retained.bytes);
      continue;
    }
    if (collisions.size >= MAX_RELOCATION_COLLISIONS) {
      throw new GitError(
        "E2BIG",
        `${operation} relocation collisions exceed ${MAX_RELOCATION_COLLISIONS} paths`,
      );
    }
    collisions.add(candidate);
    retained.bytes += candidateBytes;
    reservation.set("other", retained.bytes);
  }
}

function relocationCollisions(
  repo: Repository,
  worktree: Worktree,
  baseTree: string | null,
  incomingTree: string | null,
  initial: readonly ProjectedMergeEntry[],
  omitted: ReadonlySet<string>,
  operation: IntegrationOperation,
  reservation: MemoryReservation,
): { tracked: ReadonlySet<string>; untracked: ReadonlySet<string> } {
  let baseBytes = 3 * COLLISION_COLLECTION_BYTES;
  let baseCount = 0;
  for (const entry of initial) {
    if (entry.purpose === "primary") continue;
    baseCount++;
    baseBytes += COLLISION_ARRAY_SLOT_BYTES;
  }
  reservation.set("other", baseBytes);
  const bases: string[] = [];
  for (const entry of initial) {
    if (entry.purpose !== "primary") bases.push(entry.path);
  }
  const retained = { bytes: baseBytes };
  const tracked = new Set<string>();
  const untracked = new Set<string>();
  if (baseCount === 0) return { tracked, untracked };
  let indexRows = 0;
  const indexMemory = reservation.scope();
  try {
    for (const entry of indexScanOwned(repo.checkout, indexMemory)) {
      if (indexRows >= MAX_REPOSITORY_ROWS) {
        throw new GitError(
          "E2BIG",
          `${operation} collision scan exceeds ${MAX_REPOSITORY_ROWS} rows`,
        );
      }
      indexRows++;
      if (!omitted.has(entry.path)) {
        retainCollision(entry.path, bases, tracked, operation, reservation, retained);
      }
    }
  } finally {
    indexMemory.dispose();
  }
  for (const entry of treeStream(repo, baseTree)) {
    retainCollision(entry.path, bases, tracked, operation, reservation, retained);
  }
  for (const entry of treeStream(repo, incomingTree)) {
    retainCollision(entry.path, bases, tracked, operation, reservation, retained);
  }

  let worktreeRows = 0;
  const secondIndexMemory = reservation.scope();
  const worktreeMemory = reservation.scope();
  try {
    for (const row of joinSorted(
      indexScanOwned(repo.checkout, secondIndexMemory),
      walkWorktreeEntriesStreamOwned(worktree, repo.root, worktreeMemory, {
        includeIgnored: true,
      }),
      { left: (entry) => entry.path, right: (entry) => entry.path },
    )) {
      if (worktreeRows >= MAX_REPOSITORY_ROWS) {
        throw new GitError(
          "E2BIG",
          `${operation} collision scan exceeds ${MAX_REPOSITORY_ROWS} rows`,
        );
      }
      worktreeRows++;
      if (omitted.has(row.path)) continue;
      if (row.right !== undefined && row.left === undefined) {
        retainCollision(row.path, bases, untracked, operation, reservation, retained);
      }
    }
  } finally {
    worktreeMemory.dispose();
    secondIndexMemory.dispose();
  }
  return { tracked, untracked };
}

function projectedEntriesRetainedBytes(entries: readonly ProjectedMergeEntry[]): number {
  let bytes = 64;
  for (const entry of entries) {
    bytes += PROJECTED_ENTRY_BYTES + entry.path.length * 2 + entry.logicalPath.length * 2;
  }
  if (!Number.isSafeInteger(bytes)) {
    throw new GitError("E2BIG", "integration projection memory accounting overflow");
  }
  return bytes;
}

function projectedPathBytes(pathLength: number, logicalPathLength: number): number {
  const bytes = PROJECTED_ENTRY_BYTES + pathLength * 2 + logicalPathLength * 2;
  if (!Number.isSafeInteger(bytes)) {
    throw new GitError("E2BIG", "integration projection memory accounting overflow");
  }
  return bytes;
}

function relocationPathLength(path: string, label: string): number {
  return path.length + 1 + label.length + 4;
}

function materializableClass(mode: string | undefined): "regular" | "symlink" | null {
  if (mode === MODE_FILE || mode === MODE_EXECUTABLE) return "regular";
  return mode === MODE_SYMLINK ? "symlink" : null;
}

function projectedEntriesAdmissionBytes(
  plan: IntegrationPlan,
  currentLabel: string,
  incomingLabel: string,
): number {
  let bytes = 64;
  let index = 0;
  while (index < plan.entries.length) {
    const entry = plan.entries[index];
    if (entry === undefined) {
      throw new GitError("ECORRUPT", "integration projection lost a planned entry");
    }
    if (entry.kind !== "conflict") {
      bytes += projectedPathBytes(entry.path.length, entry.path.length);
      index++;
      continue;
    }
    const currentClass = materializableClass(entry.stages.current?.mode);
    const incomingClass = materializableClass(entry.stages.incoming?.mode);
    const distinctMaterializable =
      (entry.conflict === "add/add" || entry.conflict === "symlink") &&
      currentClass !== null &&
      incomingClass !== null &&
      currentClass !== incomingClass;
    if (distinctMaterializable) {
      const regularLabel = currentClass === "regular" ? currentLabel : incomingLabel;
      bytes += projectedPathBytes(entry.path.length, entry.path.length);
      bytes += projectedPathBytes(
        relocationPathLength(entry.path, regularLabel),
        entry.path.length,
      );
      index++;
      continue;
    }
    if (entry.conflict === "file/directory") {
      const fileLabel = entry.stages.current === null ? incomingLabel : currentLabel;
      bytes += projectedPathBytes(relocationPathLength(entry.path, fileLabel), entry.path.length);
      index++;
      const prefix = `${entry.path}/`;
      while (index < plan.entries.length && plan.entries[index]?.path.startsWith(prefix)) {
        const child = plan.entries[index];
        if (child === undefined) {
          throw new GitError("ECORRUPT", "integration projection lost a descendant entry");
        }
        bytes += projectedPathBytes(child.path.length, child.path.length);
        index++;
      }
      continue;
    }
    bytes += projectedPathBytes(entry.path.length, entry.path.length);
    index++;
  }
  if (!Number.isSafeInteger(bytes)) {
    throw new GitError("E2BIG", "integration projection memory accounting overflow");
  }
  return bytes;
}

export function projectIntegrationWithCollisions(
  repo: Repository,
  worktree: Worktree,
  baseTree: string | null,
  incomingTree: string | null,
  plan: IntegrationPlan,
  currentLabel: string,
  incomingLabel: string,
  omitted: ReadonlySet<string> = NO_OMITTED_PATHS,
  operation: IntegrationOperation = "merge",
  owningReservation?: MemoryReservation,
): readonly ProjectedMergeEntry[] {
  if (owningReservation !== undefined && !repo.store.ownsMemoryReservation(owningReservation)) {
    throw new GitError(
      "EINVAL",
      "integration projection reservation belongs to another repository",
    );
  }
  const reservation = owningReservation?.scope() ?? repo.store.reserveMemory();
  let succeeded = false;
  try {
    const admissionBytes = projectedEntriesAdmissionBytes(plan, currentLabel, incomingLabel);
    const initialMemory = reservation.scope();
    initialMemory.set("other", admissionBytes);
    const initial = projectMergePlan(plan, { currentLabel, incomingLabel });
    initialMemory.set("other", projectedEntriesRetainedBytes(initial));
    const collisionMemory = reservation.scope();
    const collisions = relocationCollisions(
      repo,
      worktree,
      baseTree,
      incomingTree,
      initial,
      omitted,
      operation,
      collisionMemory,
    );
    const finalMemory = reservation.scope();
    finalMemory.set("other", admissionBytes);
    const projected = projectMergePlan(plan, {
      currentLabel,
      incomingLabel,
      trackedCollisions: collisions.tracked,
      untrackedCollisions: collisions.untracked,
    });
    const finalBytes = projectedEntriesRetainedBytes(projected);
    finalMemory.set("other", finalBytes);
    collisionMemory.dispose();
    initialMemory.dispose();
    succeeded = true;
    return projected;
  } finally {
    if (!succeeded || owningReservation === undefined) reservation.dispose();
  }
}

export interface TouchedShape {
  path: string;
  logicalPath: string;
  purpose: MergeTouchedPath["purpose"];
}

export function retainedTouchedPathSet(
  entries: readonly { path: string }[],
  reservation: MemoryReservation,
): ReadonlySet<string> {
  reservation.set("other", TOUCHED_COLLECTION_BYTES);
  const paths = new Set<string>();
  for (const entry of entries) {
    if (paths.has(entry.path)) continue;
    reservation.set(
      "other",
      TOUCHED_COLLECTION_BYTES + (paths.size + 1) * COLLISION_SET_ENTRY_BYTES,
    );
    paths.add(entry.path);
  }
  return paths;
}

function buildProjectedTouchedShape(
  entries: readonly ProjectedMergeEntry[],
  reservation: MemoryReservation,
  mapMemory: MemoryReservation,
): TouchedShape[] {
  const byPath = new Map<string, TouchedShape>();
  let retainedBytes = 0;
  const retain = (
    path: string,
    logicalPath: string,
    purpose: MergeTouchedPath["purpose"],
  ): void => {
    if (byPath.has(path)) return;
    if (byPath.size >= 1_000) {
      throw new GitError("E2BIG", "integration ownership exceeds 1000 touched paths");
    }
    const nextRetainedBytes = retainedBytes + TOUCHED_SHAPE_BYTES;
    reservation.set("other", nextRetainedBytes);
    mapMemory.set("other", TOUCHED_COLLECTION_BYTES + (byPath.size + 1) * TOUCHED_MAP_ENTRY_BYTES);
    byPath.set(path, { path, logicalPath, purpose });
    retainedBytes = nextRetainedBytes;
  };
  const retainAncestor = (path: string): void => {
    let slash = path.lastIndexOf("/");
    while (slash > 0) {
      const candidateBytes = TOUCHED_SHAPE_BYTES + TOUCHED_STRING_BYTES + slash * 2;
      reservation.set("other", retainedBytes + candidateBytes);
      const previousSize = byPath.size;
      const ancestor = path.slice(0, slash);
      if (!byPath.has(ancestor)) {
        if (byPath.size >= 1_000) {
          throw new GitError("E2BIG", "integration ownership exceeds 1000 touched paths");
        }
        mapMemory.set(
          "other",
          TOUCHED_COLLECTION_BYTES + (byPath.size + 1) * TOUCHED_MAP_ENTRY_BYTES,
        );
        byPath.set(ancestor, {
          path: ancestor,
          logicalPath: ancestor,
          purpose: "primary",
        });
      }
      slash = ancestor.lastIndexOf("/");
      if (byPath.size === previousSize) reservation.set("other", retainedBytes);
      else retainedBytes += candidateBytes;
    }
  };
  for (const entry of entries) {
    retain(entry.path, entry.logicalPath, entry.purpose);
    if (entry.purpose !== "primary" && !byPath.has(entry.logicalPath)) {
      retain(entry.logicalPath, entry.logicalPath, "primary");
    }
    retainAncestor(entry.path);
    retainAncestor(entry.logicalPath);
  }
  reservation.set(
    "other",
    retainedBytes + TOUCHED_COLLECTION_BYTES + byPath.size * TOUCHED_ARRAY_SLOT_BYTES,
  );
  return [...byPath.values()].sort((left, right) => comparePaths(left.path, right.path));
}

export function projectedTouchedShape(
  entries: readonly ProjectedMergeEntry[],
  reservation: MemoryReservation,
): TouchedShape[] {
  const mapMemory = reservation.scope();
  try {
    mapMemory.set("other", TOUCHED_COLLECTION_BYTES);
    return buildProjectedTouchedShape(entries, reservation, mapMemory);
  } finally {
    mapMemory.dispose();
  }
}
