import type { SharedRepoStore } from "../../store/index.js";
import { advanceTransfer } from "../../store/transfer/closure.js";
import {
  assertTransfer,
  createTransfer,
  releaseTransfer,
  renewTransfer,
  type TransferOptions,
  type TransferOwner,
} from "../../store/transfer/lifetime.js";

export interface TransferRuntime {
  now?: () => number;
  yieldNow?: () => Promise<void>;
}

export function transferRuntime(runtime: TransferRuntime) {
  return {
    now: runtime.now ?? Date.now,
    yieldNow: runtime.yieldNow ?? (() => new Promise<void>((resolve) => setTimeout(resolve, 0))),
  };
}

/** Retain and plan a complete closure, yielding between fixed SQL steps. */
export async function planTransfer(
  store: SharedRepoStore,
  options: Omit<TransferOptions, "nowMs">,
  runtime: TransferRuntime = {},
): Promise<TransferOwner> {
  const { now, yieldNow } = transferRuntime(runtime);
  const owner = createTransfer(store, { ...options, nowMs: now() });
  try {
    while (!advanceTransfer(store, owner, now())) {
      renewTransfer(store, owner, now());
      await yieldNow();
      assertTransfer(store, owner, now());
    }
    return owner;
  } catch (error) {
    releaseTransfer(store, owner);
    throw error;
  }
}
