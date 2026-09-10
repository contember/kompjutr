import type { MessageCallback, ProgressCallback } from "../../protocol/progress.js";
import type { RemoteRef, UploadPackFilter } from "../../protocol/remote.js";
import type { AuthCallback } from "../../protocol/transport.js";
import type { FetchPublicationPlan, FetchPublicationToken } from "../../store/index.js";
import type {
  FetchRefspec,
  RemoteTarget,
  FetchResult as StructuredFetchResult,
} from "../refs/refspec.js";

export interface RemoteAuthOptions {
  headers?: Record<string, string>;
  onAuth?: AuthCallback;
  /** Structured progress, as Computer's interface declares it. */
  onProgress?: ProgressCallback;
  /** The remote's side-band text, verbatim. */
  onMessage?: MessageCallback;
}

export interface AbortableNetworkOptions {
  readonly signal?: AbortSignal;
}

export interface CloneOptions extends RemoteAuthOptions, AbortableNetworkOptions {
  url: string;
  dir?: string;
  ref?: string;
  paths?: string[];
  depth?: number;
  singleBranch?: boolean;
  noTags?: boolean;
  remote?: string;
  filter?: UploadPackFilter;
}

export interface MappedFetchSelection {
  readonly refspecs: readonly [FetchRefspec, ...FetchRefspec[]];
  readonly depth?: never;
  readonly deepen?: never;
  readonly unshallow?: never;
  readonly ref?: never;
  readonly remoteRef?: never;
  readonly singleBranch?: never;
  readonly prune?: never;
  readonly tags?: never;
}

export interface LegacyFetchBaseSelection {
  readonly refspecs?: never;
  readonly ref?: string;
  readonly remoteRef?: string;
  readonly singleBranch?: boolean;
  readonly prune?: boolean;
  readonly tags?: boolean;
}

export type LegacyFetchSelection = LegacyFetchBaseSelection &
  (
    | { readonly depth?: number; readonly deepen?: never; readonly unshallow?: never }
    | { readonly depth?: never; readonly deepen: number; readonly unshallow?: never }
    | { readonly depth?: never; readonly deepen?: never; readonly unshallow: boolean }
  );

export type FetchOptions = RemoteAuthOptions &
  AbortableNetworkOptions & {
    readonly dir?: string;
    readonly filter?: UploadPackFilter;
  } & RemoteTarget &
  (MappedFetchSelection | LegacyFetchSelection);

export type FetchResult = StructuredFetchResult;

/** Internal clone/concurrency callers may pin both the configured name and its observed URL. */
export type FetchOperationOptions = RemoteAuthOptions &
  AbortableNetworkOptions & {
    readonly dir?: string;
    readonly remote?: string;
    readonly url?: string;
    readonly filter?: UploadPackFilter;
  } & (MappedFetchSelection | LegacyFetchSelection);

export interface FetchBehavior {
  /** Internal coverage selector, separate from the ref reported to a caller. */
  coverageRef?: string;
  /** Internal result selector, used by pull while it fetches broader coverage. */
  resultRef?: string;
  /** A configured selector auto-follows tags even when coverage is one branch. */
  autoTags?: boolean;
  /** Private lifecycle and deterministic-test checkpoint. */
  checkpoint?: (stage: FetchCheckpointStage) => Promise<void> | undefined;
}

export type FetchCheckpointStage =
  | "before-discovery"
  | "after-discovery"
  | "before-upload"
  | "before-ingest"
  | "pack-ingest"
  | "after-ingest"
  | "after-shallow-response"
  | "before-ref-publication"
  | "after-ref-publication";

export interface FetchSelection {
  coverage: RemoteRef[];
  result: RemoteRef | null;
}

export interface AdvertisedTag {
  ref: RemoteRef;
  peeledOid: string;
}

export interface FetchTarget {
  readonly remote: string;
  readonly url: string;
  /** Whether the fetched URL owns `refs/remotes/<remote>/`, as `pushTarget` decides for push. */
  readonly configured: boolean;
}

export interface LegacyFetchResult {
  readonly mode: "legacy";
  readonly defaultBranch: string | null;
  readonly fetchHead: string | null;
  readonly updates: readonly [];
}

export interface PreparedLegacyFetchPublication {
  readonly roots: readonly string[];
  readonly publication: FetchPublicationToken;
  plan: FetchPublicationPlan | null;
  readonly result: LegacyFetchResult;
}
