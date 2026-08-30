import { join } from "node:path";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { concat, utf8, ZERO_OID } from "../src/core/bytes.js";
import { TransportOperationBudget } from "../src/core/ops/transport-budget.js";
import { FLUSH, MAX_PKT_PAYLOAD_BYTES, pkt } from "../src/core/protocol/pktline.js";
import {
  MAX_PUSH_OPTIONS,
  MAX_RECEIVE_PACK_COMMANDS,
  type ReceivePackCommand,
  type ReceivePackRequest,
  receivePack,
  validatePushOptions,
} from "../src/core/protocol/receive-pack.js";
import { discover } from "../src/core/protocol/remote.js";
import {
  fetchHttpClient,
  type GitHttpClient,
  type GitHttpResponse,
} from "../src/core/protocol/transport.js";
import { MAX_OPERATION_MEMORY_BYTES, MemoryCoordinator } from "../src/memory.js";
import { GitFixture } from "./helpers/git.js";
import { type GitServer, startGitServer } from "./helpers/http-backend.js";

async function* once(...chunks: Uint8Array[]): AsyncGenerator<Uint8Array> {
  for (const chunk of chunks) yield chunk;
}

async function* brokenBody(chunk: Uint8Array, failure: unknown): AsyncGenerator<Uint8Array> {
  yield chunk;
  throw failure;
}

async function* chunked(body: Uint8Array): AsyncGenerator<Uint8Array> {
  for (let offset = 0; offset < body.length; offset += 32 * 1_024) {
    yield body.subarray(offset, offset + 32 * 1_024);
  }
}

async function collect(body: AsyncIterable<Uint8Array>): Promise<Uint8Array> {
  const chunks: Uint8Array[] = [];
  for await (const chunk of body) chunks.push(chunk);
  return concat(chunks);
}

async function collectBody(
  body: Uint8Array | AsyncIterable<Uint8Array> | undefined,
): Promise<Uint8Array> {
  if (body === undefined) return new Uint8Array(0);
  return body instanceof Uint8Array ? body : collect(body);
}

function response(
  body: Uint8Array,
  status = 200,
  contentType = "application/x-git-receive-pack-result",
): GitHttpResponse {
  return {
    status,
    statusText: status === 200 ? "OK" : status === 401 ? "Unauthorized" : "Failure",
    headers: { "content-type": contentType },
    body: chunked(body),
  };
}

function report(
  commands: readonly ReceivePackCommand[],
  statuses: ReadonlyMap<string, string | null> = new Map(),
  unpack = "ok",
): Uint8Array {
  return concat([
    pkt(`unpack ${unpack}\n`),
    ...commands.map((command) => {
      const error = statuses.get(command.ref);
      return error === undefined || error === null
        ? pkt(`ok ${command.ref}\n`)
        : pkt(`ng ${command.ref} ${error}\n`);
    }),
    FLUSH,
  ]);
}

function baseRequest(
  commands: readonly ReceivePackCommand[],
  extra: Partial<ReceivePackRequest> = {},
): ReceivePackRequest {
  return {
    url: "http://host/repo",
    commands,
    advertised: new Set(["report-status"]),
    ...extra,
  };
}

function command(index = 0, newOid = "3".repeat(40)): ReceivePackCommand {
  return {
    oldOid: "2".repeat(40),
    newOid,
    ref: `refs/heads/branch-${index}`,
  };
}

describe("receive-pack against Git", () => {
  let fixture: GitFixture;
  let origin: string;
  let server: GitServer;

  beforeAll(async () => {
    fixture = new GitFixture().init();
    fixture.write("base.txt", "base\n").commit("base");
    origin = join(fixture.dir, "origin.git");
    fixture.git("clone", "-q", "--bare", ".", origin);
    fixture.git(`--git-dir=${origin}`, "config", "http.receivepack", "true");
    fixture.git(`--git-dir=${origin}`, "config", "receive.advertisePushOptions", "true");
    server = await startGitServer(origin);
  });

  afterAll(async () => {
    await server.close();
    fixture.dispose();
  });

  it("sends Git's multi-command, atomic and push-option phases exactly", async () => {
    const captured: Uint8Array[] = [];
    const http: GitHttpClient = async (request) => {
      if (request.method === "GET") return fetchHttpClient(request);
      const body = await collectBody(request.body);
      captured.push(body);
      return fetchHttpClient({ ...request, body });
    };
    const advertisement = await discover(server.url, "git-receive-pack", { http });
    const oid = fixture.git(`--git-dir=${origin}`, "rev-parse", "refs/heads/main");
    const commands = [
      { oldOid: ZERO_OID, newOid: oid, ref: "refs/checkpoints/first" },
      { oldOid: ZERO_OID, newOid: oid, ref: "refs/checkpoints/second" },
    ];
    const pack = fixture.packAll();
    const result = await receivePack(
      {
        url: server.url,
        commands,
        advertised: advertisement.capabilities,
        atomic: true,
        pushOptions: ["alpha", "beta=value", "carriage\rreturn"],
        pack: () => once(pack),
      },
      { http },
    );

    const capabilities = [
      "report-status",
      ...(advertisement.capabilities.has("side-band-64k") ? ["side-band-64k"] : []),
      "atomic",
      "push-options",
    ].join(" ");
    expect(captured).toEqual([
      concat([
        pkt(`${ZERO_OID} ${oid} refs/checkpoints/first\0${capabilities}\n`),
        pkt(`${ZERO_OID} ${oid} refs/checkpoints/second\n`),
        FLUSH,
        pkt("alpha"),
        pkt("beta=value"),
        pkt("carriage\rreturn"),
        FLUSH,
        pack,
      ]),
    ]);
    expect(result).toEqual({
      unpack: "ok",
      refs: new Map([
        ["refs/checkpoints/first", { ok: true }],
        ["refs/checkpoints/second", { ok: true }],
      ]),
    });
    expect(fixture.git(`--git-dir=${origin}`, "rev-parse", "refs/checkpoints/first")).toBe(oid);
    expect(fixture.git(`--git-dir=${origin}`, "rev-parse", "refs/checkpoints/second")).toBe(oid);
  });

  it("preserves a safe local E2BIG through the default fetch cause chain", async () => {
    const advertisement = await discover(server.url, "git-receive-pack");
    const oid = fixture.git(`--git-dir=${origin}`, "rev-parse", "refs/heads/main");
    const localFailure = Object.assign(new Error("pack plan exceeded its object bound"), {
      code: "E2BIG",
    });
    await expect(
      receivePack({
        url: server.url,
        commands: [{ oldOid: ZERO_OID, newOid: oid, ref: "refs/checkpoints/incomplete" }],
        advertised: advertisement.capabilities,
        pack: () => brokenBody(utf8.encode("PACK"), localFailure),
      }),
    ).rejects.toBe(localFailure);
    expect(
      fixture.gitResult(
        `--git-dir=${origin}`,
        "show-ref",
        "--verify",
        "refs/checkpoints/incomplete",
      ).status,
    ).not.toBe(0);
  });
});

describe("receive-pack request validation", () => {
  it("validates push options without commands or capability checks", () => {
    expect(validatePushOptions(undefined)).toEqual([]);
    expect(validatePushOptions([])).toEqual([]);
    expect(validatePushOptions(["carriage\rreturn"])).toEqual([15]);

    const exact = "x".repeat(MAX_PKT_PAYLOAD_BYTES);
    expect(validatePushOptions([exact])).toEqual([MAX_PKT_PAYLOAD_BYTES]);
    expect(validatePushOptions(["a".repeat(40_000), "b".repeat(40_000)])).toEqual([40_000, 40_000]);

    expect(() =>
      validatePushOptions(Array.from({ length: MAX_PUSH_OPTIONS + 1 }, () => "")),
    ).toThrowError(expect.objectContaining({ code: "E2BIG" }));
    expect(() => validatePushOptions([`${exact}x`])).toThrowError(
      expect.objectContaining({ code: "E2BIG" }),
    );
    for (const malformed of ["not-an-array", [7], ["bad\0option"], ["bad\noption"], ["\ud800"]]) {
      expect(() => validatePushOptions(malformed)).toThrowError(
        expect.objectContaining({ code: "EINVAL" }),
      );
    }
  });

  it("rejects missing capabilities before POST", async () => {
    let posts = 0;
    const http: GitHttpClient = async () => {
      posts++;
      return response(report([command()]));
    };
    const cases = [
      baseRequest([command()], { advertised: new Set() }),
      baseRequest([command(0, ZERO_OID)]),
      baseRequest([command()], { atomic: true }),
      baseRequest([command()], { pushOptions: ["ci.skip"] }),
    ];
    for (const request of cases) {
      await expect(receivePack(request, { http })).rejects.toMatchObject({ code: "EUNSUPPORTED" });
    }
    expect(posts).toBe(0);
  });

  it("validates command count, duplicate destinations, oids and canonical refs before POST", async () => {
    let posts = 0;
    const http: GitHttpClient = async () => {
      posts++;
      return response(new Uint8Array(0));
    };
    await expect(receivePack(baseRequest([]), { http })).rejects.toMatchObject({ code: "EINVAL" });
    const exact = Array.from({ length: MAX_RECEIVE_PACK_COMMANDS }, (_, index) => command(index));
    await expect(
      receivePack(baseRequest([...exact, command(MAX_RECEIVE_PACK_COMMANDS)]), { http }),
    ).rejects.toMatchObject({ code: "E2BIG" });
    await expect(receivePack(baseRequest([command(), command()]), { http })).rejects.toMatchObject({
      code: "EINVAL",
    });
    await expect(
      receivePack(baseRequest([{ ...command(), oldOid: "A".repeat(40) }]), { http }),
    ).rejects.toMatchObject({ code: "EINVAL" });
    await expect(
      receivePack(baseRequest([{ ...command(), ref: "refs/heads/bad..ref" }]), { http }),
    ).rejects.toMatchObject({ code: "EINVALIDREF" });
    expect(posts).toBe(0);
  });

  it("accepts exactly 1,024 commands and retains statuses in command order", async () => {
    const commands = Array.from({ length: MAX_RECEIVE_PACK_COMMANDS }, (_, index) =>
      command(index),
    );
    const reversed = [...commands].reverse();
    const coordinator = new MemoryCoordinator();
    const reservation = coordinator.reserve();
    const budget = new TransportOperationBudget(reservation);
    const http: GitHttpClient = async () => response(report(reversed));
    try {
      const result = await receivePack(baseRequest(commands), { http, operationBudget: budget });
      expect([...result.refs.keys()]).toEqual(commands.map((item) => item.ref));

      const stringBytes = (value: string): number => 48 + value.length * 2;
      let requestBytes = 256;
      const resultBytes = 192 + stringBytes("ok") + commands.length * 96;
      for (const [index, item] of commands.entries()) {
        requestBytes += 96;
        const capabilities = index === 0 ? "\0report-status" : "";
        requestBytes +=
          32 + utf8.encode(`${item.oldOid} ${item.newOid} ${item.ref}${capabilities}\n`).length + 4;
      }
      expect(budget.memory("receive-pack-request")).toBe(0);
      expect(budget.memory("receive-pack-result")).toBe(resultBytes);
      expect(budget.retainedBytes).toBe(resultBytes);
      expect(reservation.currentBytes).toBe(resultBytes);
      expect(coordinator.highWaterBytes).toBeGreaterThan(requestBytes + resultBytes);
      expect(coordinator.highWaterBytes).toBeLessThanOrEqual(MAX_OPERATION_MEMORY_BYTES);
    } finally {
      reservation.dispose();
    }
    coordinator.assertIdle();
  });

  it("accepts a destination at the command pkt limit and rejects its first excess", async () => {
    const prefix = "refs/x/";
    const template = command();
    const suffix = "\0report-status\n";
    const fixedBytes = utf8.encode(
      `${template.oldOid} ${template.newOid} ${prefix}${suffix}`,
    ).length;
    const exact = {
      ...template,
      ref: `${prefix}${"x".repeat(MAX_PKT_PAYLOAD_BYTES - fixedBytes)}`,
    };
    let posts = 0;
    const http: GitHttpClient = async () => {
      posts++;
      return response(report([exact]));
    };
    await expect(receivePack(baseRequest([exact]), { http })).resolves.toMatchObject({
      unpack: "ok",
    });
    await expect(
      receivePack(baseRequest([{ ...exact, ref: `${exact.ref}x` }]), { http }),
    ).rejects.toMatchObject({ code: "E2BIG" });
    expect(posts).toBe(1);
  });

  it("uses copied commands and atomic mode after the POST yields", async () => {
    const first = { ...command(1) };
    const second = { ...command(2) };
    const originalFirstRef = first.ref;
    const originalSecondRef = second.ref;
    const request = baseRequest([first, second]);
    const statuses = new Map([[originalSecondRef, "hook rejected"]]);
    const http: GitHttpClient = async () => {
      first.ref = "refs/heads/mutated";
      Object.defineProperty(request, "atomic", { value: true });
      return response(
        report(
          [
            { ...first, ref: originalFirstRef },
            { ...second, ref: originalSecondRef },
          ],
          statuses,
        ),
      );
    };
    await expect(receivePack(request, { http })).resolves.toEqual({
      unpack: "ok",
      refs: new Map([
        [originalFirstRef, { ok: true }],
        [originalSecondRef, { ok: false, error: "hook rejected" }],
      ]),
    });
  });

  it("validates push-option count, UTF-8 bytes and text before POST", async () => {
    let posts = 0;
    let framedBytes = 0;
    let ownedRequestBytes = 0;
    const coordinator = new MemoryCoordinator();
    const reservation = coordinator.reserve();
    const budget = new TransportOperationBudget(reservation);
    const http: GitHttpClient = async (request) => {
      posts++;
      ownedRequestBytes = budget.memory("receive-pack-request");
      framedBytes = (await collectBody(request.body)).length;
      return response(report([command()]));
    };
    const exact = ["x".repeat(40_000), "y".repeat(40_000)];
    try {
      await expect(
        receivePack(
          baseRequest([command()], {
            advertised: new Set(["report-status", "push-options"]),
            pushOptions: exact,
          }),
          { http, operationBudget: budget },
        ),
      ).resolves.toMatchObject({ unpack: "ok" });
      expect(posts).toBe(1);
      expect(framedBytes).toBeGreaterThan(64 * 1024);
      expect(ownedRequestBytes).toBeGreaterThan(framedBytes);
      expect(budget.memory("receive-pack-request")).toBe(0);
    } finally {
      reservation.dispose();
    }
    coordinator.assertIdle();

    const malformed: ReceivePackRequest = baseRequest([command()], {
      advertised: new Set(["report-status", "push-options"]),
      pushOptions: ["valid"],
    });
    Object.defineProperty(malformed.pushOptions, "0", { value: 7 });
    const rejected = [
      baseRequest([command()], {
        advertised: new Set(["report-status", "push-options"]),
        pushOptions: Array.from({ length: MAX_PUSH_OPTIONS + 1 }, () => "excess"),
      }),
      baseRequest([command()], {
        advertised: new Set(["report-status", "push-options"]),
        pushOptions: ["é".repeat(MAX_PKT_PAYLOAD_BYTES / 2 + 1)],
      }),
      baseRequest([command()], {
        advertised: new Set(["report-status", "push-options"]),
        pushOptions: ["bad\0option"],
      }),
      baseRequest([command()], {
        advertised: new Set(["report-status", "push-options"]),
        pushOptions: ["bad\noption"],
      }),
      baseRequest([command()], {
        advertised: new Set(["report-status", "push-options"]),
        pushOptions: ["\ud800"],
      }),
      malformed,
    ];
    for (const request of rejected)
      await expect(receivePack(request, { http })).rejects.toBeTruthy();
    expect(posts).toBe(1);
  });

  it("permits carriage return in captured push-option bytes", async () => {
    let body: Uint8Array = new Uint8Array(0);
    const update = command();
    await receivePack(
      baseRequest([update], {
        advertised: new Set(["report-status", "push-options"]),
        pushOptions: ["carriage\rreturn"],
      }),
      {
        http: async (request) => {
          body = await collectBody(request.body);
          return response(report([update]));
        },
      },
    );
    expect(body).toEqual(
      concat([
        pkt(`${update.oldOid} ${update.newOid} ${update.ref}\0report-status push-options\n`),
        FLUSH,
        pkt("carriage\rreturn"),
        FLUSH,
      ]),
    );
  });

  it("does not open a pack for a deletion-only request", async () => {
    const deletion = command(0, ZERO_OID);
    let opens = 0;
    let body: Uint8Array = new Uint8Array(0);
    const http: GitHttpClient = async (request) => {
      body = await collectBody(request.body);
      return response(report([deletion]));
    };
    await receivePack(
      baseRequest([deletion], {
        advertised: new Set(["report-status", "delete-refs"]),
        pack: () => {
          opens++;
          return once(utf8.encode("PACK"));
        },
      }),
      { http },
    );
    expect(opens).toBe(0);
    expect(body.subarray(-4)).toEqual(FLUSH);
    expect(new TextDecoder().decode(body)).not.toContain("delete-refs");
  });
});

describe("receive-pack replay and certainty", () => {
  it("replays byte-identical bodies once after 401 and opens the pack twice", async () => {
    const bodies: Uint8Array[] = [];
    let opens = 0;
    const update = command();
    const coordinator = new MemoryCoordinator();
    const reservation = coordinator.reserve();
    const budget = new TransportOperationBudget(reservation);
    const http: GitHttpClient = async (request) => {
      bodies.push(await collectBody(request.body));
      return bodies.length === 1
        ? response(utf8.encode("auth"), 401, "text/plain")
        : response(report([update]));
    };
    try {
      await receivePack(
        baseRequest([update], {
          pack: () => {
            opens++;
            return once(utf8.encode("PACKbody"));
          },
        }),
        { http, onAuth: () => ({ username: "token" }), operationBudget: budget },
      );
      expect(opens).toBe(2);
      expect(bodies).toHaveLength(2);
      expect(bodies[1]).toEqual(bodies[0]);
      expect(budget.memory("receive-pack-request")).toBe(0);
      expect(budget.memory("receive-pack-status-reader")).toBe(0);
      expect(budget.memory("receive-pack-sideband-reader")).toBe(0);
      expect(budget.memory("receive-pack-status-frame")).toBe(0);
      expect(budget.memory("receive-pack-status-parse")).toBe(0);
      expect(budget.memory("receive-pack-result")).toBe(340);
      expect(budget.retainedBytes).toBe(340);
      budget.clearAllMemory();
      expect(budget.retainedBytes).toBe(0);
      expect(coordinator.totalBytes).toBe(0);
    } finally {
      reservation.dispose();
    }
    coordinator.assertIdle();
  });

  it("does not retry POST transport failure and preserves it as uncertain cause", async () => {
    const failure = Object.assign(new Error("socket reset"), { code: "ECONNRESET" });
    let attempts = 0;
    let opens = 0;
    const http: GitHttpClient = async (request) => {
      attempts++;
      await collectBody(request.body);
      throw failure;
    };
    await expect(
      receivePack(
        baseRequest([command()], {
          pack: () => {
            opens++;
            return once(utf8.encode("PACKbody"));
          },
        }),
        { http },
      ),
    ).rejects.toMatchObject({ code: "EPUSHUNCERTAIN", cause: failure });
    expect(attempts).toBe(1);
    expect(opens).toBe(1);

    const spoofed = { localPackBodyError: true, cause: { code: "E2BIG" } };
    await expect(
      receivePack(baseRequest([command()]), {
        http: async () => {
          throw spoofed;
        },
      }),
    ).rejects.toMatchObject({ code: "EPUSHUNCERTAIN", cause: spoofed });

    const cyclicSpoof = { localPackBodyError: true, cause: null };
    Object.defineProperty(cyclicSpoof, "cause", { value: cyclicSpoof });
    await expect(
      receivePack(baseRequest([command()]), {
        http: async () => {
          throw cyclicSpoof;
        },
      }),
    ).rejects.toMatchObject({ code: "EPUSHUNCERTAIN", cause: cyclicSpoof });
  });

  it("keeps final 401 safe and maps auth callback failures to EAUTH", async () => {
    let attempts = 0;
    const final401: GitHttpClient = async () => {
      attempts++;
      return response(new Uint8Array(0), 401, "text/plain");
    };
    await expect(
      receivePack(baseRequest([command()]), {
        http: final401,
        onAuth: () => ({ username: "still-wrong" }),
      }),
    ).rejects.toMatchObject({ code: "EHTTP", status: 401 });
    expect(attempts).toBe(2);

    const callbackFailure = new Error("credential store failed");
    const coordinator = new MemoryCoordinator();
    const reservation = coordinator.reserve();
    const budget = new TransportOperationBudget(reservation);
    try {
      await expect(
        receivePack(baseRequest([command()]), {
          http: async () => response(new Uint8Array(0), 401, "text/plain"),
          onAuth: () => {
            throw callbackFailure;
          },
          operationBudget: budget,
        }),
      ).rejects.toMatchObject({ code: "EAUTH", cause: callbackFailure });
      expect(budget.retainedBytes).toBe(0);
    } finally {
      reservation.dispose();
    }
    coordinator.assertIdle();

    const readFailure = new Error("401 body read failed");
    await expect(
      receivePack(baseRequest([command()]), {
        http: async () => ({
          ...response(new Uint8Array(0), 401, "text/plain"),
          body: brokenBody(new Uint8Array(0), readFailure),
        }),
      }),
    ).rejects.toMatchObject({ code: "EHTTP", cause: readFailure });
  });

  it("preserves safe local pack failures without transport retry", async () => {
    let attempts = 0;
    const http: GitHttpClient = async (request) => {
      attempts++;
      await collectBody(request.body);
      return response(report([command()]));
    };
    const limit = Object.assign(new Error("too many objects"), { code: "E2BIG" });
    await expect(
      receivePack(
        baseRequest([command()], {
          pack: () => brokenBody(utf8.encode("PACK"), limit),
        }),
        { http },
      ),
    ).rejects.toBe(limit);
    expect(attempts).toBe(1);
  });

  it("wraps non-200, response-read, fatal and callback failures as uncertain", async () => {
    const fatal = concat([
      pkt(concat([new Uint8Array([3]), utf8.encode("remote fatal\n")])),
      FLUSH,
    ]);
    const callback = new Error("progress callback failed");
    const errorReadFailure = new Error("error body read failed");
    const cases: Array<{ http: GitHttpClient; request?: ReceivePackRequest; cause?: unknown }> = [
      { http: async () => response(utf8.encode("failure"), 500, "text/plain") },
      { http: async () => response(utf8.encode("not a report"), 200, "text/plain") },
      {
        http: async () => ({
          ...response(new Uint8Array(0), 500, "text/plain"),
          body: brokenBody(new Uint8Array(0), errorReadFailure),
        }),
        cause: errorReadFailure,
      },
      {
        http: async () => ({
          ...response(new Uint8Array(0)),
          body: brokenBody(pkt("unpack ok\n"), new Error("read failed")),
        }),
      },
      {
        http: async () => response(fatal),
        request: baseRequest([command()], {
          advertised: new Set(["report-status", "side-band-64k"]),
        }),
      },
      {
        http: async () =>
          response(concat([pkt(concat([new Uint8Array([2]), utf8.encode("progress\n")])), FLUSH])),
        request: baseRequest([command()], {
          advertised: new Set(["report-status", "side-band-64k"]),
          onProgress: () => {
            throw callback;
          },
        }),
        cause: callback,
      },
    ];
    for (const entry of cases) {
      const coordinator = new MemoryCoordinator();
      const reservation = coordinator.reserve();
      const budget = new TransportOperationBudget(reservation);
      try {
        await expect(
          receivePack(entry.request ?? baseRequest([command()]), {
            http: entry.http,
            operationBudget: budget,
          }),
        ).rejects.toMatchObject({
          code: "EPUSHUNCERTAIN",
          ...(entry.cause === undefined ? {} : { cause: entry.cause }),
        });
        expect(budget.retainedBytes).toBe(0);
      } finally {
        reservation.dispose();
      }
      coordinator.assertIdle();
    }
  });

  it("charges error-response retention to the root and preserves certainty at the cap", async () => {
    const observedCoordinator = new MemoryCoordinator();
    const observedReservation = observedCoordinator.reserve();
    const observedBudget = new TransportOperationBudget(observedReservation);
    let observedErrorBytes = 0;
    try {
      await expect(
        receivePack(baseRequest([command()]), {
          http: async () => ({
            status: 500,
            statusText: "Failure",
            headers: { "content-type": "text/plain" },
            body: (async function* (): AsyncGenerator<Uint8Array> {
              observedErrorBytes = observedBudget.memory("receive-pack-error-response");
              yield utf8.encode("bounded failure");
            })(),
          }),
          operationBudget: observedBudget,
        }),
      ).rejects.toMatchObject({ code: "EPUSHUNCERTAIN" });
      expect(observedErrorBytes).toBeGreaterThan(800);
      expect(observedBudget.memory("receive-pack-error-response")).toBe(0);
      expect(observedBudget.retainedBytes).toBe(0);
    } finally {
      observedReservation.dispose();
    }
    observedCoordinator.assertIdle();

    for (const status of [500, 401]) {
      const coordinator = new MemoryCoordinator();
      const blocker = coordinator.reserve();
      const reservation = coordinator.reserve();
      const budget = new TransportOperationBudget(reservation);
      try {
        await expect(
          receivePack(baseRequest([command()]), {
            http: async () => {
              blocker.set("other", MAX_OPERATION_MEMORY_BYTES - coordinator.totalBytes);
              return response(utf8.encode("bounded failure"), status, "text/plain");
            },
            operationBudget: budget,
          }),
        ).rejects.toMatchObject({
          code: status === 401 ? "EHTTP" : "EPUSHUNCERTAIN",
          cause: { code: "E2BIG" },
        });
        expect(budget.memory("receive-pack-error-response")).toBe(0);
        expect(budget.retainedBytes).toBe(0);
        expect(reservation.currentBytes).toBe(0);
      } finally {
        reservation.dispose();
        blocker.dispose();
      }
      coordinator.assertIdle();
    }
  });
});

describe("receive-pack status validation and bounds", () => {
  const first = command(1);
  const second = command(2);
  const commands = [first, second];

  it("returns mixed non-atomic rejection and rejects impossible atomic mixed status", async () => {
    const statuses = new Map([[second.ref, "hook rejected"]]);
    const body = report([...commands].reverse(), statuses);
    await expect(
      receivePack(baseRequest(commands), { http: async () => response(body) }),
    ).resolves.toEqual({
      unpack: "ok",
      refs: new Map([
        [first.ref, { ok: true }],
        [second.ref, { ok: false, error: "hook rejected" }],
      ]),
    });
    const coordinator = new MemoryCoordinator();
    const reservation = coordinator.reserve();
    const budget = new TransportOperationBudget(reservation);
    try {
      await expect(
        receivePack(
          baseRequest(commands, {
            advertised: new Set(["report-status", "atomic"]),
            atomic: true,
          }),
          { http: async () => response(body), operationBudget: budget },
        ),
      ).rejects.toMatchObject({ code: "EPUSHUNCERTAIN", cause: { code: "ECORRUPT" } });
      expect(budget.retainedBytes).toBe(0);
    } finally {
      reservation.dispose();
    }
    coordinator.assertIdle();
  });

  it("returns complete atomic all-ng and complete unpack rejection", async () => {
    const allNg = new Map([
      [first.ref, "atomic push failed"],
      [second.ref, "atomic push failed"],
    ]);
    await expect(
      receivePack(
        baseRequest(commands, {
          advertised: new Set(["report-status", "atomic"]),
          atomic: true,
        }),
        { http: async () => response(report(commands, allNg)) },
      ),
    ).resolves.toMatchObject({ unpack: "ok" });
    await expect(
      receivePack(baseRequest(commands), {
        http: async () => response(report(commands, allNg, "error bad pack")),
      }),
    ).resolves.toMatchObject({ unpack: "error bad pack" });

    await expect(
      receivePack(baseRequest(commands), {
        http: async () => response(report(commands, new Map(), "error bad pack")),
      }),
    ).rejects.toMatchObject({ code: "EPUSHUNCERTAIN", cause: { code: "ECORRUPT" } });
  });

  it("rejects duplicate, missing, extra, malformed and truncated reports as uncertain", async () => {
    const bodies = [
      concat([pkt("unpack ok\n"), pkt(`ok ${first.ref}\n`), pkt(`ok ${first.ref}\n`), FLUSH]),
      concat([pkt("unpack ok\n"), pkt(`ok ${first.ref}\n`), FLUSH]),
      concat([
        pkt("unpack ok\n"),
        pkt(`ok ${first.ref}\n`),
        pkt(`ok ${second.ref}\n`),
        pkt("ok refs/heads/extra\n"),
        FLUSH,
      ]),
      concat([pkt("unpack ok\n"), pkt(`ng ${first.ref}\n`), FLUSH]),
      concat([pkt(`ok ${first.ref}\n`), pkt("unpack ok\n"), pkt(`ok ${second.ref}\n`), FLUSH]),
      concat([pkt("unpack ok\n"), pkt(`ok ${first.ref}\n`), pkt(`ok ${second.ref}\n`)]),
      concat([report(commands), pkt("ok refs/heads/trailing\n")]),
    ];
    for (const body of bodies) {
      const coordinator = new MemoryCoordinator();
      const reservation = coordinator.reserve();
      const budget = new TransportOperationBudget(reservation);
      try {
        await expect(
          receivePack(baseRequest(commands), {
            http: async () => response(body),
            operationBudget: budget,
          }),
        ).rejects.toMatchObject({ code: "EPUSHUNCERTAIN" });
        expect(budget.retainedBytes).toBe(0);
      } finally {
        reservation.dispose();
      }
      coordinator.assertIdle();
    }
  });

  it("preserves caller-lowered status packet, input and result bounds", async () => {
    const body = report([first]);
    await expect(
      receivePack(baseRequest([first]), {
        http: async () => response(body),
        protocolLimits: { entries: 2, inputBytes: body.length - FLUSH.length, retainedBytes: 426 },
      }),
    ).resolves.toMatchObject({ unpack: "ok" });

    const limits = [
      { entries: 1 },
      { inputBytes: body.length - FLUSH.length - 1 },
      { retainedBytes: 425 },
    ];
    for (const protocolLimits of limits) {
      await expect(
        receivePack(baseRequest([first]), {
          http: async () => response(body),
          protocolLimits,
        }),
      ).rejects.toMatchObject({ code: "EPUSHUNCERTAIN", cause: { code: "E2BIG" } });
    }
  });

  it("enforces the sideband packet bound and preserves the nested report", async () => {
    const inner = report([first]);
    const progress = pkt(concat([new Uint8Array([2]), utf8.encode("p")]));
    const status = pkt(concat([new Uint8Array([1]), inner]));
    const exact = concat([...Array.from({ length: 16_383 }, () => progress), status, FLUSH]);
    await expect(
      receivePack(
        baseRequest([first], { advertised: new Set(["report-status", "side-band-64k"]) }),
        { http: async () => response(exact) },
      ),
    ).resolves.toMatchObject({ unpack: "ok" });

    const excess = concat([progress, exact]);
    await expect(
      receivePack(
        baseRequest([first], { advertised: new Set(["report-status", "side-band-64k"]) }),
        { http: async () => response(excess) },
      ),
    ).rejects.toMatchObject({ code: "EPUSHUNCERTAIN", cause: { code: "E2BIG" } });
  });

  it("streams beyond the former input cap and retains the result under the shared owner", async () => {
    const many = Array.from({ length: 300 }, (_, index) => command(index));
    const reason = "x".repeat(56_000);
    const statuses = new Map(many.map((item) => [item.ref, reason]));
    const body = report(many, statuses);
    expect(body.length).toBeGreaterThan(16 * 1024 * 1024);
    const coordinator = new MemoryCoordinator();
    const reservation = coordinator.reserve();
    const budget = new TransportOperationBudget(reservation);
    try {
      await expect(
        receivePack(baseRequest(many), {
          http: async () => response(body),
          operationBudget: budget,
        }),
      ).resolves.toMatchObject({ unpack: "ok" });
      expect(budget.memory("receive-pack-result")).toBeGreaterThan(8 * 1024 * 1024);
      expect(coordinator.highWaterBytes).toBeLessThanOrEqual(MAX_OPERATION_MEMORY_BYTES);
    } finally {
      reservation.dispose();
    }
    coordinator.assertIdle();
  });

  it("charges retained statuses to the caller-owned operation budget", async () => {
    const coordinator = new MemoryCoordinator();
    const reservation = coordinator.reserve();
    const budget = new TransportOperationBudget(reservation);
    try {
      await receivePack(baseRequest([first]), {
        http: async () => response(report([first])),
        operationBudget: budget,
      });
      expect(budget.memory("receive-pack-request")).toBe(0);
      expect(budget.memory("receive-pack-result")).toBe(340);
    } finally {
      reservation.dispose();
    }
    coordinator.assertIdle();
  });

  it("does not charge a caller-owned command ref as a new result string", async () => {
    const long = { ...first, ref: `refs/heads/${"r".repeat(32 * 1024)}` };
    const coordinator = new MemoryCoordinator();
    const reservation = coordinator.reserve();
    const budget = new TransportOperationBudget(reservation);
    try {
      const result = await receivePack(baseRequest([long]), {
        http: async () => response(report([long])),
        operationBudget: budget,
      });
      expect(result.refs.get(long.ref)).toEqual({ ok: true });
      expect(budget.memory("receive-pack-result")).toBe(340);
    } finally {
      reservation.dispose();
    }
    coordinator.assertIdle();
  });

  it("admits the exact shared aggregate and rejects its first memory excess", async () => {
    const calibrated = new MemoryCoordinator();
    const calibrationReservation = calibrated.reserve();
    const calibrationBudget = new TransportOperationBudget(calibrationReservation);
    await receivePack(baseRequest([first]), {
      http: async () => response(report([first])),
      operationBudget: calibrationBudget,
    });
    const required = calibrated.highWaterBytes;
    calibrationReservation.dispose();
    calibrated.assertIdle();

    for (const excess of [0, 1]) {
      const coordinator = new MemoryCoordinator();
      const blocker = coordinator.reserve();
      const reservation = coordinator.reserve();
      const budget = new TransportOperationBudget(reservation);
      blocker.set("other", MAX_OPERATION_MEMORY_BYTES - required + excess);
      try {
        const operation = receivePack(baseRequest([first]), {
          http: async () => response(report([first])),
          operationBudget: budget,
        });
        if (excess === 0) {
          await expect(operation).resolves.toMatchObject({ unpack: "ok" });
          expect(coordinator.highWaterBytes).toBe(MAX_OPERATION_MEMORY_BYTES);
        } else {
          await expect(operation).rejects.toMatchObject({ code: "EPUSHUNCERTAIN" });
          expect(budget.retainedBytes).toBe(0);
        }
      } finally {
        reservation.dispose();
        blocker.dispose();
      }
      coordinator.assertIdle();
    }
  });

  it("shares the aggregate operation reservation and fails before POST", async () => {
    const coordinator = new MemoryCoordinator();
    const blocker = coordinator.reserve();
    const reservation = coordinator.reserve();
    const budget = new TransportOperationBudget(reservation);
    let posts = 0;
    blocker.set("other", MAX_OPERATION_MEMORY_BYTES);
    try {
      await expect(
        receivePack(baseRequest([first]), {
          http: async () => {
            posts++;
            return response(report([first]));
          },
          operationBudget: budget,
        }),
      ).rejects.toMatchObject({ code: "E2BIG" });
      expect(posts).toBe(0);
    } finally {
      reservation.dispose();
      blocker.dispose();
    }
    coordinator.assertIdle();
  });
});
