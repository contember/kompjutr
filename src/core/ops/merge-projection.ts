// Project logical integration conflicts into the physical index/worktree paths Git uses.

import { GitError } from "../errors.js";
import { comparePaths } from "../streams.js";
import type { IntegrationEntry, IntegrationPlan } from "./integration.js";
import type { IntegrationIdentity, IntegrationStages } from "./integration-structure.js";
import { validateMergePath } from "./merge-state.js";

export const MAX_MERGE_RELOCATION_ATTEMPTS = 1_000;

export type MergePathPurpose = "primary" | "current-relocation" | "incoming-relocation";

export interface ProjectedMergeEntry {
  path: string;
  logicalPath: string;
  purpose: MergePathPurpose;
  stageZero: IntegrationIdentity | null;
  stages: IntegrationStages | null;
  worktree: IntegrationIdentity | null;
  content: Uint8Array | null;
}

export interface MergeProjectionOptions {
  currentLabel: string;
  incomingLabel: string;
  /** Candidate paths already owned by a tracked entry or directory. */
  trackedCollisions?: ReadonlySet<string>;
  /** Candidate paths owned only by untracked worktree content. */
  untrackedCollisions?: ReadonlySet<string>;
}

function selectedWorktree(
  stages: IntegrationStages,
  resultMode: string | undefined,
): IntegrationIdentity | null {
  const selected = stages.current ?? stages.incoming;
  if (selected === null || resultMode === undefined) return selected;
  return { mode: resultMode, oid: selected.oid };
}

function ordinary(entry: IntegrationEntry): ProjectedMergeEntry {
  if (entry.kind === "clean") {
    return {
      path: entry.path,
      logicalPath: entry.path,
      purpose: "primary",
      stageZero: entry.result,
      stages: null,
      worktree: entry.result,
      content: entry.content,
    };
  }
  return {
    path: entry.path,
    logicalPath: entry.path,
    purpose: "primary",
    stageZero: null,
    stages: entry.stages,
    worktree: selectedWorktree(entry.stages, entry.resultMode),
    content: entry.content,
  };
}

function safeRelocationLabel(label: string): string {
  if (label.length === 0) throw new GitError("EINVAL", "merge relocation label is empty");
  let out = "";
  for (let index = 0; index < label.length; index++) {
    const unit = label.charCodeAt(index);
    if (unit === 0 || unit === 0x0a || unit === 0x0d) {
      throw new GitError("EINVAL", "merge relocation label contains a control byte");
    }
    if (unit >= 0xd800 && unit <= 0xdbff) {
      const low = label.charCodeAt(index + 1);
      if (low < 0xdc00 || low > 0xdfff) {
        throw new GitError("EINVAL", "merge relocation label contains an unpaired surrogate");
      }
      out += label[index]! + label[index + 1]!;
      index++;
      continue;
    }
    if (unit >= 0xdc00 && unit <= 0xdfff) {
      throw new GitError("EINVAL", "merge relocation label contains an unpaired surrogate");
    }
    out += unit === 0x2f ? "_" : label[index]!;
  }
  return out;
}

function uniqueRelocation(
  logicalPath: string,
  label: string,
  reserved: Set<string>,
  untracked: ReadonlySet<string>,
): string {
  const base = `${logicalPath}~${safeRelocationLabel(label)}`;
  for (let attempt = 0; attempt < MAX_MERGE_RELOCATION_ATTEMPTS; attempt++) {
    const candidate = attempt === 0 ? base : `${base}_${attempt - 1}`;
    validateMergePath(candidate, "relocation path");
    if (reserved.has(candidate)) continue;
    if (untracked.has(candidate)) {
      throw new GitError(
        "ECHECKOUTFAIL",
        `untracked working tree path would be overwritten by merge: ${candidate}`,
      );
    }
    reserved.add(candidate);
    return candidate;
  }
  throw new GitError(
    "E2BIG",
    `merge relocation for ${logicalPath} exceeds ${MAX_MERGE_RELOCATION_ATTEMPTS} attempts`,
  );
}

function sideStages(
  entry: Extract<IntegrationEntry, { kind: "conflict" }>,
  side: "current" | "incoming",
): IntegrationStages {
  return {
    base: entry.stages.base,
    current: side === "current" ? entry.stages.current : null,
    incoming: side === "incoming" ? entry.stages.incoming : null,
  };
}

function descendant(
  entry: Extract<IntegrationEntry, { kind: "conflict" }>,
  directorySide: "current" | "incoming",
): ProjectedMergeEntry {
  const identity = entry.stages[directorySide];
  const other = directorySide === "current" ? entry.stages.incoming : entry.stages.current;
  if (entry.stages.base === null && identity !== null && other === null) {
    return {
      path: entry.path,
      logicalPath: entry.path,
      purpose: "primary",
      stageZero: identity,
      stages: null,
      worktree: identity,
      content: null,
    };
  }
  return ordinary(entry);
}

/** Relocate each file side of a file/directory conflict and preserve Git's stages. */
export function projectMergePlan(
  plan: IntegrationPlan,
  options: MergeProjectionOptions,
): readonly ProjectedMergeEntry[] {
  const projected: ProjectedMergeEntry[] = [];
  const reserved = new Set(options.trackedCollisions ?? []);
  const untracked = options.untrackedCollisions ?? new Set<string>();
  for (const entry of plan.entries) reserved.add(entry.path);
  let index = 0;
  while (index < plan.entries.length) {
    const entry = plan.entries[index]!;
    if (entry.kind !== "conflict" || entry.conflict !== "file/directory") {
      projected.push(ordinary(entry));
      index++;
      continue;
    }

    const currentFile = entry.stages.current;
    const incomingFile = entry.stages.incoming;
    if ((currentFile === null) === (incomingFile === null)) {
      throw new GitError("ECORRUPT", `file/directory root ${entry.path} has no unique file side`);
    }
    const fileSide = currentFile === null ? "incoming" : "current";
    const directorySide = fileSide === "current" ? "incoming" : "current";
    const fileIdentity = entry.stages[fileSide];
    if (fileIdentity === null) {
      throw new GitError("ECORRUPT", `file/directory root ${entry.path} lost its file identity`);
    }
    const label = fileSide === "current" ? options.currentLabel : options.incomingLabel;
    projected.push({
      path: uniqueRelocation(entry.path, label, reserved, untracked),
      logicalPath: entry.path,
      purpose: fileSide === "current" ? "current-relocation" : "incoming-relocation",
      stageZero: null,
      stages: sideStages(entry, fileSide),
      worktree: fileIdentity,
      content: null,
    });

    index++;
    const prefix = `${entry.path}/`;
    while (index < plan.entries.length && plan.entries[index]!.path.startsWith(prefix)) {
      const child = plan.entries[index]!;
      if (child.kind !== "conflict" || child.conflict !== "file/directory") {
        throw new GitError(
          "ECORRUPT",
          `file/directory group ${entry.path} has a non-conflict child`,
        );
      }
      projected.push(descendant(child, directorySide));
      index++;
    }
  }
  projected.sort((left, right) => comparePaths(left.path, right.path));
  for (let position = 1; position < projected.length; position++) {
    if (comparePaths(projected[position - 1]!.path, projected[position]!.path) === 0) {
      throw new GitError(
        "ECORRUPT",
        `merge projection emitted duplicate path ${projected[position]!.path}`,
      );
    }
  }
  return projected;
}
