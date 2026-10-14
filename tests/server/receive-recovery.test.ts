import { describe, expect, it } from "vitest";
import { ZERO_OID } from "../../packages/git/src/common/bytes.js";
import { createGitServer, SqliteGitDatabase } from "../../packages/git/src/index.js";
import { PACK_INGEST_LEASE_MS } from "../../packages/git/src/store/pack/shared.js";
import { bareServer, pushBytes, pushRequest, streamPushRequest } from "../helpers/bare-server.js";
import { GitFixture } from "../helpers/git.js";

function gate() {
  let open = () => {};
  const promise = new Promise<void>((resolve) => {
    open = resolve;
  });
  return { promise, open };
}

describe("receive-pack recovery", () => {
  it("cleans provisional storage on abort and retains committed state when the response is lost", async () => {
    const fixture = bareServer();
    const seed = new GitFixture().init();
    try {
      seed.write("file", "data");
      const oid = seed.commit("initial");
      const command = { oldOid: ZERO_OID, newOid: oid, ref: "refs/heads/main" };
      const pack = seed.packAll();
      const controller = new AbortController();
      let pulls = 0;
      let canceled = false;
      const request = streamPushRequest(
        {
          pull(stream) {
            if (pulls++ === 0) stream.enqueue(pushBytes([command], pack.subarray(0, 12)));
            else controller.abort("disconnected");
          },
          cancel() {
            canceled = true;
          },
        },
        controller.signal,
      );
      expect((await fixture.server.fetch(request)).status).toBe(400);
      expect(canceled).toBe(true);
      expect(fixture.store.getRef(command.ref)).toBeNull();
      expect(fixture.db.scalar("SELECT count(*) FROM git_pack_meta")).toBe(0);
      const successful = await fixture.server.fetch(pushRequest(pushBytes([command], pack)));
      await successful.body?.cancel("client disappeared before reading status");
      const reopened = new SqliteGitDatabase(fixture.db).openBareRepository(fixture.store.repoId);
      expect(reopened.getRef(command.ref)).toBe(oid);
      expect(reopened.read(oid)?.type).toBe("commit");
      expect(reopened.reflog(command.ref)).toHaveLength(1);
    } finally {
      seed.dispose();
    }
  });

  it("rejects concurrent receive before publication and checks a newly attached checkout", async () => {
    const entered = gate();
    const resume = gate();
    let first = true;
    const fixture = bareServer({
      yieldNow: async () => {
        if (first) {
          first = false;
          entered.open();
          await resume.promise;
        }
      },
    });
    const seed = new GitFixture().init();
    try {
      seed.write("file", "data");
      const oid = seed.commit("initial");
      const bytes = pushBytes(
        [{ oldOid: ZERO_OID, newOid: oid, ref: "refs/heads/main" }],
        seed.packAll(),
      );
      const pending = fixture.server.fetch(pushRequest(bytes));
      await entered.promise;
      expect((await fixture.server.fetch(pushRequest(bytes))).status).toBe(409);
      fixture.database.createCheckout(fixture.store.repoId, "/late", "ref: refs/heads/main");
      resume.open();
      expect(await (await pending).text()).toContain("branch is attached");
      expect(fixture.store.getRef("refs/heads/main")).toBeNull();
      expect(fixture.db.scalar("SELECT count(*) FROM git_pack_meta")).toBe(0);
    } finally {
      resume.open();
      seed.dispose();
    }
  });

  it("an expired ingest cannot remove or undo the successor's publication", async () => {
    const entered = gate();
    const resume = gate();
    let first = true;
    let now = 1_800_000_000_000;
    const fixture = bareServer({
      now: () => now,
      yieldNow: async () => {
        if (first) {
          first = false;
          entered.open();
          await resume.promise;
        }
      },
    });
    const seed = new GitFixture().init();
    try {
      seed.write("file", "data");
      const oid = seed.commit("initial");
      const bytes = pushBytes(
        [{ oldOid: ZERO_OID, newOid: oid, ref: "refs/heads/main" }],
        seed.packAll(),
      );
      const obsolete = fixture.server.fetch(pushRequest(bytes));
      await entered.promise;
      now += PACK_INGEST_LEASE_MS + 1;
      const coldStore = new SqliteGitDatabase(fixture.db).openBareRepository(fixture.store.repoId);
      const successor = createGitServer(coldStore, { maxPackBytes: 1_000_000, now: () => now });
      expect(await (await successor.fetch(pushRequest(bytes))).text()).toContain("unpack ok");
      resume.open();
      expect((await obsolete).status).toBe(409);
      expect(coldStore.getRef("refs/heads/main")).toBe(oid);
      expect(coldStore.read(oid)?.type).toBe("commit");
      expect(fixture.db.scalar("SELECT count(*) FROM git_pack_meta WHERE state = 'complete'")).toBe(
        1,
      );
    } finally {
      resume.open();
      seed.dispose();
    }
  });

  it("rechecks repository completeness after the network await", async () => {
    const entered = gate();
    const resume = gate();
    let first = true;
    const fixture = bareServer({
      yieldNow: async () => {
        if (first) {
          first = false;
          entered.open();
          await resume.promise;
        }
      },
    });
    const seed = new GitFixture().init();
    try {
      seed.write("file", "data");
      const oid = seed.commit("initial");
      const pending = fixture.server.fetch(
        pushRequest(
          pushBytes([{ oldOid: ZERO_OID, newOid: oid, ref: "refs/heads/main" }], seed.packAll()),
        ),
      );
      await entered.promise;
      fixture.store.setShallow([oid]);
      resume.open();
      expect(await (await pending).text()).toContain("unpack invalid");
      expect(fixture.store.getRef("refs/heads/main")).toBeNull();
      expect(fixture.db.scalar("SELECT count(*) FROM git_pack_meta")).toBe(0);
    } finally {
      resume.open();
      seed.dispose();
    }
  });
  it("rolls back object visibility and refs when publication fails after the ref write", async () => {
    const fixture = bareServer();
    const seed = new GitFixture().init();
    const run = fixture.db.run.bind(fixture.db);
    try {
      seed.write("file", "data");
      const oid = seed.commit("initial");
      fixture.db.run = (query, ...bindings) => {
        if (query.includes("INSERT INTO git_reflog_entries"))
          throw new Error("injected publication failure");
        run(query, ...bindings);
      };
      const response = await fixture.server.fetch(
        pushRequest(
          pushBytes([{ oldOid: ZERO_OID, newOid: oid, ref: "refs/heads/main" }], seed.packAll()),
        ),
      );
      fixture.db.run = run;
      expect(response.status).toBe(500);
      expect(fixture.store.getRef("refs/heads/main")).toBeNull();
      expect(fixture.store.read(oid)).toBeNull();
      expect(fixture.store.reflog("refs/heads/main")).toEqual([]);
      expect(fixture.db.scalar("SELECT count(*) FROM git_pack_meta")).toBe(0);
      const reopened = new SqliteGitDatabase(fixture.db).openBareRepository(fixture.store.repoId);
      expect(reopened.read(oid)).toBeNull();
    } finally {
      fixture.db.run = run;
      seed.dispose();
    }
  });
});
