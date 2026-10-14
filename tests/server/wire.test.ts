import { describe, expect, it } from "vitest";
import { concat, utf8, ZERO_OID } from "../../packages/git/src/common/bytes.js";
import {
  DELIM,
  FLUSH,
  MAX_PKT_PAYLOAD_BYTES,
  pkt,
} from "../../packages/git/src/protocol/pktline.js";
import { MAX_RECEIVE_PACK_COMMANDS } from "../../packages/git/src/protocol/receive-pack-types.js";
import { MAX_PROTOCOL_NEGOTIATION_ENTRIES } from "../../packages/git/src/protocol/remote-base.js";
import {
  encodeAck,
  encodeAdvertisement,
  encodePackResponse,
  encodeReceiveStatus,
  parseReceivePackRequest,
  parseUploadPackRequest,
  type ServerAdvertisedRef,
} from "../../packages/git/src/protocol/server/index.js";
import { GitFixture } from "../helpers/git.js";
import { frames, packetText, startProtocolOracle } from "../helpers/server-oracle.js";
import { runGit } from "../helpers/server-oracle-http.js";

const A = "a".repeat(40);
const B = "b".repeat(40);

async function* chunks(bytes: Uint8Array, size = 7): AsyncGenerator<Uint8Array> {
  for (let offset = 0; offset < bytes.length; offset += size) {
    yield bytes.subarray(offset, offset + size);
  }
}

async function collect(source: AsyncIterable<Uint8Array>): Promise<Buffer> {
  const parts: Uint8Array[] = [];
  for await (const chunk of source) parts.push(chunk);
  return Buffer.from(concat(parts));
}

function receive(...lines: string[]): Uint8Array {
  return concat([...lines.map(pkt), FLUSH]);
}

function upload(...tail: Uint8Array[]): Uint8Array {
  return concat([pkt(`want ${A} multi_ack_detailed side-band-64k\n`), FLUSH, ...tail]);
}

describe("server wire codecs", () => {
  it("decodes native push/clone bytes and reproduces native advertisements and status", async () => {
    const remote = new GitFixture();
    const seed = new GitFixture().init();
    const client = new GitFixture();
    remote.git("init", "--bare", "-q", "-b", "main");
    remote.git("config", "http.receivepack", "true");
    const oracle = await startProtocolOracle(remote.dir);
    try {
      await runGit(seed.dir, ["ls-remote", oracle.url]);
      const empty = oracle.exchanges.at(-1);
      expect(
        Buffer.from(
          concat([
            ...encodeAdvertisement("git-upload-pack", {
              refs: [],
              head: { ref: "refs/heads/main", oid: null },
            }),
          ]),
        ),
      ).toEqual(empty?.response);
      seed.write("file", "base\n");
      const initial = seed.commit("initial");
      await runGit(seed.dir, ["push", oracle.url, "main"]);
      seed.write("file", "changed\n");
      const target = seed.commit("target");
      await runGit(seed.dir, ["push", oracle.url, "main"]);
      seed.git("tag", "-a", "v1", "-m", "version one");
      await runGit(seed.dir, ["push", oracle.url, "refs/tags/v1"]);
      await runGit(seed.dir, ["push", oracle.url, "main:copy"]);
      await runGit(seed.dir, ["push", oracle.url, ":copy"]);
      await runGit(client.dir, ["clone", oracle.url, "."]);
      const refs: ServerAdvertisedRef[] = [
        { name: "refs/heads/main", oid: target },
        { name: "refs/tags/v1", oid: seed.git("rev-parse", "refs/tags/v1"), peeledOid: target },
      ];
      for (const exchange of oracle.exchanges) {
        if (exchange.method !== "POST") continue;
        if (exchange.path.endsWith("git-receive-pack")) {
          const request = await parseReceivePackRequest(chunks(exchange.request), {
            maxPackBytes: exchange.request.length,
          });
          try {
            expect(request.reportStatus).toBe(true);
            const command = request.commands[0];
            expect(command).toBeDefined();
            expect(`${command?.oldOid} ${command?.newOid} ${command?.ref}`).toBe(
              packetText(exchange.request)[0]?.split("\0")[0],
            );
            expect(await collect(request.pack)).toEqual(frames(exchange.request).rest);
            const response = concat([
              ...encodeReceiveStatus(
                "ok",
                request.commands.map(({ ref }) => ({ ref, error: null })),
              ),
            ]);
            expect(Buffer.from(response)).toEqual(exchange.response);
          } finally {
            await request.release();
          }
        } else {
          const request = await parseUploadPackRequest(chunks(exchange.request));
          expect(request.wants).toContain(target);
          expect(request.haves).toEqual([]);
          expect(request.done).toBe(true);
          expect(request.detailedAck).toBe(true);
          expect(request.sideband).toBe(true);
        }
      }
      const clientTree = client.git("rev-parse", "HEAD^{tree}");
      let clientTip = target;
      for (let index = 0; index < 180; index++) {
        clientTip = client.gitInput(
          `divergent-${index}\n`,
          "commit-tree",
          clientTree,
          "-p",
          clientTip,
        );
      }
      client.git("update-ref", "refs/heads/main", clientTip);
      const nextTip = remote.gitInput("next tip\n", "commit-tree", clientTree, "-p", target);
      remote.git("update-ref", "refs/heads/main", nextTip);
      const beforeFetch = oracle.exchanges.length;
      await runGit(client.dir, ["-c", "fetch.negotiationAlgorithm=consecutive", "fetch", "origin"]);
      const rounds = oracle.exchanges
        .slice(beforeFetch)
        .filter((exchange) => exchange.method === "POST");
      expect(rounds.length).toBeGreaterThan(1);
      for (const [index, round] of rounds.entries()) {
        const parsed = await parseUploadPackRequest(chunks(round.request));
        expect(parsed.done).toBe(index === rounds.length - 1);
        expect(parsed.wants).toEqual([nextTip]);
      }
      remote.git("update-ref", "refs/heads/main", target);
      expect(initial).not.toBe(target);
      for (const service of ["git-upload-pack", "git-receive-pack"]) {
        const response = await fetch(`${oracle.url}/info/refs?service=${service}`);
        const actual = Buffer.from(await response.arrayBuffer());
        const expected = concat([
          ...encodeAdvertisement(
            service === "git-upload-pack" ? "git-upload-pack" : "git-receive-pack",
            {
              refs,
              head: { ref: "refs/heads/main", oid: target },
            },
          ),
        ]);
        expect(Buffer.from(expected)).toEqual(actual);
      }
      expect(oracle.errors).toEqual([]);
    } finally {
      await oracle.close();
      remote.dispose();
      seed.dispose();
      client.dispose();
    }
  });

  it.each([
    `${ZERO_OID} ${ZERO_OID} refs/heads/main`,
    `${A} ${B} refs/remotes/origin/main`,
    `${A} ${B} refs/heads/../main`,
    `${A} ${B} refs/heads/main\0report-status report-status`,
    `${A} ${B} refs/heads/main\0atomic`,
    `${A} ${B} refs/heads/main\0report-status\t`,
    `${A} ${B} refs/heads/main\0report-status\0delete-refs`,
    `${A} ${B} refs/heads/main\nextra`,
    `${A.toUpperCase()} ${B} refs/heads/main`,
    `${A} ${B} refs/heads/main extra`,
  ])("rejects invalid receive command %s", async (line) => {
    await expect(
      parseReceivePackRequest(chunks(receive(line)), { maxPackBytes: 100 }),
    ).rejects.toThrow();
  });

  it("rejects duplicate receive refs, late capabilities, invalid UTF-8 and truncated frames", async () => {
    const first = `${A} ${B} refs/heads/main`;
    const bodies = [
      receive(first, first),
      receive(first, `${A} ${B} refs/heads/other\0report-status`),
      concat([pkt(new Uint8Array([0xff])), FLUSH]),
      concat([pkt(first), DELIM]),
      pkt(first),
      utf8.encode("00"),
      utf8.encode("0010short"),
    ];
    for (const body of bodies) {
      await expect(
        parseReceivePackRequest(chunks(body, 1), { maxPackBytes: 100 }),
      ).rejects.toThrow();
    }
  });

  it("bounds receive metadata and the actual raw stream, and releases unconsumed input", async () => {
    const command = `${ZERO_OID} ${A} refs/heads/main\0report-status`;
    let released = 0;
    async function* tracked(body: Uint8Array) {
      try {
        yield body;
      } finally {
        released++;
      }
    }
    const raw = utf8.encode("PACK\0\0\0\u0002");
    const bytes = concat([receive(command), raw]);
    const accepted = await parseReceivePackRequest(tracked(bytes), { maxPackBytes: raw.length });
    expect(await collect(accepted.pack)).toEqual(Buffer.from(raw));
    await accepted.release();
    expect(released).toBe(1);
    const rejected = await parseReceivePackRequest(tracked(bytes), {
      maxPackBytes: raw.length - 1,
    });
    await expect(collect(rejected.pack)).rejects.toMatchObject({ code: "E2BIG" });
    expect(released).toBe(2);
    const unread = await parseReceivePackRequest(tracked(bytes), { maxPackBytes: raw.length });
    await unread.release();
    expect(released).toBe(3);
    const deletion = await parseReceivePackRequest(
      chunks(concat([receive(`${A} ${ZERO_OID} refs/heads/main`), raw])),
      { maxPackBytes: 100 },
    );
    await expect(collect(deletion.pack)).rejects.toThrow("delete-only");
    const many = Array.from(
      { length: MAX_RECEIVE_PACK_COMMANDS + 1 },
      (_, index) => `${ZERO_OID} ${A} refs/heads/branch${index}`,
    );
    await expect(
      parseReceivePackRequest(chunks(receive(...many), 4096), { maxPackBytes: 100 }),
    ).rejects.toMatchObject({ code: "E2BIG" });
  });

  it("decodes flush-ended negotiation and terminal done with capability flags", async () => {
    expect(await parseUploadPackRequest(chunks(upload(pkt(`have ${B}\n`), FLUSH)))).toEqual({
      wants: [A],
      haves: [B],
      done: false,
      detailedAck: true,
      sideband: true,
    });
    expect(
      await parseUploadPackRequest(chunks(concat([pkt(`want ${A}\n`), FLUSH, pkt("done\n")]))),
    ).toEqual({
      wants: [A],
      haves: [],
      done: true,
      detailedAck: false,
      sideband: false,
    });
  });

  it("rejects malformed upload ordering, capabilities and trailing bytes", async () => {
    const bodies = [
      upload(DELIM),
      upload(pkt(`want ${B}\n`), pkt("done\n")),
      upload(pkt(`have ${ZERO_OID}\n`), FLUSH),
      upload(pkt("done\n"), FLUSH),
      upload(pkt(`have ${B}\n`)),
      concat([pkt(`want ${A} side-band-64k side-band-64k\n`), FLUSH, pkt("done\n")]),
      concat([pkt(`want ${A} no-done\n`), FLUSH, pkt("done\n")]),
      concat([pkt(`want ${ZERO_OID}\n`), FLUSH, pkt("done\n")]),
      concat([pkt(`want ${A}\n`), pkt(`want ${B} side-band-64k\n`), FLUSH, pkt("done\n")]),
      concat([FLUSH, pkt("done\n")]),
      concat([pkt(new Uint8Array([0xff])), FLUSH, pkt("done\n")]),
    ];
    for (const body of bodies)
      await expect(parseUploadPackRequest(chunks(body, 1))).rejects.toThrow();
    const haves = Array.from({ length: MAX_PROTOCOL_NEGOTIATION_ENTRIES }, (_, index) =>
      pkt(`have ${(index + 1).toString(16).padStart(40, "0")}\n`),
    );
    await expect(
      parseUploadPackRequest(chunks(upload(...haves, FLUSH), 4096)),
    ).rejects.toMatchObject({ code: "E2BIG" });
  });

  it("deduplicates repeated native wants and haves while bounding all input frames", async () => {
    const body = concat([
      pkt(`want ${A}\n`),
      pkt(`want ${A}\n`),
      FLUSH,
      pkt(`have ${B}\n`),
      pkt(`have ${B}\n`),
      pkt("done\n"),
    ]);
    expect(await parseUploadPackRequest(chunks(body))).toMatchObject({
      wants: [A],
      haves: [B],
      done: true,
    });
    const repeated = Array.from({ length: MAX_PROTOCOL_NEGOTIATION_ENTRIES }, () =>
      pkt(`have ${B}\n`),
    );
    await expect(
      parseUploadPackRequest(chunks(upload(...repeated, FLUSH), 4096)),
    ).rejects.toMatchObject({ code: "E2BIG" });
  });

  it("frames ACK and sideband without buffering the whole pack and releases on cancellation", async () => {
    expect(packetText(Buffer.from(encodeAck(null)))).toEqual(["NAK\n"]);
    expect(packetText(Buffer.from(encodeAck(A, "common")))).toEqual([`ACK ${A} common\n`]);
    expect(packetText(Buffer.from(encodeAck(A, "ready")))).toEqual([`ACK ${A} ready\n`]);
    expect(packetText(Buffer.from(encodeAck(A)))).toEqual([`ACK ${A}\n`]);
    const raw = new Uint8Array(MAX_PKT_PAYLOAD_BYTES * 2 + 7).fill(42);
    raw.set(utf8.encode("PACK"));
    const encoded = await collect(encodePackResponse(chunks(raw, raw.length), true));
    const packets = frames(encoded).packets;
    expect(packets.at(-1)?.length).toBe(0);
    expect(packets.every((packet) => packet.length <= MAX_PKT_PAYLOAD_BYTES)).toBe(true);
    expect(Buffer.concat(packets.slice(0, -1).map((packet) => packet.subarray(1)))).toEqual(
      Buffer.from(raw),
    );
    expect(await collect(encodePackResponse(chunks(raw), false))).toEqual(Buffer.from(raw));
    let released = false;
    async function* source() {
      try {
        yield raw;
        yield raw;
      } finally {
        released = true;
      }
    }
    for await (const _chunk of encodePackResponse(source(), true)) break;
    expect(released).toBe(true);
  });

  it("rejects inconsistent advertisement metadata and unordered refs", () => {
    expect(() => [
      ...encodeAdvertisement("git-upload-pack", {
        refs: [
          { name: "refs/heads/z", oid: A },
          { name: "refs/heads/a", oid: A },
        ],
        head: null,
      }),
    ]).toThrow("ordered");
    expect(() => [
      ...encodeAdvertisement("git-upload-pack", {
        refs: [{ name: "refs/heads/main", oid: A }],
        head: { ref: "refs/heads/main", oid: B },
      }),
    ]).toThrow("differs");
    expect(() => [
      ...encodeAdvertisement("git-upload-pack", {
        refs: [{ name: "refs/remotes/origin/main", oid: A }],
        head: null,
      }),
    ]).toThrow();
  });
});
