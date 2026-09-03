import { isOid } from "../../../common/bytes.js";
import { CorruptError } from "../../../common/errors.js";
import type { ObjectType } from "../../../common/objects.js";
import { isCanonicalGitPath } from "../../../common/paths.js";
import type { OperationRootPage } from "../../operations/operation-journal.js";
import { requireRefName } from "../../refs/ref-validation.js";

export const DEFAULT_PAGE_ROWS = 128;
export const MAX_PAGE_ROWS = 128;
export const MAINTENANCE_ROOT_EPOCH_DRIFTED = "maintenance roots changed after root discovery";

export const ROOT_REFS = 1;
export const ROOT_HEADS = 2;
export const ROOT_REFLOGS = 4;
export const ROOT_INDEX = 8;
export const ROOT_INDEX_BASELINE = 16;
export const ROOT_SHALLOW = 32;
export const ROOT_OPERATIONS = 64;

export type MaintenanceRootSource =
  | "refs"
  | "heads"
  | "reflogs"
  | "index"
  | "index-baseline"
  | "shallow"
  | "operations"
  | "done";

export type OperationRootPageReader = (
  checkoutId: number,
  cursor: number,
  limit: number,
) => OperationRootPage;

export interface AdvanceMaintenanceRootSnapshotOptions {
  repoId: number;
  nowMs: number;
  pageRows?: number;
  readOperationRootPage: OperationRootPageReader;
}

export interface MaintenanceRootSnapshotProgress {
  runId: number;
  rootSource: MaintenanceRootSource;
  complete: boolean;
  restarted: boolean;
}

export interface MaintenanceRootCursorState {
  phase: string;
  rootSource: MaintenanceRootSource;
  cursorCheckoutId: number | null;
  cursorText: string | null;
  cursorOrdinal: number | null;
}

export interface RootCandidate {
  oid: string;
  expectedType: ObjectType | null;
  optionalMissing: boolean;
}

export interface RootPage {
  candidates: RootCandidate[];
  cursorCheckoutId: number | null;
  cursorText: string | null;
  cursorOrdinal: number | null;
  hasMore: boolean;
}

export const ROOT_SOURCES: readonly MaintenanceRootSource[] = [
  "refs",
  "heads",
  "reflogs",
  "index",
  "index-baseline",
  "shallow",
  "operations",
  "done",
];

export function isObjectType(value: unknown): value is ObjectType {
  return value === "blob" || value === "tree" || value === "commit" || value === "tag";
}

export function requireSafeInteger(
  value: unknown,
  label: string,
  minimum: number,
  maximum = Number.MAX_SAFE_INTEGER,
): number {
  if (
    typeof value !== "number" ||
    !Number.isSafeInteger(value) ||
    value < minimum ||
    value > maximum
  ) {
    throw new CorruptError(`${label} is not a bounded safe integer`);
  }
  return value;
}

/** Validate the phase-specific durable root cursor shape. */
export function validateMaintenanceRootCursor(run: MaintenanceRootCursorState): void {
  const none =
    run.cursorCheckoutId === null && run.cursorText === null && run.cursorOrdinal === null;
  if (run.phase !== "roots") {
    if (run.rootSource !== "done" || !none) {
      throw new CorruptError("completed maintenance roots retained a cursor");
    }
    return;
  }
  if (run.rootSource === "done") {
    throw new CorruptError("incomplete maintenance roots are marked done");
  }
  if (run.rootSource === "refs") {
    if (run.cursorCheckoutId !== null || run.cursorOrdinal !== null) {
      throw new CorruptError("ref root cursor has unrelated fields");
    }
    if (run.cursorText !== null) requireRefName(run.cursorText, "maintenance ref cursor", "stored");
    return;
  }
  if (run.rootSource === "heads" || run.rootSource === "index-baseline") {
    if (run.cursorText !== null || run.cursorOrdinal !== null) {
      throw new CorruptError("checkout root cursor has unrelated fields");
    }
    if (run.cursorCheckoutId !== null && run.cursorCheckoutId < 1) {
      throw new CorruptError("checkout root cursor is invalid");
    }
    return;
  }
  if (run.rootSource === "operations") {
    if (run.cursorText !== null) {
      throw new CorruptError("operation root cursor has unrelated fields");
    }
    if (run.cursorCheckoutId === null) {
      if (run.cursorOrdinal !== null) {
        throw new CorruptError("operation root cursor lost its checkout");
      }
      return;
    }
    if (run.cursorCheckoutId < 1 || run.cursorOrdinal === 0) {
      throw new CorruptError("operation root cursor is invalid");
    }
    return;
  }
  if (run.rootSource === "reflogs") {
    if (run.cursorCheckoutId !== null || run.cursorText !== null) {
      throw new CorruptError("reflog root cursor has unrelated fields");
    }
    if (run.cursorOrdinal !== null && run.cursorOrdinal < 1) {
      throw new CorruptError("reflog root cursor is invalid");
    }
    return;
  }
  if (run.rootSource === "index") {
    if (none) return;
    if (
      run.cursorCheckoutId === null ||
      run.cursorCheckoutId < 1 ||
      run.cursorText === null ||
      !isCanonicalGitPath(run.cursorText) ||
      run.cursorOrdinal === null ||
      run.cursorOrdinal > 3
    ) {
      throw new CorruptError("index root cursor is invalid");
    }
    return;
  }
  if (run.cursorCheckoutId !== null || run.cursorOrdinal !== null) {
    throw new CorruptError("shallow root cursor has unrelated fields");
  }
  if (run.cursorText !== null && !isOid(run.cursorText)) {
    throw new CorruptError("shallow root cursor is invalid");
  }
}
