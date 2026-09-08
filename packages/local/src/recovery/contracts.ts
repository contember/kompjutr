export type RecoveryCheckpoint =
  | "journal-created"
  | "probe-intent"
  | "probe-placed"
  | "probe-returned"
  | "probe-cleaned"
  | "application-frame-synced"
  | "application-intent"
  | "backup-destination-synced"
  | "backup-moved"
  | "temporary-intent"
  | "parent-created"
  | "replacement-synced"
  | "replacement-renamed"
  | "generation-written"
  | "before-commit"
  | "after-commit"
  | "temporary-cleaned"
  | "created-path-removed"
  | "backup-restored"
  | "backup-cleaned"
  | "journal-unlinked"
  | "transaction-removed";

export type RecoveryCheckpointHandler = (checkpoint: RecoveryCheckpoint) => void;

export interface RecoveryTransactionOwner {
  begin(baseGeneration: number): void;
  /** Monotonic count of disk effects recorded by the active transaction. */
  readonly diskEffects: number;
  readonly abortOnly: boolean;
  checkpoint(checkpoint: RecoveryCheckpoint): void;
  operationFailed(): void;
  commitSucceeded(): void;
  rollback(): void;
  settleUncertain(committedGeneration: number): void;
  abandon(): void;
}
