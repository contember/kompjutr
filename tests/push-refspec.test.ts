import { join } from "node:path";

import { afterAll, describe, expect, it } from "vitest";

import { concat } from "../src/core/bytes.js";
import { openRepository } from "../src/core/context.js";
import { serializeCommit, serializeTag, serializeTree } from "../src/core/objects.js";
import { clone } from "../src/core/ops/network.js";
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
} from "../src/core/ops/push-plan.js";
import type { PushPlanningUpdate } from "../src/core/ops/refspec.js";
import { TransportOperationBudget } from "../src/core/ops/transport-budget.js";
import { FLUSH, pkt } from "../src/core/protocol/pktline.js";
import { receivePack, ZERO_OID } from "../src/core/protocol/receive-pack.js";
import { discover } from "../src/core/protocol/remote.js";
import { fetchHttpClient, type GitHttpClient } from "../src/core/protocol/transport.js";
import type { Repository } from "../src/core/repository.js";
import { MAX_OPERATION_MEMORY_BYTES } from "../src/memory.js";
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

function operation(repo: Repository): {
  budget: TransportOperationBudget;
  reservation: ReturnType<Repository["store"]["reserveMemory"]>;
} {
  const reservation = repo.store.reserveMemory();
  return { budget: new TransportOperationBudget(reservation), reservation };
}

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
  it("authenticates direct commits in one caller-owned budget and cleans retained state", () => {
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
    const { budget, reservation } = operation(workspace.repo);
    budget.setMemory("caller", 256);

    authenticatePushBranchTargets(workspace.repo, [commit], budget);

    expect(budget.memory("push-branch-target-auth")).toBe(0);
    expect(budget.memory("push-branch-target-auth-read")).toBe(0);
    expect(budget.memory("caller")).toBe(256);
    budget.clearMemory("caller");
    reservation.dispose();
    workspace.repo.store.memory.assertIdle();
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
      const { budget, reservation } = operation(workspace.repo);
      expect(() => authenticatePushBranchTargets(workspace.repo, [oid], budget)).toThrow(
        expect.objectContaining({ code: "EINVALIDREF" }),
      );
      expect(budget.retainedBytes).toBe(0);
      reservation.dispose();
    }

    const missing = operation(workspace.repo);
    expect(() =>
      authenticatePushBranchTargets(workspace.repo, ["f".repeat(40)], missing.budget),
    ).toThrow(expect.objectContaining({ code: "EPUSHLOCAL" }));
    expect(missing.budget.retainedBytes).toBe(0);
    missing.reservation.dispose();

    workspace.repo.store.db.run(
      "UPDATE git_object_chunks SET data = zeroblob(length(data)) WHERE repo_id = ? AND oid = ?",
      1,
      commit,
    );
    const corrupt = operation(workspace.repo);
    expect(() => authenticatePushBranchTargets(workspace.repo, [commit], corrupt.budget)).toThrow(
      expect.objectContaining({ code: "EPUSHLOCAL" }),
    );
    expect(corrupt.budget.retainedBytes).toBe(0);
    corrupt.reservation.dispose();
    workspace.repo.store.memory.assertIdle();
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

    const single = operation(workspace.repo);
    authenticatePushBranchTargets(workspace.repo, [commit], single.budget);
    single.reservation.dispose();

    const exact = operation(workspace.repo);
    authenticatePushBranchTargets(
      workspace.repo,
      Array.from({ length: MAX_PUSH_BRANCH_TARGETS }, () => commit),
      exact.budget,
    );
    expect(exact.budget.retainedBytes).toBe(0);
    exact.reservation.dispose();

    const excess = operation(workspace.repo);
    expect(() =>
      authenticatePushBranchTargets(
        workspace.repo,
        Array.from({ length: MAX_PUSH_BRANCH_TARGETS + 1 }, () => commit),
        excess.budget,
      ),
    ).toThrow(expect.objectContaining({ code: "E2BIG" }));
    expect(excess.budget.retainedBytes).toBe(0);
    excess.reservation.dispose();

    const bounded = operation(workspace.repo);
    bounded.budget.setMemory("caller", MAX_OPERATION_MEMORY_BYTES);
    expect(() => authenticatePushBranchTargets(workspace.repo, [commit], bounded.budget)).toThrow(
      expect.objectContaining({ code: "E2BIG" }),
    );
    expect(bounded.budget.memory("push-branch-target-auth")).toBe(0);
    expect(bounded.budget.memory("push-branch-target-auth-read")).toBe(0);
    expect(bounded.budget.memory("caller")).toBe(MAX_OPERATION_MEMORY_BYTES);
    bounded.budget.clearMemory("caller");
    bounded.reservation.dispose();

    const malformed = operation(workspace.repo);
    for (const oid of [ZERO_OID, "not-an-object-id"]) {
      expect(() => authenticatePushBranchTargets(workspace.repo, [oid], malformed.budget)).toThrow(
        expect.objectContaining({ code: "EINVAL" }),
      );
      expect(malformed.budget.retainedBytes).toBe(0);
    }
    malformed.reservation.dispose();
    workspace.repo.store.memory.assertIdle();
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
      const { budget, reservation } = operation(repo);
      const unprovenAdvertisement = directBlob;
      const plan = requirePlan(
        planPushUpdates(repo, updates, budget, { remoteOids: [base, unprovenAdvertisement] }),
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
      const reorderedOperation = operation(repo);
      const reorderedPlan = requirePlan(
        planPushUpdates(repo, [...updates].reverse(), reorderedOperation.budget, {
          remoteOids: [base, unprovenAdvertisement],
        }),
      );
      expect(planOids(reorderedPlan)).toEqual(planned);
      expect(await collect(openPushPack(repo, reorderedPlan))).toEqual(firstPack);
      disposePushPlan(reorderedPlan);
      reorderedOperation.reservation.dispose();
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
        { http, operationBudget: budget },
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
      reservation.dispose();
      repo.store.memory.assertIdle();
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
      const { budget, reservation } = operation(repo);
      expect(() => planPushUpdates(repo, [entry.update], budget)).toThrowError(
        expect.objectContaining({ code: entry.code }),
      );
      reservation.dispose();
    }

    const { budget, reservation } = operation(repo);
    const forced = requirePlan(
      planPushUpdates(
        repo,
        [update("refs/tags/blob", "refs/checkpoints/existing", blob, commit, true)],
        budget,
      ),
    );
    expect(planOids(forced)).toEqual([blob]);
    disposePushPlan(forced);
    reservation.dispose();
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
    const exact = operation(workspace.repo);
    expect(planPushUpdates(workspace.repo, deletions, exact.budget)).toBeNull();
    expect(exact.budget.retainedBytes).toBe(0);
    exact.reservation.dispose();

    const excess = operation(workspace.repo);
    const duplicate = deletions[0];
    if (duplicate === undefined) throw new Error("deletion fixture is empty");
    expect(() => planPushUpdates(workspace.repo, [...deletions, duplicate], excess.budget)).toThrow(
      expect.objectContaining({ code: "E2BIG" }),
    );
    excess.reservation.dispose();
  });

  it("plans 1,024 authoritative source-ref snapshots without scalar ref reads", () => {
    const workspace = makeRepo();
    const blob = workspace.repo.store.write("blob", new TextEncoder().encode("shared\n"));
    const updates = Array.from({ length: 1_024 }, (_, index) =>
      update(`refs/checkpoints/source-${index}`, `refs/checkpoints/destination-${index}`, blob),
    );
    const exact = operation(workspace.repo);
    workspace.storage.histogram = new Map();
    const statementStart = workspace.storage.statementCount;
    const plan = requirePlan(planPushUpdates(workspace.repo, updates, exact.budget));
    const observedStatements = workspace.storage.statementCount - statementStart;
    expect(pushPlanObjectCount(plan)).toBe(1);
    expect(
      [...workspace.storage.histogram].filter(([query]) =>
        query.startsWith("SELECT target FROM git_refs WHERE repo_id = ? AND name = ?"),
      ),
    ).toEqual([]);
    expect(observedStatements).toBeLessThan(1_000);
    disposePushPlan(plan);
    exact.reservation.dispose();
    workspace.repo.store.memory.assertIdle();
  });

  it("classifies a missing full-oid source as a safe local failure", () => {
    const workspace = makeRepo();
    const missing = "f".repeat(40);
    const { budget, reservation } = operation(workspace.repo);
    expect(() =>
      planPushUpdates(
        workspace.repo,
        [update(missing, "refs/checkpoints/missing", missing)],
        budget,
      ),
    ).toThrow(expect.objectContaining({ code: "EPUSHLOCAL" }));
    reservation.dispose();
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
    const corruptOperation = operation(corruptWorkspace.repo);
    expect(() =>
      planPushUpdates(
        corruptWorkspace.repo,
        [update(corruptBlob, "refs/checkpoints/corrupt", corruptBlob)],
        corruptOperation.budget,
      ),
    ).toThrow(expect.objectContaining({ code: "EPUSHLOCAL" }));
    corruptOperation.reservation.dispose();

    const missingWorkspace = makeRepo();
    const missingOid = "e".repeat(40);
    const incompleteTree = missingWorkspace.repo.store.write(
      "tree",
      serializeTree([{ mode: "100644", name: "missing.txt", oid: missingOid }]),
    );
    const missingOperation = operation(missingWorkspace.repo);
    expect(() =>
      planPushUpdates(
        missingWorkspace.repo,
        [update(incompleteTree, "refs/checkpoints/incomplete", incompleteTree)],
        missingOperation.budget,
      ),
    ).toThrow(expect.objectContaining({ code: "EPUSHLOCAL" }));
    missingOperation.reservation.dispose();

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
    const shallowOperation = operation(shallowWorkspace.repo);
    expect(() =>
      planPushUpdates(
        shallowWorkspace.repo,
        [update(shallow, "refs/heads/shallow", shallow)],
        shallowOperation.budget,
      ),
    ).toThrow(expect.objectContaining({ code: "EPUSHLOCAL" }));
    shallowOperation.reservation.dispose();
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
    const exactObjectsOperation = operation(objectWorkspace.repo);
    const exactObjects = requirePlan(
      planPushUpdates(
        objectWorkspace.repo,
        [update(objectTree, "refs/checkpoints/exact-objects", objectTree)],
        exactObjectsOperation.budget,
        { maxObjects: 3 },
      ),
    );
    expect(pushPlanObjectCount(exactObjects)).toBe(3);
    disposePushPlan(exactObjects);
    exactObjectsOperation.reservation.dispose();

    const excessObjectsOperation = operation(objectWorkspace.repo);
    expect(() =>
      planPushUpdates(
        objectWorkspace.repo,
        [update(objectTree, "refs/checkpoints/excess-objects", objectTree)],
        excessObjectsOperation.budget,
        { maxObjects: 2 },
      ),
    ).toThrow(expect.objectContaining({ code: "E2BIG" }));
    expect(excessObjectsOperation.budget.memory("push-plan")).toBe(0);
    excessObjectsOperation.reservation.dispose();

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
    const exactOperation = operation(exactWorkspace.repo);
    const exact = requirePlan(
      planPushUpdates(
        exactWorkspace.repo,
        [update(tip, "refs/heads/exact-commits", tip)],
        exactOperation.budget,
      ),
    );
    expect(exact.newCommits).toBe(MAX_PUSH_COMMITS);
    disposePushPlan(exact);
    exactOperation.reservation.dispose();

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
    const excessOperation = operation(exactWorkspace.repo);
    expect(() =>
      planPushUpdates(
        exactWorkspace.repo,
        [update(excessTip, "refs/heads/excess-commits", excessTip)],
        excessOperation.budget,
      ),
    ).toThrow(expect.objectContaining({ code: "E2BIG" }));
    excessOperation.reservation.dispose();
  });

  it("admits graph work above the former 16 MiB plan threshold", () => {
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
    const current = operation(workspace.repo);
    const plan = requirePlan(
      planPushUpdates(
        workspace.repo,
        [update(currentTip, "refs/heads/large-graph", currentTip)],
        current.budget,
      ),
    );

    expect(workspace.repo.store.memory.highWaterBytes).toBeGreaterThan(16 * 1024 * 1024);
    disposePushPlan(plan);
    expect(current.budget.retainedBytes).toBe(0);
    current.reservation.dispose();
    workspace.repo.store.memory.assertIdle();
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
    const current = operation(workspace.repo);
    const plan = requirePlan(
      planPushUpdates(workspace.repo, [update(source, destination, blob)], current.budget),
    );
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
      { http, operationBudget: current.budget },
    );

    expect(destination.length).toBeGreaterThan(1_024);
    expect(result.refs.get(destination)).toEqual({ ok: true });
    if (requestBody === undefined) throw new Error("receive-pack did not send a request body");
    expect(new TextDecoder().decode(requestBody)).toContain(destination);
    disposePushPlan(plan);
    current.budget.clearAllMemory();
    expect(current.budget.retainedBytes).toBe(0);
    current.reservation.dispose();
    workspace.repo.store.memory.assertIdle();
  });

  it("does not reach receive-pack when local preflight fails", async () => {
    const workspace = makeRepo();
    const blob = workspace.repo.store.write("blob", new TextEncoder().encode("not a commit\n"));
    const { budget, reservation } = operation(workspace.repo);
    let posts = 0;
    const http: GitHttpClient = async () => {
      posts++;
      throw new Error("unexpected HTTP request");
    };
    await expect(
      (async () => {
        const plan = planPushUpdates(
          workspace.repo,
          [update(blob, "refs/heads/not-a-commit", blob)],
          budget,
        );
        await receivePack(
          {
            url: "http://host/repo",
            commands: [{ oldOid: ZERO_OID, newOid: blob, ref: "refs/heads/not-a-commit" }],
            advertised: new Set(["report-status"]),
            ...(plan === null ? {} : { pack: () => openPushPack(workspace.repo, plan) }),
          },
          { http, operationBudget: budget },
        );
      })(),
    ).rejects.toMatchObject({ code: "EINVALIDREF" });
    expect(posts).toBe(0);
    reservation.dispose();
  });
});

describe("caller-owned push budget", () => {
  it("charges retained planning state and both replayable pack reads to one root", async () => {
    const workspace = makeRepo();
    const blob = workspace.repo.store.write("blob", new TextEncoder().encode("one\n"));
    const reservation = workspace.repo.store.reserveMemory();
    const budget = new TransportOperationBudget(reservation);
    const plan = requirePlan(
      planPushUpdates(workspace.repo, [update(blob, "refs/checkpoints/blob", blob)], budget),
    );
    expect(budget.memory("push-plan")).toBeGreaterThan(0);
    const first = await collect(openPushPack(workspace.repo, plan));
    expect(budget.memory("push-pack-first-read")).toBe(0);
    const second = await collect(openPushPack(workspace.repo, plan));
    expect(budget.memory("push-pack-replay-read")).toBe(0);
    expect(second).toEqual(first);
    await expect(collect(openPushPack(workspace.repo, plan))).rejects.toMatchObject({
      code: "EPUSHLOCAL",
    });
    disposePushPlan(plan);
    expect(budget.memory("push-plan")).toBe(0);
    reservation.dispose();
    workspace.repo.store.memory.assertIdle();
  });

  it("keeps pack memory additive and defers disposal until an active stream closes", async () => {
    const calibration = makeRepo();
    const blob = calibration.repo.store.write("blob", new TextEncoder().encode("one\n"));
    const calibrationOperation = operation(calibration.repo);
    const calibrationPlan = requirePlan(
      planPushUpdates(
        calibration.repo,
        [update(blob, "refs/checkpoints/blob", blob)],
        calibrationOperation.budget,
      ),
    );
    const planBytes = calibrationOperation.budget.memory("push-plan");
    const calibrationStream = openPushPack(calibration.repo, calibrationPlan);
    const firstChunk = await calibrationStream.next();
    expect(firstChunk.done).toBe(false);
    const packBytes = calibrationOperation.budget.memory("push-pack-first-read");
    expect(packBytes).toBeGreaterThan(0);
    await calibrationStream.return(undefined);
    const operationPeak = calibrationOperation.reservation.highWaterBytes;
    expect(operationPeak).toBeGreaterThan(packBytes);
    disposePushPlan(calibrationPlan);
    calibrationOperation.reservation.dispose();

    const exact = makeRepo();
    const exactBlob = exact.repo.store.write("blob", new TextEncoder().encode("one\n"));
    const exactOperation = operation(exact.repo);
    exactOperation.reservation.set("other", MAX_OPERATION_MEMORY_BYTES - operationPeak);
    const exactPlan = requirePlan(
      planPushUpdates(
        exact.repo,
        [update(exactBlob, "refs/checkpoints/blob", exactBlob)],
        exactOperation.budget,
      ),
    );
    const stream = openPushPack(exact.repo, exactPlan);
    expect((await stream.next()).done).toBe(false);
    expect(exactOperation.reservation.highWaterBytes).toBe(MAX_OPERATION_MEMORY_BYTES);
    disposePushPlan(exactPlan);
    expect(() => pushPlanObjectCount(exactPlan)).toThrow(
      expect.objectContaining({ code: "EINVAL" }),
    );
    await expect(collect(openPushPack(exact.repo, exactPlan))).rejects.toMatchObject({
      code: "EINVAL",
    });
    expect(exactOperation.budget.memory("push-plan")).toBe(planBytes);
    await stream.return(undefined);
    expect(exactOperation.budget.memory("push-plan")).toBe(0);
    exactOperation.reservation.dispose();
    exact.repo.store.memory.assertIdle();

    const excess = makeRepo();
    const excessBlob = excess.repo.store.write("blob", new TextEncoder().encode("one\n"));
    const excessOperation = operation(excess.repo);
    excessOperation.reservation.set("other", MAX_OPERATION_MEMORY_BYTES - operationPeak + 1);
    expect(() =>
      planPushUpdates(
        excess.repo,
        [update(excessBlob, "refs/checkpoints/blob", excessBlob)],
        excessOperation.budget,
      ),
    ).toThrow(expect.objectContaining({ code: "E2BIG" }));
    expect(excessOperation.budget.memory("push-plan")).toBe(0);
    excessOperation.reservation.dispose();
    excess.repo.store.memory.assertIdle();

    const concurrent = makeRepo();
    const concurrentBlob = concurrent.repo.store.write(
      "blob",
      new TextEncoder().encode("break me\n"),
    );
    const concurrentOperation = operation(concurrent.repo);
    const concurrentPlan = requirePlan(
      planPushUpdates(
        concurrent.repo,
        [update(concurrentBlob, "refs/checkpoints/blob", concurrentBlob)],
        concurrentOperation.budget,
      ),
    );
    const first = openPushPack(concurrent.repo, concurrentPlan);
    const replay = openPushPack(concurrent.repo, concurrentPlan);
    expect((await first.next()).done).toBe(false);
    expect((await replay.next()).done).toBe(false);
    expect(concurrentOperation.budget.memory("push-pack-first-read")).toBe(packBytes);
    expect(concurrentOperation.budget.memory("push-pack-replay-read")).toBe(packBytes);
    expect(concurrentOperation.reservation.currentBytes).toBe(planBytes + 2 * packBytes);
    disposePushPlan(concurrentPlan);
    expect(() => pushPlanObjectCount(concurrentPlan)).toThrow(
      expect.objectContaining({ code: "EINVAL" }),
    );
    concurrent.repo.store.db.run(
      "UPDATE git_object_chunks SET data = zeroblob(length(data)) WHERE repo_id = ? AND oid = ?",
      1,
      concurrentBlob,
    );
    await first.return(undefined);
    expect(concurrentOperation.budget.memory("push-pack-first-read")).toBe(0);
    expect(concurrentOperation.budget.memory("push-pack-replay-read")).toBe(packBytes);
    expect(concurrentOperation.budget.memory("push-plan")).toBe(planBytes);
    await expect(collect(replay)).rejects.toMatchObject({
      code: "EPUSHLOCAL",
    });
    expect(concurrentOperation.budget.memory("push-pack-replay-read")).toBe(0);
    expect(concurrentOperation.budget.memory("push-plan")).toBe(0);
    concurrentOperation.reservation.dispose();
    concurrent.repo.store.memory.assertIdle();
  });
});
