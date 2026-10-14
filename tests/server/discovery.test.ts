import { describe, expect, it } from "vitest";
import { bareServer } from "../helpers/bare-server.js";
import { GitFixture, slices } from "../helpers/git.js";
import { packetText } from "../helpers/server-oracle.js";
import { runGit } from "../helpers/server-oracle-http.js";

describe("bare Smart HTTP discovery", () => {
  it("matches native ls-remote for empty, default HEAD, branches and peeled tag chains", async () => {
    const fixture = bareServer();
    const native = new GitFixture().init();
    const server = await fixture.listen();
    try {
      const empty = await runGit(native.dir, ["ls-remote", server.url]);
      expect(empty.stdout.length).toBe(0);
      native.write("data", "hello");
      const oid = native.commit("initial");
      native.git("branch", "other");
      native.git("branch", "\u{10000}");
      native.git("branch", "\ue000");
      native.git("tag", "light");
      native.git("tag", "-a", "annotated", "-m", "tag");
      native.git("tag", "-a", "chain", "annotated", "-m", "tag chain");
      await fixture.store.packs.ingest(slices(native.packAll(), 64));
      for (const row of native
        .git("for-each-ref", "--format=%(refname) %(objectname)")
        .split("\n")) {
        const [name, target] = row.split(" ");
        if (name === undefined || target === undefined) throw new Error("invalid native ref row");
        fixture.store.setRef(name, target);
      }
      fixture.store.setRef("refs/remotes/private/main", oid);
      const actual = await runGit(native.dir, ["ls-remote", "--symref", server.url]);
      const expected = await runGit(native.dir, ["ls-remote", "--symref", native.dir]);
      expect(actual.stdout).toEqual(expected.stdout);
      expect(server.errors).toEqual([]);
    } finally {
      await server.close();
      native.dispose();
    }
  });

  it("retains one synchronous snapshot across ref changes and holds no live cursor", async () => {
    const fixture = bareServer();
    const tree = fixture.store.write("tree", new Uint8Array());
    fixture.store.setRef("refs/tags/tree", tree);
    const response = await fixture.server.fetch(
      new Request("https://git.test/info/refs?service=git-upload-pack"),
    );
    fixture.store.deleteRef("refs/tags/tree");
    const packets = packetText(Buffer.from(await response.arrayBuffer()));
    expect(packets.some((line) => line.startsWith(`${tree} refs/tags/tree`))).toBe(true);
    expect(response.headers.get("Content-Type")).toBe(
      "application/x-git-upload-pack-advertisement",
    );
    expect(response.headers.get("Cache-Control")).toContain("no-store");
  });
});
