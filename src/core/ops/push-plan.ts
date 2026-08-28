// Bounded outbound closure and replayable full-object pack generation.

import { MAX_BLOB_BATCH_BYTES } from "../../sqlite/store.js";
import { CorruptError, GitError } from "../errors.js";
import type { ObjectType } from "../objects.js";
import { streamFullObjectPack } from "../pack/full-object-stream.js";
import { ZERO_OID } from "../protocol/receive-pack.js";
import type { Repository } from "../repository.js";

export const MAX_PUSH_COMMITS = 512;
export const MAX_PUSH_OBJECTS = 100_000;
export const MAX_PUSH_PLAN_BYTES = 16 * 1024 * 1024;

const PUSH_PLAN_OBJECT_BYTES = 160;
const OBJECT_PAGE = 4096;

export interface PushObject {
  oid: string;
  type: ObjectType;
  size: number;
  source: "loose" | "pack";
  chunkRows: number;
}

export interface PushPlan {
  objects: readonly PushObject[];
  newCommits: number;
}

interface PlannedCommit {
  oid: string;
  tree: string;
  parents: readonly string[];
}

// Includes two authoritative commit reads and configured tracking reconciliation.
const PUSH_FIXED_STATEMENTS = 64;
const SMALL_BATCH_STATEMENTS = 8;
const LARGE_PACKED_STATEMENTS = 192;
const MAX_PUSH_STATEMENTS = 1_000;

function addObject(objects: Map<string, ObjectType>, oid: string, type: ObjectType): void {
  const prior = objects.get(oid);
  if (prior !== undefined && prior !== type) {
    throw new CorruptError(`object ${oid} is indexed as both ${prior} and ${type}`);
  }
  if (prior !== undefined) return;
  if (objects.size >= MAX_PUSH_OBJECTS) {
    throw new GitError("E2BIG", `push closure exceeds ${MAX_PUSH_OBJECTS} objects`);
  }
  if ((objects.size + 1) * PUSH_PLAN_OBJECT_BYTES > MAX_PUSH_PLAN_BYTES) {
    throw new GitError("E2BIG", "push closure exceeds the 16 MiB retained-state limit");
  }
  objects.set(oid, type);
}

function excludedCommits(
  commits: ReadonlyMap<string, PlannedCommit>,
  remoteOids: readonly string[],
): Set<string> {
  const excluded = new Set<string>();
  const pending = remoteOids.filter((oid) => oid !== ZERO_OID && commits.has(oid));
  while (pending.length > 0) {
    const oid = pending.pop()!;
    if (excluded.has(oid)) continue;
    excluded.add(oid);
    const commit = commits.get(oid);
    if (commit === undefined) continue;
    for (const parent of commit.parents) pending.push(parent);
  }
  return excluded;
}

function hydrateObjects(repo: Repository, objects: ReadonlyMap<string, ObjectType>): PushObject[] {
  const planned: PushObject[] = [];
  const entries = [...objects];
  for (let at = 0; at < entries.length; at += OBJECT_PAGE) {
    const page = entries.slice(at, at + OBJECT_PAGE);
    const info = repo.store.objectInfo(page.map(([oid]) => oid));
    for (let index = 0; index < page.length; index++) {
      const [oid, type] = page[index]!;
      const found = info[index]!;
      if (found.oid !== oid || found.type !== type) {
        throw new CorruptError(`push metadata for ${oid} does not match its planned type`);
      }
      planned.push(found);
    }
  }
  return planned;
}

function packPassStatements(objects: readonly PushObject[]): number {
  let statements = 0;
  let batchBytes = 0;
  let batchObjects = 0;
  const flush = (): void => {
    if (batchObjects === 0) return;
    statements += SMALL_BATCH_STATEMENTS;
    batchBytes = 0;
    batchObjects = 0;
  };
  for (const object of objects) {
    if (object.size > MAX_BLOB_BATCH_BYTES) {
      flush();
      statements += object.source === "loose" ? object.chunkRows + 2 : LARGE_PACKED_STATEMENTS;
      continue;
    }
    if (
      batchObjects > 0 &&
      (batchObjects >= OBJECT_PAGE || batchBytes + object.size > MAX_BLOB_BATCH_BYTES)
    ) {
      flush();
    }
    batchObjects++;
    batchBytes += object.size;
  }
  flush();
  return statements;
}

function requireStatementBudget(objects: readonly PushObject[], newCommits: number): void {
  const metadataPages = Math.ceil(objects.length / OBJECT_PAGE);
  const statements =
    PUSH_FIXED_STATEMENTS + newCommits + metadataPages + 2 * packPassStatements(objects);
  if (statements > MAX_PUSH_STATEMENTS) {
    throw new GitError(
      "E2BIG",
      `push requires up to ${statements} SQL statements, exceeding the ${MAX_PUSH_STATEMENTS} statement limit`,
    );
  }
}

/** Plan every object absent from the advertised target branch ancestry. */
export function planPushObjects(
  repo: Repository,
  newOid: string,
  oldOid: string,
  force: boolean,
  remoteOids: readonly string[] = [oldOid],
): PushPlan {
  const commits = new Map<string, PlannedCommit>();
  for (const { oid, commit } of repo.walkIndexed(newOid)) {
    commits.set(oid, { oid, tree: commit.tree, parents: commit.parent });
  }
  if (oldOid !== ZERO_OID && !commits.has(oldOid) && !force) {
    throw new GitError(
      "ENONFASTFORWARD",
      "remote branch is not an ancestor of the local branch; fetch or use force",
    );
  }

  const excluded = excludedCommits(commits, remoteOids);
  const wanted = [...commits.values()].filter((commit) => !excluded.has(commit.oid));
  if (wanted.length > MAX_PUSH_COMMITS) {
    throw new GitError("E2BIG", `push exceeds ${MAX_PUSH_COMMITS} new commits`);
  }

  const objects = new Map<string, ObjectType>();
  for (const commit of wanted) {
    addObject(objects, commit.oid, "commit");
    const firstParent = commit.parents[0];
    const parent = firstParent === undefined ? undefined : commits.get(firstParent);
    if (firstParent !== undefined && parent === undefined) {
      throw new GitError("ESHALLOW", `push cannot prove the tree boundary at ${firstParent}`);
    }
    for (const object of repo.walkTreeDiffObjects(parent?.tree ?? null, commit.tree)) {
      addObject(objects, object.oid, object.type);
    }
  }
  const hydrated = hydrateObjects(repo, objects);
  requireStatementBudget(hydrated, wanted.length);
  return { objects: hydrated, newCommits: wanted.length };
}

/** Open a fresh, byte-identical pack stream for an HTTP attempt. */
export async function* openPushPack(repo: Repository, plan: PushPlan): AsyncGenerator<Uint8Array> {
  try {
    yield* generatePushPack(repo, plan);
  } catch (error) {
    throw new GitError("EPUSHLOCAL", "local object validation failed while streaming push", {
      cause: error,
    });
  }
}

async function* generatePushPack(repo: Repository, plan: PushPlan): AsyncGenerator<Uint8Array> {
  yield* streamFullObjectPack(
    plan.objects,
    {
      readBatch: (objects) =>
        repo.readObjects(
          objects.map((object) => object.oid),
          { budgetBytes: MAX_BLOB_BATCH_BYTES },
        ).objects,
      readChunks: (object) => repo.store.readChunks(object.oid),
    },
    {
      maxObjects: MAX_PUSH_OBJECTS,
      maxInflatedBytes: Number.MAX_SAFE_INTEGER,
      maxStoredBytes: Number.MAX_SAFE_INTEGER,
      readBatchBytes: MAX_BLOB_BATCH_BYTES,
      allowOversizedObject: true,
    },
  );
}
