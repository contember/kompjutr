import { afterAll, describe, expect, it } from "vitest";
import { isTreeMode, serializeCommit, serializeTree } from "../src/git/common/objects.js";
import { openRepository } from "../src/git/ops/core/context.js";
import { clone } from "../src/git/ops/network/network.js";
import {
  type PushPlan,
  planPushObjects,
  pushPlanObjectCount,
  pushPlanObjectOidAt,
} from "../src/git/ops/push/push-plan.js";
import { commit } from "../src/git/ops/repository/commit.js";
import type { Repository } from "../src/git/ops/repository/repository.js";
import { add } from "../src/git/ops/staging/staging.js";
import { ZERO_OID } from "../src/git/protocol/receive-pack.js";
import { GitFixture } from "./helpers/git.js";
import { startGitServer } from "./helpers/http-backend.js";
import { makeWorkspace, writeWorkFile } from "./helpers/workspace.js";

const fixtures: GitFixture[] = [];
afterAll(() => {
  for (const fixture of fixtures) fixture.dispose();
});

function completeClosure(repo: Repository, root: string): Set<string> {
  const found = new Set<string>();
  const visitTree = (oid: string): void => {
    if (found.has(oid)) return;
    found.add(oid);
    for (const entry of repo.readTree(oid)) {
      if (entry.mode === "160000") continue;
      if (isTreeMode(entry.mode)) visitTree(entry.oid);
      else found.add(entry.oid);
    }
  };
  const pending = [root];
  while (pending.length > 0) {
    const oid = pending.pop()!;
    if (found.has(oid)) continue;
    found.add(oid);
    const parsed = repo.readCommit(oid);
    visitTree(parsed.tree);
    pending.push(...parsed.parent);
  }
  return found;
}

function planOids(plan: PushPlan): Set<string> {
  const result = new Set<string>();
  for (let index = 0; index < pushPlanObjectCount(plan); index++) {
    const oid = pushPlanObjectOidAt(plan, index);
    if (oid === null) throw new Error("push plan lost an object");
    result.add(oid);
  }
  return result;
}

describe("push object planning", () => {
  it("matches the complete closure for a new nested branch", async () => {
    const fixture = new GitFixture().init();
    fixtures.push(fixture);
    fixture.write("README.md", "initial\n");
    fixture.commit("initial");
    const server = await startGitServer(fixture.dir);
    try {
      const workspace = makeWorkspace();
      workspace.context.defaultIdentity = { name: "Agent", email: "agent@example.com" };
      await clone(workspace.context, { url: server.url, dir: "/" });
      const repo = openRepository(workspace.context, "/");
      writeWorkFile(workspace, "/src/topic.ts", "export const topic = true;\n");
      add(repo, workspace.worktree, { paths: ["src/topic.ts"] });
      const tip = commit(workspace.context, repo, { message: "topic" }).oid;

      const plan = planPushObjects(repo, tip, ZERO_OID, false);
      const planned = planOids(plan);
      const expected = completeClosure(repo, tip);
      const tipCommit = repo.readCommit(tip);
      const parentCommit = repo.readCommit(tipCommit.parent[0]!);
      const srcTree = repo.readTree(tipCommit.tree).find((entry) => entry.name === "src")!.oid;
      expect({
        tipTree: planned.has(tipCommit.tree),
        parentTree: planned.has(parentCommit.tree),
        srcTree: planned.has(srcTree),
      }).toEqual({ tipTree: true, parentTree: true, srcTree: true });
      expect(
        [...expected]
          .filter((oid) => !planned.has(oid))
          .map((oid) => ({ oid, type: repo.typeOf(oid) })),
      ).toEqual([]);
      expect(planned).toEqual(expected);

      const remoteTip = tipCommit.parent[0]!;
      const incremental = planPushObjects(repo, tip, ZERO_OID, false, [remoteTip]);
      for (const oid of completeClosure(repo, remoteTip)) expected.delete(oid);
      expect(planOids(incremental)).toEqual(expected);
    } finally {
      await server.close();
    }
  });

  it("matches closure subtraction for a merge DAG", async () => {
    const fixture = new GitFixture().init();
    fixtures.push(fixture);
    fixture.write("README.md", "initial\n");
    const old = fixture.commit("initial");
    const server = await startGitServer(fixture.dir);
    try {
      const workspace = makeWorkspace();
      await clone(workspace.context, { url: server.url, dir: "/" });
      const repo = openRepository(workspace.context, "/");
      const oldCommit = repo.readCommit(old);
      const sideBlob = repo.store.write("blob", new TextEncoder().encode("side\n"));
      const sideTree = repo.store.write(
        "tree",
        serializeTree([
          ...repo.readTree(oldCommit.tree),
          { mode: "100644", name: "side.txt", oid: sideBlob },
        ]),
      );
      const person = {
        name: "Agent",
        email: "agent@example.com",
        timestamp: 1_600_000_000,
        timezoneOffset: 0,
      };
      const side = repo.store.write(
        "commit",
        serializeCommit({
          tree: sideTree,
          parent: [old],
          author: person,
          committer: person,
          message: "side\n",
        }),
      );
      const merge = repo.store.write(
        "commit",
        serializeCommit({
          tree: sideTree,
          parent: [old, side],
          author: person,
          committer: person,
          message: "merge\n",
        }),
      );

      const plan = planPushObjects(repo, merge, old, false);
      const expected = completeClosure(repo, merge);
      for (const oid of completeClosure(repo, old)) expected.delete(oid);
      expect(planOids(plan)).toEqual(expected);
    } finally {
      await server.close();
    }
  });
});
