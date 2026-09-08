import { renameSync, unlinkSync } from "node:fs";
import { dirname, join } from "node:path";

import { localError } from "../errors.js";
import { hasCoveringVirtualPath, type PathMapper } from "../paths.js";
import type { RecoveryCheckpointHandler } from "./contracts.js";
import { pathExists, removePath, syncDirectory } from "./fs.js";
import type { RecoveryManifest, TouchRecord } from "./journal.js";

function settlementHost(mapper: PathMapper, path: string, followFinal: boolean): string {
  const current = mapper.resolve(path, followFinal);
  if (current !== path) {
    throw localError("ECORRUPT", "recovery path changed through a symbolic link", path);
  }
  return mapper.lexicalHost(path);
}

function cleanupProbes(
  mapper: PathMapper,
  directory: string,
  manifest: RecoveryManifest,
  touchPaths: ReadonlySet<string>,
  checkpoint: RecoveryCheckpointHandler,
): void {
  for (const probe of manifest.probes) {
    if (hasCoveringVirtualPath(touchPaths, probe.parent)) continue;
    const parent = settlementHost(mapper, probe.parent, true);
    removePath(join(parent, probe.destination));
    if (pathExists(parent)) syncDirectory(parent);
    removePath(join(directory, probe.origin));
    if (pathExists(directory)) syncDirectory(directory);
    checkpoint("probe-cleaned");
  }
}

function cleanupTemporaries(
  mapper: PathMapper,
  manifest: RecoveryManifest,
  touchPaths: ReadonlySet<string>,
  checkpoint: RecoveryCheckpointHandler,
): void {
  for (const temporary of manifest.temporaries) {
    if (hasCoveringVirtualPath(touchPaths, temporary.parent)) continue;
    const parent = settlementHost(mapper, temporary.parent, true);
    removePath(join(parent, temporary.name));
    if (pathExists(parent)) syncDirectory(parent);
    checkpoint("temporary-cleaned");
  }
}

function rollForward(
  directory: string,
  touches: readonly TouchRecord[],
  checkpoint: RecoveryCheckpointHandler,
): void {
  for (const touch of touches) {
    if (touch.backup === null) continue;
    removePath(join(directory, touch.backup));
    syncDirectory(directory);
    checkpoint("backup-cleaned");
  }
}

function rollBack(
  mapper: PathMapper,
  directory: string,
  touches: readonly TouchRecord[],
  checkpoint: RecoveryCheckpointHandler,
): void {
  for (let index = touches.length - 1; index >= 0; index--) {
    const touch = touches[index];
    if (touch === undefined) continue;
    const target = settlementHost(mapper, touch.path, false);
    if (touch.backup === null) {
      removePath(target);
      if (pathExists(dirname(target))) syncDirectory(dirname(target));
      checkpoint("created-path-removed");
      continue;
    }
    const backup = join(directory, touch.backup);
    if (!pathExists(backup)) {
      if (pathExists(dirname(target))) syncDirectory(dirname(target));
      continue;
    }
    removePath(target);
    renameSync(backup, target);
    syncDirectory(dirname(target));
    syncDirectory(directory);
    checkpoint("backup-restored");
  }
}

export function settleRecovery(
  mapper: PathMapper,
  recoveryRoot: string,
  directory: string,
  manifest: RecoveryManifest,
  committed: boolean,
  checkpoint: RecoveryCheckpointHandler,
): void {
  const touchPaths = new Set(manifest.touches.map((touch) => touch.path));
  if (committed) rollForward(directory, manifest.touches, checkpoint);
  else rollBack(mapper, directory, manifest.touches, checkpoint);
  cleanupProbes(mapper, directory, manifest, touchPaths, checkpoint);
  cleanupTemporaries(mapper, manifest, touchPaths, checkpoint);
  const journal = join(directory, "journal");
  if (pathExists(journal)) {
    unlinkSync(journal);
    syncDirectory(directory);
    checkpoint("journal-unlinked");
  }
  removePath(directory);
  syncDirectory(recoveryRoot);
  checkpoint("transaction-removed");
}
