import { isOid } from "../../common/bytes.js";
import { CorruptError, GitError } from "../../common/errors.js";
import { hasCanonicalRefSyntax } from "../../common/ref-name.js";
import type { FetchPublicationPlan, RefRow } from "../core/contracts.js";
import { refTextBytes, requireRawRefTarget, requireRefName } from "../refs/ref-validation.js";
import type { HeadOwner, NormalizedRefMutation } from "../refs/refs.js";

export const MAX_FETCH_NAMESPACES = 1_024;
export const MAX_FETCH_PUBLICATION_INPUTS = 100_000;

export interface FetchPublicationState {
  readonly generation: number;
  readonly trackingPrefix: string;
  readonly namespaceRevision: number;
  readonly shallowRevision: number;
  readonly shallow: readonly string[];
  readonly trackingRefs: ReadonlyMap<string, string>;
  readonly exactRefs: ReadonlyMap<string, string | null>;
  readonly checkoutRevision: number;
  disposed: boolean;
}

export interface TrackingRefPublicationState {
  readonly refName: string;
  readonly target: string | null;
  readonly refRevision: number;
  disposed: boolean;
}

export interface NormalizedFetchPublication {
  readonly refs: NormalizedRefMutation;
  readonly shallowAdd: readonly string[];
  readonly shallowRemove: readonly string[];
}

export interface FetchPublicationOptions {
  readonly headOwner: () => HeadOwner;
  readonly invalidateShallow: () => void;
  readonly bumpMaintenanceRootEpoch: () => void;
}

export function invalidFetchTrackingPrefix(_source: "input" | "stored"): never {
  throw new GitError("EINVAL", "fetch tracking prefix must identify refs/remotes/<remote>/");
}

export function requireFetchTrackingPrefix(value: unknown, source: "input" | "stored"): string {
  if (
    typeof value !== "string" ||
    !value.startsWith("refs/remotes/") ||
    value === "refs/remotes/" ||
    !value.endsWith("/")
  ) {
    invalidFetchTrackingPrefix(source);
  }
  refTextBytes(value, "fetch tracking prefix", source);
  if (!hasCanonicalRefSyntax(value, 0, value.length - 1)) {
    invalidFetchTrackingPrefix(source);
  }
  return value;
}

export function requireFetchGeneration(value: unknown, label: string, minimum: number): number {
  if (
    typeof value !== "number" ||
    !Number.isSafeInteger(value) ||
    value < minimum ||
    value > Number.MAX_SAFE_INTEGER
  ) {
    throw new CorruptError(`${label} is invalid`);
  }
  return value;
}

export function staleFetch(message: string): GitError {
  return new GitError("ESTALEFETCH", message);
}

export function normalizeFetchPublication(
  state: FetchPublicationState,
  plan: FetchPublicationPlan,
): NormalizedFetchPublication {
  const puts = new Map<string, string>();
  const deletes = new Set<string>();
  const keep = new Set<string>();
  const remoteHeadName = `${state.trackingPrefix}HEAD`;
  let inputs = 0;
  const countInput = (name: string, label: string, target?: string): void => {
    inputs++;
    if (inputs > MAX_FETCH_PUBLICATION_INPUTS) {
      throw new GitError("E2BIG", "fetch publication exceeds its retained input count bound");
    }
    refTextBytes(name, label, "input");
    if (target !== undefined) refTextBytes(target, "fetch ref target", "input");
  };
  const trackingName = (value: unknown, label: string): string => {
    const name = requireRefName(value, label, "input");
    if (!name.startsWith(state.trackingPrefix) || name === remoteHeadName) {
      throw new GitError("EINVAL", `${label} is outside the issued tracking namespace`);
    }
    return name;
  };

  for (const row of plan.trackingPuts ?? []) {
    if (typeof row !== "object" || row === null) {
      throw new GitError("EINVAL", "fetch tracking update row is invalid");
    }
    const name = trackingName(row.name, "fetch tracking ref name");
    const target = requireRawRefTarget(row.target, `target of ${name}`, "input");
    countInput(name, "fetch tracking ref name", target);
    puts.set(name, target);
    keep.add(name);
  }
  const prune = plan.trackingKeep !== undefined;
  for (const value of plan.trackingKeep ?? []) {
    const name = trackingName(value, "advertised tracking ref name");
    countInput(name, "advertised tracking ref name");
    keep.add(name);
  }
  if (prune) {
    for (const name of state.trackingRefs.keys()) {
      if (name !== remoteHeadName && !keep.has(name)) deletes.add(name);
    }
  }

  if (plan.remoteHead !== undefined) {
    if (plan.remoteHead === null) {
      countInput(remoteHeadName, "remote HEAD ref name");
      deletes.add(remoteHeadName);
    } else {
      const target = requireRawRefTarget(plan.remoteHead, "remote HEAD target", "input");
      countInput(remoteHeadName, "remote HEAD ref name", target);
      puts.set(remoteHeadName, target);
    }
  }

  const exactPut = (row: RefRow, label: string, requireTag: boolean): void => {
    if (typeof row !== "object" || row === null) {
      throw new GitError("EINVAL", `${label} update row is invalid`);
    }
    const name = requireRefName(row.name, `${label} name`, "input");
    if (requireTag && !name.startsWith("refs/tags/")) {
      throw new GitError("EINVAL", `${label} ${name} is not a tag ref`);
    }
    const target = requireRawRefTarget(row.target, `target of ${name}`, "input");
    if (!isOid(target)) {
      throw new GitError("EINVAL", `${label} ${name} must target an object id`);
    }
    if (!state.exactRefs.has(name)) {
      throw new GitError("EINVAL", `${label} ${name} was not included in the issued snapshot`);
    }
    if (puts.has(name) || deletes.has(name)) {
      throw new GitError("EINVAL", `fetch publication contains duplicate destination ${name}`);
    }
    countInput(name, `${label} name`, target);
    puts.set(name, target);
  };
  for (const row of plan.globalTagPuts ?? []) exactPut(row, "fetch global tag", true);
  for (const row of plan.exactPuts ?? []) exactPut(row, "fetch exact ref", false);

  const shallowAdd = new Set<string>();
  const shallowRemove = new Set<string>();
  const shallowOid = (value: unknown, label: string): string => {
    if (typeof value !== "string" || !isOid(value)) {
      throw new GitError("EINVAL", `${label} must be a full object id`);
    }
    countInput(value, label);
    return value;
  };
  for (const value of plan.shallowAdd ?? []) {
    const oid = shallowOid(value, "shallow addition");
    if (shallowAdd.has(oid)) {
      throw new GitError("EINVAL", `duplicate shallow addition ${oid}`);
    }
    shallowAdd.add(oid);
  }
  for (const value of plan.shallowRemove ?? []) {
    const oid = shallowOid(value, "shallow deletion");
    if (shallowRemove.has(oid)) {
      throw new GitError("EINVAL", `duplicate shallow deletion ${oid}`);
    }
    if (!state.shallow.includes(oid)) {
      throw new GitError(
        "EINVAL",
        `shallow deletion ${oid} was not included in the issued snapshot`,
      );
    }
    if (shallowAdd.has(oid)) {
      throw new GitError("EINVAL", `fetch publication both adds and deletes shallow ${oid}`);
    }
    shallowRemove.add(oid);
  }

  return {
    refs: { puts, deletes, head: undefined, expected: undefined },
    shallowAdd: [...shallowAdd],
    shallowRemove: [...shallowRemove],
  };
}
