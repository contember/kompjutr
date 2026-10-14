import { afterEach, describe, expect, it } from "vitest";
import { type SharedRepoStore, SqliteGitDatabase } from "../../packages/git/src/store/index.js";
import { TestDatabase } from "../helpers/db.js";
import { GitFixture, slices } from "../helpers/git.js";
import {
  frames,
  packetText,
  startProtocolOracle,
  UPLOAD_CAPABILITIES,
} from "../helpers/server-oracle.js";
import { runGit } from "../helpers/server-oracle-http.js";
import { startUploadServer } from "../helpers/server-upload.js";

const fixtures: GitFixture[] = [];
afterEach(() => {
  for (const git of fixtures.splice(0)) git.dispose();
});
function fixture(initialize = true): GitFixture {
  const git = new GitFixture();
  if (initialize) git.init();
  fixtures.push(git);
  return git;
}
function bare(): SharedRepoStore {
  return new SqliteGitDatabase(new TestDatabase()).createBareRepository();
}
async function publish(store: SharedRepoStore, git: GitFixture): Promise<void> {
  await store.packs.ingest(slices(git.packAll(), 8192));
  for (const line of git.git("for-each-ref", "--format=%(refname) %(objectname)").split("\n")) {
    const [name, oid] = line.split(" ");
    if (name === undefined || oid === undefined) throw new Error("invalid fixture ref");
    store.setRef(name, oid);
  }
}
function extend(git: GitFixture, count: number, prefix: string): string {
  const tree = git.git("rev-parse", "HEAD^{tree}");
  let tip = git.git("rev-parse", "HEAD");
  for (let index = 0; index < count; index++) {
    tip = git.gitInput(`${prefix}-${index}\n`, "commit-tree", tree, "-p", tip);
  }
  git.git("update-ref", "refs/heads/main", tip);
  return tip;
}

describe("native Git uploads from SQLite", () => {
  it("clones an empty repository with modern protocol fallback", async () => {
    const server = await startUploadServer(bare());
    const client = fixture(false);
    const native = fixture(false);
    native.git("init", "--bare", "-q", "-b", "main");
    const oracle = await startProtocolOracle(native.dir);
    const nativeClient = fixture(false);
    try {
      await runGit(client.dir, ["clone", server.url, "."]);
      await runGit(nativeClient.dir, ["clone", oracle.url, "."]);
      expect(client.git("symbolic-ref", "HEAD")).toBe(nativeClient.git("symbolic-ref", "HEAD"));
      expect(server.exchanges[0]?.protocol).toBe("version=2");
      expect(server.exchanges.some((exchange) => exchange.method === "POST")).toBe(false);
      await runGit(client.dir, ["fsck", "--full"]);
      expect(server.errors).toEqual([]);
    } finally {
      await server.close();
      await oracle.close();
    }
  });

  it("clones branches, annotated tags and a non-main default, then makes no-op and incremental fetches", async () => {
    const seed = fixture();
    seed.write("file", "base");
    const first = seed.commit("base");
    seed.git("branch", "develop");
    seed.git("tag", "-a", "v1", "-m", "release");
    const tag = seed.git("rev-parse", "v1");
    const store = bare();
    await publish(store, seed);
    store.setDefaultBranch("refs/heads/develop");
    const server = await startUploadServer(store);
    const client = fixture(false);
    try {
      await runGit(client.dir, ["clone", server.url, "."]);
      expect(client.git("symbolic-ref", "HEAD")).toBe("refs/heads/develop");
      expect(client.git("rev-parse", "origin/main")).toBe(first);
      expect(client.git("rev-parse", "v1")).toBe(tag);
      expect(client.git("show", "HEAD:file")).toBe("base");
      server.exchanges.length = 0;
      await runGit(client.dir, ["fetch", "origin"]);
      expect(server.exchanges.filter((exchange) => exchange.method === "POST")).toHaveLength(0);
      seed.write("file", "next");
      const next = seed.commit("next");
      await publish(store, seed);
      await runGit(client.dir, ["fetch", "origin"]);
      expect(client.git("rev-parse", "origin/main")).toBe(next);
      expect(client.git("show", "origin/main:file")).toBe("next");
      await runGit(client.dir, ["fsck", "--full"]);
      expect(server.errors).toEqual([]);
    } finally {
      await server.close();
    }
  });

  it.each([false, true])(
    "completes divergent multi-round fetch with raw fallback=%s",
    async (fallback) => {
      const seed = fixture();
      seed.write("file", "base");
      seed.commit("base");
      extend(seed, 10, "shared");
      const store = bare();
      await publish(store, seed);
      const server = await startUploadServer(store, fallback);
      const client = fixture(false);
      try {
        await runGit(client.dir, ["-c", "protocol.version=0", "clone", server.url, "."]);
        expect(server.exchanges[0]?.protocol).toBeNull();
        if (!fallback) {
          const first = packetText(server.exchanges[0]?.response ?? Buffer.alloc(0)).find((line) =>
            line.includes("\0"),
          );
          expect(first?.split("\0")[1]?.trim().split(" ")).toEqual(UPLOAD_CAPABILITIES);
        }
        extend(client, 180, "client");
        const target = extend(seed, 3, "server");
        await publish(store, seed);
        server.exchanges.length = 0;
        await runGit(client.dir, [
          "-c",
          "fetch.negotiationAlgorithm=consecutive",
          "fetch",
          "origin",
        ]);
        const rounds = server.exchanges.filter((exchange) => exchange.method === "POST");
        expect(rounds.length).toBeGreaterThan(1);
        const terminal = rounds.at(-1);
        if (terminal === undefined) throw new Error("missing final upload round");
        expect(packetText(terminal.request)).toContain("done\n");
        for (const round of rounds.slice(0, -1)) {
          expect(packetText(round.request)).not.toContain("done\n");
          expect(packetText(round.response).at(-1)).toBe("NAK\n");
          expect(frames(round.response).rest.length).toBe(0);
          if (fallback) expect(packetText(round.response)).toEqual(["NAK\n"]);
        }
        if (fallback) {
          expect(frames(terminal.response).rest.subarray(0, 4).toString()).toBe("PACK");
        } else {
          const common = rounds
            .slice(0, -1)
            .flatMap((round) => packetText(round.response))
            .filter((line) => /^ACK [0-9a-f]{40} common\n$/.test(line));
          expect(common.length).toBeGreaterThan(0);
          expect(
            rounds.some((round) =>
              packetText(round.response).some((line) => line.endsWith(" ready\n")),
            ),
          ).toBe(true);
          const replayed = packetText(terminal.request).filter((line) => line.startsWith("have "));
          expect(replayed.length).toBeGreaterThan(0);
          for (const have of replayed)
            expect(common).toContain(`ACK ${have.slice(5).trim()} common\n`);
          const packets = frames(terminal.response).packets;
          const firstPack = packets.findIndex((packet) => packet[0] === 1);
          expect(firstPack).toBeGreaterThan(0);
          expect(packets[firstPack - 1]?.toString()).toMatch(/^ACK [0-9a-f]{40}\n$/);
          expect(
            Buffer.concat(
              packets.filter((packet) => packet[0] === 1).map((packet) => packet.subarray(1)),
            )
              .subarray(0, 4)
              .toString(),
          ).toBe("PACK");
          expect(packets.at(-1)?.length).toBe(0);
        }
        expect(client.git("rev-parse", "origin/main")).toBe(target);
        await runGit(client.dir, ["fsck", "--full"]);
        expect(server.errors).toEqual([]);
        expect(store.db.scalar("SELECT count(*) FROM git_transfers WHERE released = 0")).toBe(0);
      } finally {
        await server.close();
      }
    },
  );
});
