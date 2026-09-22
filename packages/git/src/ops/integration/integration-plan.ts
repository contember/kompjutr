import { CorruptError } from "../../common/errors.js";
import type { IntegrationEntry as StoredIntegrationEntry } from "../../store/operations/integration-workspace/descriptors.js";
import type { IntegrationPlanHandle } from "../../store/operations/integration-workspace/storage.js";
import {
  type IntegrationWorkspace,
  withIntegrationWorkspaceOwned,
} from "../../store/operations/integration-workspace/workspace.js";
import type { Repository } from "../repository/repository.js";
import {
  planIntegrationOwned,
  planVirtualAncestorIntegrationOwned,
} from "./integration-plan-owned.js";
import type {
  IntegrationEntry,
  IntegrationInput,
  IntegrationPlan,
  VirtualAncestorIntegrationInput,
} from "./integration-types.js";

function detach(
  workspace: IntegrationWorkspace,
  plan: IntegrationPlanHandle<StoredIntegrationEntry>,
): IntegrationPlan {
  const entries: IntegrationEntry[] = [];
  for (const entry of plan.entries) {
    if (entry.content === null) {
      entries.push({ ...entry, content: null });
      continue;
    }
    const batch = workspace.source.readBlobs([entry.content.oid], {
      budgetBytes: Math.max(1, entry.content.size),
    });
    const content = batch.blobs.get(entry.content.oid);
    if (content === undefined) throw new CorruptError("detached integration content is missing");
    entries.push({ ...entry, content });
  }
  return { entries, sourceRows: plan.sourceRows };
}

/** Detached diagnostic plans materialize their required return value inside the owner scope. */
export function planIntegration(repo: Repository, input: IntegrationInput): IntegrationPlan {
  return withIntegrationWorkspaceOwned(repo.store, (workspace) =>
    detach(workspace, planIntegrationOwned(workspace, input)),
  );
}

export function planVirtualAncestorIntegration(
  repo: Repository,
  input: VirtualAncestorIntegrationInput,
): IntegrationPlan {
  return withIntegrationWorkspaceOwned(repo.store, (workspace) =>
    detach(workspace, planVirtualAncestorIntegrationOwned(workspace, input)),
  );
}
