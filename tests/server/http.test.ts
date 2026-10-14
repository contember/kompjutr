import { gzipSync } from "node:zlib";
import { describe, expect, it } from "vitest";
import { ZERO_OID } from "../../packages/git/src/common/bytes.js";
import { createGitServer, SqliteGitDatabase } from "../../packages/git/src/index.js";
import { bareServer, pushBytes, pushRequest, streamPushRequest } from "../helpers/bare-server.js";
import { TestDatabase } from "../helpers/db.js";
import { GitFixture } from "../helpers/git.js";

const OID = "1".repeat(40);

describe("Git HTTP boundary", () => {
  it.each([
    ["/missing", "GET", 404],
    ["/info/refs", "GET", 400],
    ["/info/refs?service=git-unknown", "GET", 400],
    ["/info/refs?service=git-upload-pack&service=git-upload-pack", "GET", 400],
    ["/info/refs?service=git-upload-pack", "POST", 405],
    ["/git-receive-pack", "GET", 405],
    ["/git-upload-pack", "POST", 415],
  ])("rejects route %s %s", async (path, method, status) => {
    const { server } = bareServer();
    const response = await server.fetch(new Request(`https://git.test${path}`, { method }));
    expect(response.status).toBe(status);
    expect(response.headers.get("Cache-Control")).toContain("no-store");
    if (status === 405) expect(response.headers.has("Allow")).toBe(true);
  });

  it("rejects a disabled write service before pulling the request body", async () => {
    const { server, db } = bareServer({ receivePack: false });
    let pulls = 0;
    const response = await server.fetch(
      streamPushRequest({
        pull() {
          pulls++;
          throw new Error("must not read");
        },
      }),
    );
    expect(response.status).toBe(403);
    expect(pulls).toBe(0);
    expect(
      (await server.fetch(new Request("https://git.test/info/refs?service=git-receive-pack")))
        .status,
    ).toBe(403);
    expect(db.scalar("SELECT count(*) FROM git_pack_meta")).toBe(0);
  });

  it("keeps repository selection outside URLs and isolates bound stores", async () => {
    const fixture = bareServer();
    const otherStore = fixture.database.createBareRepository();
    const other = createGitServer(otherStore, { maxPackBytes: 1024 });
    const oid = fixture.store.write("blob", new TextEncoder().encode("private"));
    const command = { oldOid: ZERO_OID, newOid: oid, ref: "refs/tags/leak" };
    const rejected = await other.fetch(pushRequest(pushBytes([command])));
    expect(await rejected.text()).toContain("unpacker error");
    expect(otherStore.getRef(command.ref)).toBeNull();
    expect(
      (
        await other.fetch(
          new Request(`https://git.test/${fixture.store.repoId}/info/refs?service=git-upload-pack`),
        )
      ).status,
    ).toBe(404);
  });

  it("requires bare ownership and rejects malformed commands before pack storage", async () => {
    const db = new SqliteGitDatabase(new TestDatabase());
    const checkout = db.createRepository("/workspace", "ref: refs/heads/main");
    expect(() => createGitServer(db.openShared(checkout.repoId), { maxPackBytes: 1024 })).toThrow(
      "bare",
    );
    const fixture = bareServer();
    const command = { oldOid: ZERO_OID, newOid: OID, ref: "refs/heads/main" };
    const response = await fixture.server.fetch(pushRequest(pushBytes([command, command])));
    expect(response.status).toBe(400);
    expect(fixture.db.scalar("SELECT count(*) FROM git_pack_meta")).toBe(0);
  });

  it("enforces actual chunked pack bytes despite absent or false Content-Length", async () => {
    const native = new GitFixture().init();
    try {
      native.write("file", "payload");
      const oid = native.commit("initial");
      const pack = native.packAll();
      for (const advertised of [undefined, "1"]) {
        const fixture = bareServer({ maxPackBytes: pack.length - 1 });
        const bytes = pushBytes([{ oldOid: ZERO_OID, newOid: oid, ref: "refs/heads/main" }], pack);
        let offset = 0;
        const request = streamPushRequest({
          pull(controller) {
            if (offset === bytes.length) {
              controller.close();
              return;
            }
            controller.enqueue(bytes.subarray(offset, offset + 17));
            offset = Math.min(bytes.length, offset + 17);
          },
        });
        if (advertised !== undefined) request.headers.set("Content-Length", advertised);
        const response = await fixture.server.fetch(request);
        expect(response.status).toBe(413);
        expect(fixture.store.getRef("refs/heads/main")).toBeNull();
        expect(fixture.db.scalar("SELECT count(*) FROM git_pack_meta")).toBe(0);
      }
      const fixture = bareServer({ maxPackBytes: pack.length });
      const response = await fixture.server.fetch(
        pushRequest(pushBytes([{ oldOid: ZERO_OID, newOid: oid, ref: "refs/heads/main" }], pack)),
      );
      expect(await response.text()).toContain("unpack ok");
      expect(fixture.store.getRef("refs/heads/main")).toBe(oid);
    } finally {
      native.dispose();
    }
  });
  it("streams native gzip requests and applies limits to decoded pack bytes", async () => {
    const native = new GitFixture().init();
    try {
      native.write("file", "compressible".repeat(1000));
      const oid = native.commit("gzip");
      const pack = native.packAll();
      for (const limit of [pack.length, pack.length - 1]) {
        const fixture = bareServer({ maxPackBytes: limit });
        const request = pushRequest(
          gzipSync(pushBytes([{ oldOid: ZERO_OID, newOid: oid, ref: "refs/heads/main" }], pack)),
        );
        request.headers.set("Content-Encoding", "gzip");
        const response = await fixture.server.fetch(request);
        expect(response.status).toBe(limit === pack.length ? 200 : 413);
        if (response.status === 200) expect(await response.text()).toContain("unpack ok");
        expect(fixture.store.getRef("refs/heads/main")).toBe(limit === pack.length ? oid : null);
      }
      const fixture = bareServer();
      const malformed = pushRequest(new Uint8Array([31, 139, 8, 0]));
      malformed.headers.set("Content-Encoding", "gzip");
      expect((await fixture.server.fetch(malformed)).status).toBe(400);
      const unsupported = pushRequest(new Uint8Array());
      unsupported.headers.set("Content-Encoding", "br");
      expect((await fixture.server.fetch(unsupported)).status).toBe(415);
    } finally {
      native.dispose();
    }
  });
});
