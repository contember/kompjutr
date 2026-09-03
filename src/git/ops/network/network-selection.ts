import { GitError } from "../../common/errors.js";
import type { Advertisement, RemoteRef } from "../../protocol/remote.js";
import type { FetchSelection } from "./network-types.js";

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
