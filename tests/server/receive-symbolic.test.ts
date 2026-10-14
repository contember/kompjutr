import { describe, expect, it } from "vitest";
import { utf8, ZERO_OID } from "../../packages/git/src/common/bytes.js";
import { SqliteGitDatabase } from "../../packages/git/src/index.js";
import type { ReceivePackCommand } from "../../packages/git/src/protocol/receive-pack-types.js";
import { bareServer, pushBytes, pushRequest } from "../helpers/bare-server.js";
import { GitFixture, slices } from "../helpers/git.js";
import { startGitServer } from "../helpers/http-backend.js";
import { assertColdTip, firstYieldBarrier } from "../helpers/server-concurrency.js";
import { packetText } from "../helpers/server-oracle.js";
import { runGit } from "../helpers/server-oracle-http.js";

const MAIN = "refs/heads/main";
const ALIAS = "refs/heads/alias";
const OTHER = "refs/heads/other";

async function report(response: Response): Promise<string[]> {
  expect(response.status).toBe(200);
  return packetText(Buffer.from(await response.arrayBuffer()));
}

function results(lines: readonly string[]): string[] {
  return lines
    .filter((line) => /^(ok|ng) /.test(line))
    .map((line) => line.trim().split(" ").slice(0, 2).join(" "));
}

async function symbolicScenario(scenario: string, collisionPolicy: boolean): Promise<void> {
  const fixture = bareServer();
  const seed = new GitFixture().init();
  const remote = new GitFixture();
  remote.git("init", "--bare", "-q", "-b", "unborn");
  remote.git("config", "http.receivepack", "true");
  const native = await startGitServer(remote.dir);
  try {
    seed.write("file", "first");
    const first = seed.commit("first");
    seed.write("file", "second");
    const second = seed.commit("second");
    const pack = seed.packAll();
    await fixture.store.packs.ingest(slices(pack, 8192));
    await runGit(remote.dir, ["index-pack", "--stdin"], pack);
    const unborn = scenario === "unborn";
    if (!unborn) {
      fixture.store.setRef(MAIN, first);
      remote.git("update-ref", MAIN, first);
    }
    const chained = scenario.includes("chain");
    if (chained) {
      fixture.store.setRef("refs/heads/middle", `ref: ${MAIN}`);
      remote.git("symbolic-ref", "refs/heads/middle", MAIN);
    }
    const target = chained ? "refs/heads/middle" : MAIN;
    fixture.store.setRef(ALIAS, `ref: ${target}`);
    remote.git("symbolic-ref", ALIAS, target);
    const oldOid = unborn ? ZERO_OID : first;
    const deleting = scenario === "delete" || scenario === "two alias deletes";
    const newOid = deleting ? ZERO_OID : second;
    const commands: ReceivePackCommand[] = [{ ref: ALIAS, oldOid, newOid }];
    if (scenario.includes("consistent") || scenario === "delete versus update") {
      commands.push({
        ref: MAIN,
        oldOid: scenario === "inconsistent old" ? ZERO_OID : oldOid,
        newOid:
          scenario === "delete versus update"
            ? ZERO_OID
            : scenario === "inconsistent"
              ? first
              : newOid,
      });
      if (scenario === "consistent reverse") commands.reverse();
    }
    if (scenario.startsWith("two")) {
      fixture.store.setRef(OTHER, `ref: ${target}`);
      remote.git("symbolic-ref", OTHER, target);
      commands.push({ ref: OTHER, oldOid, newOid });
    }
    if (scenario.startsWith("inconsistent") || scenario === "delete versus update")
      commands.push({ ref: "refs/heads/unrelated", oldOid: ZERO_OID, newOid: second });
    const bytes = pushBytes(commands, deleting ? undefined : pack);
    const actual = await report(await fixture.server.fetch(pushRequest(bytes)));
    const expected = await report(
      await fetch(`${native.url}/git-receive-pack`, {
        method: "POST",
        headers: { "Content-Type": "application/x-git-receive-pack-request" },
        body: Uint8Array.from(bytes),
      }),
    );
    if (collisionPolicy) {
      expect(results(actual)).toEqual([`ok ${ALIAS}`, `ng ${OTHER}`]);
      const nativeStatus = scenario === "two aliases" ? "ng" : "ok";
      expect(results(expected)).toEqual([`${nativeStatus} ${ALIAS}`, `${nativeStatus} ${OTHER}`]);
      expect(actual).toContain(`ng ${OTHER} refname conflict\n`);
      const nativeMain = remote.gitResult("rev-parse", "--verify", MAIN);
      expect(nativeMain.status === 0 ? nativeMain.stdout : null).toBe(
        scenario === "two aliases" ? first : deleting ? null : second,
      );
    } else expect(results(actual)).toEqual(results(expected));
    const cold = new SqliteGitDatabase(fixture.db).openBareRepository(fixture.store.repoId);
    for (const name of [ALIAS, MAIN, OTHER, "refs/heads/middle", "refs/heads/unrelated"]) {
      if (collisionPolicy && name === MAIN) continue;
      const symbolic = remote.gitResult("symbolic-ref", "--no-recurse", "-q", name);
      const direct = remote.gitResult("rev-parse", "--verify", name);
      const raw =
        symbolic.status === 0
          ? `ref: ${symbolic.stdout}`
          : direct.status === 0
            ? direct.stdout
            : null;
      expect(cold.getRef(name)).toBe(raw);
    }
    assertColdTip(
      fixture.db,
      fixture.store.repoId,
      seed,
      collisionPolicy ? (deleting ? null : second) : cold.getRef(MAIN),
    );
    expect(cold.getRef(ALIAS)).toBe(`ref: ${target}`);
    if (scenario.startsWith("inconsistent") || scenario === "delete versus update")
      expect(actual.filter((line) => line.includes("inconsistent aliased update"))).toHaveLength(2);
  } finally {
    await native.close();
    remote.dispose();
    seed.dispose();
  }
}

describe("receive-pack symbolic refs", () => {
  it.each([
    "update",
    "delete",
    "unborn",
    "chain",
    "consistent",
    "consistent reverse",
    "inconsistent",
    "inconsistent old",
    "delete versus update",
  ])("matches native symbolic %s publication", async (scenario) => {
    await symbolicScenario(scenario, false);
  });

  it.each(["two aliases", "two alias deletes", "two chained aliases"])(
    "applies first-alias-wins policy for %s and characterizes the native HTTP difference",
    async (scenario) => {
      await symbolicScenario(scenario, true);
    },
  );

  it.each([MAIN, ALIAS, "refs/heads/middle"])(
    "protects checkout HEAD chains when pushing %s",
    async (ref) => {
      const barrier = firstYieldBarrier();
      const fixture = bareServer({ yieldNow: barrier.yieldNow });
      const seed = new GitFixture().init();
      try {
        seed.write("file", "first");
        const first = seed.commit("first");
        fixture.store.setRef(ALIAS, "ref: refs/heads/middle");
        fixture.store.setRef("refs/heads/middle", `ref: ${MAIN}`);
        const pending = fixture.server.fetch(
          pushRequest(pushBytes([{ ref, oldOid: ZERO_OID, newOid: first }], seed.packAll())),
        );
        await barrier.entered;
        fixture.database.createCheckout(fixture.store.repoId, "/attached", `ref: ${ALIAS}`);
        barrier.release();
        expect(await report(await pending)).toContain(
          `ng ${ref} branch is attached to a checkout\n`,
        );
        const cold = new SqliteGitDatabase(fixture.db).openBareRepository(fixture.store.repoId);
        expect(cold.getRef(MAIN)).toBeNull();
        expect(cold.read(first)).toBeNull();
        expect(cold.getRef(ALIAS)).toBe("ref: refs/heads/middle");
      } finally {
        barrier.release();
        seed.dispose();
      }
    },
  );

  it("rejects aliases into internal refs and cyclic refs while allowing unrelated commands", async () => {
    const fixture = bareServer();
    const seed = new GitFixture().init();
    try {
      seed.write("file", "first");
      const first = seed.commit("first");
      await fixture.store.packs.ingest(slices(seed.packAll(), 8192));
      fixture.store.setRef("refs/remotes/origin/main", first);
      fixture.store.setRef(ALIAS, "ref: refs/remotes/origin/main");
      fixture.store.setRef("refs/heads/cycle", "ref: refs/heads/cycle");
      const actual = await report(
        await fixture.server.fetch(
          pushRequest(
            pushBytes([
              { ref: ALIAS, oldOid: first, newOid: ZERO_OID },
              { ref: "refs/heads/cycle", oldOid: ZERO_OID, newOid: first },
              { ref: MAIN, oldOid: ZERO_OID, newOid: first },
            ]),
          ),
        ),
      );
      expect(actual).toContain(`ng ${ALIAS} symbolic ref target is outside served namespaces\n`);
      expect(actual).toContain("ng refs/heads/cycle symbolic ref cannot be resolved\n");
      expect(actual).toContain(`ok ${MAIN}\n`);
      const cold = new SqliteGitDatabase(fixture.db).openBareRepository(fixture.store.repoId);
      expect(cold.getRef("refs/remotes/origin/main")).toBe(first);
      expect(cold.getRef(ALIAS)).toBe("ref: refs/remotes/origin/main");
      assertColdTip(fixture.db, fixture.store.repoId, seed, first);
    } finally {
      seed.dispose();
    }
  });

  it("requires commits for both the wire name and the effective branch destination", async () => {
    for (const [ref, destination] of [
      ["refs/tags/alias", MAIN],
      [ALIAS, "refs/tags/target"],
    ]) {
      if (ref === undefined || destination === undefined) throw new Error("missing fixture name");
      const fixture = bareServer();
      const blob = fixture.store.write("blob", utf8.encode("not a commit"));
      fixture.store.setRef(ref, `ref: ${destination}`);
      const actual = await report(
        await fixture.server.fetch(
          pushRequest(pushBytes([{ ref, oldOid: ZERO_OID, newOid: blob }])),
        ),
      );
      expect(actual[0]).toContain("unpack invalid");
      const cold = new SqliteGitDatabase(fixture.db).openBareRepository(fixture.store.repoId);
      expect(cold.getRef(destination)).toBeNull();
      expect(cold.getRef(ref)).toBe(`ref: ${destination}`);
    }
  });
});
