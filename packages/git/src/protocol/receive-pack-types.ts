import type { ProtocolRequestOptions } from "./remote-base.js";

export const MAX_RECEIVE_PACK_COMMANDS = 1_024;
export const MAX_PUSH_OPTIONS = 64;
export const MAX_RECEIVE_PACK_STATUS_PACKETS = 16_384;

export interface ReceivePackCommand {
  readonly oldOid: string;
  readonly newOid: string;
  readonly ref: string;
}

export interface ReceivePackRequest {
  readonly url: string;
  readonly commands: readonly ReceivePackCommand[];
  readonly advertised: Set<string>;
  readonly atomic?: boolean;
  readonly pushOptions?: readonly string[];
  readonly pack?: () => AsyncIterable<Uint8Array>;
  readonly onProgress?: (message: string) => void;
  readonly onMessage?: (message: string) => void;
}

export interface ReceivePackRefStatus {
  readonly ok: boolean;
  readonly error?: string;
}

export interface ReceivePackStatus {
  readonly unpack: string;
  readonly refs: Map<string, ReceivePackRefStatus>;
}

export interface ReceivePackOptions extends ProtocolRequestOptions {}

export interface PreparedRequest {
  readonly commands: readonly ReceivePackCommand[];
  readonly commandFrames: readonly Uint8Array[];
  readonly optionFrames: readonly Uint8Array[];
  readonly hasNonDeletion: boolean;
  readonly sideband: boolean;
  readonly atomic: boolean;
  readonly pack?: () => AsyncIterable<Uint8Array>;
  readonly onProgress?: (message: string) => void;
  readonly onMessage?: (message: string) => void;
}

export interface ResolvedStatusLimits {
  readonly retainedBytes?: number;
  readonly inputBytes?: number;
  readonly entries: number;
  readonly lineBytes: number;
}

export interface PostCertainty {
  invoked: boolean;
  safeAbort: boolean;
}
