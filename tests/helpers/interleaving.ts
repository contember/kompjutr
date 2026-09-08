import type {
  GitHttpClient,
  GitHttpRequest,
  GitHttpResponse,
} from "../../packages/git/src/protocol/transport.js";

export interface BarrierEntry {
  readonly name: string;
  readonly entered: Promise<void>;
}

export interface OneShotBarrier extends BarrierEntry {
  wait(): Promise<void>;
  release(): void;
}

export async function awaitBarrierEntry<T>(
  barrier: BarrierEntry,
  owner: Promise<T>,
): Promise<void> {
  const ownerSettled = owner.then(
    () => {
      throw new Error(`owner fulfilled before barrier "${barrier.name}" was entered`);
    },
    (cause: unknown) => {
      throw new Error(`owner rejected before barrier "${barrier.name}" was entered`, { cause });
    },
  );
  await Promise.race([barrier.entered, ownerSettled]);
}

export function oneShotBarrier(name: string): OneShotBarrier {
  if (name.trim().length === 0) throw new TypeError("barrier name must not be empty");

  let signalEntered = (): void => {};
  let signalReleased = (): void => {};
  let waited = false;
  let released = false;
  const entered = new Promise<void>((resolve) => {
    signalEntered = resolve;
  });
  const releaseSignal = new Promise<void>((resolve) => {
    signalReleased = resolve;
  });

  return {
    name,
    entered,
    async wait() {
      if (waited) throw new Error(`barrier "${name}" was entered more than once`);
      waited = true;
      signalEntered();
      await releaseSignal;
    },
    release() {
      if (released) return;
      released = true;
      signalReleased();
    },
  };
}

export interface CheckpointBarrier<T> extends BarrierEntry {
  checkpoint(value: T): Promise<void>;
  release(): void;
}

export function checkpointBarrier<T>(
  name: string,
  matches: (value: T) => boolean,
): CheckpointBarrier<T> {
  const gate = oneShotBarrier(name);
  let matched = false;
  return {
    name: gate.name,
    entered: gate.entered,
    async checkpoint(value) {
      if (matched || !matches(value)) return;
      matched = true;
      await gate.wait();
    },
    release: gate.release,
  };
}

export const INTERLEAVING_RETAINED_LIMIT_BYTES = 1024 * 1024;
export const BUFFERED_HTTP_RESPONSE_HEADROOM_BYTES = 64 * 1024;
export const MAX_BUFFERED_HTTP_RESPONSE_BYTES =
  INTERLEAVING_RETAINED_LIMIT_BYTES - BUFFERED_HTTP_RESPONSE_HEADROOM_BYTES;

export interface BufferedHttpResponseBarrierOptions {
  readonly name: string;
  readonly select: (request: GitHttpRequest) => boolean;
  readonly maxBytes?: number;
  readonly loseResponse?: boolean;
}

export interface BufferedHttpResponseBarrier extends BarrierEntry {
  readonly http: GitHttpClient;
  release(): void;
}

async function bufferResponseBody(
  name: string,
  response: GitHttpResponse,
  maxBytes: number,
): Promise<Uint8Array> {
  const storage = new Uint8Array(maxBytes);
  let length = 0;
  for await (const chunk of response.body) {
    if (chunk.length > maxBytes - length) {
      throw new Error(`buffered response for barrier "${name}" exceeds ${maxBytes} bytes`);
    }
    storage.set(chunk, length);
    length += chunk.length;
  }
  return storage.subarray(0, length);
}

async function* replayResponseBody(body: Uint8Array): AsyncGenerator<Uint8Array> {
  if (body.length > 0) yield body;
}

export function bufferedHttpResponseBarrier(
  upstream: GitHttpClient,
  options: BufferedHttpResponseBarrierOptions,
): BufferedHttpResponseBarrier {
  const maxBytes = options.maxBytes ?? MAX_BUFFERED_HTTP_RESPONSE_BYTES;
  if (
    !Number.isSafeInteger(maxBytes) ||
    maxBytes < 1 ||
    maxBytes > MAX_BUFFERED_HTTP_RESPONSE_BYTES
  ) {
    throw new RangeError(
      `buffered response limit must be between 1 and ${MAX_BUFFERED_HTTP_RESPONSE_BYTES} bytes`,
    );
  }
  const gate = oneShotBarrier(options.name);
  let selected = false;
  const http: GitHttpClient = async (request) => {
    if (selected || !options.select(request)) return upstream(request);
    // The first selected request owns this one-shot even if its upstream response fails.
    selected = true;
    const response = await upstream(request);
    const body = await bufferResponseBody(options.name, response, maxBytes);
    await gate.wait();
    if (options.loseResponse === true) {
      throw new Error(`simulated response loss after barrier "${options.name}"`);
    }
    return { ...response, body: replayResponseBody(body) };
  };
  return {
    name: gate.name,
    entered: gate.entered,
    http,
    release: gate.release,
  };
}

export type PairCompletionOrder = "left-first" | "right-first";

export async function runPairInBothCompletionOrders(
  run: (order: PairCompletionOrder) => Promise<void>,
): Promise<void> {
  await run("left-first");
  await run("right-first");
}
