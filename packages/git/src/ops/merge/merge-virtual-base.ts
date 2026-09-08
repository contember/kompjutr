import { GitError } from "../../common/errors.js";
import { hashObject, serializeCommit } from "../../common/objects.js";
import { joinSorted } from "../../common/streams.js";
import type { IndexEntry, ObjectBatch } from "../../store/index.js";
import { writeObjectsOwned } from "../../store/repository/shared.js";
import type { IntegrationPlan } from "../integration/integration.js";
import { planVirtualAncestorIntegration } from "../integration/integration.js";
import { requireBoundedIntegrationTree } from "../integration/integration-worktree.js";
import type { Repository } from "../repository/repository.js";
import { buildTreeInBatch } from "../tree/tree-build.js";
import { treeStream } from "../tree/tree-stream.js";
import { selectMergeBases } from "./merge-base.js";

const MAX_VIRTUAL_COMMITS = 1;
const VIRTUAL_IDENTITY = {
  name: "git merge-recursive",
  email: "merge-recursive@localhost",
  timestamp: 0,
  timezoneOffset: 0,
};

export function commitTree(repo: Repository, oid: string): string {
  return repo.readCommit(oid).tree;
}

export interface VirtualState {
  commits: number;
}

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

function* virtualTreeEntries(
  repo: Repository,
  batch: ObjectBatch,
  currentTree: string,
  plan: IntegrationPlan,
): Generator<IndexEntry> {
  for (const row of joinSorted(treeStream(repo, currentTree), plan.entries, {
    left: (entry) => entry.path,
    right: (entry) => entry.path,
  })) {
    const planned = row.right;
    if (planned === undefined) {
      const current = row.left;
      if (current === undefined) throw new GitError("ECORRUPT", "virtual tree row is empty");
      yield indexEntry(current.path, current.mode, current.oid);
      continue;
    }
    if (planned.kind !== "clean") {
      throw new GitError("ECORRUPT", "virtual integration retained a conflict");
    }
    const result = planned.result;
    if (result === null) continue;
    if (planned.content !== null) {
      const oid = batch.write("blob", planned.content);
      if (oid !== result.oid || hashObject("blob", planned.content) !== result.oid) {
        throw new GitError("ECORRUPT", `virtual content identity differs at ${planned.path}`);
      }
    }
    yield indexEntry(planned.path, result.mode, result.oid);
  }
}

function materializeVirtualCommit(
  repo: Repository,
  currentOid: string,
  incomingOid: string,
  plan: IntegrationPlan,
): string {
  const currentTree = commitTree(repo, currentOid);
  return writeObjectsOwned(repo.store, (batch) => {
    const tree = buildTreeInBatch(batch, virtualTreeEntries(repo, batch, currentTree, plan));
    return batch.write(
      "commit",
      serializeCommit({
        tree,
        parent: [currentOid, incomingOid],
        author: VIRTUAL_IDENTITY,
        committer: VIRTUAL_IDENTITY,
        message: "virtual merge base\n",
      }),
    );
  });
}

function requireBoundedVirtualTree(
  repo: Repository,
  currentOid: string,
  plan: IntegrationPlan,
): void {
  const currentTree = commitTree(repo, currentOid);
  requireBoundedIntegrationTree(
    repo,
    virtualTreeEntries(repo, batchForIdentity(), currentTree, plan),
  );
}

function batchForIdentity(): ObjectBatch {
  return {
    write: (type, data) => hashObject(type, data),
    flush() {},
  };
}

function synthesizeVirtualPair(
  repo: Repository,
  currentOid: string,
  incomingOid: string,
  state: VirtualState,
  depth: number,
): string {
  const selection = selectMergeBases(repo, { currentOid, incomingOid });
  if (selection.kind === "already-merged") return currentOid;
  if (selection.kind === "fast-forward") return incomingOid;
  if (selection.kind === "shallow") {
    throw new GitError("ESHALLOW", "cannot synthesize a merge base across a shallow boundary");
  }
  if (selection.kind === "unrelated") {
    throw new GitError("EUNRELATED", "cannot synthesize unrelated merge bases");
  }
  state.commits++;
  if (state.commits > MAX_VIRTUAL_COMMITS) {
    throw new GitError(
      "E2BIG",
      `recursive merge-base synthesis exceeds ${MAX_VIRTUAL_COMMITS} temporary commits`,
    );
  }
  const baseCommit = synthesizeVirtualBases(repo, selection.bases, state, depth + 1);
  const plan = planVirtualAncestorIntegration(repo, {
    baseTreeOid: commitTree(repo, baseCommit),
    currentTreeOid: commitTree(repo, currentOid),
    incomingTreeOid: commitTree(repo, incomingOid),
    labels: { current: "Temporary merge branch 1", incoming: "Temporary merge branch 2" },
    depth,
  });
  requireBoundedVirtualTree(repo, currentOid, plan);
  return materializeVirtualCommit(repo, currentOid, incomingOid, plan);
}

function synthesizeVirtualBases(
  repo: Repository,
  bases: readonly string[],
  state: VirtualState,
  depth: number,
): string {
  const first = bases[0];
  if (first === undefined) throw new GitError("EUNRELATED", "merge base list is empty");
  let current = first;
  for (let index = 1; index < bases.length; index++) {
    const incoming = bases[index];
    if (incoming === undefined) throw new GitError("ECORRUPT", "merge base list has a hole");
    current = synthesizeVirtualPair(repo, current, incoming, state, depth);
  }
  return current;
}

export function selectedBaseTree(
  repo: Repository,
  bases: readonly string[],
  state: VirtualState,
): string {
  return commitTree(repo, synthesizeVirtualBases(repo, bases, state, 1));
}
