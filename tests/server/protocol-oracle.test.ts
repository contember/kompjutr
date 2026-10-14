import { execFileSync } from "node:child_process";
import { describe, expect, it } from "vitest";
import { GitFixture } from "../helpers/git.js";
import {
  frames,
  type OracleExchange,
  packetText,
  RECEIVE_CAPABILITIES,
  startProtocolOracle,
  UPLOAD_CAPABILITIES,
} from "../helpers/server-oracle.js";
import { runGit } from "../helpers/server-oracle-http.js";

const ZERO = "0".repeat(40);

function post(exchanges: readonly OracleExchange[]): OracleExchange {
  const exchange = exchanges.filter((item) => item.method === "POST").at(-1);
  if (exchange === undefined) throw new Error("missing POST");
  return exchange;
}

function command(exchange: OracleExchange): string {
  const first = packetText(exchange.request)[0];
  if (first === undefined) throw new Error("missing command");
  return first.split("\0")[0] ?? "";
}

function capabilities(exchange: OracleExchange): string[] {
  const first = packetText(exchange.response).find((packet) => packet.includes("\0"));
  if (first === undefined) return [];
  return first
    .slice(first.indexOf("\0") + 1)
    .trim()
    .split(" ");
}

function bare(): GitFixture {
  const repository = new GitFixture();
  repository.git("init", "--bare", "-q", "-b", "main");
  repository.git("config", "http.receivepack", "true");
  return repository;
}

function extend(repository: GitFixture, count: number, prefix: string): string {
  const tree = repository.git("rev-parse", "HEAD^{tree}");
  let parent = repository.git("rev-parse", "HEAD");
  for (let index = 0; index < count; index++) {
    parent = repository.gitInput(`${prefix}-${index}\n`, "commit-tree", tree, "-p", parent);
  }
  repository.git("update-ref", "refs/heads/main", parent);
  return parent;
}

describe(`native Smart HTTP oracle (${execFileSync("git", ["--version"], { encoding: "utf8" }).trim()})`, () => {
  it("captures empty discovery, initial/incremental push, zero-object update and packless deletion", async () => {
    const remote = bare();
    const client = new GitFixture().init();
    const packCheck = bare();
    const oracle = await startProtocolOracle(remote.dir);
    try {
      await runGit(client.dir, ["ls-remote", oracle.url]);
      expect(packetText(oracle.exchanges[0]?.response ?? Buffer.alloc(0))).toEqual([
        "# service=git-upload-pack\n",
        "",
        `${ZERO} capabilities^{}\0${UPLOAD_CAPABILITIES.join(" ")}\n`,
        "",
      ]);
      expect(oracle.exchanges[0]?.protocol).toBe("version=2");
      client.write("data", Array.from({ length: 2000 }, (_, i) => `line ${i}`).join("\n"));
      const first = client.commit("first");
      await runGit(client.dir, ["push", oracle.url, "main"]);
      const initial = post(oracle.exchanges);
      expect(command(initial)).toBe(`${ZERO} ${first} refs/heads/main`);
      expect(frames(initial.request).rest.subarray(0, 4).toString()).toBe("PACK");
      expect(packetText(initial.response)).toEqual(["unpack ok\n", "ok refs/heads/main\n", ""]);
      const discovery = oracle.exchanges.find((exchange) =>
        capabilities(exchange).includes("no-thin"),
      );
      expect(discovery && capabilities(discovery)).toEqual(RECEIVE_CAPABILITIES);
      client.write("data", `${client.git("show", "HEAD:data")}\nnext line\n`);
      const second = client.commit("second");
      await runGit(client.dir, ["push", oracle.url, "main"]);
      const incremental = post(oracle.exchanges);
      expect(command(incremental)).toBe(`${first} ${second} refs/heads/main`);
      // An empty object store cannot resolve external delta bases: no --fix-thin is used.
      await runGit(packCheck.dir, ["index-pack", "--stdin"], frames(incremental.request).rest);
      expect(packCheck.git("cat-file", "-t", second)).toBe("commit");
      await runGit(client.dir, ["push", oracle.url, "main:copy"]);
      const noObjects = post(oracle.exchanges);
      expect(command(noObjects)).toBe(`${ZERO} ${second} refs/heads/copy`);
      expect(frames(noObjects.request).rest.subarray(0, 4).toString()).toBe("PACK");
      expect(frames(noObjects.request).rest.readUInt32BE(8)).toBe(0);
      await runGit(client.dir, ["push", oracle.url, ":copy"]);
      const deletion = post(oracle.exchanges);
      expect(command(deletion)).toBe(`${second} ${ZERO} refs/heads/copy`);
      expect(frames(deletion.request).rest.length).toBe(0);
      expect(remote.git("rev-parse", "main")).toBe(second);
      expect(oracle.errors).toEqual([]);
    } finally {
      await oracle.close();
      remote.dispose();
      client.dispose();
      packCheck.dispose();
    }
  });

  it("replays common haves after detailed ACKs and requires done before the terminal pack", async () => {
    const remote = bare();
    const seed = new GitFixture().init();
    const client = new GitFixture();
    const oracle = await startProtocolOracle(remote.dir);
    try {
      seed.write("file", "base");
      seed.commit("base");
      extend(seed, 10, "shared");
      seed.git("push", remote.dir, "main");
      await runGit(client.dir, ["clone", oracle.url, "."]);
      const discovery = oracle.exchanges.find((exchange) =>
        capabilities(exchange).includes("multi_ack_detailed"),
      );
      expect(discovery && capabilities(discovery)).toEqual(UPLOAD_CAPABILITIES);
      extend(client, 180, "client");
      const target = extend(seed, 3, "server");
      seed.git("push", remote.dir, "main");
      oracle.exchanges.length = 0;
      await runGit(client.dir, ["-c", "fetch.negotiationAlgorithm=consecutive", "fetch", "origin"]);
      const rounds = oracle.exchanges.filter((exchange) => exchange.method === "POST");
      expect(rounds.length).toBeGreaterThan(1);
      const common = rounds
        .flatMap((exchange) => packetText(exchange.response))
        .filter((line) => /^ACK [0-9a-f]{40} common\n$/.test(line));
      expect(common.length).toBeGreaterThan(0);
      expect(
        rounds.some((exchange) =>
          packetText(exchange.response).some((line) => line.endsWith(" ready\n")),
        ),
      ).toBe(true);
      const terminal = post(rounds);
      const request = packetText(terminal.request);
      expect(request).toContain("done\n");
      const replayed = request
        .filter((line) => line.startsWith("have "))
        .map((line) => line.slice(5).trim());
      expect(replayed.length).toBeGreaterThan(0);
      for (const oid of replayed) expect(common).toContain(`ACK ${oid} common\n`);
      // Git drops acknowledged ancestors once a replayed descendant proves their closure.
      for (const line of common) {
        const oid = line.split(" ")[1];
        if (oid === undefined) throw new Error("missing ACK OID");
        expect(
          replayed.some(
            (tip) => client.gitResult("merge-base", "--is-ancestor", oid, tip).status === 0,
          ),
        ).toBe(true);
      }
      for (const round of rounds.slice(0, -1)) {
        expect(packetText(round.request)).not.toContain("done\n");
        expect(frames(round.response).packets.some((packet) => packet[0] === 1)).toBe(false);
      }
      const response = frames(terminal.response);
      const firstPack = response.packets.findIndex((packet) => packet[0] === 1);
      expect(firstPack).toBeGreaterThan(0);
      expect(
        response.packets
          .slice(0, firstPack)
          .some((packet) => /^ACK [0-9a-f]{40}\n$/.test(packet.toString())),
      ).toBe(true);
      expect(
        Buffer.concat(
          response.packets.filter((packet) => packet[0] === 1).map((packet) => packet.subarray(1)),
        )
          .subarray(0, 4)
          .toString(),
      ).toBe("PACK");
      expect(client.git("rev-parse", "origin/main")).toBe(target);
      await runGit(client.dir, ["fsck", "--full"]);
      expect(oracle.errors).toEqual([]);
    } finally {
      await oracle.close();
      remote.dispose();
      seed.dispose();
      client.dispose();
    }
  });

  it("accepts raw-pack v0 clone but exposes native base-ACK failure in stateless multi-round fetch", async () => {
    const remote = bare();
    const seed = new GitFixture().init();
    const client = new GitFixture();
    const oracle = await startProtocolOracle(remote.dir, false, false);
    try {
      seed.write("file", "base");
      seed.commit("base");
      seed.git("push", remote.dir, "main");
      await runGit(client.dir, ["-c", "protocol.version=0", "clone", oracle.url, "."]);
      const clone = post(oracle.exchanges);
      expect(packetText(clone.response)).toEqual(["NAK\n"]);
      expect(frames(clone.response).rest.subarray(0, 4).toString()).toBe("PACK");
      expect(oracle.exchanges[0]?.protocol).toBeNull();
      extend(client, 180, "client");
      extend(seed, 3, "server");
      seed.git("push", remote.dir, "main");
      oracle.exchanges.length = 0;
      // Native base ACKs are unsafe for stateless continuation. WU5 must instead emit NAK.
      await expect(
        runGit(client.dir, ["-c", "fetch.negotiationAlgorithm=consecutive", "fetch", "origin"]),
      ).rejects.toThrow("protocol error: bad pack header");
      const rounds = oracle.exchanges.filter((exchange) => exchange.method === "POST");
      expect(rounds.length).toBeGreaterThan(1);
      const terminal = post(rounds);
      expect(packetText(terminal.request)).toContain("done\n");
      expect(packetText(terminal.request).some((line) => line.startsWith("have "))).toBe(false);
      expect(packetText(rounds[0]?.response ?? Buffer.alloc(0))).toEqual([
        expect.stringMatching(/^ACK [0-9a-f]{40}\n$/),
      ]);
      expect(packetText(terminal.response)).toEqual(["NAK\n"]);
      expect(frames(terminal.response).rest.subarray(0, 4).toString()).toBe("PACK");
      await runGit(client.dir, ["fsck", "--full"]);
      expect(oracle.errors).toEqual([]);
    } finally {
      await oracle.close();
      remote.dispose();
      seed.dispose();
      client.dispose();
    }
  });
});
