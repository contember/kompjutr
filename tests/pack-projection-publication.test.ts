import { describe, expect, it } from "vitest";
import { fetchInto } from "../packages/git/src/ops/network/network.js";
import { GitFixture } from "./helpers/git.js";
import { startGitServer } from "./helpers/http-backend.js";
import { awaitBarrierEntry, checkpointBarrier } from "./helpers/interleaving.js";
import { reopenTestRepository } from "./helpers/repository-invariants.js";
import { makeRepo } from "./helpers/workspace.js";

describe("pack commit projection publication", () => {
  it("hides staged history during Smart HTTP fetch, interruption, and cold retry", async () => {
    const fixture = new GitFixture().init();
    const commands: string[] = [];
    for (let i = 0; i < 3073; i++) {
      const message = `commit ${i}\n`;
      commands.push(
        `commit refs/heads/main\ncommitter Fixture <fixture@example.com> 1577836800 +0000\ndata ${message.length}\n${message}\n`,
      );
    }
    fixture.gitInput(commands.join(""), "fast-import", "--quiet");
    const head = fixture.git("rev-parse", "HEAD");
    const server = await startGitServer(fixture.dir);
    const workspace = makeRepo("/work");
    const { repo } = workspace;
    const beforeHead = repo.checkout.getRef("HEAD");
    const barrier = checkpointBarrier<boolean>("pending commit projections", Boolean);
    const controller = new AbortController();
    let pendingOid: string | undefined;
    const fetching = fetchInto(
      {
        ...workspace.context,
        async yieldNow() {
          const db = repo.store.db;
          // Recognize the baseline leak as well as the fixed staging phase.
          const staging =
            db.scalar<number>(
              "SELECT count(*) FROM sqlite_master WHERE name = 'git_pack_commit_staging'",
            ) === 1;
          const table = staging ? "git_pack_commit_staging" : "git_commits";
          pendingOid = db.scalar<string>(
            `SELECT c.oid FROM ${table} c
             JOIN git_pack_entries e ON e.repo_id = c.repo_id AND e.oid = c.oid
             JOIN git_pack_meta m ON m.repo_id = e.repo_id AND m.pack_id = e.pack_id
             WHERE m.state = 'pending' LIMIT 1`,
          );
          await barrier.checkpoint(pendingOid !== undefined);
        },
      },
      repo,
      {
        remote: "origin",
        url: server.url,
        singleBranch: false,
        tags: false,
        signal: controller.signal,
      },
    );
    try {
      await awaitBarrierEntry(barrier, fetching);
      if (pendingOid === undefined) throw new Error("staging checkpoint missing");
      const oid = pendingOid;
      const second = reopenTestRepository(workspace, "/work");
      for (const reader of [repo, second.repo]) {
        expect(() => reader.readCommit(oid)).toThrow();
        expect(() => [...reader.walk(oid)]).toThrow();
        expect(reader.store.getRef("refs/remotes/origin/main")).toBeNull();
        expect(reader.checkout.getRef("HEAD")).toBe(beforeHead);
      }
      expect(second.repo.store.packs.reclaimPending()).toBe(0);
      controller.abort();
      barrier.release();
      await expect(fetching).rejects.toMatchObject({ code: "EABORTED" });
      const cold = reopenTestRepository(workspace, "/work");
      expect(() => cold.repo.readCommit(oid)).toThrow();
      expect(() => [...cold.repo.walk(oid)]).toThrow();
      expect(cold.repo.store.getRef("refs/remotes/origin/main")).toBeNull();
      expect(cold.repo.checkout.getRef("HEAD")).toBe(beforeHead);
      expect(cold.repo.store.packs.reclaimPending()).toBe(1);
      expect(
        cold.repo.store.db.scalar<number>("SELECT count(*) FROM git_pack_commit_staging"),
      ).toBe(0);
      await fetchInto(cold.context, cold.repo, {
        remote: "origin",
        url: server.url,
        singleBranch: false,
        tags: false,
      });
      const published = reopenTestRepository(workspace, "/work");
      expect(published.repo.store.getRef("refs/remotes/origin/main")).toBe(head);
      expect([...published.repo.walk(head)].length).toBe(
        Number(fixture.git("rev-list", "--count", "HEAD")),
      );
      expect(published.repo.readCommit(head).message).toBe("commit 3072\n");
      expect(
        published.repo.store.db.scalar<number>("SELECT count(*) FROM git_pack_commit_staging"),
      ).toBe(0);
    } finally {
      controller.abort();
      barrier.release();
      await Promise.allSettled([fetching]);
      await server.close();
      fixture.dispose();
    }
  });
});
