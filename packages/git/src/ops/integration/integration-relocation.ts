import { CorruptError, GitError } from "../../common/errors.js";
import { MODE_COMMIT, MODE_EXECUTABLE, MODE_FILE, MODE_SYMLINK } from "../../common/objects.js";
import { DEFAULT_TEXT_MERGE_LIMITS } from "../../diff/xmerge.js";
import { isRegularMode } from "./integration-content.js";
import type {
  ConflictStructuralEntry,
  IntegrationIdentity,
  StructuralIntegrationEntry,
} from "./integration-structure.js";
import type { CleanIntegrationEntry, RelocationRequest } from "./integration-types.js";

const BASE_CONFLICT_MARKER_SIZE = 7;

export function validateVirtualLabel(label: string, role: string): void {
  if (label.length === 0 || label.includes("/") || label.includes("\0")) {
    throw new GitError("EINVAL", `virtual ${role} label is not a safe path segment`);
  }
}

export function virtualMarkerSize(depth: number | undefined): number {
  const resolved = depth ?? 1;
  if (!Number.isSafeInteger(resolved) || resolved < 0) {
    throw new GitError("EINVAL", "virtual integration depth must be a non-negative safe integer");
  }
  const markerSize = BASE_CONFLICT_MARKER_SIZE + resolved * 2;
  if (markerSize > DEFAULT_TEXT_MERGE_LIMITS.maxMarkerSize) {
    throw new GitError("E2BIG", "virtual integration depth exceeds the marker-size limit");
  }
  return markerSize;
}

function relocationKey(path: string, side: "current" | "incoming"): string {
  return `${path}\0${side}`;
}

function modeRank(mode: string): number {
  if (mode === MODE_FILE) return 1;
  if (mode === MODE_EXECUTABLE) return 2;
  if (mode === MODE_SYMLINK) return 3;
  if (mode === MODE_COMMIT) return 4;
  throw new CorruptError(`virtual integration has invalid mode ${mode}`);
}

function isDescendant(path: string, parent: string): boolean {
  return path.length > parent.length && path.startsWith(parent) && path[parent.length] === "/";
}

function visitRelocationRequests(
  entries: readonly StructuralIntegrationEntry[],
  labels: { current: string; incoming: string },
  visit: (
    path: string,
    side: "current" | "incoming",
    label: string,
    identity: IntegrationIdentity,
  ) => void,
): void {
  for (let index = 0; index < entries.length; index++) {
    const entry = entries[index];
    if (entry?.kind !== "conflict") continue;
    const current = entry.stages.current;
    const incoming = entry.stages.incoming;
    if (entry.conflict === "file/directory") {
      const next = entries[index + 1];
      if (next === undefined || !isDescendant(next.path, entry.path)) continue;
      if (current !== null && incoming === null) {
        visit(entry.path, "current", labels.current, current);
      } else if (incoming !== null && current === null) {
        visit(entry.path, "incoming", labels.incoming, incoming);
      }
      continue;
    }
    if (
      current === null ||
      incoming === null ||
      current.mode === incoming.mode ||
      (isRegularMode(current.mode) && isRegularMode(incoming.mode))
    ) {
      continue;
    }
    if (
      entry.conflict !== "add/add" &&
      entry.conflict !== "symlink" &&
      entry.conflict !== "gitlink"
    ) {
      continue;
    }
    const side = modeRank(current.mode) < modeRank(incoming.mode) ? "current" : "incoming";
    const identity = side === "current" ? current : incoming;
    const label = side === "current" ? labels.current : labels.incoming;
    visit(entry.path, side, label, identity);
  }
}

export function relocationRequests(
  entries: readonly StructuralIntegrationEntry[],
  labels: { current: string; incoming: string },
): RelocationRequest[] {
  const requests: RelocationRequest[] = [];
  visitRelocationRequests(entries, labels, (path, side, label, identity) => {
    requests.push({
      key: relocationKey(path, side),
      path,
      desired: `${path}~${label}`,
      side,
      identity,
    });
  });
  return requests;
}

function cleanIdentity(
  path: string,
  before: IntegrationIdentity | null,
  result: IntegrationIdentity | null,
): CleanIntegrationEntry | null {
  if (
    before?.mode === result?.mode &&
    before?.oid === result?.oid &&
    (before !== null || result !== null)
  ) {
    return null;
  }
  return { kind: "clean", path, before, result, content: null };
}

function relocatedEntry(
  request: RelocationRequest,
  names: ReadonlyMap<string, string>,
): CleanIntegrationEntry {
  const path = names.get(request.key);
  if (path === undefined) throw new CorruptError("virtual relocation path is missing");
  return { kind: "clean", path, before: null, result: request.identity, content: null };
}

export function collapseVirtualConflict(
  entry: ConflictStructuralEntry,
  requests: ReadonlyMap<string, RelocationRequest>,
  names: ReadonlyMap<string, string>,
): CleanIntegrationEntry[] {
  const current = entry.stages.current;
  const incoming = entry.stages.incoming;
  const currentRequest = requests.get(relocationKey(entry.path, "current"));
  const incomingRequest = requests.get(relocationKey(entry.path, "incoming"));
  const request = currentRequest ?? incomingRequest;
  if (request !== undefined) {
    const result: CleanIntegrationEntry[] = [];
    if (request.side === "current") {
      const original = cleanIdentity(entry.path, current, incoming);
      if (original !== null) result.push(original);
    }
    if (request.side === "incoming" && current !== null && incoming !== null) {
      const original = cleanIdentity(entry.path, current, current);
      if (original !== null) result.push(original);
    } else if (request.side === "incoming" && current === null && incoming !== null) {
      // The original path is occupied by the current directory and remains implicit.
    }
    result.push(relocatedEntry(request, names));
    return result;
  }
  if (entry.conflict === "file/directory") {
    const clean = cleanIdentity(entry.path, current, current ?? incoming);
    return clean === null ? [] : [clean];
  }
  if (entry.conflict === "modify/delete") {
    const modified = current ?? incoming;
    const clean = cleanIdentity(entry.path, current, modified);
    return clean === null ? [] : [clean];
  }
  // Git keeps the current side for unresolved modes, symlinks and gitlinks.
  const clean = cleanIdentity(entry.path, current, current ?? incoming);
  return clean === null ? [] : [clean];
}
