// The command registry.
//
// `git` is deliberately absent. It is injected by the consumer as a
// registered command, exactly as `@cloudflare/computer` does it, because
// putting it here would make `src/shell/` depend on `src/git/` and break the
// one-way rule in docs/reference/architecture.md.

import { type ByteStream, isAsyncByteStream } from "../exec/bytes.js";
import { type Command, type CommandResult, fail } from "../exec/context.js";
import { fileCommands } from "./files.js";
import { UsageError } from "./flags.js";
import { grep } from "./grep.js";
import { listCommands } from "./list.js";
import { readCommands } from "./read.js";
import { rg } from "./rg.js";
import { registerKnownCommands, textCommands } from "./text.js";
import { xargs } from "./xargs.js";

export function builtinCommands(): Map<string, Command> {
  const raw = new Map<string, Command>([
    ["grep", grep],
    ["rg", rg],
    ["xargs", xargs],
    ...readCommands,
    ...listCommands,
    ...fileCommands,
    ...textCommands,
  ]);
  const commands = new Map<string, Command>();
  for (const [name, command] of raw) commands.set(name, normalizeFailures(command));
  registerKnownCommands(commands.keys());
  return commands;
}

function normalizeFailures(command: Command): Command {
  return async (context) => {
    let produced: CommandResult;
    try {
      produced = await command(context);
    } catch (error) {
      const expected = expectedFailure(error);
      if (expected === null) throw error;
      return fail(context, expected.message, expected.status);
    }

    let failed: number | null = null;
    const stdout = normalizeOutput(produced.stdout, context.warn, (status) => {
      failed = status;
    });
    return {
      stdout,
      status: () => failed ?? produced.status(),
      truncated: () => produced.truncated?.() ?? false,
    };
  };
}

function normalizeOutput(
  source: ByteStream,
  warn: (message: string) => void,
  failWith: (status: number) => void,
): ByteStream {
  const handle = (error: unknown): void => {
    const expected = expectedFailure(error);
    if (expected === null) throw error;
    warn(expected.message);
    failWith(expected.status);
  };
  return isAsyncByteStream(source)
    ? new NormalizedAsyncOutput(source, handle)
    : new NormalizedSyncOutput(source, handle);
}

class NormalizedSyncOutput implements IterableIterator<Uint8Array, void, undefined> {
  #closed = false;

  constructor(
    private readonly source: IterableIterator<Uint8Array, void, undefined>,
    private readonly handle: (error: unknown) => void,
  ) {}

  [Symbol.iterator](): IterableIterator<Uint8Array, void, undefined> {
    return this;
  }

  next(..._args: [] | [undefined]): IteratorResult<Uint8Array, void> {
    if (this.#closed) return { done: true, value: undefined };
    try {
      const next = this.source.next();
      if (next.done) this.#closed = true;
      return next;
    } catch (error) {
      this.#finish();
      this.handle(error);
      return { done: true, value: undefined };
    }
  }

  return(_value?: undefined): IteratorResult<Uint8Array, void> {
    if (this.#closed) return { done: true, value: undefined };
    try {
      return this.source.return?.() ?? { done: true, value: undefined };
    } catch (error) {
      this.handle(error);
      return { done: true, value: undefined };
    } finally {
      this.#closed = true;
    }
  }

  throw(error: unknown): IteratorResult<Uint8Array, void> {
    this.#finish();
    throw error;
  }

  #finish(): void {
    if (this.#closed) return;
    this.#closed = true;
    this.source.return?.();
  }
}

class NormalizedAsyncOutput implements AsyncIterableIterator<Uint8Array, void, undefined> {
  #closed = false;

  constructor(
    private readonly source: AsyncIterableIterator<Uint8Array, void, undefined>,
    private readonly handle: (error: unknown) => void,
  ) {}

  [Symbol.asyncIterator](): AsyncIterableIterator<Uint8Array, void, undefined> {
    return this;
  }

  async next(..._args: [] | [undefined]): Promise<IteratorResult<Uint8Array, void>> {
    if (this.#closed) return { done: true, value: undefined };
    try {
      const next = await this.source.next();
      if (next.done) this.#closed = true;
      return next;
    } catch (error) {
      await this.#finish();
      this.handle(error);
      return { done: true, value: undefined };
    }
  }

  async return(_value?: undefined): Promise<IteratorResult<Uint8Array, void>> {
    if (this.#closed) return { done: true, value: undefined };
    try {
      return (await this.source.return?.()) ?? { done: true, value: undefined };
    } catch (error) {
      this.handle(error);
      return { done: true, value: undefined };
    } finally {
      this.#closed = true;
    }
  }

  async throw(error: unknown): Promise<IteratorResult<Uint8Array, void>> {
    await this.#finish();
    throw error;
  }

  async #finish(): Promise<void> {
    if (this.#closed) return;
    this.#closed = true;
    await this.source.return?.();
  }
}

function expectedFailure(error: unknown): { message: string; status: number } | null {
  if (error instanceof UsageError) return { message: error.message, status: 2 };
  if (
    error instanceof Error &&
    "code" in error &&
    typeof error.code === "string" &&
    error.code.startsWith("E")
  ) {
    return { message: error.message, status: 1 };
  }
  return null;
}

export { grep, rg, xargs };
