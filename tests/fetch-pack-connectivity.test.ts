import { execFile } from "node:child_process";
import { join } from "node:path";
import { promisify } from "node:util";
import { describe, expect, it, vi } from "vitest";
import { utf8 } from "../packages/git/src/common/bytes.js";
import {
  MODE_FILE,
  MODE_TREE,
  type ObjectType,
  type TreeEntry,
} from "../packages/git/src/common/objects.js";
import { openRepository } from "../packages/git/src/ops/core/context.js";
import { clone, fetchInto } from "../packages/git/src/ops/network/network.js";
import { beginFetchConnectivity } from "../packages/git/src/ops/network/network-reachability.js";
import type { CloneOptions } from "../packages/git/src/ops/network/network-types.js";
import type { Repository } from "../packages/git/src/ops/repository/repository.js";
import { fetchHttpClient, type GitHttpClient } from "../packages/git/src/protocol/transport.js";
import { PackReferenceCollector } from "../packages/git/src/store/pack/ingest/ingest-references.js";
import {
  ANCESTRY_WALK,
  blobObject as blob,
  commitObject,
  completePacks,
  fetchPacked as fetchFresh,
  packOf,
  statementsOf,
  tagObject,
  treeObject as tree,
  withoutIncludeTag,
} from "./helpers/fetch-pack.js";
import { GitFixture, slices } from "./helpers/git.js";
import { startGitServer } from "./helpers/http-backend.js";
import { makeRepo, makeWorkspace } from "./helpers/workspace.js";

const execFileAsync = promisify(execFile);

function expectRejected(
  state: Awaited<ReturnType<typeof fetchFresh>>,
  code: string,
  message?: string,
): void {
  expect(state.outcome).toMatchObject(message === undefined ? { code } : { code, message });
  expect(state.refsChanged).toBe(false);
  expect(state.packsAdded).toBe(0);
  expect(state.promisesAdded).toBe(0);
}

/** A fixture with history, a deleted file, a subdirectory, an annotated tag and a gitlink. */
function historyFixture(): GitFixture {
  const fixture = new GitFixture().init();
  fixture.write("old.txt", "historical\n");
  fixture.write("dir/nested.txt", "nested\n");
  fixture.commit("first");
  fixture.remove("old.txt");
  fixture.write("dir/nested.txt", "nested again\n");
  fixture.write("current.txt", "current\n");
  fixture.commit("second");
  fixture.git("tag", "-a", "v1", "-m", "release");
  fixture.git("checkout", "-q", "-b", "topic");
  fixture.write("topic.txt", "topic only\n");
  fixture.commit("topic");
  fixture.git("checkout", "-q", "main");
  // A gitlink names a commit no pack carries; neither Git nor the check follows it.
  fixture.git("update-index", "--add", "--cacheinfo", `160000,${"1".repeat(40)},vendor/sub`);
  fixture.git("commit", "-q", "-m", "gitlink");
  fixture.git("config", "uploadpack.allowFilter", "true");
  return fixture;
}

async function nativePromises(url: string): Promise<Set<string>> {
  const target = new GitFixture();
  try {
    const env = {
      ...process.env,
      GIT_TERMINAL_PROMPT: "0",
      GIT_CONFIG_GLOBAL: "/dev/null",
      GIT_CONFIG_SYSTEM: "/dev/null",
    };
    await execFileAsync("git", ["clone", "-q", "--no-checkout", "--filter=blob:none", url, "c"], {
      cwd: target.dir,
      env,
    });
    const { stdout } = await execFileAsync(
      "git",
      ["rev-list", "--objects", "--all", "--missing=print"],
      { cwd: join(target.dir, "c"), env, maxBuffer: 1 << 26 },
    );
    return new Set(
      stdout
        .split("\n")
        .filter((line) => line.startsWith("?"))
        .map((line) => line.slice(1)),
    );
  } finally {
    target.dispose();
  }
}

describe("per-pack connectivity accepts", () => {
  it.each<[string, Pick<CloneOptions, "filter" | "depth">]>([
    ["a full clone", {}],
    ["a blob:none clone", { filter: "blob:none" }],
    ["a --depth clone", { depth: 1 }],
  ])("publishes %s without a reachability walk", async (_name, options) => {
    const fixture = new GitFixture().init();
    fixture.write("a.txt", "a\n");
    fixture.commit("first");
    fixture.write("dir/b.txt", "b\n");
    const head = fixture.commit("second");
    fixture.git("config", "uploadpack.allowFilter", "true");
    const server = await startGitServer(fixture.dir);
    const workspace = makeWorkspace();
    try {
      const { statements } = await statementsOf(workspace, () =>
        clone(workspace.context, { url: server.url, dir: "/work", ...options }),
      );
      const repo = openRepository(workspace.context, "/work");
      expect(repo.head().oid).toBe(head);
      expect(repo.store.getRef("refs/remotes/origin/main")).toBe(head);
      expect(statements.has(ANCESTRY_WALK)).toBe(false);
    } finally {
      await server.close();
      fixture.dispose();
    }
  });

  it("promises exactly the blobs native Git reports missing, and skips gitlinks", async () => {
    const fixture = historyFixture();
    const server = await startGitServer(fixture.dir);
    const workspace = makeRepo("/work");
    const { repo, context } = workspace;
    try {
      repo.store.configSet("remote.origin.url", server.url);
      const { statements } = await statementsOf(workspace, () =>
        fetchInto(context, repo, {
          remote: "origin",
          singleBranch: false,
          tags: true,
          filter: "blob:none",
        }),
      );
      const promised = new Set([...repo.store.iteratePromisedBlobs()].map((entry) => entry.oid));
      const native = await nativePromises(server.url);
      expect(native.size).toBeGreaterThan(0);
      expect(promised).toEqual(native);
      expect(statements.has(ANCESTRY_WALK)).toBe(false);
      expect(repo.store.getRef("refs/remotes/origin/topic")).toBe(
        fixture.git("rev-parse", "topic"),
      );
    } finally {
      await server.close();
      fixture.dispose();
    }
  });

  it("does not check a gitlink in an unfiltered fetch", async () => {
    const fixture = historyFixture();
    const server = await startGitServer(fixture.dir);
    const { repo, context } = makeRepo("/work");
    try {
      repo.store.configSet("remote.origin.url", server.url);
      await fetchInto(context, repo, { remote: "origin", singleBranch: false, tags: true });
      expect(repo.store.getRef("refs/remotes/origin/main")).toBe(fixture.git("rev-parse", "main"));
      expect(repo.store.promisedBlobCount()).toBe(0);
    } finally {
      await server.close();
      fixture.dispose();
    }
  });

  it("resolves the tag-follow second pack into the first", async () => {
    const fixture = new GitFixture().init();
    fixture.write("file.txt", "tagged\n");
    const tagged = fixture.commit("tagged");
    fixture.git("tag", "-a", "v1", "-m", "release");
    const server = await startGitServer(fixture.dir);
    const { repo, context } = makeRepo("/work");
    let posts = 0;
    const http: GitHttpClient = (request) => {
      if (request.method === "POST") posts++;
      return fetchHttpClient(withoutIncludeTag(request));
    };
    try {
      repo.store.configSet("remote.origin.url", server.url);
      await fetchInto({ ...context, http }, repo, { remote: "origin" });
      const tag = repo.store.getRef("refs/tags/v1");
      if (tag === null) throw new Error("annotated tag was not fetched");
      expect(repo.peel(tag)).toBe(tagged);
      expect(posts).toBe(2);
      expect(completePacks(repo)).toBe(2);
    } finally {
      await server.close();
      fixture.dispose();
    }
  });

  it("wants a fallback tag a concurrent write made present on a fresh store", async () => {
    const fixture = new GitFixture().init();
    fixture.write("file.txt", "tagged\n");
    const tagged = fixture.commit("tagged");
    fixture.git("tag", "-a", "v1", "-m", "release");
    const tag = fixture.git("rev-parse", "v1");
    const server = await startGitServer(fixture.dir);
    const { repo, context } = makeRepo("/work");
    let posts = 0;
    const http: GitHttpClient = (request) => {
      if (request.method === "POST") posts++;
      return fetchHttpClient(withoutIncludeTag(request));
    };
    let written = false;
    try {
      repo.store.configSet("remote.origin.url", server.url);
      await fetchInto({ ...context, http }, repo, { remote: "origin" }, "fetch", {
        checkpoint: (stage) => {
          // Another writer publishes the tag object between the two rounds.
          if (stage !== "after-ingest" || written) return undefined;
          repo.store.write("tag", fixture.catFile(tag));
          written = true;
          return undefined;
        },
      });
      expect(written).toBe(true);
      expect(posts).toBe(2);
      expect(repo.store.getRef("refs/tags/v1")).toBe(tag);
      expect(repo.peel(tag)).toBe(tagged);
    } finally {
      await server.close();
      fixture.dispose();
    }
  });

  it("accepts a missing parent of a shallow boundary commit", async () => {
    const file = blob("file\n");
    const root = tree([{ mode: MODE_FILE, name: "file", oid: file.oid }]);
    const commit = commitObject(root.oid, ["2".repeat(40)]);
    const state = await fetchFresh([commit, root, file], commit.oid, { shallow: [commit.oid] });
    expect(state.outcome).toBeNull();
    expect(state.refsChanged).toBe(true);
  });
});

describe("per-pack connectivity rejects on a fresh store", () => {
  const file = blob("file\n");

  function rooted(entries: TreeEntry[], parents: readonly string[] = []) {
    const root = tree(entries);
    return { root, commit: commitObject(root.oid, parents) };
  }

  it("a tree naming a missing subtree", async () => {
    const { root, commit } = rooted([{ mode: MODE_TREE, name: "dir", oid: "3".repeat(40) }]);
    expectRejected(
      await fetchFresh([commit, root], commit.oid),
      "EFETCHFAIL",
      "fetched graph references a missing object",
    );
  });

  it("a missing parent outside the shallow boundary", async () => {
    const { root, commit } = rooted(
      [{ mode: MODE_FILE, name: "file", oid: file.oid }],
      ["4".repeat(40)],
    );
    expectRejected(await fetchFresh([commit, root, file], commit.oid), "EFETCHFAIL");
  });

  it("a blob-mode entry naming a tree object", async () => {
    const subtree = tree([{ mode: MODE_FILE, name: "file", oid: file.oid }]);
    const { root, commit } = rooted([{ mode: MODE_FILE, name: "file", oid: subtree.oid }]);
    expectRejected(
      await fetchFresh([commit, root, subtree, file], commit.oid),
      "ECORRUPT",
      `fetched graph requires ${subtree.oid} to be a blob`,
    );
  });

  it.each<[string, (root: string) => { oid: string; type: ObjectType; data: Uint8Array }[]]>([
    ["is missing", () => [tagObject("5".repeat(40), "commit", "lost")]],
    ["has another type", (root) => [tagObject(root, "commit", "wrong")]],
  ])("a tag whose target %s", async (name, tags) => {
    const { root, commit } = rooted([{ mode: MODE_FILE, name: "file", oid: file.oid }]);
    const state = await fetchFresh([commit, root, file, ...tags(root.oid)], commit.oid);
    expectRejected(state, name === "is missing" ? "EFETCHFAIL" : "ECORRUPT");
  });

  it("a dangling unreachable object with a missing reference", async () => {
    const { root, commit } = rooted([{ mode: MODE_FILE, name: "file", oid: file.oid }]);
    const dangling = tree([{ mode: MODE_FILE, name: "lost", oid: "6".repeat(40) }]);
    expectRejected(await fetchFresh([commit, root, file, dangling], commit.oid), "EFETCHFAIL");
  });

  it("a filtered fetch still requires every tree", async () => {
    const { root, commit } = rooted([
      { mode: MODE_FILE, name: "file", oid: file.oid },
      { mode: MODE_TREE, name: "dir", oid: "7".repeat(40) },
    ]);
    expectRejected(await fetchFresh([commit, root], commit.oid, { filter: true }), "EFETCHFAIL");
  });

  it("a root only an unchecked local write supplied", async () => {
    // The pack omits the root commit; a local write supplies it while the pack streams.
    const { root, commit } = rooted([{ mode: MODE_FILE, name: "file", oid: file.oid }]);
    let written = false;
    const state = await fetchFresh([root, file], commit.oid, {
      checkpoint(stage, repo) {
        if (stage !== "pack-ingest" || written) return;
        repo.store.write("commit", commit.data);
        written = true;
      },
    });
    expect(written).toBe(true);
    expect(state.outcome).toMatchObject({
      code: "EFETCHFAIL",
      message: "fetched graph references a missing object",
    });
    expect(state.refsChanged).toBe(false);
    expect(state.promisesAdded).toBe(0);
  });

  it("a shallow boundary that changed during ingest", async () => {
    const { root, commit } = rooted([{ mode: MODE_FILE, name: "file", oid: file.oid }]);
    let moved = false;
    const state = await fetchFresh([commit, root, file], commit.oid, {
      checkpoint(stage, repo) {
        if (stage !== "pack-ingest" || moved) return;
        repo.store.setShallow(["8".repeat(40)]);
        moved = true;
      },
    });
    expect(moved).toBe(true);
    expectRejected(state, "ESTALE", "shallow boundary changed during pack ingest");
  });

  it("rolls back promises written before a later publication failure", async () => {
    const { root, commit } = rooted([{ mode: MODE_FILE, name: "file", oid: file.oid }]);
    const { repo } = makeRepo("/work");
    const run = vi.spyOn(repo.store.db, "run");
    await expect(
      repo.store.packs.ingest(slices(packOf([commit, root]), 4096), {
        connectivity: {
          reachability: null,
          trees: repo.store,
          promisor: { remoteName: "origin", url: "https://example.test/repo.git" },
          shallow: [],
          unshallow: [],
          acceptedPacks: [],
        },
        lifecycle: {
          reserved: () => undefined,
          published: () => {
            throw new Error("publication failed after promises");
          },
        },
      }),
    ).rejects.toThrow(/publication failed after promises/);
    expect(run.mock.calls.some(([query]) => query.includes("INSERT INTO git_promised"))).toBe(true);
    expect(repo.store.promisedBlobCount()).toBe(0);
    expect(completePacks(repo)).toBe(0);
  });
});

describe("fresh-store detection", () => {
  it.each<[string, (repo: Repository) => Promise<unknown> | unknown]>([
    ["a loose object", (repo) => repo.store.write("blob", utf8.encode("loose only\n"))],
    [
      "a complete pack",
      (repo) => repo.store.packs.ingest(slices(packOf([blob("packed only\n")]), 4096)),
    ],
    [
      "a promise",
      (repo) => {
        repo.store.registerPromisorRemote("other", "https://example.test/other.git");
        repo.store.addPromisedBlobs("other", ["9".repeat(40)]);
      },
    ],
  ])("treats a store holding only %s as non-fresh", async (_name, seed) => {
    const fixture = new GitFixture().init();
    fixture.write("a.txt", "a\n");
    const head = fixture.commit("first");
    const server = await startGitServer(fixture.dir);
    const { repo, context } = makeRepo("/work");
    try {
      repo.store.configSet("remote.origin.url", server.url);
      expect(beginFetchConnectivity(context, repo, undefined).reachability).toBeNull();
      await seed(repo);
      expect(beginFetchConnectivity(context, repo, undefined).reachability).not.toBeNull();
      await fetchInto(context, repo, { remote: "origin" });
      expect(repo.store.getRef("refs/remotes/origin/main")).toBe(head);
    } finally {
      await server.close();
      fixture.dispose();
    }
  });
});

describe("pack reference collector", () => {
  it("keeps probe chains short for OIDs that share their leading words", () => {
    const collector = new PackReferenceCollector(16, new Set());
    const count = 20_000;
    for (let index = 0; index < count; index++) {
      collector.addObject(`${"0".repeat(32)}${index.toString(16).padStart(8, "0")}`, "blob");
    }
    // Uniform hashing at this load probes about a hundred slots at worst; keying on the
    // shared leading word would probe every earlier entry.
    expect(collector.longestProbe).toBeLessThan(count / 20);
    expect([...collector.unresolved()]).toEqual([]);
  });
});
