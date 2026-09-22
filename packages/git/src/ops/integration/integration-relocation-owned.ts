import { CorruptError, GitError } from "../../common/errors.js";
import { dirnameOf } from "../../common/paths.js";
import type {
  IntegrationReservation,
  StructuralIntegrationEntry,
} from "../../store/operations/integration-workspace/descriptors.js";
import type { IntegrationPlanHandle } from "../../store/operations/integration-workspace/storage.js";
import type { IntegrationWorkspace } from "../../store/operations/integration-workspace/workspace.js";
import { collapseVirtualConflict, relocationRequests } from "./integration-relocation.js";
import type {
  CleanIntegrationEntry,
  IntegrationInput,
  RelocationRequest,
} from "./integration-types.js";

function* requests(
  entries: Iterable<StructuralIntegrationEntry>,
  labels: { current: string; incoming: string },
): Generator<RelocationRequest> {
  const cursor = entries[Symbol.iterator]();
  try {
    let current = cursor.next();
    while (!current.done) {
      const next = cursor.next();
      const window = next.done ? [current.value] : [current.value, next.value];
      for (const request of relocationRequests(window, labels)) {
        if (request.path === current.value.path) yield request;
      }
      current = next;
    }
  } finally {
    cursor.return?.();
  }
}

export function prepareVirtualRelocations(
  workspace: IntegrationWorkspace,
  plan: IntegrationPlanHandle<StructuralIntegrationEntry>,
  input: IntegrationInput,
  labels: { current: string; incoming: string },
  maxRows: number,
): (entry: Extract<StructuralIntegrationEntry, { kind: "conflict" }>) => CleanIntegrationEntry[] {
  const occupied = workspace.reservations(plan, "occupied");
  const allocated = workspace.reservations(plan, "virtual");
  let prepared = false;
  for (const request of requests(plan.entries, labels)) {
    if (!prepared) {
      function* paths(): Generator<IntegrationReservation> {
        let count = 0;
        for (const tree of [input.currentTreeOid, input.incomingTreeOid]) {
          if (tree === null) continue;
          for (const entry of workspace.source.walkTree(tree)) {
            if (count++ >= maxRows * 2)
              throw new GitError("E2BIG", "virtual relocation scan exceeds its source row limit");
            yield {
              path: entry.path,
              logicalPath: entry.path,
              purpose: "primary",
              identity: entry,
            };
          }
        }
      }
      occupied.add(paths());
      prepared = true;
    }
    let ancestor = dirnameOf(request.desired);
    while (ancestor !== "/") {
      if (occupied.has(ancestor.slice(1)))
        throw new GitError("E2BIG", "virtual relocation path is below an occupied file");
      ancestor = dirnameOf(ancestor);
    }
    let path: string | null = null;
    for (let attempt = 0; attempt < 1000; attempt++) {
      const candidate = attempt === 0 ? request.desired : `${request.desired}_${attempt - 1}`;
      if (!occupied.has(candidate) && !occupied.hasDescendant(candidate)) {
        path = candidate;
        break;
      }
    }
    if (path === null) throw new GitError("E2BIG", "virtual relocation suffix space is exhausted");
    occupied.add([
      { path, logicalPath: request.path, purpose: "primary", identity: request.identity },
    ]);
    allocated.add([
      {
        path: request.path,
        logicalPath: request.path,
        purpose: request.side === "current" ? "current-relocation" : "incoming-relocation",
        identity: request.identity,
        allocatedPath: path,
      },
    ]);
  }
  return (entry) => {
    const reservation = allocated.get(entry.path);
    const byKey = new Map<string, RelocationRequest>();
    const names = new Map<string, string>();
    if (reservation !== null) {
      const side = reservation.purpose === "current-relocation" ? "current" : "incoming";
      const key = `${entry.path}\0${side}`;
      if (reservation.identity === null || reservation.allocatedPath === undefined)
        throw new CorruptError("virtual relocation identity is missing");
      byKey.set(key, {
        key,
        path: entry.path,
        desired: reservation.allocatedPath,
        side,
        identity: reservation.identity,
      });
      names.set(key, reservation.allocatedPath);
    }
    return collapseVirtualConflict(entry, byKey, names);
  };
}
