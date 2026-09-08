import type { RealPath, ScanEntry, ScanOptions } from "./index.js";

export interface NativeDriveReads {
  realpath(path: string): RealPath;
  scan(root: RealPath, options: ScanOptions): ScanEntry[];
}

const NATIVE_READS = new WeakMap<object, NativeDriveReads>();

export function registerNativeDriveReads(drive: object, reads: NativeDriveReads): void {
  NATIVE_READS.set(drive, reads);
}

export function nativeRealpathOwned(drive: object, path: string): RealPath | null {
  return NATIVE_READS.get(drive)?.realpath(path) ?? null;
}

export function nativeScanOwned(
  drive: object,
  root: RealPath,
  options: ScanOptions,
): ScanEntry[] | null {
  return NATIVE_READS.get(drive)?.scan(root, options) ?? null;
}

export type ExactPathState = "present" | "missing";

export interface ExactPathStateSource {
  states(paths: readonly string[]): readonly ExactPathState[];
}

type OwnedExactPathStates = (paths: readonly string[]) => readonly ExactPathState[];

const EXACT_PATH_STATES = new WeakMap<ExactPathStateSource, OwnedExactPathStates>();

export function registerExactPathStates(
  source: ExactPathStateSource,
  states: OwnedExactPathStates,
): void {
  EXACT_PATH_STATES.set(source, states);
}

export function exactPathStatesOwned(
  source: ExactPathStateSource,
  paths: readonly string[],
): readonly ExactPathState[] | null {
  return EXACT_PATH_STATES.get(source)?.(paths) ?? null;
}
