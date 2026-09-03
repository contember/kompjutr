import { CorruptError, GitError } from "../common/errors.js";
import { MODE_COMMIT, MODE_EXECUTABLE, MODE_FILE, MODE_SYMLINK } from "../common/objects.js";
import { DEFAULT_TEXT_MERGE_LIMITS } from "../diff/xmerge.js";
import { isRegularMode } from "./integration-content.js";
import type {
  ConflictStructuralEntry,
  IntegrationIdentity,
  StructuralIntegrationEntry,
} from "./integration-structure.js";
import type {
  CleanIntegrationEntry,
  RelocationRequest,
  ResolvedIntegrationLimits,
  VirtualAncestorIntegrationInput,
} from "./integration-types.js";
import { MAX_INTEGRATION_PLAN_ENTRIES } from "./integration-types.js";
import type { Repository } from "./repository.js";
import { treeStream } from "./tree-stream.js";

const BASE_CONFLICT_MARKER_SIZE = 7;

interface CollisionNamespace {
  occupied: Set<number>;
  blockedByAncestor: boolean;
}

class CollisionTrieNode {
  readonly children = new Map<string, CollisionTrieNode>();
  namespace: CollisionNamespace | null = null;
}

class RelocationAllocator {
  readonly #root = new CollisionTrieNode();
  readonly #namespaces = new Map<string, CollisionNamespace>();

  constructor(requests: readonly RelocationRequest[]) {
    for (const request of requests) this.#add(request.desired);
  }

  observe(path: string): void {
    let node = this.#root;
    for (let index = 0; index <= path.length; index++) {
      const namespace = node.namespace;
      if (namespace !== null) {
        const suffix = path.slice(index);
        const ordinal = collisionOrdinal(suffix);
        if (ordinal !== null && !namespace.occupied.has(ordinal)) {
          namespace.occupied.add(ordinal);
        }
      }
      if (index === path.length) {
        const descendants = node.children.get("/");
        if (descendants !== undefined) this.#blockDescendantNamespaces(descendants);
        return;
      }
      const next = node.children.get(path[index]!);
      if (next === undefined) return;
      node = next;
    }
  }

  allocate(desired: string): string {
    const namespace = this.#namespaces.get(desired);
    if (namespace === undefined) throw new CorruptError("virtual relocation namespace is missing");
    if (namespace.blockedByAncestor) {
      throw new GitError("E2BIG", "virtual relocation path is below an occupied file");
    }
    if (!namespace.occupied.has(-1)) {
      this.observe(desired);
      return desired;
    }
    for (let ordinal = 0; ordinal < MAX_INTEGRATION_PLAN_ENTRIES - 1; ordinal++) {
      if (namespace.occupied.has(ordinal)) continue;
      const allocated = `${desired}_${ordinal}`;
      this.observe(allocated);
      return allocated;
    }
    throw new GitError("E2BIG", "virtual relocation suffix space is exhausted");
  }

  #add(desired: string): void {
    if (this.#namespaces.has(desired)) return;
    const namespace: CollisionNamespace = { occupied: new Set(), blockedByAncestor: false };
    this.#namespaces.set(desired, namespace);
    let node = this.#root;
    for (let index = 0; index < desired.length; index++) {
      const unit = desired[index]!;
      let next = node.children.get(unit);
      if (next === undefined) {
        next = new CollisionTrieNode();
        node.children.set(unit, next);
      }
      node = next;
    }
    node.namespace = namespace;
  }

  #blockDescendantNamespaces(root: CollisionTrieNode): void {
    const pending = [root];
    while (pending.length > 0) {
      const node = pending.pop();
      if (node === undefined) throw new CorruptError("virtual relocation trie is inconsistent");
      if (node.namespace !== null) node.namespace.blockedByAncestor = true;
      for (const child of node.children.values()) pending.push(child);
    }
  }
}

function collisionOrdinal(suffix: string): number | null {
  if (suffix === "" || suffix.startsWith("/")) return -1;
  if (!suffix.startsWith("_") || suffix.length === 1) return null;
  const separator = suffix.indexOf("/", 1);
  const digits = suffix.slice(1, separator < 0 ? undefined : separator);
  if (digits.length === 0) return null;
  if (digits.length > 1 && digits.startsWith("0")) return null;
  for (const digit of digits) {
    if (digit < "0" || digit > "9") return null;
  }
  const ordinal = Number(digits);
  return Number.isSafeInteger(ordinal) && ordinal >= 0 ? ordinal : null;
}

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

export function allocateRelocations(
  repo: Repository,
  input: VirtualAncestorIntegrationInput,
  requests: readonly RelocationRequest[],
  limits: ResolvedIntegrationLimits,
): Map<string, string> {
  if (requests.length === 0) return new Map();
  const allocator = new RelocationAllocator(requests);
  let rows = 0;
  for (const treeOid of [input.currentTreeOid, input.incomingTreeOid]) {
    for (const entry of treeStream(repo, treeOid)) {
      if (rows >= limits.maxSourceRows * 2) {
        throw new GitError("E2BIG", "virtual relocation scan exceeds its source row limit");
      }
      rows++;
      allocator.observe(entry.path);
    }
  }
  const names = new Map<string, string>();
  for (const request of requests) names.set(request.key, allocator.allocate(request.desired));
  return names;
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
