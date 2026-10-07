import type { SqlDatabase } from "../../../db/db.js";
import type { ReadBatch, ReadOptions, RealPath } from "../../types.js";
import { readFiles as readStoredFiles } from "../read.js";

/**
 * `readFiles` over caller paths already resolved in one batch. A `null`
 * resolution reads as absent. Results stay keyed by the caller's strings,
 * and a deferral keeps the caller's order: everything from the first
 * deferred path on is `remaining`.
 */
export function readResolvedFiles(
  db: SqlDatabase,
  paths: readonly string[],
  resolved: readonly (RealPath | null)[],
  options?: ReadOptions,
): ReadBatch {
  const originals = new Map<string, string[]>();
  for (let index = 0; index < paths.length; index++) {
    const input = paths[index];
    const target = resolved[index];
    if (input === undefined || target === undefined || target === null) continue;
    const callers = originals.get(target);
    if (callers === undefined) originals.set(target, [input]);
    else callers.push(input);
  }

  const batch = readStoredFiles(db, [...originals.keys()], options);
  const deferredTargets = new Set(batch.remaining);
  let deferredAt = paths.length;
  for (let index = 0; index < resolved.length; index++) {
    const target = resolved[index];
    if (target !== undefined && target !== null && deferredTargets.has(target)) {
      deferredAt = index;
      break;
    }
  }
  const files = new Map<string, Uint8Array>();
  for (let index = 0; index < deferredAt; index++) {
    const input = paths[index];
    const target = resolved[index];
    if (input === undefined || target === undefined || target === null) continue;
    const bytes = batch.files.get(target);
    if (bytes !== undefined) files.set(input, bytes);
  }
  return { files, remaining: paths.slice(deferredAt) };
}
