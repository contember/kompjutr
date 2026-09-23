import { GitError } from "../../common/errors.js";
import type { Advertisement, RemoteRef } from "../../protocol/remote.js";
import type { ExpandedFetchRefspec } from "../refs/refspec.js";
import { advertisedTags } from "./network-tags.js";
import type {
  FetchBehavior,
  FetchSelection,
  FetchTarget,
  LegacyFetchSelection,
  MappedFetchPlan,
  ShallowRequest,
} from "./network-types.js";

function findAdvertisedRef(advertisement: Advertisement, wanted: string): RemoteRef {
  const { refs } = advertisement;
  const exact = refs.find((ref) => ref.name === wanted);
  if (exact !== undefined) return exact;
  for (const prefix of ["refs/heads/", "refs/tags/", "refs/remotes/"]) {
    const found = refs.find((ref) => ref.name === `${prefix}${wanted}`);
    if (found !== undefined) return found;
  }
  throw new GitError("EREFNOTFOUND", `couldn't find remote ref ${wanted}`);
}

/** Separate transfer coverage from the one ref returned as FETCH_HEAD. */
export function selectRefs(
  advertisement: Advertisement,
  options: { coverageRef?: string; resultRef?: string; singleBranch: boolean },
): FetchSelection {
  let coverage: RemoteRef[];
  if (options.coverageRef !== undefined) {
    coverage = [findAdvertisedRef(advertisement, options.coverageRef)];
  } else if (options.singleBranch) {
    const head = advertisement.headRef;
    const branch = head === null ? undefined : advertisement.refs.find((ref) => ref.name === head);
    if (branch !== undefined) coverage = [branch];
    else {
      const fallback = advertisement.refs.find((ref) => ref.name.startsWith("refs/heads/"));
      if (fallback === undefined) throw new GitError("EREFNOTFOUND", "remote has no branches");
      coverage = [fallback];
    }
  } else {
    coverage = advertisement.refs.filter((ref) => ref.name.startsWith("refs/heads/"));
  }

  const result =
    options.resultRef !== undefined
      ? findAdvertisedRef(advertisement, options.resultRef)
      : advertisement.headRef === null
        ? (coverage[0] ?? null)
        : (advertisement.refs.find((ref) => ref.name === advertisement.headRef) ??
          coverage[0] ??
          null);
  return { coverage, result };
}

function trackingRef(prefix: string, branch: string): string {
  return `${prefix}${branch.slice("refs/heads/".length)}`;
}

/**
 * Lower legacy selectors to one mapped plan: selected heads become forced
 * tracking refspecs of a configured remote, selected tags non-forced tag
 * refspecs, and every other selected ref is fetched for FETCH_HEAD alone.
 */
export function lowerLegacyFetch(
  advertisement: Advertisement,
  options: LegacyFetchSelection,
  behavior: FetchBehavior,
  target: FetchTarget,
): { plan: MappedFetchPlan; fetchHead: string | null } {
  const requestedRef = options.remoteRef ?? options.ref;
  const coverageRef = behavior.coverageRef ?? requestedRef;
  const resultRef = behavior.resultRef ?? requestedRef;
  const selection = selectRefs(advertisement, {
    ...(coverageRef === undefined ? {} : { coverageRef }),
    ...(resultRef === undefined ? {} : { resultRef }),
    singleBranch: options.singleBranch ?? false,
  });
  const prefix = `refs/remotes/${target.remote}/`;
  const roots = [...selection.coverage];
  if (options.tags === true) roots.push(...advertisedTags(advertisement).map((tag) => tag.ref));

  const updates = new Map<string, ExpandedFetchRefspec>();
  for (const ref of roots) {
    if (ref.name.startsWith("refs/tags/")) {
      updates.set(ref.name, {
        source: ref.name,
        destination: ref.name,
        oid: ref.oid,
        force: false,
      });
    } else if (target.configured && ref.name.startsWith("refs/heads/")) {
      const destination = trackingRef(prefix, ref.name);
      updates.set(destination, { source: ref.name, destination, oid: ref.oid, force: true });
    }
  }

  const shallow: ShallowRequest | undefined =
    options.deepen !== undefined
      ? { kind: "deepen", deepen: options.deepen }
      : options.unshallow === true
        ? { kind: "unshallow" }
        : options.depth !== undefined
          ? { kind: "depth", depth: options.depth }
          : undefined;
  const headRef = advertisement.headRef ?? "";
  const plan: MappedFetchPlan = {
    roots,
    updates: [...updates.values()],
    followTags: options.tags === undefined && (behavior.autoTags ?? requestedRef === undefined),
    ...(shallow === undefined ? {} : { shallow }),
    ...(target.configured && options.prune === true
      ? {
          trackingKeep: advertisement.refs
            .filter((ref) => ref.name.startsWith("refs/heads/"))
            .map((ref) => trackingRef(prefix, ref.name)),
        }
      : {}),
    ...(target.configured
      ? { remoteHead: headRef.startsWith("refs/heads/") ? trackingRef(prefix, headRef) : null }
      : {}),
  };
  return { plan, fetchHead: selection.result?.oid ?? null };
}
