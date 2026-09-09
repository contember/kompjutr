import { describe, expect, it } from "vitest";
import { Workspace } from "../packages/do/src/runtime/workspace.js";
import { createGit } from "../packages/git/src/client.js";
import { utf8 } from "../packages/git/src/common/bytes.js";
import {
  PROVISIONAL_CLONE_LEASE_MS,
  PROVISIONAL_CLONE_RENEW_WINDOW_MS,
} from "../packages/git/src/store/index.js";
import { GitFixture } from "./helpers/git.js";
import { startGitServer } from "./helpers/http-backend.js";
import { SqliteTestStorage } from "./helpers/storage.js";

const START = 90_000;
const ACQUIRE =
  "INSERT INTO git_meta (key, value) VALUES (?, '') ON CONFLICT(key) DO NOTHING RETURNING key";
const RELEASE = "DELETE FROM git_meta WHERE key = ?";

function fixtureWithFiles(): GitFixture {
  const fixture = new GitFixture().init();
  fixture.write("README.md", "heartbeat clone\n");
  fixture.write("nested/file.txt", "nested heartbeat\n");
  fixture.commit("heartbeat fixture");
  return fixture;
}

async function expectPublished(runtime: Workspace, fixture: GitFixture): Promise<void> {
  await expect(runtime.git.revParse({ dir: "/repo", ref: "HEAD" })).resolves.toBe(
    fixture.git("rev-parse", "HEAD"),
  );
  for (const path of ["README.md", "nested/file.txt"]) {
    expect(runtime.filesystem.readFile(`/repo/${path}`)).toEqual(
      utf8.encode(`${fixture.git("show", `HEAD:${path}`)}\n`),
    );
  }
  expect(fixture.git("status", "--porcelain")).toBe("");
  await expect(runtime.git.status({ dir: "/repo" })).resolves.toEqual([]);
}

describe("clone heartbeat", () => {
  it("does not acquire mutation guards for non-due streamed checkpoints", async () => {
    const fixture = fixtureWithFiles();
    const server = await startGitServer(fixture.dir);
    const storage = new SqliteTestStorage();
    let yields = 0;
    const runtime = new Workspace({
      storage,
      git: createGit(),
      now: () => START,
      yieldNow: async () => {
        yields++;
      },
    });
    try {
      storage.histogram = new Map();
      storage.resetCounters();
      await runtime.git.clone({ url: server.url, dir: "/repo" });
      const counts = {
        statements: storage.statementCount,
        acquisitions: storage.histogram.get(ACQUIRE) ?? 0,
        releases: storage.histogram.get(RELEASE) ?? 0,
        yields,
      };
      console.log("fixed-clock clone SQL", counts);
      expect(yields).toBeGreaterThan(2);
      // Only reservation, config, fetched refs, local refs, and ready publication need guards.
      expect(counts.acquisitions).toBe(5);
      expect(counts.releases).toBe(counts.acquisitions);
      await expectPublished(runtime, fixture);
      await expectPublished(
        new Workspace({ storage, git: createGit(), now: () => START }),
        fixture,
      );
    } finally {
      await server.close();
      fixture.dispose();
    }
  });

  it("renews at exact window equality but not one millisecond before it", async () => {
    const fixture = fixtureWithFiles();
    const server = await startGitServer(fixture.dir);
    const storage = new SqliteTestStorage();
    let clock = START;
    let stage = 0;
    const initialExpiry = START + PROVISIONAL_CLONE_LEASE_MS;
    const threshold = initialExpiry - PROVISIONAL_CLONE_RENEW_WINDOW_MS;
    const renewedExpiry = threshold + PROVISIONAL_CLONE_LEASE_MS;
    const runtime = new Workspace({
      storage,
      git: createGit(),
      now: () => clock,
      yieldNow: async () => {
        const expiry = runtime.db.scalar<number>(
          "SELECT clone_expires_ms FROM git_repositories WHERE lifecycle = 'provisional'",
        );
        if (stage === 0) {
          expect(expiry).toBe(initialExpiry);
          clock = threshold - 1;
        } else if (stage === 1) {
          expect(expiry).toBe(initialExpiry);
          clock = threshold;
        } else if (stage === 2) {
          expect(expiry).toBe(renewedExpiry);
          clock = renewedExpiry - PROVISIONAL_CLONE_RENEW_WINDOW_MS;
        } else if (stage === 3) {
          expect(expiry).toBe(clock + PROVISIONAL_CLONE_LEASE_MS);
        }
        stage++;
      },
    });
    try {
      await runtime.git.clone({ url: server.url, dir: "/repo" });
      expect(stage).toBeGreaterThan(3);
      await expectPublished(runtime, fixture);
      await expectPublished(
        new Workspace({ storage, git: createGit(), now: () => clock }),
        fixture,
      );
    } finally {
      await server.close();
      fixture.dispose();
    }
  });
});
