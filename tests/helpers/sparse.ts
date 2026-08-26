import { expect } from "vitest";

import type { GitContext, IndexTrackerSeedEntry } from "../../src/core/context.js";
import { hashWorktreePath, indexEntryFor } from "../../src/core/ops/worktree-io.js";
import type { SparseWorkspaceSource } from "../../src/core/sparse-workspace.js";
import { resealIndexTracker } from "../../src/sqlite/index-tracker.js";
import type { TestRepository } from "./workspace.js";

export function configureFixtureIdentity(workspace: TestRepository): void {
  workspace.repo.store.configSet("user.name", "Fixture");
  workspace.repo.store.configSet("user.email", "fixture@example.com");
}

export function stageWorktreePaths(workspace: TestRepository, paths: readonly string[]): void {
  for (const path of paths) {
    const hashed = hashWorktreePath(workspace.repo, workspace.worktree, path);
    if (hashed === null) throw new Error(`missing fixture path: ${path}`);
    workspace.repo.checkout.indexPut(indexEntryFor(path, hashed));
  }
}

export function requireSparseWorkspace(workspace: TestRepository): SparseWorkspaceSource {
  const source = workspace.context.sparseWorkspace;
  if (source === undefined) throw new Error("missing sparse workspace source");
  return source;
}

export function sparseTrackerContext(
  workspace: TestRepository,
  source: SparseWorkspaceSource | undefined = workspace.context.sparseWorkspace,
): GitContext {
  return {
    ...workspace.context,
    sparseWorkspace: source,
    indexTracker: {
      reseal(checkoutId, baselineTreeOid, entries) {
        return resealIndexTracker(workspace.database.db, checkoutId, baselineTreeOid, entries);
      },
    },
  };
}

export interface SealIndexTrackerOptions {
  baselineTreeOid?: string | null;
  entries?: Iterable<IndexTrackerSeedEntry>;
}

export function sealIndexTracker(
  workspace: TestRepository,
  options: SealIndexTrackerOptions = {},
): void {
  expect(
    resealIndexTracker(
      workspace.database.db,
      workspace.repo.checkout.checkoutId,
      options.baselineTreeOid === undefined ? workspace.repo.headTree() : options.baselineTreeOid,
      options.entries ?? [],
    ),
  ).toBe(true);
}
