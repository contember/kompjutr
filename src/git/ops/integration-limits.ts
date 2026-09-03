import { GitError } from "../common/errors.js";
import { DEFAULT_TEXT_MERGE_LIMITS, type TextMergeOptions } from "../diff/xmerge.js";
import {
  type IntegrationEntry,
  type IntegrationLimits,
  MAX_INTEGRATION_PLAN_ENTRIES,
  MAX_INTEGRATION_SOURCE_ROWS,
  type ResolvedIntegrationLimits,
} from "./integration-types.js";

const INTEGRATION_ENTRY_BYTES = 512;

function boundedLimit(value: number | undefined, ceiling: number, label: string): number {
  if (value === undefined) return ceiling;
  if (!Number.isSafeInteger(value) || value < 0 || value > ceiling) {
    throw new RangeError(`invalid integration ${label} limit`);
  }
  return value;
}

export function resolveLimits(limits: IntegrationLimits | undefined): ResolvedIntegrationLimits {
  return {
    maxSourceRows: boundedLimit(limits?.maxSourceRows, MAX_INTEGRATION_SOURCE_ROWS, "source row"),
    maxEntries: boundedLimit(limits?.maxEntries, MAX_INTEGRATION_PLAN_ENTRIES, "entry"),
    maxStructureBytes: optionalLimit(limits?.maxStructureBytes, "structure byte"),
    maxPlanBytes: optionalLimit(limits?.maxPlanBytes, "plan byte"),
  };
}

function optionalLimit(value: number | undefined, label: string): number | undefined {
  if (value !== undefined && (!Number.isSafeInteger(value) || value < 0)) {
    throw new RangeError(`invalid integration ${label} limit`);
  }
  return value;
}

export function checkedAdd(left: number, right: number, label: string): number {
  if (
    !Number.isSafeInteger(left) ||
    !Number.isSafeInteger(right) ||
    right > Number.MAX_SAFE_INTEGER - left
  ) {
    throw new GitError("E2BIG", `integration ${label} accounting overflow`);
  }
  return left + right;
}

function pathBytes(path: string): number {
  return pathUnitsBytes(path.length);
}

function pathUnitsBytes(units: number): number {
  return checkedAdd(64, units * 2, "path");
}

export function integrationEntryBytes(entry: IntegrationEntry): number {
  const contentBytes = entry.content?.length ?? 0;
  return checkedAdd(
    checkedAdd(INTEGRATION_ENTRY_BYTES, pathBytes(entry.path), "plan"),
    contentBytes,
    "plan",
  );
}

function integrationEntryOverhead(path: string): number {
  return checkedAdd(INTEGRATION_ENTRY_BYTES, pathBytes(path), "plan entry");
}

export function remainingContentCapacity(
  maxPlanBytes: number | undefined,
  passthroughBytes: number,
  resolvedBytes: number,
  path: string,
): number {
  if (maxPlanBytes === undefined) return DEFAULT_TEXT_MERGE_LIMITS.maxOutputBytes;
  const retained = checkedAdd(passthroughBytes, resolvedBytes, "plan");
  const overhead = integrationEntryOverhead(path);
  if (retained > maxPlanBytes || overhead > maxPlanBytes - retained) {
    throw new GitError("E2BIG", `integration plan exceeds ${maxPlanBytes} retained bytes`);
  }
  return maxPlanBytes - retained - overhead;
}

export function boundTextOutput(text: TextMergeOptions, maxOutputBytes: number): TextMergeOptions {
  const requested = text.limits?.maxOutputBytes;
  if (requested !== undefined) {
    if (!Number.isSafeInteger(requested) || requested < 0) {
      throw new GitError("EINVAL", "text merge maxOutputBytes must be a non-negative safe integer");
    }
    if (requested > DEFAULT_TEXT_MERGE_LIMITS.maxOutputBytes) {
      throw new GitError(
        "EINVAL",
        `text merge maxOutputBytes exceeds its hard ceiling of ${DEFAULT_TEXT_MERGE_LIMITS.maxOutputBytes}`,
      );
    }
  }
  return {
    ...text,
    limits: {
      ...text.limits,
      maxOutputBytes: Math.min(
        requested ?? DEFAULT_TEXT_MERGE_LIMITS.maxOutputBytes,
        maxOutputBytes,
      ),
    },
  };
}
