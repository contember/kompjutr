import { describe, expect, it } from "vitest";
import { utf8, ZERO_OID } from "../../packages/git/src/common/bytes.js";
import { bareServer, pushBytes, pushRequest } from "../helpers/bare-server.js";
import { GitFixture, slices } from "../helpers/git.js";
import { startGitServer } from "../helpers/http-backend.js";
import { packetText } from "../helpers/server-oracle.js";
import { runGit } from "../helpers/server-oracle-http.js";

async function status(response: Response): Promise<string[]> {
  expect(response.status).toBe(200);
  return packetText(Buffer.from(await response.arrayBuffer()));
}

describe("receive-pack publication", () => {
  it("accepts native initial/incremental pushes, multiple refs, replacements and deletions", async () => {
    const fixture = bareServer();
    const seed = new GitFixture().init();
    const server = await fixture.listen();
    try {
      seed.write("file", "initial");
      const first = seed.commit("initial");
      await runGit(seed.dir, ["push", server.url, "main"]);
      expect(fixture.store.getRef("refs/heads/main")).toBe(first);
      seed.write("file", "changed");
      const second = seed.commit("next");
      seed.git("tag", "light");
      seed.git("tag", "-a", "annotated", "-m", "annotated");
      await runGit(seed.dir, [
        "push",
        server.url,
        "main",
        "refs/tags/light",
        "refs/tags/annotated",
      ]);
      expect(fixture.store.getRef("refs/tags/annotated")).toBe(seed.git("rev-parse", "annotated"));
      await runGit(seed.dir, ["push", server.url, "main:copy"]);
      await runGit(seed.dir, ["push", server.url, ":copy", ":refs/tags/light"]);
      expect(fixture.store.getRef("refs/heads/copy")).toBeNull();
      await runGit(seed.dir, [
        "push",
        "--force",
        server.url,
        `${first}:main`,
        `${first}:refs/tags/annotated`,
      ]);
      expect(fixture.store.getRef("refs/heads/main")).toBe(first);
      expect(fixture.store.getRef("refs/tags/annotated")).toBe(first);
      expect(fixture.store.read(second)?.type).toBe("commit");
      expect(fixture.store.reflog("refs/heads/main")[0]?.reason).toBe("push");
      expect(fixture.database.listCheckouts(fixture.store.repoId)).toEqual([]);
      expect(server.errors).toEqual([]);
    } finally {
      await server.close();
      seed.dispose();
    }
  });

  it("reports per-ref old-OID conflicts while publishing valid commands and packless existing targets", async () => {
    const fixture = bareServer();
    const seed = new GitFixture().init();
    try {
      seed.write("file", "first");
      const first = seed.commit("first");
      seed.write("file", "second");
      const second = seed.commit("second");
      await fixture.store.packs.ingest(slices(seed.packAll(), 64));
      fixture.store.setRef("refs/heads/main", first);
      const result = await status(
        await fixture.server.fetch(
          pushRequest(
            pushBytes([
              { oldOid: second, newOid: second, ref: "refs/heads/main" },
              { oldOid: ZERO_OID, newOid: second, ref: "refs/heads/other" },
            ]),
          ),
        ),
      );
      expect(result).toEqual([
        "unpack ok\n",
        "ng refs/heads/main stale old object id\n",
        "ok refs/heads/other\n",
        "",
      ]);
      expect(fixture.store.getRef("refs/heads/main")).toBe(first);
      expect(fixture.store.getRef("refs/heads/other")).toBe(second);
    } finally {
      seed.dispose();
    }
  });

  it("protects attached branches and rolls back a pack when every command is rejected", async () => {
    const fixture = bareServer();
    const seed = new GitFixture().init();
    try {
      fixture.database.createCheckout(fixture.store.repoId, "/attached", "ref: refs/heads/main");
      seed.write("file", "first");
      const first = seed.commit("first");
      const result = await status(
        await fixture.server.fetch(
          pushRequest(
            pushBytes(
              [{ oldOid: ZERO_OID, newOid: first, ref: "refs/heads/main" }],
              seed.packAll(),
            ),
          ),
        ),
      );
      expect(result).toContain("ng refs/heads/main branch is attached to a checkout\n");
      expect(fixture.store.getRef("refs/heads/main")).toBeNull();
      expect(fixture.store.read(first)).toBeNull();
      expect(fixture.db.scalar("SELECT count(*) FROM git_pack_meta")).toBe(0);
      expect(fixture.db.scalar("SELECT count(*) FROM git_commits")).toBe(0);
    } finally {
      seed.dispose();
    }
  });

  it("matches native namespace transitions and conflicts", async () => {
    const fixture = bareServer();
    const seed = new GitFixture().init();
    const remote = new GitFixture();
    remote.git("init", "--bare", "-q", "-b", "main");
    remote.git("config", "http.receivepack", "true");
    const native = await startGitServer(remote.dir);
    const server = await fixture.listen();
    try {
      seed.write("file", "first");
      const oid = seed.commit("first");
      for (const url of [native.url, server.url])
        await runGit(seed.dir, ["push", url, "main:parent"]);
      for (const url of [native.url, server.url]) {
        await runGit(seed.dir, ["push", url, ":parent", "main:parent/child"]);
      }
      expect(fixture.store.getRef("refs/heads/parent")).toBeNull();
      expect(fixture.store.getRef("refs/heads/parent/child")).toBe(oid);
      for (const url of [native.url, server.url]) {
        await expect(
          runGit(seed.dir, ["push", url, "main:conflict", "main:conflict/child"]),
        ).rejects.toThrow();
      }
      expect(fixture.store.listRefs()).toEqual(
        remote
          .git("for-each-ref", "--format=%(refname) %(objectname)")
          .split("\n")
          .map((line) => {
            const [name, target] = line.split(" ");
            return { name, target };
          }),
      );
    } finally {
      await native.close();
      await server.close();
      remote.dispose();
      seed.dispose();
    }
  });

  it("rejects missing and wrong-type tips, incomplete closures, and invalid checksums without publishing refs", async () => {
    const fixture = bareServer();
    const seed = new GitFixture().init();
    try {
      const blob = fixture.store.write("blob", utf8.encode("not a commit"));
      for (const oid of ["1".repeat(40), blob]) {
        const result = await status(
          await fixture.server.fetch(
            pushRequest(pushBytes([{ oldOid: ZERO_OID, newOid: oid, ref: "refs/heads/main" }])),
          ),
        );
        expect(result[0]).toContain("unpack invalid");
      }
      seed.write("file", "content");
      const oid = seed.commit("first");
      const broken = seed.packAll();
      broken[broken.length - 1] = (broken[broken.length - 1] ?? 0) ^ 1;
      expect(
        (
          await status(
            await fixture.server.fetch(
              pushRequest(
                pushBytes([{ oldOid: ZERO_OID, newOid: oid, ref: "refs/heads/main" }], broken),
              ),
            ),
          )
        )[0],
      ).toContain("unpack invalid");
      const missingTree = "2".repeat(40);
      const incomplete = fixture.store.write(
        "commit",
        utf8.encode(
          `tree ${missingTree}\nauthor Fixture <fixture@example.com> 0 +0000\ncommitter Fixture <fixture@example.com> 0 +0000\n\nbroken\n`,
        ),
      );
      expect(
        (
          await status(
            await fixture.server.fetch(
              pushRequest(
                pushBytes([{ oldOid: ZERO_OID, newOid: incomplete, ref: "refs/heads/main" }]),
              ),
            ),
          )
        )[0],
      ).toContain("unpack invalid");
      expect(fixture.store.getRef("refs/heads/main")).toBeNull();
      expect(fixture.db.scalar("SELECT count(*) FROM git_pack_meta")).toBe(0);
    } finally {
      seed.dispose();
    }
  });
  it("checks every incoming object even when its broken closure is not reachable from a commanded tip", async () => {
    const fixture = bareServer();
    const seed = new GitFixture().init();
    try {
      seed.write("file", "valid");
      const oid = seed.commit("valid");
      const broken = seed.writeObject(
        "commit",
        utf8.encode(
          `tree ${"4".repeat(40)}\nauthor Fixture <fixture@example.com> 0 +0000\ncommitter Fixture <fixture@example.com> 0 +0000\n\nunreferenced broken commit\n`,
        ),
      );
      const inputs = seed
        .git("rev-list", "--objects", "--all")
        .split("\n")
        .map((line) => line.split(" ")[0])
        .join("\n");
      const pack = (
        await runGit(
          seed.dir,
          ["pack-objects", "--stdout", "-q"],
          utf8.encode(`${inputs}\n${broken}\n`),
        )
      ).stdout;
      const result = await status(
        await fixture.server.fetch(
          pushRequest(pushBytes([{ oldOid: ZERO_OID, newOid: oid, ref: "refs/heads/main" }], pack)),
        ),
      );
      expect(result[0]).toContain("unpack invalid");
      expect(fixture.store.getRef("refs/heads/main")).toBeNull();
      expect(fixture.store.read(oid)).toBeNull();
      expect(fixture.db.scalar("SELECT count(*) FROM git_pack_meta")).toBe(0);
    } finally {
      seed.dispose();
    }
  });

  it("rejects a native thin pack even when its external base already exists", async () => {
    const fixture = bareServer();
    const seed = new GitFixture().init();
    const empty = new GitFixture();
    empty.git("init", "--bare", "-q");
    try {
      const content = Array.from(
        { length: 5000 },
        (_, index) => `${index.toString(16)} original content ${index}`,
      ).join("\n");
      seed.write("file", content);
      const first = seed.commit("base");
      await fixture.store.packs.ingest(slices(seed.packAll(), 4096));
      fixture.store.setRef("refs/heads/main", first);
      seed.write("file", `${content}\nsmall addition`);
      const second = seed.commit("delta");
      const thin = (
        await runGit(
          seed.dir,
          ["pack-objects", "--stdout", "--thin", "--revs", "-q"],
          utf8.encode(`${second}\n^${first}\n`),
        )
      ).stdout;
      await expect(runGit(empty.dir, ["index-pack", "--stdin"], thin)).rejects.toThrow();
      const result = await status(
        await fixture.server.fetch(
          pushRequest(pushBytes([{ oldOid: first, newOid: second, ref: "refs/heads/main" }], thin)),
        ),
      );
      expect(result[0]).toContain("unpack invalid");
      expect(fixture.store.getRef("refs/heads/main")).toBe(first);
      expect(fixture.store.read(second)).toBeNull();
      expect(fixture.db.scalar("SELECT count(*) FROM git_pack_meta WHERE state = 'pending'")).toBe(
        0,
      );
    } finally {
      seed.dispose();
      empty.dispose();
    }
  });

  it("does not treat a rejected deletion as freeing its namespace", async () => {
    const fixture = bareServer();
    const seed = new GitFixture().init();
    try {
      seed.write("file", "content");
      const oid = seed.commit("base");
      await fixture.store.packs.ingest(slices(seed.packAll(), 4096));
      fixture.store.setRef("refs/heads/parent", oid);
      const result = await status(
        await fixture.server.fetch(
          pushRequest(
            pushBytes([
              { oldOid: "5".repeat(40), newOid: ZERO_OID, ref: "refs/heads/parent" },
              { oldOid: ZERO_OID, newOid: oid, ref: "refs/heads/parent/child" },
            ]),
          ),
        ),
      );
      expect(result).toContain("ng refs/heads/parent stale old object id\n");
      expect(result).toContain("ng refs/heads/parent/child ref namespace conflict\n");
      expect(fixture.store.getRef("refs/heads/parent")).toBe(oid);
      expect(fixture.store.getRef("refs/heads/parent/child")).toBeNull();
    } finally {
      seed.dispose();
    }
  });
});
