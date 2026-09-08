import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createGit, type FetchRefspec, type Git } from "../packages/do/src/index.js";
import { worktreeAdd } from "../packages/git/src/ops/worktree/worktrees.js";
import {
  fetchHttpClient,
  type GitHttpClient,
  type GitHttpRequest,
} from "../packages/git/src/protocol/transport.js";
import { PACK_BLOB_BATCH_TARGET_BYTES } from "../packages/git/src/store/index.js";
import { GitFixture } from "./helpers/git.js";
import { type GitServer, startGitServer } from "./helpers/http-backend.js";
import { reopenTestRepository } from "./helpers/repository-invariants.js";
import { makeRepo, type TestRepository } from "./helpers/workspace.js";

let fixture: GitFixture;
let server: GitServer;
let baseOid: string;
let tipOid: string;
let blobOid: string;
let oversizedBlobOid: string;
const TEST_TIME = 1_700_000_000_000;

beforeAll(async () => {
  fixture = new GitFixture().init();
  fixture.write("base.txt", "base\n");
  baseOid = fixture.commit("base");
  fixture.write("tip.txt", "tip\n");
  tipOid = fixture.commit("tip");
  blobOid = fixture.git("hash-object", "-w", "base.txt");
  oversizedBlobOid = fixture.writeObject(
    "blob",
    new Uint8Array(PACK_BLOB_BATCH_TARGET_BYTES + 1).fill(0x61),
  );
  fixture.git("update-ref", "refs/blobs/base", blobOid);
  fixture.git("update-ref", "refs/blobs/oversized", oversizedBlobOid);
  fixture.git("update-ref", "refs/checkpoints/base", baseOid);
  fixture.git("update-ref", "refs/heads/team/\ue000", baseOid);
  fixture.git("update-ref", "refs/heads/team/\u{10000}", tipOid);
  fixture.git("tag", "-a", "release", "-m", "release", tipOid);
  server = await startGitServer(fixture.dir);
});

afterAll(async () => {
  await server.close();
  fixture.dispose();
});

function configured(): { readonly workspace: TestRepository; readonly git: Git } {
  const workspace = makeRepo("/", { startTime: TEST_TIME, now: () => TEST_TIME });
  workspace.repo.store.configSet("remote.origin.url", server.url);
  return { workspace, git: gitFor(workspace) };
}

function gitFor(workspace: TestRepository, http?: GitHttpClient): Git {
  const git = createGit()({
    database: workspace.database,
    worktree: workspace.worktree,
    now: workspace.context.now,
    timezoneOffset: workspace.context.timezoneOffset,
    ...(http === undefined ? {} : { http }),
  });
  return git;
}

function requestsSince(start: number) {
  return server.requests.slice(start);
}

function withoutIncludeTag(request: GitHttpRequest): GitHttpRequest {
  if (request.method !== "POST" || !(request.body instanceof Uint8Array)) return request;
  const decoder = new TextDecoder();
  const encoder = new TextEncoder();
  const frameLength = Number.parseInt(decoder.decode(request.body.subarray(0, 4)), 16);
  if (!Number.isSafeInteger(frameLength) || frameLength < 4 || frameLength > request.body.length) {
    throw new Error("invalid upload-pack request frame");
  }
  const line = decoder.decode(request.body.subarray(4, frameLength));
  const rewritten = line.replace(" include-tag", "");
  if (rewritten === line) return request;
  const payload = encoder.encode(rewritten);
  const header = encoder.encode((payload.length + 4).toString(16).padStart(4, "0"));
  const body = new Uint8Array(header.length + payload.length + request.body.length - frameLength);
  body.set(header);
  body.set(payload, header.length);
  body.set(request.body.subarray(frameLength), header.length + payload.length);
  return { ...request, body };
}

describe("mapped fetch refspecs", () => {
  it("keeps both legacy upload exchanges in one operation", async () => {
    const workspace = makeRepo("/", { startTime: TEST_TIME, now: () => TEST_TIME });
    let posts = 0;
    const http: GitHttpClient = (request) => {
      if (request.method === "POST") posts++;
      return fetchHttpClient(withoutIncludeTag(request));
    };
    workspace.storage.resetCounters();

    const result = await gitFor(workspace, http).fetch({ url: server.url });

    expect(result.mode).toBe("legacy");
    expect(posts).toBe(2);
    expect(workspace.repo.store.getRef("refs/tags/release")).toBe(
      fixture.git("rev-parse", "refs/tags/release"),
    );
    expect(workspace.storage.statementCount).toBeLessThan(1_000);
  });

  it("publishes exact and wildcard destinations atomically in Git byte order", async () => {
    const { workspace, git } = configured();
    const before = server.requests.length;
    workspace.storage.resetCounters();
    const refspecs: readonly [FetchRefspec, ...FetchRefspec[]] = [
      { source: "refs/checkpoints/base", destination: "refs/snapshots/base" },
      { source: "refs/heads/team/*", destination: "refs/remotes/team/*" },
    ];

    const result = await git.fetch({ refspecs });

    expect(result).toEqual({
      mode: "mapped",
      defaultBranch: "refs/heads/main",
      fetchHead: null,
      updates: [
        {
          source: "refs/heads/team/\ue000",
          destination: "refs/remotes/team/\ue000",
          oid: baseOid,
        },
        {
          source: "refs/heads/team/\u{10000}",
          destination: "refs/remotes/team/\u{10000}",
          oid: tipOid,
        },
        {
          source: "refs/checkpoints/base",
          destination: "refs/snapshots/base",
          oid: baseOid,
        },
      ],
    });
    expect(workspace.repo.store.getRef("refs/remotes/team/\ue000")).toBe(baseOid);
    expect(workspace.repo.store.getRef("refs/remotes/team/\u{10000}")).toBe(tipOid);
    expect(workspace.repo.store.getRef("refs/snapshots/base")).toBe(baseOid);
    expect(workspace.repo.store.reflog("refs/snapshots/base")[0]).toMatchObject({
      oldOid: null,
      newOid: baseOid,
      reason: "fetch",
    });
    expect(requestsSince(before).filter((request) => request.method === "GET")).toHaveLength(1);
    expect(requestsSince(before).filter((request) => request.method === "POST")).toHaveLength(1);
    expect(workspace.storage.statementCount).toBeLessThan(1_000);
  });

  it("returns an empty mapped result after discovery without a token or POST", async () => {
    const { workspace, git } = configured();
    const before = server.requests.length;
    const generation = workspace.repo.store.db.one<{ generation: number }>(
      "SELECT fetch_generation AS generation FROM git_repositories WHERE id = ?",
      workspace.repo.store.repoId,
    )?.generation;

    await expect(
      git.fetch({
        refspecs: [{ source: "refs/heads/missing/*", destination: "refs/remotes/missing/*" }],
      }),
    ).resolves.toEqual({
      mode: "mapped",
      defaultBranch: "refs/heads/main",
      fetchHead: null,
      updates: [],
    });

    expect(requestsSince(before).filter((request) => request.method === "GET")).toHaveLength(1);
    expect(requestsSince(before).filter((request) => request.method === "POST")).toHaveLength(0);
    expect(
      workspace.repo.store.db.one<{ generation: number }>(
        "SELECT fetch_generation AS generation FROM git_repositories WHERE id = ?",
        workspace.repo.store.repoId,
      )?.generation,
    ).toBe(generation);
  });

  it("fetches an explicit annotated tag and its peeled target in one exchange", async () => {
    const { workspace, git } = configured();
    const before = server.requests.length;
    const tagOid = fixture.git("rev-parse", "refs/tags/release");

    await expect(
      git.fetch({
        refspecs: [{ source: "refs/tags/release", destination: "refs/tags/release" }],
      }),
    ).resolves.toMatchObject({
      mode: "mapped",
      updates: [{ destination: "refs/tags/release", oid: tagOid }],
    });

    expect(workspace.repo.store.getRef("refs/tags/release")).toBe(tagOid);
    expect(workspace.repo.store.has(tipOid)).toBe(true);
    expect(requestsSince(before).filter((request) => request.method === "POST")).toHaveLength(1);
  });

  it("authenticates a mapped root above the object batching target as a singleton", async () => {
    const { workspace, git } = configured();

    await expect(
      git.fetch({
        refspecs: [{ source: "refs/blobs/oversized", destination: "refs/snapshots/oversized" }],
      }),
    ).resolves.toMatchObject({
      mode: "mapped",
      updates: [{ destination: "refs/snapshots/oversized", oid: oversizedBlobOid }],
    });

    expect(workspace.repo.store.getRef("refs/snapshots/oversized")).toBe(oversizedBlobOid);
    expect(workspace.repo.read(oversizedBlobOid).data).toHaveLength(
      PACK_BLOB_BATCH_TARGET_BYTES + 1,
    );
  });

  it("rejects a corrupt loose peeled-target shadow during tag-chain authentication", async () => {
    const { workspace, git } = configured();
    const tagOid = fixture.git("rev-parse", "refs/tags/release");
    await git.fetch({
      refspecs: [{ source: "refs/tags/release", destination: "refs/tags/packed" }],
    });
    const packed = workspace.repo.store.read(tipOid);
    if (packed === null || packed.type !== "commit") {
      throw new Error("fetched peeled target is missing");
    }
    expect(workspace.repo.store.readAuthenticatedObject(tagOid, "tag")).not.toBeNull();
    workspace.repo.store.write("blob", new Uint8Array([1]));
    const corrupt = packed.data.slice();
    corrupt[corrupt.length - 1] = (corrupt.at(-1) ?? 0) ^ 1;
    workspace.repo.store.db.run(
      `INSERT INTO git_objects (repo_id, oid, type, size, stored)
       VALUES (?, ?, 'commit', ?, 'raw')`,
      workspace.repo.store.repoId,
      tipOid,
      corrupt.length,
    );
    workspace.repo.store.db.run(
      "INSERT INTO git_object_chunks (repo_id, oid, seq, data) VALUES (?, ?, 0, ?)",
      workspace.repo.store.repoId,
      tipOid,
      corrupt,
    );
    const destination = "refs/tags/corrupt-peeled-shadow";

    await expect(
      git.fetch({
        refspecs: [{ source: "refs/tags/release", destination }],
      }),
    ).rejects.toMatchObject({ code: "ECORRUPT" });

    expect(workspace.repo.store.getRef(destination)).toBeNull();
    expect(workspace.repo.store.reflog(destination)).toEqual([]);
    const cold = reopenTestRepository(workspace);
    expect(cold.repo.store.getRef(destination)).toBeNull();
    expect(cold.repo.store.reflog(destination)).toEqual([]);
    expect(
      cold.repo.store.db.scalar<number>(
        "SELECT count(*) FROM git_pack_meta WHERE repo_id = ? AND state = 'complete'",
        cold.repo.store.repoId,
      ),
    ).toBeGreaterThan(0);
  });

  it("requires force to replace an existing tag and rejects before POST", async () => {
    const { workspace, git } = configured();
    const mapping = {
      source: "refs/tags/release",
      destination: "refs/tags/release",
    };
    try {
      await git.fetch({ refspecs: [mapping] });
      const original = workspace.repo.store.getRef(mapping.destination);
      fixture.git("tag", "-f", "release", baseOid);
      const before = server.requests.length;

      await expect(git.fetch({ refspecs: [mapping] })).rejects.toMatchObject({
        code: "ETAGFAIL",
      });
      expect(workspace.repo.store.getRef(mapping.destination)).toBe(original);
      expect(requestsSince(before).filter((request) => request.method === "POST")).toHaveLength(0);

      await git.fetch({ refspecs: [{ ...mapping, force: true }] });
      expect(workspace.repo.store.getRef(mapping.destination)).toBe(baseOid);
    } finally {
      fixture.git("tag", "-f", "-a", "release", "-m", "release", tipOid);
    }
  });

  it("requires a branch fast-forward unless force is explicit", async () => {
    const { workspace, git } = configured();
    const mapping = {
      source: "refs/heads/main",
      destination: "refs/heads/fetched",
    };
    try {
      await git.fetch({ refspecs: [mapping] });
      expect(workspace.repo.store.getRef(mapping.destination)).toBe(tipOid);

      fixture.git("update-ref", "refs/heads/main", baseOid);
      await expect(git.fetch({ refspecs: [mapping] })).rejects.toMatchObject({
        code: "ENONFASTFORWARD",
      });
      expect(workspace.repo.store.getRef(mapping.destination)).toBe(tipOid);

      await expect(git.fetch({ refspecs: [{ ...mapping, force: true }] })).resolves.toMatchObject({
        mode: "mapped",
        updates: [{ destination: mapping.destination, oid: baseOid }],
      });
      expect(workspace.repo.store.getRef(mapping.destination)).toBe(baseOid);
    } finally {
      fixture.git("update-ref", "refs/heads/main", tipOid);
    }
  });

  it("retains authenticated object residue but no ref after a forbidden branch target", async () => {
    const { workspace, git } = configured();
    const destination = "refs/heads/blob-target";

    await expect(
      git.fetch({
        refspecs: [{ source: "refs/blobs/base", destination }],
      }),
    ).rejects.toMatchObject({ code: "EINVALIDREF" });

    expect(workspace.repo.store.getRef(destination)).toBeNull();
    expect(workspace.repo.store.reflog(destination)).toEqual([]);
    expect(workspace.repo.store.has(blobOid)).toBe(true);
    const cold = reopenTestRepository(workspace);
    expect(cold.repo.store.getRef(destination)).toBeNull();
    expect(cold.repo.store.has(blobOid)).toBe(true);
  });

  it("rejects checked-out destinations before issuing a token or POST", async () => {
    const { workspace, git } = configured();
    const before = server.requests.length;
    const generation = workspace.repo.store.db.one<{ generation: number }>(
      "SELECT fetch_generation AS generation FROM git_repositories WHERE id = ?",
      workspace.repo.store.repoId,
    )?.generation;

    await expect(
      git.fetch({
        refspecs: [{ source: "refs/heads/main", destination: "refs/heads/main" }],
      }),
    ).rejects.toMatchObject({ code: "EBRANCHFAIL" });

    expect(requestsSince(before).filter((request) => request.method === "POST")).toHaveLength(0);
    expect(
      workspace.repo.store.db.one<{ generation: number }>(
        "SELECT fetch_generation AS generation FROM git_repositories WHERE id = ?",
        workspace.repo.store.repoId,
      )?.generation,
    ).toBe(generation);
  });

  it("checks linked checkouts as well as the primary checkout", async () => {
    const { workspace, git } = configured();
    const mapping = {
      source: "refs/heads/main",
      destination: "refs/heads/linked",
    };
    await git.fetch({ refspecs: [mapping] });
    worktreeAdd(workspace.context, workspace.repo, {
      root: "/linked",
      target: { kind: "existing-branch", name: "linked" },
    });
    const before = server.requests.length;

    await expect(git.fetch({ refspecs: [mapping] })).rejects.toMatchObject({
      code: "EBRANCHFAIL",
    });

    expect(requestsSince(before).filter((request) => request.method === "POST")).toHaveLength(0);
  });

  it("rejects mapped legacy fields and destination collisions before mutation", async () => {
    const { git } = configured();
    const before = server.requests.length;
    const mixed = {
      depth: 1,
      refspecs: [{ source: "refs/heads/main", destination: "refs/snapshots/main" }],
    };

    await expect(Reflect.apply(git.fetch, git, [mixed])).rejects.toMatchObject({ code: "EINVAL" });
    await expect(
      Reflect.apply(git.fetch, git, [
        {
          refspecs: [{ source: "main", destination: "refs/snapshots/main" }],
        },
      ]),
    ).rejects.toMatchObject({ code: "EINVALIDREF" });
    await expect(
      git.fetch({
        refspecs: [
          { source: "refs/heads/main", destination: "refs/snapshots/same" },
          { source: "refs/checkpoints/base", destination: "refs/snapshots/same" },
        ],
      }),
    ).rejects.toMatchObject({ code: "EINVAL" });
    await expect(
      git.fetch({
        refspecs: [{ source: "refs/checkpoints/missing", destination: "refs/snapshots/missing" }],
      }),
    ).rejects.toMatchObject({ code: "EREFNOTFOUND" });

    expect(requestsSince(before).filter((request) => request.method === "POST")).toHaveLength(0);
  });

  it("admits exactly 1,024 mappings under the structural limit", async () => {
    const { workspace, git } = configured();
    const refspecs = Array.from({ length: 1_024 }, (_, index) => ({
      source: "refs/checkpoints/base",
      destination: `refs/load/${index.toString().padStart(4, "0")}`,
    }));
    workspace.storage.resetCounters();

    await expect(Reflect.apply(git.fetch, git, [{ refspecs }])).resolves.toMatchObject({
      mode: "mapped",
      fetchHead: null,
    });

    expect(workspace.repo.store.listRefs("refs/load/")).toHaveLength(1_024);
    expect(workspace.storage.statementCount).toBeLessThan(1_000);

    const before = server.requests.length;
    await expect(
      Reflect.apply(git.fetch, git, [
        {
          refspecs: [
            ...refspecs,
            { source: "refs/checkpoints/base", destination: "refs/load/excess" },
          ],
        },
      ]),
    ).rejects.toMatchObject({ code: "E2BIG" });
    expect(server.requests).toHaveLength(before);
  });

  it("publishes the former first-excess ref set atomically and survives cold reopen", () => {
    const { workspace } = configured();
    const oid = workspace.repo.store.write("blob", new TextEncoder().encode("budget\n"));
    const rows = Array.from({ length: 1_024 }, (_, index) => ({
      name: `refs/checkpoints/budget-first-excess/${index.toString().padStart(4, "0")}`,
      target: oid,
    }));
    const metadata = {
      actor: { name: "Fetch Bot", email: "fetch@example.test" },
      reason: "fetch",
      timestamp: TEST_TIME / 1_000,
      timezoneOffset: 0,
    };
    const first = rows[0];
    if (first === undefined) throw new Error("missing first publication row");
    const publication = workspace.repo.store.beginFetchPublication(
      "refs/remotes/budget-first-excess/",
      rows.map((row) => row.name),
    );
    try {
      expect(
        workspace.repo.store.publishFetchRefs(publication, { exactPuts: rows }, metadata),
      ).toBe(true);
    } finally {
      publication.dispose();
    }
    expect(workspace.repo.store.listRefs("refs/checkpoints/budget-first-excess/")).toEqual(rows);
    expect(workspace.repo.store.reflog(first.name)).toHaveLength(1);
    const cold = reopenTestRepository(workspace);
    expect(cold.repo.store.listRefs("refs/checkpoints/budget-first-excess/")).toEqual(rows);
    expect(cold.repo.store.reflog(first.name)).toHaveLength(1);
  });

  it("keeps refs and reflogs unchanged after a truncated pack and cold reopen", async () => {
    const failing = await startGitServer(fixture.dir, { truncatePostAfter: 200 });
    const workspace = makeRepo();
    const destination = "refs/snapshots/truncated";
    try {
      await expect(
        gitFor(workspace).fetch({
          url: failing.url,
          refspecs: [{ source: "refs/heads/main", destination }],
        }),
      ).rejects.toMatchObject({ code: "EHTTP" });

      expect(workspace.repo.store.getRef(destination)).toBeNull();
      expect(workspace.repo.store.reflog(destination)).toEqual([]);
      const cold = reopenTestRepository(workspace);
      expect(cold.repo.store.getRef(destination)).toBeNull();
      expect(cold.repo.store.reflog(destination)).toEqual([]);
    } finally {
      await failing.close();
    }
  });

  it("retries only a 401 POST and reuses byte-identical request content", async () => {
    const workspace = makeRepo();
    const bodies: Uint8Array[] = [];
    let authCalls = 0;
    const http: GitHttpClient = async (request) => {
      if (request.method !== "POST") return fetchHttpClient(request);
      if (!(request.body instanceof Uint8Array)) {
        throw new Error("mapped fetch POST body must be replayable bytes");
      }
      bodies.push(request.body.slice());
      if (bodies.length > 1) return fetchHttpClient(request);
      return {
        status: 401,
        statusText: "Unauthorized",
        headers: { "www-authenticate": 'Basic realm="git"' },
        body: (async function* (): AsyncGenerator<Uint8Array> {
          yield new TextEncoder().encode("authentication required\n");
        })(),
      };
    };

    await expect(
      gitFor(workspace, http).fetch({
        url: server.url,
        refspecs: [
          { source: "refs/checkpoints/base", destination: "refs/snapshots/authenticated" },
        ],
        onAuth: () => {
          authCalls++;
          return { username: "fixture", password: "secret" };
        },
      }),
    ).resolves.toMatchObject({ mode: "mapped" });

    expect(authCalls).toBe(1);
    expect(bodies).toHaveLength(2);
    expect(bodies[1]).toEqual(bodies[0]);
    expect(workspace.repo.store.getRef("refs/snapshots/authenticated")).toBe(baseOid);
  });
});
