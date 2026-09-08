import { join } from "node:path";

import { comparePaths, hasCoveringVirtualPath, type PathMapper, virtualDepth } from "../paths.js";
import { pathExists } from "./fs.js";
import type { TouchRecord } from "./journal.js";

interface RequestedPath {
  readonly path: string;
  readonly host: string;
}

export interface PreparedPath extends RequestedPath {
  readonly source: string | null;
  readonly moved: boolean;
}

export interface RecoveryPreparationPlan {
  readonly requested: readonly RequestedPath[];
  readonly touches: readonly TouchRecord[];
  readonly nextBackupSequence: number;
}

function firstMissingRoot(mapper: PathMapper, path: string): string | null {
  if (path === "/") return pathExists(mapper.root) ? null : "/";
  const parts = path.slice(1).split("/");
  let current = "";
  for (const part of parts) {
    current += `/${part}`;
    if (!pathExists(mapper.lexicalHost(current))) return current;
  }
  return null;
}

export function planRecoveryPreparation(
  mapper: PathMapper,
  paths: readonly string[],
  activeTouchPaths: ReadonlySet<string>,
  initialBackupSequence: number,
): RecoveryPreparationPlan {
  const canonical = paths.map((path) => mapper.resolve(path, false));
  const requested = canonical.map((path) => ({ path, host: mapper.lexicalHost(path) }));
  const candidates = new Map<string, TouchRecord>();
  for (const item of requested) {
    if (hasCoveringVirtualPath(activeTouchPaths, item.path)) continue;
    const missing = firstMissingRoot(mapper, item.path);
    const touchPath = missing ?? item.path;
    if (hasCoveringVirtualPath(activeTouchPaths, touchPath)) continue;
    candidates.set(touchPath, { path: touchPath, backup: null });
  }

  const ordered = [...candidates.values()].sort((left, right) => {
    const depth = virtualDepth(left.path) - virtualDepth(right.path);
    return depth === 0 ? comparePaths(left.path, right.path) : depth;
  });
  const touches: TouchRecord[] = [];
  const batchTouchPaths = new Set<string>();
  let backupSequence = initialBackupSequence;
  for (const candidate of ordered) {
    if (hasCoveringVirtualPath(batchTouchPaths, candidate.path)) continue;
    const host = mapper.lexicalHost(candidate.path);
    const backup = pathExists(host) ? `backup-${backupSequence++}` : null;
    touches.push({ path: candidate.path, backup });
    batchTouchPaths.add(candidate.path);
  }
  return { requested, touches, nextBackupSequence: backupSequence };
}

export function preparedPaths(
  requested: readonly RequestedPath[],
  touches: readonly TouchRecord[],
  recoveryDirectory: string,
): PreparedPath[] {
  const exactTouches = new Map(touches.map((touch) => [touch.path, touch]));
  return requested.map((item) => {
    const backup = exactTouches.get(item.path)?.backup;
    const moved = backup !== null && backup !== undefined;
    const source = moved
      ? join(recoveryDirectory, backup)
      : pathExists(item.host)
        ? item.host
        : null;
    return { ...item, source, moved };
  });
}
