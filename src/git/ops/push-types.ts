import type { AbortableNetworkOptions, RemoteAuthOptions } from "./network.js";
import type {
  PushLeaseExpectation,
  PushPlanningUpdate,
  PushRefspec,
  RemoteTarget,
} from "./refspec.js";

export interface MappedPushSelection {
  readonly refspecs: readonly [PushRefspec, ...PushRefspec[]];
  readonly ref?: never;
  readonly remoteRef?: never;
  readonly force?: never;
  readonly delete?: never;
}

export interface LegacyPushSelection {
  readonly refspecs?: never;
  readonly ref?: string;
  readonly remoteRef?: string;
  readonly force?: boolean;
  readonly delete?: boolean;
}

export type PushOptions = RemoteAuthOptions &
  AbortableNetworkOptions &
  RemoteTarget & {
    readonly atomic?: boolean;
    readonly leases?: Readonly<Record<string, PushLeaseExpectation>>;
    readonly pushOptions?: readonly string[];
  } & (MappedPushSelection | LegacyPushSelection);

export interface JoinedPushUpdate extends PushPlanningUpdate {
  readonly noop: boolean;
}

export interface JoinedAdvertisement {
  readonly updates: JoinedPushUpdate[];
  readonly remoteOids: string[];
  readonly capabilities: Set<string>;
}
