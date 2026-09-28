// A compound stage's stdin, shared by the commands of its body in order.
//
// `{ head -1; cat; } < f` hands both inner commands the same input: each
// pipeline borrows the cursor in turn. Over a file, a consumer that stops
// inside a chunk (`head`) returns the unused suffix for the next borrower, as
// `head` seeks back on a regular file. Over a pipe or a here-document there
// is nothing to seek, so a chunk once read is consumed: Bash agrees for
// `head -n`, which reads ahead, but not for `head -c`, which reads exactly
// N bytes (a divergence pinned in compound.test.ts).

import { type ByteStream, close, withUnusedRestorer } from "../bytes.js";
import type { RetainedBudget } from "../context.js";
import type { StdinCursor } from "./frame.js";

export class StreamCursor implements StdinCursor {
  #pending: { readonly bytes: Uint8Array; readonly release: () => void } | null = null;
  #exhausted = false;
  #closed = false;

  constructor(
    private readonly source: ByteStream,
    private readonly retained: RetainedBudget,
    private readonly seekable: boolean,
  ) {}

  borrow(): ByteStream {
    const stream = this.#read();
    if (!this.seekable) return stream;
    return withUnusedRestorer(stream, (unused) => this.#restore(unused));
  }

  async *#read(): AsyncGenerator<Uint8Array, void, undefined> {
    for (;;) {
      const chunk = await this.#take();
      if (chunk === null) return;
      yield chunk;
    }
  }

  async #take(): Promise<Uint8Array | null> {
    const pending = this.#pending;
    if (pending !== null) {
      this.#pending = null;
      pending.release();
      return pending.bytes;
    }
    if (this.#exhausted || this.#closed) return null;
    const next = await this.source.next();
    if (next.done) {
      this.#exhausted = true;
      return null;
    }
    return next.value;
  }

  #restore(unused: Uint8Array): void {
    this.#pending?.release();
    // The suffix outlives the chunk its producer reserved, so it holds its own reservation.
    this.#pending = {
      bytes: unused,
      release: this.retained.retain(unused.length, "compound stdin"),
    };
  }

  async close(): Promise<void> {
    this.#pending?.release();
    this.#pending = null;
    if (this.#closed) return;
    this.#closed = true;
    await close(this.source);
  }
}
