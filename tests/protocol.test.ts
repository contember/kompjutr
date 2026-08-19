import { describe, expect, it } from "vitest";

import { concat, utf8 } from "../src/core/bytes.js";
import { FLUSH, pkt, pktLines } from "../src/core/protocol/pktline.js";
import { discover, normalizeRemoteUrl, uploadPack } from "../src/core/protocol/remote.js";
import { ByteReader, pktText } from "../src/core/protocol/stream.js";
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
          sent = new TextDecoder().decode(request.body ?? new Uint8Array(0));
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
