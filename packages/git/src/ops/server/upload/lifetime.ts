import { abortable, throwIfAborted } from "../../../protocol/stream.js";
import type { SharedRepoStore } from "../../../store/index.js";
import { advanceTransfer } from "../../../store/transfer/closure.js";
import {
  assertTransfer,
  createTransfer,
  releaseTransfer,
  renewTransfer,
  type TransferOptions,
  type TransferOwner,
} from "../../../store/transfer/lifetime.js";
import type { ServerRuntime } from "../runtime.js";

/** At most the access-validation owner and the pack owner overlap during a request. */
export class UploadLifetime {
  private readonly owners = new Set<TransferOwner>();
  private readonly onAbort = () => this.close();

  constructor(
    private readonly store: SharedRepoStore,
    private readonly runtime: ServerRuntime,
  ) {
    throwIfAborted(runtime.signal);
    runtime.signal.addEventListener("abort", this.onAbort, { once: true });
  }

  create(options: Omit<TransferOptions, "nowMs">): TransferOwner {
    throwIfAborted(this.runtime.signal);
    const owner = createTransfer(this.store, { ...options, nowMs: this.runtime.now() });
    this.owners.add(owner);
    return owner;
  }

  release(owner: TransferOwner): void {
    releaseTransfer(this.store, owner);
    this.owners.delete(owner);
  }

  close(): void {
    this.runtime.signal.removeEventListener("abort", this.onAbort);
    for (const owner of this.owners) this.release(owner);
  }

  async plan(owner: TransferOwner): Promise<void> {
    throwIfAborted(this.runtime.signal);
    while (!advanceTransfer(this.store, owner, this.runtime.now())) {
      renewTransfer(this.store, owner, this.runtime.now());
      await abortable(this.runtime.yieldNow(), this.runtime.signal);
      throwIfAborted(this.runtime.signal);
      assertTransfer(this.store, owner, this.runtime.now());
    }
  }

  response(body: AsyncGenerator<Uint8Array>): AsyncIterableIterator<Uint8Array> {
    const lifetime = this;
    const signal = this.runtime.signal;
    let closed = false;
    return {
      [Symbol.asyncIterator]() {
        return this;
      },
      async next() {
        if (closed) return { done: true, value: undefined };
        try {
          throwIfAborted(signal);
          const result = await body.next();
          throwIfAborted(signal);
          if (result.done) {
            closed = true;
            lifetime.close();
          }
          return result;
        } catch (error) {
          closed = true;
          lifetime.close();
          await body.return(undefined);
          throw error;
        }
      },
      async return() {
        closed = true;
        lifetime.close();
        return body.return(undefined);
      },
      async throw(error: unknown) {
        closed = true;
        lifetime.close();
        return body.throw(error);
      },
    };
  }
}
