import { describe, expect, it } from "vitest";

import { concat, utf8 } from "../src/core/bytes.js";
import { FLUSH, pkt, pktLines } from "../src/core/protocol/pktline.js";
import { receivePack } from "../src/core/protocol/receive-pack.js";
import {
  discover,
  MAX_PROTOCOL_RETAINED_BYTES,
  normalizeRemoteUrl,
  uploadPack,
} from "../src/core/protocol/remote.js";
import {
  ByteReader,
  MAX_PKT_FRAME_BYTES,
  MAX_PROTOCOL_SOURCE_CHUNK_BYTES,
  pktText,
} from "../src/core/protocol/stream.js";
import type { GitHttpClient, GitHttpResponse } from "../src/core/protocol/transport.js";
import { GitFixture } from "./helpers/git.js";
import { startGitServer } from "./helpers/http-backend.js";

async function* once(...chunks: Uint8Array[]): AsyncGenerator<Uint8Array> {
  for (const chunk of chunks) yield chunk;
}

function respond(body: Uint8Array, contentType: string, chunk = 7): GitHttpResponse {
  const pieces: Uint8Array[] = [];
  for (let offset = 0; offset < body.length; offset += chunk) {
    pieces.push(body.subarray(offset, offset + chunk));
  }
  return {
    status: 200,
    statusText: "OK",
    headers: { "content-type": contentType },
    body: once(...pieces),
  };
}

/** A transport that answers every request with one canned response. */
function canned(response: () => GitHttpResponse): GitHttpClient {
  return () => Promise.resolve(response());
}

async function collect(pack: AsyncIterable<Uint8Array>): Promise<Uint8Array> {
  const chunks: Uint8Array[] = [];
  for await (const chunk of pack) chunks.push(chunk);
  return concat(chunks);
}

async function collectBody(
  body: Uint8Array | AsyncIterable<Uint8Array> | undefined,
): Promise<Uint8Array> {
  if (body === undefined) return new Uint8Array(0);
  return body instanceof Uint8Array ? body : collect(body);
}

function bufferedBody(body: Uint8Array | AsyncIterable<Uint8Array> | undefined): Uint8Array {
  if (body === undefined) return new Uint8Array(0);
  if (!(body instanceof Uint8Array)) throw new Error("expected a buffered request body");
  return body;
}

const OID = "1".repeat(40);

describe("pkt-lines", () => {
  it("frames payloads the way git does", () => {
    expect(new TextDecoder().decode(pkt("done\n"))).toBe("0009done\n");
    expect(new TextDecoder().decode(pkt(""))).toBe("0004");
    expect(() => pkt(new Uint8Array(65517))).toThrow(/too long/);
  });

  it("reads lines, flushes and delimiters across chunk boundaries", async () => {
    const reader = new ByteReader(
      once(
        ...[...concat([pktLines("a\n", "b\n"), FLUSH, pkt("c\n")])].map((b) => new Uint8Array([b])),
      ),
    );
    expect(pktText((await reader.readPkt())!)).toBe("a");
    expect(pktText((await reader.readPkt())!)).toBe("b");
    expect((await reader.readPkt())?.kind).toBe("flush");
    expect(pktText((await reader.readPkt())!)).toBe("c");
    expect(await reader.readPkt()).toBeNull();
  });

  it("refuses a length that is not four hex digits", async () => {
    const reader = new ByteReader(once(utf8.encode("00zz")));
    await expect(reader.readPkt()).rejects.toMatchObject({ code: "ECORRUPT" });
  });

  it("refuses a frame the stream never finishes", async () => {
    const reader = new ByteReader(once(utf8.encode("0020short")));
    await expect(reader.readPkt()).rejects.toMatchObject({ code: "ECORRUPT" });
  });

  it("hands the unconsumed tail to rest()", async () => {
    const reader = new ByteReader(once(concat([pkt("a\n"), utf8.encode("PACKrest")])));
    expect(pktText((await reader.readPkt())!)).toBe("a");
    expect(new TextDecoder().decode(await collect(reader.rest()))).toBe("PACKrest");
  });

  it("rejects an oversized caller chunk before buffering it", async () => {
    const reader = new ByteReader(once(new Uint8Array(MAX_PROTOCOL_SOURCE_CHUNK_BYTES + 1)));
    await expect(reader.readPkt()).rejects.toMatchObject({ code: "E2BIG" });
  });

  it("accepts the maximum frame and rejects the next byte", async () => {
    const payload = new Uint8Array(MAX_PKT_FRAME_BYTES - 4);
    const accepted = new ByteReader(once(pkt(payload)));
    expect((await accepted.readPkt())?.payload).toHaveLength(payload.length);

    const over = utf8.encode((MAX_PKT_FRAME_BYTES + 1).toString(16).padStart(4, "0"));
    const rejected = new ByteReader(once(over));
    await expect(rejected.readPkt()).rejects.toMatchObject({ code: "ECORRUPT" });
  });

  it("copies only a split frame and streams the accepted source tail", async () => {
    const prefix = utf8.encode("000");
    const source = new Uint8Array(MAX_PROTOCOL_SOURCE_CHUNK_BYTES);
    source.set(utf8.encode("6a\nPACK"));
    const reader = new ByteReader(once(prefix, source));

    expect(pktText((await reader.readPkt())!)).toBe("a");
    const tail = await reader.rest().next();
    expect(tail.done).toBe(false);
    if (tail.done === true) throw new Error("protocol tail was not returned");
    expect(tail.value.buffer).toBe(source.buffer);
    expect(new TextDecoder().decode(tail.value.subarray(0, 4))).toBe("PACK");
  });
});

describe("receive-pack", () => {
  const ref = "refs/heads/main";
  const oldOid = "2".repeat(40);
  const newOid = "3".repeat(40);
  const ok = concat([pkt("unpack ok\n"), pkt(`ok ${ref}\n`), FLUSH]);

  it("replays an identical streamed command and pack after a 401", async () => {
    const requests: Uint8Array[] = [];
    const http: GitHttpClient = async (request) => {
      requests.push(await collectBody(request.body));
      if (requests.length === 1) {
        return {
          status: 401,
          statusText: "Unauthorized",
          headers: { "content-type": "text/plain" },
          body: once(utf8.encode("auth required")),
        };
      }
      return respond(ok, "application/x-git-receive-pack-result");
    };
    let opens = 0;
    const result = await receivePack(
      {
        url: "http://host/repo",
        commands: [{ oldOid, newOid, ref }],
        advertised: new Set(["report-status"]),
        pack: () => {
          opens++;
          return once(utf8.encode("PACKbody"));
        },
      },
      { http, onAuth: () => ({ username: "token" }) },
    );

    expect(result).toEqual({ unpack: "ok", refs: new Map([[ref, { ok: true }]]) });
    expect(opens).toBe(2);
    expect(requests).toHaveLength(2);
    expect(requests[1]).toEqual(requests[0]);
    expect(new TextDecoder().decode(requests[0])).toContain(` ${ref}\0report-status\n`);
  });

  it("returns a bounded per-ref rejection report", async () => {
    const rejected = concat([pkt("unpack ok\n"), pkt(`ng ${ref} non-fast-forward\n`), FLUSH]);
    await expect(
      receivePack(
        {
          url: "http://host/repo",
          commands: [{ oldOid, newOid, ref }],
          advertised: new Set(["report-status"]),
        },
        { http: canned(() => respond(rejected, "application/x-git-receive-pack-result")) },
      ),
    ).resolves.toEqual({
      unpack: "ok",
      refs: new Map([[ref, { ok: false, error: "non-fast-forward" }]]),
    });
  });

  it("rejects missing report-status support and malformed status", async () => {
    await expect(
      receivePack(
        { url: "http://host/repo", commands: [{ oldOid, newOid, ref }], advertised: new Set() },
        { http: canned(() => respond(ok, "application/x-git-receive-pack-result")) },
      ),
    ).rejects.toMatchObject({ code: "EUNSUPPORTED" });

    const duplicate = concat([pkt("unpack ok\n"), pkt(`ok ${ref}\n`), pkt(`ok ${ref}\n`), FLUSH]);
    await expect(
      receivePack(
        {
          url: "http://host/repo",
          commands: [{ oldOid, newOid, ref }],
          advertised: new Set(["report-status"]),
        },
        { http: canned(() => respond(duplicate, "application/x-git-receive-pack-result")) },
      ),
    ).rejects.toMatchObject({ code: "EPUSHUNCERTAIN", cause: { code: "ECORRUPT" } });
  });
});

describe("remote urls", () => {
  it("keeps http(s) and drops trailing slashes", () => {
    expect(normalizeRemoteUrl("https://example.com/x.git/")).toBe("https://example.com/x.git");
    expect(normalizeRemoteUrl("http://example.com/x")).toBe("http://example.com/x");
  });

  it("rejects transports it cannot speak", () => {
    expect(() => normalizeRemoteUrl("git@example.com:x.git")).toThrow(/unsupported URL scheme/);
    expect(() => normalizeRemoteUrl("ssh://example.com/x")).toThrow(/unsupported URL scheme/);
  });
});

describe("discovery", () => {
  const advertisementBody = (lines: readonly string[]): Uint8Array =>
    concat([
      pkt("# service=git-upload-pack\n"),
      FLUSH,
      ...lines.map((line) => pkt(`${line}\n`)),
      FLUSH,
    ]);

  it("reads refs, capabilities and the HEAD symref", async () => {
    const body = concat([
      pkt("# service=git-upload-pack\n"),
      FLUSH,
      pkt(
        `${OID} refs/heads/main\0side-band-64k ofs-delta symref=HEAD:refs/heads/main agent=git/2\n`,
      ),
      pkt(`${"2".repeat(40)} refs/tags/v1\n`),
      FLUSH,
    ]);
    const advertisement = await discover("http://host/repo", "git-upload-pack", {
      http: canned(() => respond(body, "application/x-git-upload-pack-advertisement")),
    });
    expect(advertisement.refs).toEqual([
      { name: "refs/heads/main", oid: OID },
      { name: "refs/tags/v1", oid: "2".repeat(40) },
    ]);
    expect(advertisement.headRef).toBe("refs/heads/main");
    expect(advertisement.capabilities.has("side-band-64k")).toBe(true);
    expect(advertisement.capabilities.has("ofs-delta")).toBe(true);
  });

  it("retries one failed idempotent discovery request", async () => {
    const body = advertisementBody([`${OID} refs/heads/main`]);
    let calls = 0;
    const advertisement = await discover("http://host/repo", "git-upload-pack", {
      http: () => {
        calls++;
        if (calls === 1) return Promise.reject(new Error("stale keep-alive connection"));
        return Promise.resolve(respond(body, "application/x-git-upload-pack-advertisement"));
      },
    });
    expect(calls).toBe(2);
    expect(advertisement.refs).toEqual([{ name: "refs/heads/main", oid: OID }]);
  });

  it("treats an empty repository as zero refs", async () => {
    const body = concat([
      pkt("# service=git-upload-pack\n"),
      FLUSH,
      pkt(`${"0".repeat(40)} capabilities^{}\0side-band-64k\n`),
      FLUSH,
    ]);
    const advertisement = await discover("http://host/repo", "git-upload-pack", {
      http: canned(() => respond(body, "application/x-git-upload-pack-advertisement")),
    });
    expect(advertisement.refs).toEqual([]);
    expect(advertisement.capabilities.has("side-band-64k")).toBe(true);
  });

  it("names the content-type when the remote is not smart HTTP", async () => {
    await expect(
      discover("http://host/repo", "git-upload-pack", {
        http: canned(() => respond(utf8.encode(`${OID}\trefs/heads/main\n`), "text/plain")),
      }),
    ).rejects.toMatchObject({ code: "ECORRUPT", message: /content-type: text\/plain/ });
  });

  it("surfaces a server-side ERR", async () => {
    const body = concat([
      pkt("# service=git-upload-pack\n"),
      FLUSH,
      pkt("ERR access denied\n"),
      FLUSH,
    ]);
    await expect(
      discover("http://host/repo", "git-upload-pack", {
        http: canned(() => respond(body, "application/x-git-upload-pack-advertisement")),
      }),
    ).rejects.toMatchObject({ code: "EFETCHFAIL", message: "access denied" });

    const receiveBody = concat([
      pkt("# service=git-receive-pack\n"),
      FLUSH,
      pkt("ERR hooks unavailable\n"),
      FLUSH,
    ]);
    await expect(
      discover("http://host/repo", "git-receive-pack", {
        http: canned(() => respond(receiveBody, "application/x-git-receive-pack-advertisement")),
      }),
    ).rejects.toMatchObject({ code: "EPUSHREJECTED", message: "hooks unavailable" });
  });

  it("rejects an advertisement truncated before its terminating flush", async () => {
    const body = concat([
      pkt("# service=git-upload-pack\n"),
      FLUSH,
      pkt(`${OID} refs/heads/main\n`),
    ]);
    await expect(
      discover("http://host/repo", "git-upload-pack", {
        http: canned(() => respond(body, "application/x-git-upload-pack-advertisement")),
      }),
    ).rejects.toMatchObject({ code: "ECORRUPT" });
  });

  it("drains a large HTTP error while retaining only its prefix", async () => {
    let yielded = 0;
    const chunk = new Uint8Array(1024 * 1024).fill(0x61);
    const body = async function* (): AsyncGenerator<Uint8Array> {
      for (let index = 0; index < 17; index++) {
        yielded++;
        yield chunk;
      }
    };

    let error: unknown;
    try {
      await discover("http://host/repo", "git-upload-pack", {
        http: () =>
          Promise.resolve({ status: 503, statusText: "Unavailable", headers: {}, body: body() }),
      });
    } catch (caught) {
      error = caught;
    }
    expect(error).toMatchObject({ code: "EHTTP", status: 503 });
    if (!(error instanceof Error)) throw new Error("expected HTTP error");
    expect(error.message.length).toBeLessThan(300);
    expect(yielded).toBe(17);
  });

  it("admits the exact retained boundary and rejects one byte less", async () => {
    const name = "refs/heads/main";
    const body = advertisementBody([`${OID} ${name}`]);
    // Result 256 + ref 96 + two strings (48 + UTF-16 bytes each).
    const retained = 256 + 96 + (48 + OID.length * 2) + (48 + name.length * 2);
    const response = () => respond(body, "application/x-git-upload-pack-advertisement");

    await expect(
      discover("http://host/repo", "git-upload-pack", {
        http: canned(response),
        protocolLimits: { retainedBytes: retained },
      }),
    ).resolves.toMatchObject({ refs: [{ name, oid: OID }] });
    await expect(
      discover("http://host/repo", "git-upload-pack", {
        http: canned(response),
        protocolLimits: { retainedBytes: retained - 1 },
      }),
    ).rejects.toMatchObject({ code: "E2BIG" });
  });

  it("rejects duplicate advertisement rows before retaining another entry", async () => {
    const line = `${OID} refs/heads/repeated`;
    const response = canned(() =>
      respond(advertisementBody([line, line]), "application/x-git-upload-pack-advertisement"),
    );
    await expect(
      discover("http://host/repo", "git-upload-pack", {
        http: response,
      }),
    ).rejects.toMatchObject({ code: "ECORRUPT" });
  });

  it("charges duplicate capabilities and the HEAD symref before retention", async () => {
    const symref = "symref=HEAD:refs/heads/main";
    const headRef = "refs/heads/main";
    const line = `${OID} refs/heads/main\0thin-pack thin-pack ${symref}`;
    const response = () =>
      respond(advertisementBody([line]), "application/x-git-upload-pack-advertisement");
    const stringBytes = (value: string): number => 48 + value.length * 2;
    const retained =
      256 +
      64 +
      stringBytes("thin-pack") +
      64 +
      stringBytes(symref) +
      16 +
      stringBytes(headRef) +
      96 +
      stringBytes(OID) +
      stringBytes(headRef);

    await expect(
      discover("http://host/repo", "git-upload-pack", {
        http: canned(response),
        protocolLimits: { entries: 4, retainedBytes: retained },
      }),
    ).resolves.toMatchObject({
      capabilities: new Set(["thin-pack", symref]),
      headRef,
      refs: [{ name: headRef, oid: OID }],
    });
    await expect(
      discover("http://host/repo", "git-upload-pack", {
        http: canned(response),
        protocolLimits: { entries: 3 },
      }),
    ).rejects.toMatchObject({ code: "E2BIG" });
    await expect(
      discover("http://host/repo", "git-upload-pack", {
        http: canned(response),
        protocolLimits: { retainedBytes: retained - 1 },
      }),
    ).rejects.toMatchObject({ code: "E2BIG" });
  });

  it("accepts identical HEAD symrefs once and rejects conflicts or malformed targets", async () => {
    const headRef = "refs/heads/main";
    const identical = advertisementBody([
      `${OID} HEAD\0symref=HEAD:${headRef} symref=HEAD:${headRef}`,
      `${OID} ${headRef}`,
    ]);
    await expect(
      discover("http://host/repo", "git-upload-pack", {
        http: canned(() => respond(identical, "application/x-git-upload-pack-advertisement")),
      }),
    ).resolves.toMatchObject({ headRef });

    const badCapabilities = [
      `symref=HEAD:${headRef} symref=HEAD:refs/heads/other`,
      "symref=HEAD:main",
      "symref=HEAD",
      "symref=HEAD:refs/heads/.hidden",
    ];
    for (const capabilities of badCapabilities) {
      const body = advertisementBody([`${OID} HEAD\0${capabilities}`]);
      await expect(
        discover("http://host/repo", "git-upload-pack", {
          http: canned(() => respond(body, "application/x-git-upload-pack-advertisement")),
        }),
      ).rejects.toMatchObject({ code: "ECORRUPT" });
    }
  });

  it("requires advertised HEAD and its present symref target to have the same oid", async () => {
    const headRef = "refs/heads/main";
    const absentTarget = advertisementBody([`${OID} HEAD\0symref=HEAD:${headRef}`]);
    await expect(
      discover("http://host/repo", "git-upload-pack", {
        http: canned(() => respond(absentTarget, "application/x-git-upload-pack-advertisement")),
      }),
    ).resolves.toMatchObject({ headRef, refs: [{ name: "HEAD", oid: OID }] });

    const mismatched = advertisementBody([
      `${OID} HEAD\0symref=HEAD:${headRef}`,
      `${"2".repeat(40)} ${headRef}`,
    ]);
    await expect(
      discover("http://host/repo", "git-upload-pack", {
        http: canned(() => respond(mismatched, "application/x-git-upload-pack-advertisement")),
      }),
    ).rejects.toMatchObject({ code: "ECORRUPT" });
  });

  it("accepts only HEAD, canonical refs, and peeled tag pseudo-rows", async () => {
    const accepted = advertisementBody([
      `${OID} HEAD`,
      `${"2".repeat(40)} refs/heads/main`,
      `${"3".repeat(40)} refs/tags/v1`,
      `${"4".repeat(40)} refs/tags/v1^{}`,
    ]);
    await expect(
      discover("http://host/repo", "git-upload-pack", {
        http: canned(() => respond(accepted, "application/x-git-upload-pack-advertisement")),
      }),
    ).resolves.toMatchObject({
      refs: [
        { name: "HEAD", oid: OID },
        { name: "refs/heads/main", oid: "2".repeat(40) },
        { name: "refs/tags/v1", oid: "3".repeat(40) },
        { name: "refs/tags/v1^{}", oid: "4".repeat(40) },
      ],
    });

    const malformed = [
      `${"A".repeat(40)} refs/heads/main`,
      `${OID.slice(1)} refs/heads/main`,
      `${OID} main`,
      `${OID} refs/heads/main^{}`,
      `${OID} refs/heads/.hidden`,
      `${OID} refs/heads/main extra`,
      `${OID}refs/heads/main`,
    ];
    for (const row of malformed) {
      const body = advertisementBody([row]);
      await expect(
        discover("http://host/repo", "git-upload-pack", {
          http: canned(() => respond(body, "application/x-git-upload-pack-advertisement")),
        }),
      ).rejects.toMatchObject({ code: "ECORRUPT" });
    }
  });

  it("bounds pkt-line text and cumulative negotiation input", async () => {
    const body = advertisementBody([`${OID} refs/heads/main`]);
    const response = () => respond(body, "application/x-git-upload-pack-advertisement");
    const refPayloadBytes = pkt(`${OID} refs/heads/main\n`).length - 4;

    await expect(
      discover("http://host/repo", "git-upload-pack", {
        http: canned(response),
        protocolLimits: { lineBytes: refPayloadBytes },
      }),
    ).resolves.toMatchObject({ refs: [{}] });
    await expect(
      discover("http://host/repo", "git-upload-pack", {
        http: canned(response),
        protocolLimits: { lineBytes: refPayloadBytes - 1 },
      }),
    ).rejects.toMatchObject({ code: "E2BIG" });
    await expect(
      discover("http://host/repo", "git-upload-pack", {
        http: canned(response),
        protocolLimits: { inputBytes: body.length },
      }),
    ).resolves.toMatchObject({ refs: [{}] });
    await expect(
      discover("http://host/repo", "git-upload-pack", {
        http: canned(response),
        protocolLimits: { inputBytes: body.length - 1 },
      }),
    ).rejects.toMatchObject({ code: "E2BIG" });
  });

  it("keeps a production-sized advertisement under the time cap", async () => {
    const measure = async (count: number): Promise<number> => {
      const lines = Array.from(
        { length: count },
        (_, index) => `${OID} refs/heads/r${index.toString().padStart(5, "0")}`,
      );
      const body = advertisementBody(lines);
      const before = performance.now();
      const result = await discover("http://host/repo", "git-upload-pack", {
        http: canned(() =>
          respond(
            body,
            "application/x-git-upload-pack-advertisement",
            Math.min(body.length, MAX_PROTOCOL_SOURCE_CHUNK_BYTES),
          ),
        ),
      });
      expect(result.refs).toHaveLength(count);
      return performance.now() - before;
    };

    expect(MAX_PROTOCOL_RETAINED_BYTES).toBe(4 * 1024 * 1024);
    await measure(10_000);
    const samples: number[] = [];
    for (let sample = 0; sample < 5; sample++) {
      samples.push(await measure(10_000));
    }
    expect(Math.max(...samples)).toBeLessThan(100);
  });

  it("agrees with the refs a real git server advertises", async () => {
    const fixture = new GitFixture();
    fixture.init();
    fixture.write("a.txt", "a\n");
    const head = fixture.commit("first");
    fixture.git("branch", "topic");
    fixture.git("tag", "v1");
    const expected = fixture
      .git("show-ref", "--head")
      .split("\n")
      .map((line) => {
        const [oid, name] = line.split(" ");
        return { name: name ?? "", oid: oid ?? "" };
      })
      .sort((a, b) => a.name.localeCompare(b.name));

    const server = await startGitServer(fixture.dir);
    try {
      const advertisement = await discover(server.url, "git-upload-pack");
      expect(advertisement.refs.slice().sort((a, b) => a.name.localeCompare(b.name))).toEqual(
        expected,
      );
      expect(advertisement.headRef).toBe("refs/heads/main");
      expect(advertisement.capabilities.has("side-band-64k")).toBe(true);
      expect(advertisement.refs.find((ref) => ref.name === "refs/heads/main")?.oid).toBe(head);
    } finally {
      await server.close();
      fixture.dispose();
    }
  });
});

describe("upload-pack", () => {
  const PACK = utf8.encode("PACK-not-really-but-opaque-to-the-client");

  it("demuxes side-band frames and reports progress", async () => {
    const progress: string[] = [];
    const body = concat([
      pkt(`shallow ${OID}\n`),
      FLUSH,
      pkt("NAK\n"),
      pkt(concat([new Uint8Array([2]), utf8.encode("counting objects\n")])),
      pkt(concat([new Uint8Array([1]), PACK.subarray(0, 10)])),
      pkt(concat([new Uint8Array([1]), PACK.subarray(10)])),
      FLUSH,
    ]);
    const result = await uploadPack(
      {
        url: "http://host/repo",
        wants: [OID],
        advertised: new Set(["side-band-64k", "ofs-delta"]),
        onProgress: (message) => progress.push(message),
      },
      { http: canned(() => respond(body, "application/x-git-upload-pack-result")) },
    );
    expect(result.shallow).toEqual([OID]);
    expect(await collect(result.pack)).toEqual(PACK);
    expect(progress).toEqual(["counting objects\n"]);
  });

  it("reads a packfile the server did not wrap in side-band", async () => {
    const body = concat([pkt("NAK\n"), PACK]);
    const result = await uploadPack(
      { url: "http://host/repo", wants: [OID], advertised: new Set(["ofs-delta"]) },
      { http: canned(() => respond(body, "application/x-git-upload-pack-result")) },
    );
    expect(await collect(result.pack)).toEqual(PACK);
  });

  it("rejects an oversized raw pack source chunk before yielding it", async () => {
    const result = await uploadPack(
      { url: "http://host/repo", wants: [OID], advertised: new Set(["ofs-delta"]) },
      {
        http: canned(() => ({
          status: 200,
          statusText: "OK",
          headers: { "content-type": "application/x-git-upload-pack-result" },
          body: once(pkt("NAK\n"), new Uint8Array(MAX_PROTOCOL_SOURCE_CHUNK_BYTES + 1)),
        })),
      },
    );
    await expect(collect(result.pack)).rejects.toMatchObject({ code: "E2BIG" });
  });

  it("collects shallow and unshallow boundaries", async () => {
    const other = "3".repeat(40);
    const body = concat([
      pkt(`shallow ${OID}\n`),
      pkt(`unshallow ${other}\n`),
      FLUSH,
      pkt("ACK 4444444444444444444444444444444444444444\n"),
      pkt(concat([new Uint8Array([1]), PACK])),
      FLUSH,
    ]);
    const result = await uploadPack(
      {
        url: "http://host/repo",
        wants: [OID],
        depth: 1,
        advertised: new Set(["side-band-64k", "shallow"]),
      },
      { http: canned(() => respond(body, "application/x-git-upload-pack-result")) },
    );
    expect(result.shallow).toEqual([OID]);
    expect(result.unshallow).toEqual([other]);
    expect(await collect(result.pack)).toEqual(PACK);
  });

  it("bounds retained shallow state at the exact byte", async () => {
    const other = "3".repeat(40);
    const body = concat([
      pkt(`shallow ${OID}\n`),
      pkt(`unshallow ${other}\n`),
      pkt("NAK\n"),
      pkt(concat([new Uint8Array([1]), PACK])),
      FLUSH,
    ]);
    // Result 192 + two array entries 56 + two strings (48 + UTF-16 bytes).
    const retained = 192 + 2 * (56 + 48 + OID.length * 2);
    const request = {
      url: "http://host/repo",
      wants: [OID],
      advertised: new Set(["side-band-64k"]),
    };
    const response = () => respond(body, "application/x-git-upload-pack-result");

    await expect(
      uploadPack(request, {
        http: canned(response),
        protocolLimits: { retainedBytes: retained },
      }),
    ).resolves.toMatchObject({ shallow: [OID], unshallow: [other] });
    await expect(
      uploadPack(request, {
        http: canned(response),
        protocolLimits: { retainedBytes: retained - 1 },
      }),
    ).rejects.toMatchObject({ code: "E2BIG" });
  });

  it("rejects duplicate shallow entries before a partial result escapes", async () => {
    const response = (count: number) =>
      canned(() =>
        respond(
          concat([
            ...Array.from({ length: count }, () => pkt(`shallow ${OID}\n`)),
            pkt("NAK\n"),
            pkt(concat([new Uint8Array([1]), PACK])),
            FLUSH,
          ]),
          "application/x-git-upload-pack-result",
        ),
      );
    const request = {
      url: "http://host/repo",
      wants: [OID],
      advertised: new Set(["side-band-64k"]),
    };

    await expect(
      uploadPack(request, { http: response(2), protocolLimits: { entries: 2 } }),
    ).resolves.toMatchObject({ shallow: [OID, OID] });
    await expect(
      uploadPack(request, { http: response(3), protocolLimits: { entries: 2 } }),
    ).rejects.toMatchObject({ code: "E2BIG" });
  });

  it("turns a band-3 frame into a fetch failure", async () => {
    const body = concat([
      pkt("NAK\n"),
      pkt(concat([new Uint8Array([3]), utf8.encode("upload-pack: not our ref\n")])),
    ]);
    const result = await uploadPack(
      { url: "http://host/repo", wants: [OID], advertised: new Set(["side-band-64k"]) },
      { http: canned(() => respond(body, "application/x-git-upload-pack-result")) },
    );
    await expect(collect(result.pack)).rejects.toMatchObject({
      code: "EFETCHFAIL",
      message: "upload-pack: not our ref",
    });
  });

  it("sends only capabilities the server advertised, on the first want line", async () => {
    let sent = "";
    const body = concat([pkt("NAK\n"), pkt(concat([new Uint8Array([1]), PACK])), FLUSH]);
    const other = "5".repeat(40);
    await uploadPack(
      {
        url: "http://host/repo",
        wants: [OID, other],
        haves: ["6".repeat(40)],
        advertised: new Set(["side-band-64k", "ofs-delta"]),
      },
      {
        http: (request) => {
          sent = new TextDecoder().decode(bufferedBody(request.body));
          return Promise.resolve(respond(body, "application/x-git-upload-pack-result"));
        },
      },
    );
    const lines = sent.match(/[0-9a-f]{4}[\s\S]*?(?=[0-9a-f]{4}|$)/g) ?? [];
    expect(sent).toContain(`want ${OID} `);
    expect(sent).toContain("side-band-64k");
    expect(sent).toContain("ofs-delta");
    expect(sent).not.toContain("thin-pack");
    expect(sent).toContain(`0032want ${other}\n`);
    expect(sent).toContain("0000");
    expect(sent).toContain(`have ${"6".repeat(40)}\n`);
    expect(sent.endsWith("0009done\n")).toBe(true);
    expect(lines.length).toBeGreaterThan(3);
  });

  it("bounds outbound entries and bytes before sending the request", async () => {
    const body = concat([pkt("NAK\n"), pkt(concat([new Uint8Array([1]), PACK])), FLUSH]);
    let calls = 0;
    let sentBytes = 0;
    const http: GitHttpClient = (request) => {
      calls++;
      sentBytes = bufferedBody(request.body).length;
      return Promise.resolve(respond(body, "application/x-git-upload-pack-result"));
    };
    const request = {
      url: "http://host/repo",
      wants: [OID],
      haves: ["2".repeat(40)],
      advertised: new Set(["side-band-64k"]),
    };

    await uploadPack(request, { http });
    expect(calls).toBe(1);
    const exactBytes = sentBytes;
    await expect(
      uploadPack(request, { http, protocolLimits: { entries: 2, inputBytes: exactBytes } }),
    ).resolves.toBeDefined();
    expect(calls).toBe(2);
    await expect(
      uploadPack(request, { http, protocolLimits: { inputBytes: exactBytes - 1 } }),
    ).rejects.toMatchObject({ code: "E2BIG" });
    await expect(
      uploadPack(
        { ...request, wants: [OID, "3".repeat(40)] },
        { http, protocolLimits: { entries: 2 } },
      ),
    ).rejects.toMatchObject({ code: "E2BIG" });
    expect(calls).toBe(2);
  });

  it("refuses to ask for nothing", async () => {
    await expect(
      uploadPack(
        { url: "http://host/repo", wants: [], advertised: new Set() },
        { http: canned(() => respond(new Uint8Array(0), "application/x-git-upload-pack-result")) },
      ),
    ).rejects.toMatchObject({ code: "ENOWANT" });
  });

  it("reports a non-200 as an HTTP error", async () => {
    await expect(
      uploadPack(
        { url: "http://host/repo", wants: [OID], advertised: new Set() },
        {
          http: () =>
            Promise.resolve({
              status: 500,
              statusText: "Internal Server Error",
              headers: {},
              body: once(utf8.encode("boom")),
            }),
        },
      ),
    ).rejects.toMatchObject({ code: "EHTTP", status: 500 });
  });
});
