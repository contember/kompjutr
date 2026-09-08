import type { ExpandedArguments } from "./arguments.js";
import { type ByteStream, isAsyncByteStream } from "./bytes.js";
import type { HeldChunk, OutputDestination } from "./routing-types.js";

export function diagnosticsFor(
  diagnostics: Map<OutputDestination, HeldChunk[]>,
  destination: OutputDestination,
): HeldChunk[] {
  const existing = diagnostics.get(destination);
  if (existing !== undefined) return existing;
  const created: HeldChunk[] = [];
  diagnostics.set(destination, created);
  return created;
}

export function releaseDiagnostics(
  diagnostics: Map<OutputDestination, HeldChunk[]>,
  except?: HeldChunk[],
): void {
  for (const chunks of diagnostics.values()) {
    if (chunks === except) continue;
    for (const chunk of chunks) chunk.release();
  }
}

export function rethrowAfterCommandCleanup(
  error: unknown,
  expanded: ExpandedArguments,
  diagnostics: Map<OutputDestination, HeldChunk[]>,
): never {
  try {
    expanded.release();
  } catch {
    // Cleanup must not replace the command's observable failure.
  }
  for (const chunks of diagnostics.values()) {
    for (const held of chunks) {
      try {
        held.release();
      } catch {
        // Keep releasing later owners, then rethrow the command failure.
      }
    }
  }
  throw error;
}

/** Interleave diagnostics emitted while pulling a command with its stdout. */
export function stageOutput(
  stdout: ByteStream,
  mergedErrors: HeldChunk[],
  releaseStage: () => void | Promise<void>,
  asyncRelease: boolean,
): ByteStream {
  return isAsyncByteStream(stdout) || asyncRelease
    ? new AsyncStageOutput(stdout, mergedErrors, releaseStage)
    : new SyncStageOutput(stdout, mergedErrors, releaseStage);
}

/** A generator whose unstarted `return()` still closes its source and reservations. */
class SyncStageOutput implements IterableIterator<Uint8Array, void, undefined> {
  #warningIndex = 0;
  #pending: IteratorResult<Uint8Array, void> | null = null;
  #releaseYielded: (() => void) | null = null;
  #closed = false;

  constructor(
    private readonly stdout: IterableIterator<Uint8Array, void, undefined>,
    private readonly mergedErrors: HeldChunk[],
    private readonly releaseStage: () => void | Promise<void>,
  ) {}

  [Symbol.iterator](): IterableIterator<Uint8Array, void, undefined> {
    return this;
  }

  [Symbol.dispose](): void {
    this.#finish(true);
  }

  next(..._args: [] | [undefined]): IteratorResult<Uint8Array, void> {
    this.#releaseLastYield();
    if (this.#closed) return { done: true, value: undefined };
    try {
      if (this.#pending === null) this.#pending = this.stdout.next();
      const warning = this.mergedErrors[this.#warningIndex];
      if (warning !== undefined) {
        this.#warningIndex++;
        this.#releaseYielded = warning.release;
        return { done: false, value: warning.bytes };
      }
      const pending = this.#pending;
      this.#pending = null;
      if (pending.done) {
        this.#finish(false);
        return { done: true, value: undefined };
      }
      return pending;
    } catch (error) {
      this.#finish(true);
      throw error;
    }
  }

  return(_value: undefined): IteratorResult<Uint8Array, void> {
    this.#finish(true);
    return { done: true, value: undefined };
  }

  throw(error: unknown): IteratorResult<Uint8Array, void> {
    this.#finish(true);
    throw error;
  }

  #releaseLastYield(): void {
    this.#releaseYielded?.();
    this.#releaseYielded = null;
  }

  #finish(closeSource: boolean): void {
    if (this.#closed) return;
    this.#closed = true;
    this.#releaseLastYield();
    let closeError: { readonly value: unknown } | null = null;
    try {
      if (closeSource) this.stdout.return?.();
    } catch (error) {
      closeError = { value: error };
    }
    for (; this.#warningIndex < this.mergedErrors.length; this.#warningIndex++) {
      this.mergedErrors[this.#warningIndex]?.release();
    }
    const released = this.releaseStage();
    if (released instanceof Promise) {
      throw new Error("synchronous stage cleanup became asynchronous");
    }
    if (closeError !== null) throw closeError.value;
  }
}

class AsyncStageOutput implements AsyncIterableIterator<Uint8Array, void, undefined> {
  #warningIndex = 0;
  #pending: IteratorResult<Uint8Array, void> | null = null;
  #releaseYielded: (() => void) | null = null;
  #closed = false;

  constructor(
    private readonly stdout: ByteStream,
    private readonly mergedErrors: HeldChunk[],
    private readonly releaseStage: () => void | Promise<void>,
  ) {}

  [Symbol.asyncIterator](): AsyncIterableIterator<Uint8Array, void, undefined> {
    return this;
  }

  async next(..._args: [] | [undefined]): Promise<IteratorResult<Uint8Array, void>> {
    this.#releaseLastYield();
    if (this.#closed) return { done: true, value: undefined };
    try {
      if (this.#pending === null) this.#pending = await this.stdout.next();
      const warning = this.mergedErrors[this.#warningIndex];
      if (warning !== undefined) {
        this.#warningIndex++;
        this.#releaseYielded = warning.release;
        return { done: false, value: warning.bytes };
      }
      const pending = this.#pending;
      this.#pending = null;
      if (pending.done) {
        await this.#finish(false);
        return { done: true, value: undefined };
      }
      return pending;
    } catch (error) {
      await this.#finish(true);
      throw error;
    }
  }

  async return(_value?: undefined): Promise<IteratorResult<Uint8Array, void>> {
    await this.#finish(true);
    return { done: true, value: undefined };
  }

  async throw(error: unknown): Promise<IteratorResult<Uint8Array, void>> {
    await this.#finish(true);
    throw error;
  }

  #releaseLastYield(): void {
    this.#releaseYielded?.();
    this.#releaseYielded = null;
  }

  async #finish(closeSource: boolean): Promise<void> {
    if (this.#closed) return;
    this.#closed = true;
    this.#releaseLastYield();
    try {
      if (closeSource) await this.stdout.return?.();
    } finally {
      for (; this.#warningIndex < this.mergedErrors.length; this.#warningIndex++) {
        this.mergedErrors[this.#warningIndex]?.release();
      }
      await this.releaseStage();
    }
  }
}
