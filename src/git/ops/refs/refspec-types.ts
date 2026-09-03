export const MAX_REFSPEC_MAPPINGS = 1_024;
export const MAX_REFSPEC_EXPANDED_DESTINATIONS = 1_024;
export const MAX_PUSH_LEASES = 1_024;

export type RemoteTarget =
  | { readonly remote?: string; readonly url?: never }
  | { readonly remote?: never; readonly url: string };

export interface FetchRefspec {
  readonly source: string;
  readonly destination: string;
  readonly force?: boolean;
}

export type PushRefspec =
  | {
      readonly source: string;
      readonly destination: string;
      readonly force?: boolean;
    }
  | {
      readonly source: null;
      readonly destination: string;
      readonly force?: never;
    };

export type PushLeaseExpectation =
  | { readonly expected: string | null }
  | { readonly tracking: true };

export interface NormalizedPushLease {
  readonly destination: string;
  readonly expectation: PushLeaseExpectation;
}

export interface RemoteRefView {
  readonly name: string;
  readonly oid: string;
}

export interface LsRemoteResult {
  readonly refs: readonly RemoteRefView[];
  readonly headRef: string | null;
}

export interface FetchRefUpdate {
  readonly source: string;
  readonly destination: string;
  readonly oid: string;
}

export type FetchResult =
  | {
      readonly mode: "legacy";
      readonly defaultBranch: string | null;
      readonly fetchHead: string | null;
      readonly updates: readonly [];
    }
  | {
      readonly mode: "mapped";
      readonly defaultBranch: string | null;
      readonly fetchHead: null;
      readonly updates: readonly FetchRefUpdate[];
    };

export interface PushRefStatus {
  readonly ref: string;
  readonly ok: boolean;
  readonly error: string | null;
}

export type PushTrackingResult =
  | { readonly outcome: "not-applicable" | "unchanged" | "updated" | "stale" | "deferred" }
  | { readonly outcome: "failed"; readonly code: string; readonly message: string };

export interface PushResult {
  readonly ok: boolean;
  readonly error: string | null;
  readonly unpack: { readonly ok: true } | { readonly ok: false; readonly error: string };
  readonly refs: readonly PushRefStatus[];
  readonly tracking: PushTrackingResult;
}

export interface RefspecSourceRef {
  readonly name: string;
  readonly oid: string;
}

export interface ExpandedFetchRefspec extends FetchRefUpdate {
  readonly force: boolean;
}

export interface ExpandedPushRefspec {
  readonly source: string | null;
  readonly destination: string;
  readonly oid: string | null;
  readonly force: boolean;
}

/** One authoritative local-expansion snapshot paired with the observed remote destination. */
export interface PushPlanningUpdate extends ExpandedPushRefspec {
  readonly oldOid: string;
}

export interface CompiledFetchRefspecs {
  expand(refs: readonly RefspecSourceRef[]): readonly ExpandedFetchRefspec[];
}

export interface CompiledPushRefspecs {
  expand(refs: readonly RefspecSourceRef[]): readonly ExpandedPushRefspec[];
}
