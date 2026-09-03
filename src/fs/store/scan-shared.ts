import { subtreeSuccessor } from "../path.js";
import type { RealPath } from "../types.js";

/** The DO SQLite ceiling on a GLOB/LIKE pattern. */
export const GLOB_PATTERN_MAX_BYTES = 50;
export const DISCOVERY_PAGE_MAX = 1_000;

const ENCODER = new TextEncoder();

export function validatePattern(pattern: string, operation: string): void {
  const bytes = ENCODER.encode(pattern).length;
  if (bytes > GLOB_PATTERN_MAX_BYTES) {
    throw new Error(
      `${operation}: pattern is ${bytes} bytes; the platform caps a GLOB pattern at ${GLOB_PATTERN_MAX_BYTES}`,
    );
  }
}

export function subtreeBounds(root: RealPath): { lower: string; upper: string } {
  return { lower: root === "/" ? "/" : `${root}/`, upper: subtreeSuccessor(root) };
}
