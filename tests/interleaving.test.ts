import { describe, expect, it } from "vitest";
import type {
  GitHttpClient,
  GitHttpRequest,
  GitHttpResponse,
} from "../src/git/protocol/transport.js";
import {
  awaitBarrierEntry,
  BUFFERED_HTTP_RESPONSE_HEADROOM_BYTES,
  bufferedHttpResponseBarrier,
  checkpointBarrier,
  INTERLEAVING_RETAINED_LIMIT_BYTES,
  MAX_BUFFERED_HTTP_RESPONSE_BYTES,
  oneShotBarrier,
  type PairCompletionOrder,
  runPairInBothCompletionOrders,
} from "./helpers/interleaving.js";

function response(...chunks: Uint8Array[]): GitHttpResponse {
  return {
    status: 200,
    statusText: "OK",
    headers: { "content-type": "application/x-git-test-result" },
    body: (async function* () {
      yield* chunks;
    })(),
  };
}

async function collect(body: AsyncIterable<Uint8Array>): Promise<Uint8Array> {
  const bytes: number[] = [];
  for await (const chunk of body) bytes.push(...chunk);
  return new Uint8Array(bytes);
}

describe("interleaving helpers", () => {
  it("blocks exactly one waiter until its named barrier is released", async () => {
    const barrier = oneShotBarrier("pack index checkpoint");
    const events: string[] = [];
    const operation = (async () => {
      events.push("before");
      await barrier.wait();
      events.push("after");
    })();

    await barrier.entered;
    expect(barrier.name).toBe("pack index checkpoint");
    expect(events).toEqual(["before"]);

    barrier.release();
    await operation;
    expect(events).toEqual(["before", "after"]);
    await expect(barrier.wait()).rejects.toThrow(
      'barrier "pack index checkpoint" was entered more than once',
    );
  });

  it("allows idempotent release for failure cleanup", async () => {
    const barrier = oneShotBarrier("failed scenario cleanup");
    let resumed = false;
    const operation = (async () => {
      await barrier.wait();
      resumed = true;
    })();

    try {
      await barrier.entered;
      throw new Error("injected failure");
    } catch (error) {
      expect(error).toEqual(new Error("injected failure"));
    } finally {
      barrier.release();
      barrier.release();
    }

    await operation;
    expect(resumed).toBe(true);
  });

  it("permits cleanup release before an operation reaches the barrier", async () => {
    const barrier = oneShotBarrier("early cleanup");

    barrier.release();
    await barrier.wait();
    await expect(barrier.entered).resolves.toBeUndefined();
  });

  it("requires a useful barrier name", () => {
    expect(() => oneShotBarrier("  ")).toThrow("barrier name must not be empty");
  });

  it("reports owner fulfillment before entry without a timer", async () => {
    const barrier = oneShotBarrier("unreached owner checkpoint");

    await expect(awaitBarrierEntry(barrier, Promise.resolve("done"))).rejects.toThrow(
      'owner fulfilled before barrier "unreached owner checkpoint" was entered',
    );
  });

  it("reports owner rejection before entry without an unhandled rejection", async () => {
    const barrier = oneShotBarrier("failed owner checkpoint");
    const failure = new Error("owner failed");

    await expect(awaitBarrierEntry(barrier, Promise.reject(failure))).rejects.toMatchObject({
      message: 'owner rejected before barrier "failed owner checkpoint" was entered',
      cause: failure,
    });
  });

  it("leaves a post-entry owner rejection handled by the caller", async () => {
    const barrier = oneShotBarrier("post-entry failure");
    const failure = new Error("failed after entry");
    const owner = (async () => {
      await barrier.wait();
      throw failure;
    })();

    await awaitBarrierEntry(barrier, owner);
    barrier.release();
    await expect(owner).rejects.toBe(failure);
  });

  it("blocks only the first matching checkpoint", async () => {
    const barrier = checkpointBarrier<number>("second pack checkpoint", (value) => value >= 2);

    await barrier.checkpoint(1);
    const firstMatch = barrier.checkpoint(2);
    await barrier.entered;
    await barrier.checkpoint(3);

    barrier.release();
    await firstMatch;
    await barrier.checkpoint(4);
  });

  it("reports a checkpoint owner that finishes without a match", async () => {
    const barrier = checkpointBarrier<number>("missing checkpoint", (value) => value === 2);
    const owner = barrier.checkpoint(1);

    await expect(awaitBarrierEntry(barrier, owner)).rejects.toThrow(
      'owner fulfilled before barrier "missing checkpoint" was entered',
    );
  });

  it("buffers one selected GET response exactly before replay", async () => {
    let upstreamCalls = 0;
    let completedBodies = 0;
    const upstream: GitHttpClient = async () => {
      upstreamCalls++;
      return {
        ...response(),
        body: (async function* () {
          try {
            yield new Uint8Array([1, 2]);
            yield new Uint8Array(0);
            yield new Uint8Array([3, 4, 5]);
          } finally {
            completedBodies++;
          }
        })(),
      };
    };
    const barrier = bufferedHttpResponseBarrier(upstream, {
      name: "discovery response",
      select: (request) => request.method === "GET",
      maxBytes: 5,
    });
    const request: GitHttpRequest = {
      url: "https://example.com/info/refs",
      method: "GET",
      headers: {},
    };

    const blockedResponse = barrier.http(request);
    await barrier.entered;
    expect(completedBodies).toBe(1);
    expect(upstreamCalls).toBe(1);
    barrier.release();

    const replayed = await blockedResponse;
    expect(replayed).toMatchObject({
      status: 200,
      statusText: "OK",
      headers: { "content-type": "application/x-git-test-result" },
    });
    expect(await collect(replayed.body)).toEqual(new Uint8Array([1, 2, 3, 4, 5]));

    const unblocked = await barrier.http(request);
    expect(await collect(unblocked.body)).toEqual(new Uint8Array([1, 2, 3, 4, 5]));
    expect(upstreamCalls).toBe(2);
  });

  it("rejects a selected response at the configured buffer bound", async () => {
    let yieldedChunks = 0;
    let finalizedBodies = 0;
    let upstreamCalls = 0;
    const upstream: GitHttpClient = async () => ({
      ...response(),
      body: (async function* () {
        upstreamCalls++;
        try {
          yieldedChunks++;
          yield new Uint8Array([1, 2]);
          yieldedChunks++;
          yield new Uint8Array([3, 4]);
          yieldedChunks++;
          yield new Uint8Array([5]);
        } finally {
          finalizedBodies++;
        }
      })(),
    });
    const barrier = bufferedHttpResponseBarrier(upstream, {
      name: "bounded response",
      select: () => true,
      maxBytes: 3,
    });

    const owner = barrier.http({ url: "https://example.com/upload", method: "POST", headers: {} });
    await expect(awaitBarrierEntry(barrier, owner)).rejects.toMatchObject({
      message: 'owner rejected before barrier "bounded response" was entered',
      cause: new Error('buffered response for barrier "bounded response" exceeds 3 bytes'),
    });
    await expect(owner).rejects.toThrow(
      'buffered response for barrier "bounded response" exceeds 3 bytes',
    );
    expect(yieldedChunks).toBe(2);
    expect(finalizedBodies).toBe(1);

    const retry = await barrier.http({
      url: "https://example.com/upload",
      method: "POST",
      headers: {},
    });
    expect(upstreamCalls).toBe(1);
    expect(await collect(retry.body)).toEqual(new Uint8Array([1, 2, 3, 4, 5]));
    expect(upstreamCalls).toBe(2);
    expect(finalizedBodies).toBe(2);
    expect(() =>
      bufferedHttpResponseBarrier(upstream, {
        name: "invalid response bound",
        select: () => true,
        maxBytes: MAX_BUFFERED_HTTP_RESPONSE_BYTES + 1,
      }),
    ).toThrow(`buffered response limit must be between 1 and ${MAX_BUFFERED_HTTP_RESPONSE_BYTES}`);
  });

  it("keeps its exact payload ceiling below the retained-state limit", async () => {
    expect(MAX_BUFFERED_HTTP_RESPONSE_BYTES + BUFFERED_HTTP_RESPONSE_HEADROOM_BYTES).toBe(
      INTERLEAVING_RETAINED_LIMIT_BYTES,
    );
    expect(MAX_BUFFERED_HTTP_RESPONSE_BYTES).toBeLessThan(INTERLEAVING_RETAINED_LIMIT_BYTES);
    const bytes = new Uint8Array(MAX_BUFFERED_HTTP_RESPONSE_BYTES);
    bytes[0] = 1;
    bytes[bytes.length - 1] = 2;
    const barrier = bufferedHttpResponseBarrier(async () => response(bytes), {
      name: "exact response ceiling",
      select: () => true,
    });

    const owner = barrier.http({
      url: "https://example.com/info/refs",
      method: "GET",
      headers: {},
    });
    await awaitBarrierEntry(barrier, owner);
    barrier.release();
    const replayed = await owner;
    let chunks = 0;
    for await (const chunk of replayed.body) {
      chunks++;
      expect(chunk.length).toBe(MAX_BUFFERED_HTTP_RESPONSE_BYTES);
      expect(chunk[0]).toBe(1);
      expect(chunk[chunk.length - 1]).toBe(2);
    }
    expect(chunks).toBe(1);
  });

  it("reports HTTP upstream and body failures and consumes each selected one-shot", async () => {
    let upstreamCalls = 0;
    const upstreamFailure = new Error("upstream failed");
    const upstream: GitHttpClient = async () => {
      upstreamCalls++;
      if (upstreamCalls === 1) throw upstreamFailure;
      return response(new Uint8Array([6]));
    };
    const upstreamBarrier = bufferedHttpResponseBarrier(upstream, {
      name: "upstream failure",
      select: () => true,
    });
    const request: GitHttpRequest = {
      url: "https://example.com/info/refs",
      method: "GET",
      headers: {},
    };

    const upstreamOwner = upstreamBarrier.http(request);
    await expect(awaitBarrierEntry(upstreamBarrier, upstreamOwner)).rejects.toMatchObject({
      message: 'owner rejected before barrier "upstream failure" was entered',
      cause: upstreamFailure,
    });
    await expect(upstreamOwner).rejects.toBe(upstreamFailure);
    const afterUpstreamFailure = await upstreamBarrier.http(request);
    expect(await collect(afterUpstreamFailure.body)).toEqual(new Uint8Array([6]));
    expect(upstreamCalls).toBe(2);

    let bodyCalls = 0;
    let finalizedBodies = 0;
    const bodyFailure = new Error("body failed");
    const bodyUpstream: GitHttpClient = async () => {
      bodyCalls++;
      if (bodyCalls === 1) {
        return {
          ...response(),
          body: (async function* () {
            try {
              yield new Uint8Array([1]);
              throw bodyFailure;
            } finally {
              finalizedBodies++;
            }
          })(),
        };
      }
      return response(new Uint8Array([7]));
    };
    const bodyBarrier = bufferedHttpResponseBarrier(bodyUpstream, {
      name: "body failure",
      select: () => true,
    });
    const bodyOwner = bodyBarrier.http(request);
    await expect(awaitBarrierEntry(bodyBarrier, bodyOwner)).rejects.toMatchObject({
      message: 'owner rejected before barrier "body failure" was entered',
      cause: bodyFailure,
    });
    await expect(bodyOwner).rejects.toBe(bodyFailure);
    expect(finalizedBodies).toBe(1);
    const afterBodyFailure = await bodyBarrier.http(request);
    expect(await collect(afterBodyFailure.body)).toEqual(new Uint8Array([7]));
    expect(bodyCalls).toBe(2);
  });

  it("reports an HTTP owner that finishes without selecting a request", async () => {
    const barrier = bufferedHttpResponseBarrier(async () => response(new Uint8Array([4])), {
      name: "unselected POST response",
      select: (request) => request.method === "POST",
    });
    const owner = barrier.http({
      url: "https://example.com/info/refs",
      method: "GET",
      headers: {},
    });

    await expect(awaitBarrierEntry(barrier, owner)).rejects.toThrow(
      'owner fulfilled before barrier "unselected POST response" was entered',
    );
    expect(await collect((await owner).body)).toEqual(new Uint8Array([4]));
  });

  it("injects POST response loss only after upstream completion", async () => {
    let completedBodies = 0;
    let upstreamCalls = 0;
    const upstream: GitHttpClient = async () => {
      upstreamCalls++;
      return {
        ...response(),
        body: (async function* () {
          try {
            yield new Uint8Array([9, 8, 7]);
          } finally {
            completedBodies++;
          }
        })(),
      };
    };
    const barrier = bufferedHttpResponseBarrier(upstream, {
      name: "receive-pack publication",
      select: (request) => request.method === "POST",
      loseResponse: true,
    });
    const request: GitHttpRequest = {
      url: "https://example.com/git-receive-pack",
      method: "POST",
      headers: {},
      body: new Uint8Array([1]),
    };

    const lost = barrier.http(request);
    await barrier.entered;
    expect(completedBodies).toBe(1);
    barrier.release();
    await expect(lost).rejects.toThrow(
      'simulated response loss after barrier "receive-pack publication"',
    );

    const retry = await barrier.http(request);
    expect(await collect(retry.body)).toEqual(new Uint8Array([9, 8, 7]));
    expect(upstreamCalls).toBe(2);
  });

  it("runs a fresh pair scenario in both deterministic completion orders", async () => {
    const observedOrders: PairCompletionOrder[] = [];

    await runPairInBothCompletionOrders(async (order) => {
      observedOrders.push(order);
      const barrier = oneShotBarrier(`${order} delayed operation`);
      const completions: string[] = [];
      const left = (async () => {
        if (order === "right-first") await barrier.wait();
        completions.push("left");
      })();
      const right = (async () => {
        if (order === "left-first") await barrier.wait();
        completions.push("right");
      })();

      await barrier.entered;
      if (order === "left-first") await left;
      else await right;
      barrier.release();
      await Promise.all([left, right]);

      expect(completions).toEqual(order === "left-first" ? ["left", "right"] : ["right", "left"]);
    });

    expect(observedOrders).toEqual(["left-first", "right-first"]);
  });

  it("stops pair schedules at the first failure", async () => {
    const observedOrders: PairCompletionOrder[] = [];

    await expect(
      runPairInBothCompletionOrders(async (order) => {
        observedOrders.push(order);
        throw new Error("scenario failed");
      }),
    ).rejects.toThrow("scenario failed");
    expect(observedOrders).toEqual(["left-first"]);
  });
});
