import { GitError } from "../../common/errors.js";
import { joinSorted } from "../../common/streams.js";
import type { IndexEntry, ObjectBatch } from "../../store/index.js";
import type { IntegrationWorkspace } from "../../store/operations/integration-workspace/workspace.js";
import { planVirtualAncestorIntegrationOwned } from "../integration/integration-plan-owned.js";
import { requireBoundedIntegrationTree } from "../integration/integration-worktree.js";
import type { Repository } from "../repository/repository.js";
import { buildTreeInBatch } from "../tree/tree-build.js";
import { selectMergeBases } from "./merge-base.js";

const MAX_VIRTUAL_COMMITS = 1;

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

type VirtualBaseSource = { kind: "commit"; oid: string } | { kind: "tree"; oid: string };

export function selectedBaseTreeOwned(
  workspace: IntegrationWorkspace,
  repo: Repository,
  bases: readonly string[],
  state: VirtualState,
): string {
  const treeOf = (source: VirtualBaseSource) =>
    source.kind === "tree" ? source.oid : commitTree(repo, source.oid);
  function synthesize(bases: readonly string[], depth: number): VirtualBaseSource {
    const first = bases[0];
    if (first === undefined) throw new GitError("EUNRELATED", "merge base list is empty");
    let current: VirtualBaseSource = { kind: "commit", oid: first };
    for (const incoming of bases.slice(1)) {
      if (current.kind === "tree")
        throw new GitError(
          "E2BIG",
          `recursive merge-base synthesis exceeds ${MAX_VIRTUAL_COMMITS} temporary commits`,
        );
      const selection = selectMergeBases(repo, { currentOid: current.oid, incomingOid: incoming });
      if (selection.kind === "already-merged") continue;
      if (selection.kind === "fast-forward") {
        current = { kind: "commit", oid: incoming };
        continue;
      }
      if (selection.kind === "shallow")
        throw new GitError("ESHALLOW", "cannot synthesize a merge base across a shallow boundary");
      if (selection.kind === "unrelated")
        throw new GitError("EUNRELATED", "cannot synthesize unrelated merge bases");
      if (++state.commits > MAX_VIRTUAL_COMMITS)
        throw new GitError(
          "E2BIG",
          `recursive merge-base synthesis exceeds ${MAX_VIRTUAL_COMMITS} temporary commits`,
        );
      const base = synthesize(selection.bases, depth + 1);
      const currentTree = treeOf(current);
      const plan = planVirtualAncestorIntegrationOwned(workspace, {
        baseTreeOid: treeOf(base),
        currentTreeOid: currentTree,
        incomingTreeOid: commitTree(repo, incoming),
        labels: { current: "Temporary merge branch 1", incoming: "Temporary merge branch 2" },
        depth,
      });
      function* entries(): Generator<IndexEntry> {
        for (const row of joinSorted(workspace.source.walkTree(currentTree), plan.entries, {
          left: (entry) => entry.path,
          right: (entry) => entry.path,
        })) {
          if (row.right !== undefined) {
            if (row.right.kind !== "clean")
              throw new GitError("ECORRUPT", "virtual integration retained a conflict");
            if (row.right.result !== null)
              yield indexEntry(row.right.path, row.right.result.mode, row.right.result.oid);
          } else if (row.left !== undefined)
            yield indexEntry(row.left.path, row.left.mode, row.left.oid);
        }
      }
      requireBoundedIntegrationTree(repo, entries);
      const batch: ObjectBatch = {
        write(type, data) {
          if (type !== "blob" && type !== "tree")
            throw new GitError("ECORRUPT", "virtual tree construction emitted a non-tree object");
          return workspace.source.write(type, data);
        },
        flush() {},
      };
      current = { kind: "tree", oid: buildTreeInBatch(batch, entries()) };
    }
    return current;
  }
  return treeOf(synthesize(bases, 1));
}
