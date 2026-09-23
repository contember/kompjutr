// Runs the owned integration planners inside one workspace and collects their
// stored plans into arrays, so tests can assert whole plans after the scope ends.

import {
  planIntegrationOwned,
  planVirtualAncestorIntegrationOwned,
} from "../../packages/git/src/ops/integration/integration-plan-owned.js";
import { classifyIntegrationStructureOwned } from "../../packages/git/src/ops/integration/integration-structure-owned.js";
import { integrationTouched } from "../../packages/git/src/ops/integration/integration-touched.js";
import {
  type IntegrationEntry,
  type IntegrationInput,
  MAX_INTEGRATION_SOURCE_ROWS,
  type VirtualAncestorIntegrationInput,
} from "../../packages/git/src/ops/integration/integration-types.js";
import {
  type MergeProjectionCollisions,
  type MergeProjectionOptions,
  type ProjectedMergeEntry,
  projectMergePlanOwned,
} from "../../packages/git/src/ops/merge/merge-projection.js";
import { planReplayOwned } from "../../packages/git/src/ops/replay/replay-planning.js";
import type { ReplayInput, ReplayPlan } from "../../packages/git/src/ops/replay/replay-types.js";
import type { Repository } from "../../packages/git/src/ops/repository/repository.js";
import type {
  IntegrationContentReference,
  IntegrationEntry as StoredIntegrationEntry,
  ProjectedMergeEntry as StoredProjectedEntry,
  StructuralIntegrationEntry,
} from "../../packages/git/src/store/operations/integration-workspace/descriptors.js";
import type { IntegrationPlanHandle } from "../../packages/git/src/store/operations/integration-workspace/storage.js";
import type { IntegrationTouchedShape } from "../../packages/git/src/store/operations/integration-workspace/touched.js";
import {
  type IntegrationWorkspace,
  withIntegrationWorkspaceOwned,
} from "../../packages/git/src/store/operations/integration-workspace/workspace.js";

export interface CollectedIntegrationPlan {
  entries: readonly IntegrationEntry[];
  sourceRows: number;
}

export type CollectedReplayPlan = Omit<ReplayPlan, "integration"> & {
  integration: CollectedIntegrationPlan;
};

export interface CollectedStructure {
  entries: readonly StructuralIntegrationEntry[];
  sourceRows: number;
}

export interface StructureTrees {
  baseTreeOid: string | null;
  currentTreeOid: string | null;
  incomingTreeOid: string | null;
}

export interface StructureLimits {
  maxRows?: number;
}

function readContent(
  workspace: IntegrationWorkspace,
  content: IntegrationContentReference,
): Uint8Array {
  const batch = workspace.source.readBlobs([content.oid], {
    budgetBytes: Math.max(1, content.size),
  });
  const bytes = batch.blobs.get(content.oid);
  if (bytes === undefined)
    throw new Error(`collected integration content ${content.oid} is missing`);
  return bytes;
}

function collectPlan(
  workspace: IntegrationWorkspace,
  plan: IntegrationPlanHandle<StoredIntegrationEntry>,
): CollectedIntegrationPlan {
  const entries: IntegrationEntry[] = [];
  for (const entry of plan.entries) {
    entries.push({
      ...entry,
      content: entry.content === null ? null : readContent(workspace, entry.content),
    });
  }
  return { entries, sourceRows: plan.sourceRows };
}

export function collectIntegration(
  repo: Repository,
  input: IntegrationInput,
): CollectedIntegrationPlan {
  return withIntegrationWorkspaceOwned(repo.store, (workspace) =>
    collectPlan(workspace, planIntegrationOwned(workspace, input)),
  );
}

export function collectVirtualAncestorIntegration(
  repo: Repository,
  input: VirtualAncestorIntegrationInput,
): CollectedIntegrationPlan {
  return withIntegrationWorkspaceOwned(repo.store, (workspace) =>
    collectPlan(workspace, planVirtualAncestorIntegrationOwned(workspace, input)),
  );
}

export function collectReplay(repo: Repository, input: ReplayInput): CollectedReplayPlan {
  return withIntegrationWorkspaceOwned(repo.store, (workspace) => {
    const plan = planReplayOwned(workspace, repo, input);
    return { ...plan, integration: collectPlan(workspace, plan.integration) };
  });
}

/** Classify three stored trees with the planner's structural pass and its row bound. */
export function collectStructure(
  repo: Repository,
  trees: StructureTrees,
  limits: StructureLimits = {},
  prepare: (workspace: IntegrationWorkspace) => void = () => {},
): CollectedStructure {
  return withIntegrationWorkspaceOwned(repo.store, (workspace) => {
    prepare(workspace);
    const plan = classifyIntegrationStructureOwned(workspace, trees, {
      maxRows: limits.maxRows ?? MAX_INTEGRATION_SOURCE_ROWS,
    });
    return { entries: [...plan.entries], sourceRows: plan.sourceRows };
  });
}

function storeResolvedPlan(
  workspace: IntegrationWorkspace,
  plan: CollectedIntegrationPlan,
): IntegrationPlanHandle<StoredIntegrationEntry> {
  const stored = workspace.resolvedPlan();
  function* entries(): Generator<StoredIntegrationEntry> {
    for (const entry of plan.entries) {
      const content =
        entry.content === null
          ? null
          : { oid: workspace.source.write("blob", entry.content), size: entry.content.length };
      yield { ...entry, content };
    }
  }
  stored.entries.write(entries());
  stored.finish(plan.sourceRows, plan.entries.length);
  return stored;
}

export function collectMergeProjection(
  repo: Repository,
  plan: CollectedIntegrationPlan,
  options: MergeProjectionOptions,
  collisions?: MergeProjectionCollisions,
): ProjectedMergeEntry<Uint8Array>[] {
  return withIntegrationWorkspaceOwned(repo.store, (workspace) => {
    const projected = projectMergePlanOwned(
      workspace,
      storeResolvedPlan(workspace, plan),
      options,
      collisions,
    );
    const entries: ProjectedMergeEntry<Uint8Array>[] = [];
    for (const entry of projected.entries) {
      entries.push({
        ...entry,
        content: entry.content === null ? null : readContent(workspace, entry.content),
      });
    }
    return entries;
  });
}

/** The touched shapes an apply reserves for these projected entries. */
export function collectTouchedShapes(
  repo: Repository,
  entries: readonly StoredProjectedEntry[],
): IntegrationTouchedShape[] {
  return withIntegrationWorkspaceOwned(repo.store, (workspace) => {
    const projected = workspace.projectedPlan();
    projected.entries.write(entries);
    projected.finish(0, entries.length);
    return [...integrationTouched(workspace, projected).shapes()];
  });
}
