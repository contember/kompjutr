import { throwIfAborted } from "../protocol/stream.js";
import type { FetchBehavior, FetchCheckpointStage } from "./network-types.js";

export async function runFetchCheckpoint(
  checkpoint: FetchBehavior["checkpoint"],
  stage: FetchCheckpointStage,
  signal: AbortSignal | undefined,
): Promise<void> {
  throwIfAborted(signal);
  const pending = checkpoint?.(stage);
  if (pending !== undefined) await pending;
  throwIfAborted(signal);
}
