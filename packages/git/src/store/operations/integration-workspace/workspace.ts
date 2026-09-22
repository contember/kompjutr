import { CorruptError, GitError } from "../../../common/errors.js";
import type { Decoder } from "../../../common/rows.js";
import { isThenableResult } from "../../core/json-pages.js";
import type { SharedRepoStore } from "../../repository/shared.js";
import { scratchTransactionsFor } from "../../repository/shared-support.js";
import {
  type IntegrationEntry,
  type ProjectedMergeEntry,
  projectedDescriptor,
  resolvedDescriptor,
  type StructuralIntegrationEntry,
  structuralDescriptor,
} from "./descriptors.js";
import { IntegrationWorkspaceObjects } from "./objects.js";
import { type IntegrationReservationFamily, IntegrationReservations } from "./reservations.js";
import { IntegrationPlanHandle, IntegrationWorkspaceOwner } from "./storage.js";
import { IntegrationTouched } from "./touched.js";

export class IntegrationWorkspace {
  readonly source: IntegrationWorkspaceObjects;
  #nextPlan = 0;
  readonly #plans = new WeakSet<object>();
  readonly #touched = new WeakMap<object, IntegrationTouched>();

  constructor(
    private readonly owner: IntegrationWorkspaceOwner,
    ordinary: SharedRepoStore,
  ) {
    this.source = new IntegrationWorkspaceObjects(owner, ordinary);
  }

  structuralPlan(): IntegrationPlanHandle<StructuralIntegrationEntry> {
    return this.createPlan("structural", structuralDescriptor);
  }

  resolvedPlan(): IntegrationPlanHandle<IntegrationEntry> {
    return this.createPlan("resolved", resolvedDescriptor);
  }

  projectedPlan(): IntegrationPlanHandle<ProjectedMergeEntry> {
    return this.createPlan("projected", projectedDescriptor);
  }

  touched<T extends { path: string }>(plan: IntegrationPlanHandle<T>): IntegrationTouched {
    this.owner.requireActive();
    if (!this.#plans.has(plan))
      throw new GitError("EINVAL", "integration plan belongs to another workspace");
    let touched = this.#touched.get(plan);
    if (touched === undefined) {
      touched = new IntegrationTouched(this.owner, plan.planId);
      this.#touched.set(plan, touched);
    }
    return touched;
  }

  reservations<T extends { path: string }>(
    plan: IntegrationPlanHandle<T>,
    family: IntegrationReservationFamily,
  ): IntegrationReservations {
    this.owner.requireActive();
    if (!this.#plans.has(plan))
      throw new GitError("EINVAL", "integration plan belongs to another workspace");
    return new IntegrationReservations(this.owner, plan.planId, family);
  }

  private createPlan<T extends { path: string }>(
    kind: "structural" | "resolved" | "projected",
    decoder: Decoder<T>,
  ): IntegrationPlanHandle<T> {
    const owner = this.owner;
    owner.requireActive();
    const planId = this.#nextPlan++;
    owner.db.run(
      `INSERT INTO git_integration_plans (repo_id, workspace_id, plan_id, kind, source_rows, entry_count)
       VALUES (?, ?, ?, ?, 0, 0)`,
      owner.repoId,
      owner.workspaceId,
      planId,
      kind,
    );
    const plan = new IntegrationPlanHandle(owner, planId, decoder, kind === "structural");
    this.#plans.add(plan);
    return plan;
  }
}

export function withIntegrationWorkspaceOwned<T>(
  store: SharedRepoStore,
  body: (workspace: IntegrationWorkspace) => T,
): T {
  const coordinator = scratchTransactionsFor(store.db);
  const outermost = coordinator.enter();
  const owner = new IntegrationWorkspaceOwner(store.db, store.repoId, crypto.randomUUID(), () =>
    coordinator.requireHealthy(),
  );
  try {
    const result = store.db.transactionSync(() => {
      coordinator.requireHealthy();
      store.db.run(
        "INSERT INTO git_integration_workspaces (repo_id, workspace_id) VALUES (?, ?)",
        store.repoId,
        owner.workspaceId,
      );
      try {
        const result = body(new IntegrationWorkspace(owner, store));
        if (isThenableResult(result)) {
          void Promise.resolve(result).catch(() => {});
          throw new GitError("EINVAL", "integration workspace callback must be synchronous");
        }
        coordinator.requireHealthy();
        owner.closeCursors();
        const deleted = store.db.one<{ workspace_id: unknown }>(
          `DELETE FROM git_integration_workspaces WHERE repo_id = ? AND workspace_id = ?
           RETURNING workspace_id`,
          store.repoId,
          owner.workspaceId,
        );
        if (deleted?.workspace_id !== owner.workspaceId)
          throw new CorruptError("integration workspace ownership changed");
        return result;
      } finally {
        owner.revoke();
      }
    });
    coordinator.leave();
    if (outermost) coordinator.finish();
    return result;
  } catch (error) {
    owner.revoke();
    coordinator.fail(error);
    coordinator.leave();
    if (!outermost) throw error;
    const outcome = coordinator.finish();
    for (const changed of outcome.storageWrites) changed.revalidateStorageCaches();
    throw outcome.failure;
  }
}
