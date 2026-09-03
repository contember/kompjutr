import { join } from "node:path";

import { afterAll, describe, expect, it } from "vitest";

import { concat } from "../src/git/common/bytes.js";
import { serializeCommit, serializeTag, serializeTree } from "../src/git/common/objects.js";
import { openRepository } from "../src/git/ops/core/context.js";
import { clone } from "../src/git/ops/network/network.js";
import {
  authenticatePushBranchTargets,
  disposePushPlan,
  MAX_PUSH_BRANCH_TARGETS,
  MAX_PUSH_COMMITS,
  openPushPack,
  type PushPlan,
  planPushUpdates,
  pushPlanHasObject,
  pushPlanObjectCount,
  pushPlanObjectOidAt,
} from "../src/git/ops/push/push-plan.js";
import type { PushPlanningUpdate } from "../src/git/ops/refs/refspec.js";
import { FLUSH, pkt } from "../src/git/protocol/pktline.js";
import { receivePack, ZERO_OID } from "../src/git/protocol/receive-pack.js";
import { discover } from "../src/git/protocol/remote.js";
import { fetchHttpClient, type GitHttpClient } from "../src/git/protocol/transport.js";
import { GitFixture } from "./helpers/git.js";
import { startGitServer } from "./helpers/http-backend.js";
import { makeRepo, makeWorkspace } from "./helpers/workspace.js";

const fixtures: GitFixture[] = [];
afterAll(() => {
  for (const fixture of fixtures) fixture.dispose();
});

const person = {
  name: "Agent",
  email: "agent@example.com",
  timestamp: 1_600_000_000,
  timezoneOffset: 0,
};

async function collect(body: AsyncIterable<Uint8Array>): Promise<Uint8Array> {
  const chunks: Uint8Array[] = [];
  for await (const chunk of body) chunks.push(chunk);
  return concat(chunks);
}

async function* once(body: Uint8Array): AsyncGenerator<Uint8Array> {
  yield body;
}

async function collectBody(
  body: Uint8Array | AsyncIterable<Uint8Array> | undefined,
): Promise<Uint8Array> {
  if (body === undefined) return new Uint8Array(0);
  return body instanceof Uint8Array ? body : collect(body);
}

function requirePlan(plan: PushPlan | null): PushPlan {
  if (plan === null) throw new Error("expected a non-delete push plan");
  return plan;
}

function planOids(plan: PushPlan): string[] {
  const result: string[] = [];
  for (let index = 0; index < pushPlanObjectCount(plan); index++) {
    const oid = pushPlanObjectOidAt(plan, index);
    if (oid === null) throw new Error("push plan lost an object");
    result.push(oid);
  }
  return result;
}

function update(
  source: string,
  destination: string,
  oid: string,
  oldOid = ZERO_OID,
  force = false,
): PushPlanningUpdate {
  return { source, destination, oid, oldOid, force };
}

describe("post-push branch target authentication", () => {
  it("authenticates direct commits", () => {
    const workspace = makeRepo();
    const tree = workspace.repo.store.write("tree", serializeTree([]));
    const commit = workspace.repo.store.write(
      "commit",
      serializeCommit({
        tree,
        parent: [],
        author: person,
        committer: person,
        message: "target\n",
      }),
    );
    expect(() => authenticatePushBranchTargets(workspace.repo, [commit])).not.toThrow();
  });

  it("rejects tags and blobs while classifying missing and corrupt commits as local failures", () => {
    const workspace = makeRepo();
    const blob = workspace.repo.store.write("blob", new TextEncoder().encode("blob\n"));
    const tree = workspace.repo.store.write("tree", serializeTree([]));
    const commit = workspace.repo.store.write(
      "commit",
      serializeCommit({
        tree,
        parent: [],
        author: person,
        committer: person,
        message: "target\n",
      }),
    );
    const tag = workspace.repo.store.write(
      "tag",
      serializeTag({ object: commit, type: "commit", tag: "target", message: "target\n" }),
    );
    for (const oid of [tag, blob]) {
      expect(() => authenticatePushBranchTargets(workspace.repo, [oid])).toThrow(
        expect.objectContaining({ code: "EINVALIDREF" }),
      );
    }

    expect(() => authenticatePushBranchTargets(workspace.repo, ["f".repeat(40)])).toThrow(
      expect.objectContaining({ code: "EPUSHLOCAL" }),
    );

    workspace.repo.store.db.run(
      "UPDATE git_object_chunks SET data = zeroblob(length(data)) WHERE repo_id = ? AND oid = ?",
      1,
      commit,
    );
    expect(() => authenticatePushBranchTargets(workspace.repo, [commit])).toThrow(
      expect.objectContaining({ code: "EPUSHLOCAL" }),
    );
  });

  it("accepts the exact input bound after deduplication and rejects the first excess", () => {
    const workspace = makeRepo();
    const tree = workspace.repo.store.write("tree", serializeTree([]));
    const commit = workspace.repo.store.write(
      "commit",
      serializeCommit({
        tree,
        parent: [],
        author: person,
        committer: person,
        message: "target\n",
      }),
    );

    authenticatePushBranchTargets(workspace.repo, [commit]);

    authenticatePushBranchTargets(
      workspace.repo,
      Array.from({ length: MAX_PUSH_BRANCH_TARGETS }, () => commit),
    );

    expect(() =>
      authenticatePushBranchTargets(
        workspace.repo,
        Array.from({ length: MAX_PUSH_BRANCH_TARGETS + 1 }, () => commit),
      ),
    ).toThrow(expect.objectContaining({ code: "E2BIG" }));

    for (const oid of [ZERO_OID, "not-an-object-id"]) {
      expect(() => authenticatePushBranchTargets(workspace.repo, [oid])).toThrow(
        expect.objectContaining({ code: "EINVAL" }),
      );
    }
  });
});

describe("multi-ref push planning", () => {
  it("sends one deterministic union pack for commits, tags, a tree, a blob, force and deletion", async () => {
    const fixture = new GitFixture().init();
    fixtures.push(fixture);
    fixture.write("base.txt", "base\n");
    const base = fixture.commit("base");
    const origin = join(fixture.dir, "origin.git");
    fixture.git("clone", "-q", "--bare", ".", origin);
    fixture.git(`--git-dir=${origin}`, "config", "http.receivepack", "true");
    fixture.git(`--git-dir=${origin}`, "update-ref", "refs/heads/delete-me", base);
    fixture.git(`--git-dir=${origin}`, "update-ref", "refs/checkpoints/forced", base);
    const server = await startGitServer(origin);
    try {
      const workspace = makeWorkspace();
      await clone(workspace.context, { url: server.url, dir: "/" });
      const repo = openRepository(workspace.context, "/");
      const baseCommit = repo.readCommit(base);
      const baseTree = repo.readTree(baseCommit.tree);
      const blobA = repo.store.write("blob", new TextEncoder().encode("branch a\n"));
      const treeA = repo.store.write(
        "tree",
        serializeTree([...baseTree, { mode: "100644", name: "branch-a.txt", oid: blobA }]),
      );
      const commitA = repo.store.write(
        "commit",
        serializeCommit({
          tree: treeA,
          parent: [base],
          author: person,
          committer: person,
          message: "branch a\n",
        }),
      );
      const blobB = repo.store.write("blob", new TextEncoder().encode("branch b\n"));
      const treeB = repo.store.write(
        "tree",
        serializeTree([...baseTree, { mode: "100644", name: "branch-b.txt", oid: blobB }]),
      );
      const commitB = repo.store.write(
        "commit",
        serializeCommit({
          tree: treeB,
          parent: [base],
          author: person,
          committer: person,
          message: "branch b\n",
        }),
      );
      const annotated = repo.store.write(
        "tag",
        serializeTag({ object: commitA, type: "commit", tag: "annotated", message: "release\n" }),
      );
      const directBlob = repo.store.write("blob", new TextEncoder().encode("direct\n"));
      const directTree = repo.store.write(
        "tree",
        serializeTree([{ mode: "100644", name: "direct.txt", oid: directBlob }]),
      );
      repo.store.setRef("refs/heads/local-a", commitA);
      repo.store.setRef("refs/heads/local-b", commitB);
      repo.store.setRef("refs/tags/local-light", commitA);
      repo.store.setRef("refs/tags/local-annotated", annotated);

      const updates: PushPlanningUpdate[] = [
        update("refs/heads/local-a", "refs/heads/branch-a", commitA),
        update("refs/heads/local-b", "refs/heads/branch-b", commitB),
        update("refs/tags/local-light", "refs/tags/light", commitA),
        update("refs/tags/local-annotated", "refs/tags/annotated", annotated),
        update(commitB, "refs/checkpoints/commit", commitB),
        update(directTree, "refs/checkpoints/tree", directTree),
        update(directBlob, "refs/checkpoints/blob", directBlob),
        update(directBlob, "refs/checkpoints/forced", directBlob, base, true),
        {
          source: null,
          destination: "refs/heads/delete-me",
          oid: null,
          oldOid: base,
          force: false,
        },
      ];
      const unprovenAdvertisement = directBlob;
      const plan = requirePlan(
        planPushUpdates(repo, updates, { remoteOids: [base, unprovenAdvertisement] }),
      );
      const planned = planOids(plan);
      expect(new Set(planned).size).toBe(planned.length);
      expect(plan.newCommits).toBe(2);
      expect(pushPlanHasObject(plan, base)).toBe(false);
      expect(pushPlanHasObject(plan, baseCommit.tree)).toBe(false);
      expect(pushPlanHasObject(plan, annotated)).toBe(true);
      expect(pushPlanHasObject(plan, directTree)).toBe(true);
      expect(pushPlanHasObject(plan, directBlob)).toBe(true);

      const firstPack = await collect(openPushPack(repo, plan));
      const reorderedPlan = requirePlan(
        planPushUpdates(repo, [...updates].reverse(), {
          remoteOids: [base, unprovenAdvertisement],
        }),
      );
      expect(planOids(reorderedPlan)).toEqual(planned);
      expect(await collect(openPushPack(repo, reorderedPlan))).toEqual(firstPack);
      disposePushPlan(reorderedPlan);
      const captured: Uint8Array[] = [];
      const http: GitHttpClient = async (request) => {
        if (request.method === "GET") return fetchHttpClient(request);
        const body = await collectBody(request.body);
        captured.push(body);
        return fetchHttpClient({ ...request, body });
      };
      const advertisement = await discover(server.url, "git-receive-pack", { http });
      const commands = updates.map((item) => ({
        oldOid: item.oldOid,
        newOid: item.oid ?? ZERO_OID,
        ref: item.destination,
      }));
      const status = await receivePack(
        {
          url: server.url,
          commands,
          advertised: advertisement.capabilities,
          pack: () => openPushPack(repo, plan),
        },
        { http },
      );
      expect([...status.refs.values()].every((item) => item.ok)).toBe(true);
      const requestBody = captured[0];
      if (requestBody === undefined) throw new Error("receive-pack did not send a body");
      expect(requestBody.subarray(requestBody.length - firstPack.length)).toEqual(firstPack);
      expect(fixture.git(`--git-dir=${origin}`, "rev-parse", "refs/heads/branch-a")).toBe(commitA);
      expect(fixture.git(`--git-dir=${origin}`, "rev-parse", "refs/tags/annotated")).toBe(
        annotated,
      );
      expect(fixture.git(`--git-dir=${origin}`, "rev-parse", "refs/checkpoints/tree")).toBe(
        directTree,
      );
      expect(
        fixture.gitResult(`--git-dir=${origin}`, "show-ref", "--verify", "refs/heads/delete-me")
          .status,
      ).toBeGreaterThan(0);
      disposePushPlan(plan);
    } finally {
      await server.close();
    }
  });

  it("preflights branch, tag and custom namespace force rules", () => {
    const workspace = makeRepo();
    const repo = workspace.repo;
    const blob = repo.store.write("blob", new TextEncoder().encode("value\n"));
    const tree = repo.store.write(
      "tree",
      serializeTree([{ mode: "100644", name: "value.txt", oid: blob }]),
    );
    const commit = repo.store.write(
      "commit",
      serializeCommit({
        tree,
        parent: [],
        author: person,
        committer: person,
        message: "root\n",
      }),
    );
    repo.store.setRef("refs/heads/commit", commit);
    repo.store.setRef("refs/tags/blob", blob);

    const cases: { update: PushPlanningUpdate; code: string }[] = [
      { update: update("refs/tags/blob", "refs/heads/not-commit", blob), code: "EINVALIDREF" },
      {
        update: update("refs/heads/commit", "refs/heads/non-ff", commit, "1".repeat(40)),
        code: "ENONFASTFORWARD",
      },
      {
        update: update("refs/tags/blob", "refs/tags/existing", blob, "2".repeat(40)),
        code: "ETAGFAIL",
      },
      {
        update: update("refs/tags/blob", "refs/checkpoints/existing", blob, commit),
        code: "ENONFASTFORWARD",
      },
    ];
    for (const entry of cases) {
      expect(() => planPushUpdates(repo, [entry.update])).toThrowError(
        expect.objectContaining({ code: entry.code }),
      );
    }

    const forced = requirePlan(
      planPushUpdates(repo, [
        update("refs/tags/blob", "refs/checkpoints/existing", blob, commit, true),
      ]),
    );
    expect(planOids(forced)).toEqual([blob]);
    disposePushPlan(forced);
  });

  it("returns no pack for 1,024 deletion commands and rejects the first excess", () => {
    const workspace = makeRepo();
    const deletions: PushPlanningUpdate[] = Array.from({ length: 1_024 }, (_, index) => ({
      source: null,
      destination: `refs/checkpoints/delete-${index}`,
      oid: null,
      oldOid: "1".repeat(40),
      force: false,
    }));
    expect(planPushUpdates(workspace.repo, deletions)).toBeNull();

    const duplicate = deletions[0];
    if (duplicate === undefined) throw new Error("deletion fixture is empty");
    expect(() => planPushUpdates(workspace.repo, [...deletions, duplicate])).toThrow(
      expect.objectContaining({ code: "E2BIG" }),
    );
  });

  it("plans 1,024 authoritative source-ref snapshots without scalar ref reads", () => {
    const workspace = makeRepo();
    const blob = workspace.repo.store.write("blob", new TextEncoder().encode("shared\n"));
    const updates = Array.from({ length: 1_024 }, (_, index) =>
      update(`refs/checkpoints/source-${index}`, `refs/checkpoints/destination-${index}`, blob),
    );
    workspace.storage.histogram = new Map();
    const statementStart = workspace.storage.statementCount;
    const plan = requirePlan(planPushUpdates(workspace.repo, updates));
    const observedStatements = workspace.storage.statementCount - statementStart;
    expect(pushPlanObjectCount(plan)).toBe(1);
    expect(
      [...workspace.storage.histogram].filter(([query]) =>
        query.startsWith("SELECT target FROM git_refs WHERE repo_id = ? AND name = ?"),
      ),
    ).toEqual([]);
    expect(observedStatements).toBeLessThan(1_000);
    disposePushPlan(plan);
  });

  it("classifies a missing full-oid source as a safe local failure", () => {
    const workspace = makeRepo();
    const missing = "f".repeat(40);
    expect(() =>
      planPushUpdates(workspace.repo, [update(missing, "refs/checkpoints/missing", missing)]),
    ).toThrow(expect.objectContaining({ code: "EPUSHLOCAL" }));
  });

  it("rejects a corrupt source, missing transitive object and shallow boundary locally", () => {
    const corruptWorkspace = makeRepo();
    const corruptBlob = corruptWorkspace.repo.store.write(
      "blob",
      new TextEncoder().encode("corrupt me\n"),
    );
    corruptWorkspace.repo.store.db.run(
      "UPDATE git_object_chunks SET data = zeroblob(length(data)) WHERE repo_id = ? AND oid = ?",
      1,
      corruptBlob,
    );
    expect(() =>
      planPushUpdates(corruptWorkspace.repo, [
        update(corruptBlob, "refs/checkpoints/corrupt", corruptBlob),
      ]),
    ).toThrow(expect.objectContaining({ code: "EPUSHLOCAL" }));

    const missingWorkspace = makeRepo();
    const missingOid = "e".repeat(40);
    const incompleteTree = missingWorkspace.repo.store.write(
      "tree",
      serializeTree([{ mode: "100644", name: "missing.txt", oid: missingOid }]),
    );
    expect(() =>
      planPushUpdates(missingWorkspace.repo, [
        update(incompleteTree, "refs/checkpoints/incomplete", incompleteTree),
      ]),
    ).toThrow(expect.objectContaining({ code: "EPUSHLOCAL" }));

    const shallowWorkspace = makeRepo();
    const emptyTree = shallowWorkspace.repo.store.write("tree", serializeTree([]));
    const parent = shallowWorkspace.repo.store.write(
      "commit",
      serializeCommit({
        tree: emptyTree,
        parent: [],
        author: person,
        committer: person,
        message: "parent\n",
      }),
    );
    const shallow = shallowWorkspace.repo.store.write(
      "commit",
      serializeCommit({
        tree: emptyTree,
        parent: [parent],
        author: person,
        committer: person,
        message: "shallow\n",
      }),
    );
    shallowWorkspace.repo.store.setShallow([shallow]);
    expect(() =>
      planPushUpdates(shallowWorkspace.repo, [update(shallow, "refs/heads/shallow", shallow)]),
    ).toThrow(expect.objectContaining({ code: "EPUSHLOCAL" }));
  });

  it("enforces exact union commit and object limits", () => {
    const objectWorkspace = makeRepo();
    const firstBlob = objectWorkspace.repo.store.write("blob", new TextEncoder().encode("a\n"));
    const secondBlob = objectWorkspace.repo.store.write("blob", new TextEncoder().encode("b\n"));
    const objectTree = objectWorkspace.repo.store.write(
      "tree",
      serializeTree([
        { mode: "100644", name: "a", oid: firstBlob },
        { mode: "100644", name: "b", oid: secondBlob },
      ]),
    );
    const exactObjects = requirePlan(
      planPushUpdates(
        objectWorkspace.repo,
        [update(objectTree, "refs/checkpoints/exact-objects", objectTree)],
        { maxObjects: 3 },
      ),
    );
    expect(pushPlanObjectCount(exactObjects)).toBe(3);
    disposePushPlan(exactObjects);

    expect(() =>
      planPushUpdates(
        objectWorkspace.repo,
        [update(objectTree, "refs/checkpoints/excess-objects", objectTree)],
        { maxObjects: 2 },
      ),
    ).toThrow(expect.objectContaining({ code: "E2BIG" }));

    const exactWorkspace = makeRepo();
    const tree = exactWorkspace.repo.store.write("tree", serializeTree([]));
    let tip = "";
    for (let index = 0; index < MAX_PUSH_COMMITS; index++) {
      tip = exactWorkspace.repo.store.write(
        "commit",
        serializeCommit({
          tree,
          parent: tip === "" ? [] : [tip],
          author: person,
          committer: person,
          message: `commit ${index}\n`,
        }),
      );
    }
    const exact = requirePlan(
      planPushUpdates(exactWorkspace.repo, [update(tip, "refs/heads/exact-commits", tip)]),
    );
    expect(exact.newCommits).toBe(MAX_PUSH_COMMITS);
    disposePushPlan(exact);

    const excessTip = exactWorkspace.repo.store.write(
      "commit",
      serializeCommit({
        tree,
        parent: [tip],
        author: person,
        committer: person,
        message: "first excess\n",
      }),
    );
    expect(() =>
      planPushUpdates(exactWorkspace.repo, [
        update(excessTip, "refs/heads/excess-commits", excessTip),
      ]),
    ).toThrow(expect.objectContaining({ code: "E2BIG" }));
  });

  it("plans a large commit graph", () => {
    const workspace = makeRepo();
    const tree = workspace.repo.store.write("tree", serializeTree([]));
    const message = "x".repeat(900_000);
    let tip = "";
    for (let index = 0; index < 10; index++) {
      tip = workspace.repo.store.write(
        "commit",
        serializeCommit({
          tree,
          parent: tip === "" ? [] : [tip],
          author: person,
          committer: person,
          message,
        }),
      );
    }
    const currentTip = tip;
    const plan = requirePlan(
      planPushUpdates(workspace.repo, [update(currentTip, "refs/heads/large-graph", currentTip)]),
    );

    expect(plan.newCommits).toBe(10);
    disposePushPlan(plan);
  });

  it("lets a long canonical source and destination reach receive-pack framing", async () => {
    const workspace = makeRepo();
    const blob = workspace.repo.store.write("blob", new TextEncoder().encode("long ref\n"));
    const components = Array.from(
      { length: 8 },
      (_, index) => `${String(index).padStart(2, "0")}-${"r".repeat(140)}`,
    ).join("/");
    const source = `refs/checkpoints/source/${components}`;
    const destination = `refs/checkpoints/destination/${components}`;
    const plan = requirePlan(planPushUpdates(workspace.repo, [update(source, destination, blob)]));
    let requestBody: Uint8Array | undefined;
    const http: GitHttpClient = async (request) => {
      requestBody = await collectBody(request.body);
      return {
        status: 200,
        statusText: "OK",
        headers: { "content-type": "application/x-git-receive-pack-result" },
        body: once(concat([pkt("unpack ok\n"), pkt(`ok ${destination}\n`), FLUSH])),
      };
    };

    const result = await receivePack(
      {
        url: "http://host/repo",
        commands: [{ oldOid: ZERO_OID, newOid: blob, ref: destination }],
        advertised: new Set(["report-status"]),
      },
      { http },
    );

    expect(destination.length).toBeGreaterThan(1_024);
    expect(result.refs.get(destination)).toEqual({ ok: true });
    if (requestBody === undefined) throw new Error("receive-pack did not send a request body");
    expect(new TextDecoder().decode(requestBody)).toContain(destination);
    disposePushPlan(plan);
  });

  it("does not reach receive-pack when local preflight fails", async () => {
    const workspace = makeRepo();
    const blob = workspace.repo.store.write("blob", new TextEncoder().encode("not a commit\n"));
    let posts = 0;
    const http: GitHttpClient = async () => {
      posts++;
      throw new Error("unexpected HTTP request");
    };
    await expect(
      (async () => {
        const plan = planPushUpdates(workspace.repo, [
          update(blob, "refs/heads/not-a-commit", blob),
        ]);
        await receivePack(
          {
            url: "http://host/repo",
            commands: [{ oldOid: ZERO_OID, newOid: blob, ref: "refs/heads/not-a-commit" }],
            advertised: new Set(["report-status"]),
            ...(plan === null ? {} : { pack: () => openPushPack(workspace.repo, plan) }),
          },
          { http },
        );
      })(),
    ).rejects.toMatchObject({ code: "EINVALIDREF" });
    expect(posts).toBe(0);
  });
});

describe("push pack lifecycle", () => {
  it("allows two replayable pack reads and rejects the third", async () => {
    const workspace = makeRepo();
    const blob = workspace.repo.store.write("blob", new TextEncoder().encode("one\n"));
    const plan = requirePlan(
      planPushUpdates(workspace.repo, [update(blob, "refs/checkpoints/blob", blob)]),
    );
    const first = await collect(openPushPack(workspace.repo, plan));
    const second = await collect(openPushPack(workspace.repo, plan));
    expect(second).toEqual(first);
    await expect(collect(openPushPack(workspace.repo, plan))).rejects.toMatchObject({
      code: "EPUSHLOCAL",
    });
    disposePushPlan(plan);
  });

  it("marks a disposed plan unavailable while its active stream closes", async () => {
    const workspace = makeRepo();
    const blob = workspace.repo.store.write("blob", new TextEncoder().encode("one\n"));
    const plan = requirePlan(
      planPushUpdates(workspace.repo, [update(blob, "refs/checkpoints/blob", blob)]),
    );
    const stream = openPushPack(workspace.repo, plan);
    expect((await stream.next()).done).toBe(false);
    disposePushPlan(plan);
    expect(() => pushPlanObjectCount(plan)).toThrow(expect.objectContaining({ code: "EINVAL" }));
    await expect(collect(openPushPack(workspace.repo, plan))).rejects.toMatchObject({
      code: "EINVAL",
    });
    await stream.return(undefined);
  });
});
