import { ZERO_OID } from "../../common/bytes.js";
import { GitError } from "../../common/errors.js";
import { comparePaths, gitParentPath, isNestedPath } from "../../common/paths.js";
import { int, oneOf, RowShape, text } from "../../common/rows.js";
import type { ReceivePackCommand } from "../../protocol/receive-pack-types.js";
import type { ServerRefStatus } from "../../protocol/server/index.js";
import type { RefLogMetadata, RefRow } from "../core/contracts.js";
import { withGitMutationGuard } from "../core/mutation-guard.js";
import type { SharedRepoStore } from "../index.js";
import { sharedRepoStoreMutations } from "../repository/shared.js";
import { validateCompleteClosure } from "../transfer/closure.js";
import { requireCompleteRepository, type TransferRoot } from "../transfer/lifetime.js";
import { resolveRawRef } from "./refs.js";

const PACK_ROOT = new RowShape({ oid: text(), type: oneOf(["commit", "tree", "blob", "tag"]) });

function* roots(
  store: SharedRepoStore,
  commands: readonly ResolvedCommand[],
  packId?: number,
): Generator<TransferRoot> {
  if (packId !== undefined) {
    for (const raw of store.db.iterate(
      "SELECT oid, type FROM git_pack_entries WHERE repo_id = ? AND pack_id = ? ORDER BY offset",
      store.repoId,
      packId,
    )) {
      yield PACK_ROOT.decode(raw);
    }
  }
  for (const { command, destination } of commands) {
    if (command.newOid !== ZERO_OID) {
      yield {
        oid: command.newOid,
        ...(command.ref.startsWith("refs/heads/") || destination.startsWith("refs/heads/")
          ? { type: "commit" }
          : {}),
      };
    }
  }
}

function namespaceConflict(
  store: SharedRepoStore,
  name: string,
  accepted: readonly RefRow[],
  deletes: readonly string[],
): boolean {
  const ancestors: string[] = [];
  for (let ancestor = gitParentPath(name); ancestor !== ""; ancestor = gitParentPath(ancestor))
    ancestors.push(ancestor);
  const result = store.db.scalar<unknown>(
    `SELECT EXISTS(SELECT 1 FROM git_refs WHERE repo_id = ? AND name IN (SELECT value FROM json_each(?))
         AND name NOT IN (SELECT value FROM json_each(?)))
      OR EXISTS(SELECT 1 FROM git_refs WHERE repo_id = ? AND name > ? AND name < ?
         AND name NOT IN (SELECT value FROM json_each(?)))`,
    store.repoId,
    JSON.stringify(ancestors),
    JSON.stringify(deletes),
    store.repoId,
    `${name}/`,
    `${name}0`,
    JSON.stringify(deletes),
  );
  const conflict = new RowShape({ value: oneOf([0, 1]) }).decode({ value: result }).value;
  if (conflict === 1) return true;
  return accepted.some((put) => isNestedPath(put.name, name) || isNestedPath(name, put.name));
}

interface ResolvedCommand {
  readonly command: ReceivePackCommand;
  readonly destination: string;
  readonly current: string | null;
  error: string | null;
}

function resolveCommand(store: SharedRepoStore, command: ReceivePackCommand): ResolvedCommand {
  let destination = command.ref;
  let raw = store.getRef(destination);
  const current = resolveRawRef(raw, (name) => {
    destination = name;
    raw = store.getRef(name);
    return raw;
  });
  let error: string | null = null;
  if (current === null && raw !== null) error = "symbolic ref cannot be resolved";
  else if (!(destination.startsWith("refs/heads/") || destination.startsWith("refs/tags/")))
    error = "symbolic ref target is outside served namespaces";
  return { command, destination, current, error };
}

function attachedDestinations(
  store: SharedRepoStore,
  destinations: ReadonlySet<string>,
): Set<string> {
  const attached = new Set<string>();
  const shape = new RowShape({ head: text() });
  for (const raw of store.db.iterate(
    "SELECT head FROM git_checkouts WHERE repo_id = ?",
    store.repoId,
  )) {
    resolveRawRef(shape.decode(raw).head, (name) => {
      if (destinations.has(name)) attached.add(name);
      return store.getRef(name);
    });
  }
  return attached;
}

function aliasedGroups(commands: readonly ResolvedCommand[]): [string, ResolvedCommand[]][] {
  const groups = new Map<string, ResolvedCommand[]>();
  for (const resolved of commands) {
    const group = groups.get(resolved.destination);
    if (group === undefined) groups.set(resolved.destination, [resolved]);
    else group.push(resolved);
  }
  for (const group of groups.values()) {
    const direct = group.find(({ command, destination }) => command.ref === destination);
    if (direct !== undefined) {
      if (
        group.some(
          ({ command }) =>
            command.oldOid !== direct.command.oldOid || command.newOid !== direct.command.newOid,
        )
      ) {
        for (const entry of group) entry.error = "inconsistent aliased update";
      }
    } else {
      // Keep one winner in request order; native HTTP batching changes outcomes with alias depth.
      for (const entry of group.slice(1)) entry.error = "refname conflict";
    }
  }
  return [...groups.entries()];
}

/** CAS, attached-checkout protection and ref publication share the pack's final transaction. */
export function publishServerRefs(
  store: SharedRepoStore,
  commands: readonly ReceivePackCommand[],
  metadata: RefLogMetadata,
  packId?: number,
): ServerRefStatus[] {
  return withGitMutationGuard(store.db, () => {
    requireCompleteRepository(store);
    const resolved = commands.map((command) => resolveCommand(store, command));
    validateCompleteClosure(store, roots(store, resolved, packId));
    const groups = aliasedGroups(resolved);
    const attached = attachedDestinations(
      store,
      new Set(resolved.map(({ destination }) => destination)),
    );
    const puts: RefRow[] = [];
    const deletes: string[] = [];
    for (const entry of resolved) {
      if (entry.error !== null) continue;
      const expected = entry.command.oldOid === ZERO_OID ? null : entry.command.oldOid;
      if (entry.current !== expected) entry.error = "stale old object id";
      else if (attached.has(entry.destination)) entry.error = "branch is attached to a checkout";
    }
    for (const [, group] of groups) {
      const accepted = group.find((entry) => entry.error === null);
      if (accepted?.command.newOid === ZERO_OID) deletes.push(accepted.destination);
    }
    const ordered = groups.sort(([left], [right]) => comparePaths(right, left));
    for (const [, group] of ordered) {
      const accepted = group.find((entry) => entry.error === null);
      if (accepted === undefined || accepted.command.newOid === ZERO_OID) continue;
      if (namespaceConflict(store, accepted.destination, puts, deletes)) {
        for (const entry of group) {
          if (entry.error === null) entry.error = "ref namespace conflict";
        }
      } else puts.push({ name: accepted.destination, target: accepted.command.newOid });
    }
    if (puts.length + deletes.length > 0) {
      sharedRepoStoreMutations(store).mutateSharedRefsOwned({ puts, deletes }, metadata);
    }
    return resolved.map(({ command, error }) => ({ ref: command.ref, error }));
  });
}

export function pendingPackGeneration(store: SharedRepoStore, packId: number): number {
  const row = new RowShape({ owner_generation: int(1) }).decode(
    store.db.one<Record<string, unknown>>(
      "SELECT owner_generation FROM git_pack_ingest_control WHERE repo_id = ? AND active_pack_id = ?",
      store.repoId,
      packId,
    ),
  );
  return row.owner_generation;
}

export function rejectUnpublishedPack(statuses: readonly ServerRefStatus[]): void {
  if (statuses.length > 0 && statuses.every((status) => status.error !== null)) {
    throw new GitError("ERECEIVEREJECTED", "all receive commands were rejected");
  }
}
