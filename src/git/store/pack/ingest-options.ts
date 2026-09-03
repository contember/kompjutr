// Derived from dgit (MIT, Copyright (c) 2026 Divy Srivastava),
// https://github.com/littledivy/dgit — the three-phase ingest, the rotating offset window, the deferred-delta table and the iterative delta-chain walk all follow dgit's src/git/packstore.ts.

import { GitError } from "../../common/errors.js";
import type { PackIngestOptions } from "./shared.js";

export interface AbortablePackIngestOptions extends PackIngestOptions {
  signal?: AbortSignal;
}

export function throwIfIngestAborted(signal: AbortSignal | undefined): void {
  if (signal?.aborted === true) {
    throw new GitError("EABORTED", "network operation aborted", { cause: signal.reason });
  }
}
