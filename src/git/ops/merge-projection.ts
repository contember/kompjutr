// Project logical integration conflicts into the physical index/worktree paths Git uses.

import { GitError } from "../common/errors.js";
import { MODE_EXECUTABLE, MODE_FILE, MODE_SYMLINK } from "../common/objects.js";
import { comparePaths } from "../common/streams.js";
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

type MaterializableModeClass = "regular" | "symlink";

function materializableModeClass(
  identity: IntegrationIdentity | null,
): MaterializableModeClass | null {
  if (identity === null) return null;
  if (identity.mode === MODE_FILE || identity.mode === MODE_EXECUTABLE) return "regular";
  return identity.mode === MODE_SYMLINK ? "symlink" : null;
}

function stagesForModeClass(
  entry: Extract<IntegrationEntry, { kind: "conflict" }>,
  modeClass: MaterializableModeClass,
): IntegrationStages {
  return {
    base: materializableModeClass(entry.stages.base) === modeClass ? entry.stages.base : null,
    current:
      materializableModeClass(entry.stages.current) === modeClass ? entry.stages.current : null,
    incoming:
      materializableModeClass(entry.stages.incoming) === modeClass ? entry.stages.incoming : null,
  };
}

function distinctMaterializableSides(
  entry: Extract<IntegrationEntry, { kind: "conflict" }>,
): { regular: "current" | "incoming"; symlink: "current" | "incoming" } | null {
  if (entry.conflict !== "add/add" && entry.conflict !== "symlink") return null;
  const currentClass = materializableModeClass(entry.stages.current);
  const incomingClass = materializableModeClass(entry.stages.incoming);
  if (currentClass === "regular" && incomingClass === "symlink") {
    return { regular: "current", symlink: "incoming" };
  }
  if (currentClass === "symlink" && incomingClass === "regular") {
    return { regular: "incoming", symlink: "current" };
  }
  return null;
}

function projectDistinctMaterializableConflict(
  entry: Extract<IntegrationEntry, { kind: "conflict" }>,
  sides: { regular: "current" | "incoming"; symlink: "current" | "incoming" },
  options: MergeProjectionOptions,
  reserved: Set<string>,
  untracked: ReadonlySet<string>,
): ProjectedMergeEntry[] {
  const regular = entry.stages[sides.regular];
  const symlink = entry.stages[sides.symlink];
  if (regular === null || symlink === null) {
    throw new GitError("ECORRUPT", `distinct-type conflict ${entry.path} lost one side`);
  }
  const label = sides.regular === "current" ? options.currentLabel : options.incomingLabel;
  return [
    {
      path: entry.path,
      logicalPath: entry.path,
      purpose: "primary",
      stageZero: null,
      stages: stagesForModeClass(entry, "symlink"),
      worktree: symlink,
      content: null,
    },
    {
      path: uniqueRelocation(entry.path, label, reserved, untracked),
      logicalPath: entry.path,
      purpose: sides.regular === "current" ? "current-relocation" : "incoming-relocation",
      stageZero: null,
      stages: stagesForModeClass(entry, "regular"),
      worktree: regular,
      content: null,
    },
  ];
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

/** Project structural conflicts to Git's collision-safe physical paths. */
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
    if (entry.kind === "conflict") {
      const distinctSides = distinctMaterializableSides(entry);
      if (distinctSides !== null) {
        projected.push(
          ...projectDistinctMaterializableConflict(
            entry,
            distinctSides,
            options,
            reserved,
            untracked,
          ),
        );
        index++;
        continue;
      }
    }
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
