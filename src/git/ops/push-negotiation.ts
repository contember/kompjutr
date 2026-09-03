import { CorruptError, GitError } from "../common/errors.js";
import type { ReceivePackCommand, ReceivePackStatus } from "../protocol/receive-pack.js";
import { ZERO_OID } from "../protocol/receive-pack.js";
import type { Advertisement } from "../protocol/remote.js";
import type { JoinedAdvertisement, JoinedPushUpdate } from "./push-types.js";
import type { ExpandedPushRefspec, PushPlanningUpdate, PushResult } from "./refspec.js";

export function emptyPushResult(): PushResult {
  return {
    ok: true,
    error: null,
    unpack: { ok: true },
    refs: [],
    tracking: { outcome: "not-applicable" },
  };
}

export function joinAdvertisement(
  mappings: readonly ExpandedPushRefspec[],
  advertisement: Advertisement,
): JoinedAdvertisement {
  const advertised = new Map<string, string>();
  const remoteOids: string[] = [];
  for (const ref of advertisement.refs) {
    advertised.set(ref.name, ref.oid);
    remoteOids.push(ref.oid);
  }
  const capabilities = new Set<string>();
  for (const capability of advertisement.capabilities) {
    capabilities.add(capability);
  }

  const updates: JoinedPushUpdate[] = [];
  for (const mapping of mappings) {
    const oldOid = advertised.get(mapping.destination) ?? ZERO_OID;
    const noop = mapping.oid === null ? oldOid === ZERO_OID : mapping.oid === oldOid;
    updates.push({ ...mapping, oldOid, noop });
  }
  return { updates, remoteOids, capabilities };
}

export function verifyPushLeases(
  updates: readonly JoinedPushUpdate[],
  leases: ReadonlyMap<string, string | null>,
): void {
  for (const update of updates) {
    if (!leases.has(update.destination)) continue;
    const expected = leases.get(update.destination) ?? null;
    const advertised = update.oldOid === ZERO_OID ? null : update.oldOid;
    if (advertised !== expected) {
      throw new GitError("ESTALELEASE", `push lease is stale for ${update.destination}`);
    }
  }
}

export function commandSet(updates: readonly JoinedPushUpdate[]): ReceivePackCommand[] {
  const commands: ReceivePackCommand[] = [];
  for (const update of updates) {
    if (update.noop) continue;
    commands.push({
      oldOid: update.oldOid,
      newOid: update.oid ?? ZERO_OID,
      ref: update.destination,
    });
  }
  return commands;
}

export function activePlanningUpdates(updates: readonly JoinedPushUpdate[]): PushPlanningUpdate[] {
  const active: PushPlanningUpdate[] = [];
  for (const update of updates) {
    if (update.noop) continue;
    active.push(update);
  }
  return active;
}

export function uncertainResult(cause: unknown): GitError {
  return new GitError("EPUSHUNCERTAIN", "remote result could not be retained safely", { cause });
}

export function confirmedResult(
  updates: readonly JoinedPushUpdate[],
  wire: ReceivePackStatus | null,
): Omit<PushResult, "tracking"> {
  const refs: PushResult["refs"][number][] = [];
  for (const update of updates) {
    const status = update.noop ? { ok: true } : wire?.refs.get(update.destination);
    if (status === undefined) {
      throw new CorruptError(`confirmed push result omitted ${update.destination}`);
    }
    const error = status.ok ? null : (status.error ?? "remote rejected ref");
    refs.push({ ref: update.destination, ok: status.ok, error });
  }
  const unpack: PushResult["unpack"] =
    wire === null || wire.unpack === "ok" ? { ok: true } : { ok: false, error: wire.unpack };
  const error = unpack.ok ? (refs.find((status) => !status.ok)?.error ?? null) : unpack.error;
  return { ok: error === null, error, unpack, refs };
}
