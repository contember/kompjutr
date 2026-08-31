import { afterEach, describe, expect, it } from "vitest";
import { utf8Decoder } from "../src/core/bytes.js";
import { commit } from "../src/core/ops/commit.js";
import { updateRef } from "../src/core/ops/plumbing.js";
import { operationRefLogMetadata } from "../src/core/ops/ref-log.js";
import {
  branch,
  branchDelete,
  checkout,
  switchBranch,
  tag,
  tagDelete,
} from "../src/core/ops/refs.js";
import { add, reset } from "../src/core/ops/staging.js";
import { Repository } from "../src/core/repository.js";
import { GitFixture } from "./helpers/git.js";
import { importFixture } from "./helpers/import.js";
import { makeRepo, type TestRepository, writeWorkFile } from "./helpers/workspace.js";

const ACTOR = { name: "Reflog Actor", email: "reflog@example.com" };
const START_MILLISECONDS = 1_700_000_000_000;

const fixtures: GitFixture[] = [];

afterEach(() => {
  while (fixtures.length > 0) fixtures.pop()?.dispose();
});

function repository(): TestRepository {
  const workspace = makeRepo("/", {
    startTime: START_MILLISECONDS,
    timezoneOffset: -120,
    now: () => START_MILLISECONDS + 10_000,
  });
  workspace.context.defaultIdentity = ACTOR;
  return workspace;
}

function stage(workspace: TestRepository, content: string): void {
  writeWorkFile(workspace, "/tracked.txt", content);
  add(workspace.repo, workspace.worktree, { paths: ["tracked.txt"] });
}

describe("operation reflog metadata", () => {
  it("uses explicit, environment, config, and default actor precedence", () => {
    const workspace = repository();
    workspace.repo.store.configSet("user.name", "Configured");
    workspace.repo.store.configSet("user.email", "configured@example.com");

    expect(operationRefLogMetadata(workspace.context, workspace.repo, "checkout").actor).toEqual({
      name: "Configured",
      email: "configured@example.com",
    });
    expect(
      operationRefLogMetadata(workspace.context, workspace.repo, "checkout", {
        env: {
          GIT_COMMITTER_NAME: "Environment",
          GIT_COMMITTER_EMAIL: "environment@example.com",
        },
      }).actor,
    ).toEqual({ name: "Environment", email: "environment@example.com" });
    expect(
      operationRefLogMetadata(workspace.context, workspace.repo, "checkout", {
        identity: { name: "Explicit", email: "explicit@example.com" },
        env: {
          GIT_COMMITTER_NAME: "Environment",
          GIT_COMMITTER_EMAIL: "environment@example.com",
        },
      }),
    ).toEqual({
      actor: { name: "Explicit", email: "explicit@example.com" },
      timestamp: START_MILLISECONDS / 1_000,
      timezoneOffset: -120,
      reason: "checkout",
    });
  });

  it("accepts the former identity first excess and rejects incomplete identity", () => {
    const workspace = makeRepo("/", {
      startTime: START_MILLISECONDS,
      now: () => START_MILLISECONDS + 10_000,
    });
    const longName = "x".repeat(1_025);
    workspace.context.defaultIdentity = { name: longName, email: "valid@example.com" };
    expect(operationRefLogMetadata(workspace.context, workspace.repo, "checkout").actor).toEqual({
      name: longName,
      email: "valid@example.com",
    });

    workspace.context.defaultIdentity = { name: "Only name", email: "" };
    expect(operationRefLogMetadata(workspace.context, workspace.repo, "checkout").actor).toBeNull();
  });

  it("falls through invalid optional config and logs a null actor when no source exists", () => {
    const fallback = repository();
    const longName = "x".repeat(1_025);
    fallback.repo.store.configSet("user.name", longName);
    fallback.repo.store.configSet("user.email", "configured@example.com");
    expect(operationRefLogMetadata(fallback.context, fallback.repo, "checkout").actor).toEqual({
      name: longName,
      email: "configured@example.com",
    });

    fallback.repo.store.configSet("user.name", "invalid\nname");
    expect(operationRefLogMetadata(fallback.context, fallback.repo, "checkout").actor).toEqual(
      ACTOR,
    );

    fallback.repo.store.configSet("user.name", "Incomplete");
    fallback.repo.store.configUnset("user.email");
    expect(operationRefLogMetadata(fallback.context, fallback.repo, "checkout").actor).toEqual(
      ACTOR,
    );

    const absent = makeRepo("/", {
      startTime: START_MILLISECONDS,
      now: () => START_MILLISECONDS + 10_000,
    });
    const oid = absent.repo.store.write("blob", new Uint8Array());
    updateRef(absent.context, absent.repo, { ref: "refs/tags/no-actor", value: oid });
    expect(absent.repo.store.reflog("refs/tags/no-actor")[0]).toMatchObject({
      actor: null,
      timestamp: START_MILLISECONDS / 1_000,
      timezoneOffset: 0,
      reason: "update-ref",
    });
  });

  it("rejects malformed stored config writes", () => {
    const workspace = repository();
    workspace.repo.store.configSet("user.name", "Valid");
    expect(() =>
      workspace.repo.store.db.run(
        "UPDATE git_config SET value = x'00' WHERE repo_id = ? AND path = 'user.name'",
        workspace.repo.store.repoId,
      ),
    ).toThrow(/CHECK/);
    expect(workspace.repo.store.configGet("user.name")).toBe("Valid");
  });
});

describe("commit publication history", () => {
  it("records exact initial, ordinary, and amend committer metadata", () => {
    const workspace = repository();
    stage(workspace, "one\n");
    const initial = commit(workspace.context, workspace.repo, { message: "initial" }).oid;

    workspace.tick(1_000);
    stage(workspace, "two\n");
    const ordinary = commit(workspace.context, workspace.repo, { message: "ordinary" }).oid;

    workspace.tick(1_000);
    const amended = commit(workspace.context, workspace.repo, {
      message: "amended",
      amend: true,
    }).oid;

    expect(workspace.repo.store.reflog("refs/heads/main")).toEqual([
      expect.objectContaining({
        oldOid: ordinary,
        newOid: amended,
        actor: ACTOR,
        timestamp: START_MILLISECONDS / 1_000 + 2,
        timezoneOffset: -120,
        reason: "commit (amend)",
      }),
      expect.objectContaining({
        oldOid: initial,
        newOid: ordinary,
        actor: ACTOR,
        timestamp: START_MILLISECONDS / 1_000 + 1,
        reason: "commit",
      }),
      expect.objectContaining({
        oldRaw: null,
        newOid: initial,
        actor: ACTOR,
        timestamp: START_MILLISECONDS / 1_000,
        reason: "commit (initial)",
      }),
    ]);
    expect(workspace.repo.checkout.reflog("HEAD").map((entry) => entry.reason)).toEqual([
      "commit (amend)",
      "commit",
      "commit (initial)",
    ]);
  });
});

describe("local ref operations", () => {
  it("publishes branch checkout through one ordered branch mutation", () => {
    const workspace = repository();
    stage(workspace, "one\n");
    const oid = commit(workspace.context, workspace.repo, { message: "first" }).oid;

    branch(workspace.context, workspace.repo, { name: "feature", checkout: true });

    const named = workspace.repo.store.reflog("refs/heads/feature")[0];
    const head = workspace.repo.checkout.reflog("HEAD")[0];
    expect(named).toMatchObject({
      oldRaw: null,
      newRaw: oid,
      oldOid: null,
      newOid: oid,
      actor: ACTOR,
      timestamp: START_MILLISECONDS / 1_000,
      timezoneOffset: -120,
      reason: "branch: create",
    });
    expect(head).toMatchObject({
      oldRaw: "ref: refs/heads/main",
      newRaw: "ref: refs/heads/feature",
      oldOid: oid,
      newOid: oid,
      actor: ACTOR,
      timestamp: START_MILLISECONDS / 1_000,
      timezoneOffset: -120,
      reason: "branch: create",
    });
    if (named === undefined || head === undefined)
      throw new Error("branch checkout history missing");
    expect(named.ordinal + 1).toBe(head.ordinal);
  });

  it("logs symbolic branch-to-branch checkout when both branches resolve to one OID", () => {
    const workspace = repository();
    stage(workspace, "one\n");
    const oid = commit(workspace.context, workspace.repo, { message: "first" }).oid;
    branch(workspace.context, workspace.repo, { name: "twin" });
    const mainEntries = workspace.repo.store.reflog("refs/heads/main").length;

    checkout(workspace.context, workspace.repo, workspace.worktree, { ref: "twin" });

    expect(workspace.repo.checkout.reflog("HEAD")[0]).toMatchObject({
      oldRaw: "ref: refs/heads/main",
      newRaw: "ref: refs/heads/twin",
      oldOid: oid,
      newOid: oid,
      actor: ACTOR,
      timestamp: START_MILLISECONDS / 1_000,
      timezoneOffset: -120,
      reason: "checkout",
    });
    expect(workspace.repo.store.reflog("refs/heads/main")).toHaveLength(mainEntries);
    expect(workspace.repo.store.reflog("refs/heads/twin")).toHaveLength(1);
  });

  it("records branch, tag, checkout, reset, and update-ref reasons", () => {
    const workspace = repository();
    stage(workspace, "one\n");
    const first = commit(workspace.context, workspace.repo, { message: "first" }).oid;
    branch(workspace.context, workspace.repo, { name: "side" });

    stage(workspace, "two\n");
    const second = commit(workspace.context, workspace.repo, { message: "second" }).oid;
    branch(workspace.context, workspace.repo, {
      name: "side",
      startPoint: "main",
      force: true,
    });
    branchDelete(workspace.context, workspace.repo, { name: "side" });

    tag(workspace.context, workspace.repo, { name: "release", object: first });
    tag(workspace.context, workspace.repo, {
      name: "release",
      object: second,
      force: true,
    });
    tagDelete(workspace.context, workspace.repo, { name: "release" });

    tag(workspace.context, workspace.repo, { name: "same", object: second });
    const beforeCheckout = workspace.repo.checkout.reflog("HEAD").length;
    checkout(workspace.context, workspace.repo, workspace.worktree, { ref: "same" });
    const checkoutEntry = workspace.repo.checkout.reflog("HEAD")[0];
    expect(checkoutEntry).toMatchObject({
      oldRaw: "ref: refs/heads/main",
      newRaw: second,
      oldOid: second,
      newOid: second,
      reason: "checkout",
    });
    expect(workspace.repo.checkout.reflog("HEAD")).toHaveLength(beforeCheckout + 1);

    checkout(workspace.context, workspace.repo, workspace.worktree, { ref: "main" });
    reset(workspace.context, workspace.repo, workspace.worktree, { hard: true, ref: first });
    expect(workspace.repo.store.reflog("refs/heads/main")[0]).toMatchObject({
      oldOid: second,
      newOid: first,
      reason: "reset: hard",
    });
    expect(workspace.repo.checkout.reflog("HEAD")[0]?.reason).toBe("reset: hard");

    updateRef(workspace.context, workspace.repo, { ref: "refs/heads/recovered", value: second });
    expect(workspace.repo.store.reflog("refs/heads/recovered")[0]).toMatchObject({
      oldRaw: null,
      newOid: second,
      reason: "update-ref",
      actor: ACTOR,
      timestamp: START_MILLISECONDS / 1_000,
      timezoneOffset: -120,
    });

    expect(workspace.repo.store.reflog("refs/heads/side")).toEqual([
      expect.objectContaining({
        oldOid: second,
        newRaw: null,
        actor: ACTOR,
        reason: "branch: delete",
      }),
      expect.objectContaining({
        oldOid: first,
        newOid: second,
        actor: ACTOR,
        reason: "branch: reset",
      }),
      expect.objectContaining({
        oldRaw: null,
        newOid: first,
        actor: ACTOR,
        reason: "branch: create",
      }),
    ]);
    expect(workspace.repo.store.reflog("refs/tags/release")).toEqual([
      expect.objectContaining({ oldOid: second, newRaw: null, reason: "tag: delete" }),
      expect.objectContaining({ oldOid: first, newOid: second, reason: "tag: update" }),
      expect.objectContaining({ oldRaw: null, newOid: first, reason: "tag: create" }),
    ]);
  });

  it("does not log path-only, no-op, or refused operations", () => {
    const workspace = repository();
    stage(workspace, "one\n");
    const oid = commit(workspace.context, workspace.repo, { message: "first" }).oid;
    tag(workspace.context, workspace.repo, { name: "same", object: oid });
    const before = workspace.repo.checkout.reflog("HEAD").length;

    checkout(workspace.context, workspace.repo, workspace.worktree, {
      ref: "HEAD",
      paths: ["tracked.txt"],
    });
    checkout(workspace.context, workspace.repo, workspace.worktree, { ref: "main" });
    tag(workspace.context, workspace.repo, { name: "same", object: oid, force: true });
    reset(workspace.context, workspace.repo, workspace.worktree, { hard: true, ref: oid });
    expect(() => tag(workspace.context, workspace.repo, { name: "same", object: oid })).toThrow(
      /already exists/,
    );

    expect(workspace.repo.checkout.reflog("HEAD")).toHaveLength(before);
    expect(workspace.repo.store.reflog("refs/tags/same")).toHaveLength(1);
  });

  it("moves detached HEAD on hard reset without mutating a named ref", () => {
    const fixture = new GitFixture().init();
    fixtures.push(fixture);
    fixture.write("tracked.txt", "one\n");
    const fixtureFirst = fixture.commit("first");
    fixture.write("tracked.txt", "two\n");
    const fixtureSecond = fixture.commit("second");
    fixture.git("checkout", "-q", "--detach", fixtureFirst);

    const workspace = repository();
    stage(workspace, "one\n");
    const first = commit(workspace.context, workspace.repo, { message: "first" }).oid;
    stage(workspace, "two\n");
    const second = commit(workspace.context, workspace.repo, { message: "second" }).oid;
    checkout(workspace.context, workspace.repo, workspace.worktree, { ref: first });
    const namedEntries = workspace.repo.store.reflog("refs/heads/main").length;
    workspace.tick(3_000);

    reset(workspace.context, workspace.repo, workspace.worktree, { hard: true, ref: second });
    fixture.git("reset", "--hard", "-q", fixtureSecond);

    expect(workspace.repo.checkout.head()).toBe(second);
    expect({
      detached: workspace.repo.head().ref === null,
      atRequestedCommit: workspace.repo.head().oid === second,
    }).toEqual({
      detached: fixture.git("rev-parse", "--abbrev-ref", "HEAD") === "HEAD",
      atRequestedCommit: fixture.git("rev-parse", "HEAD") === fixtureSecond,
    });
    expect(workspace.repo.checkout.reflog("HEAD")[0]).toMatchObject({
      oldRaw: first,
      newRaw: second,
      oldOid: first,
      newOid: second,
      actor: ACTOR,
      timestamp: START_MILLISECONDS / 1_000 + 3,
      timezoneOffset: -120,
      reason: "reset: hard",
    });
    expect(workspace.repo.store.reflog("refs/heads/main")).toHaveLength(namedEntries);

    const headEntries = workspace.repo.checkout.reflog("HEAD").length;
    reset(workspace.context, workspace.repo, workspace.worktree, { hard: true, ref: second });
    expect(workspace.repo.checkout.reflog("HEAD")).toHaveLength(headEntries);
    expect(() =>
      reset(workspace.context, workspace.repo, workspace.worktree, {
        hard: true,
        ref: "refs/heads/missing",
      }),
    ).toThrow(expect.objectContaining({ code: "ENOTFOUND" }));
    expect(workspace.repo.checkout.head()).toBe(second);
    expect(workspace.repo.checkout.reflog("HEAD")).toHaveLength(headEntries);
  });

  it("logs direct, symbolic, raw HEAD, and causal update-ref movements", () => {
    const workspace = repository();
    stage(workspace, "one\n");
    const first = commit(workspace.context, workspace.repo, { message: "first" }).oid;
    stage(workspace, "two\n");
    const second = commit(workspace.context, workspace.repo, { message: "second" }).oid;
    const beforeOrdinal =
      workspace.repo.store.db.scalar<number>(
        "SELECT next_ordinal FROM git_reflog_state WHERE repo_id = ?",
        workspace.repo.store.repoId,
      ) ?? -1;

    updateRef(workspace.context, workspace.repo, { ref: "refs/heads/recovered", value: first });
    updateRef(workspace.context, workspace.repo, {
      ref: "refs/heads/alias",
      value: "refs/heads/recovered",
      symbolic: true,
    });
    updateRef(workspace.context, workspace.repo, {
      ref: "HEAD",
      value: "refs/heads/recovered",
      symbolic: true,
      force: true,
    });
    updateRef(workspace.context, workspace.repo, {
      ref: "refs/heads/recovered",
      value: second,
      force: true,
    });

    expect(workspace.repo.store.reflog("refs/heads/alias")[0]).toMatchObject({
      oldRaw: null,
      newRaw: "ref: refs/heads/recovered",
      oldOid: null,
      newOid: first,
      actor: ACTOR,
      timestamp: START_MILLISECONDS / 1_000,
      timezoneOffset: -120,
      reason: "update-ref",
    });
    expect(workspace.repo.store.reflog("refs/heads/recovered")).toEqual([
      expect.objectContaining({
        oldRaw: first,
        newRaw: second,
        oldOid: first,
        newOid: second,
        actor: ACTOR,
        timestamp: START_MILLISECONDS / 1_000,
        timezoneOffset: -120,
        reason: "update-ref",
      }),
      expect.objectContaining({
        oldRaw: null,
        newRaw: first,
        oldOid: null,
        newOid: first,
        actor: ACTOR,
        timestamp: START_MILLISECONDS / 1_000,
        timezoneOffset: -120,
        reason: "update-ref",
      }),
    ]);
    const headEntries = workspace.repo.checkout.reflog("HEAD");
    expect(headEntries[0]).toMatchObject({
      oldRaw: "ref: refs/heads/recovered",
      newRaw: "ref: refs/heads/recovered",
      oldOid: first,
      newOid: second,
      actor: ACTOR,
      timestamp: START_MILLISECONDS / 1_000,
      timezoneOffset: -120,
      reason: "update-ref",
    });
    expect(headEntries[1]).toMatchObject({
      oldRaw: "ref: refs/heads/main",
      newRaw: "ref: refs/heads/recovered",
      oldOid: second,
      newOid: first,
      actor: ACTOR,
      timestamp: START_MILLISECONDS / 1_000,
      timezoneOffset: -120,
      reason: "update-ref",
    });
    expect(
      workspace.repo.store.db.all<{ ref_name: string; reason: string }>(
        `SELECT ref_name, reason FROM (
           SELECT ref_name, reason, ordinal FROM git_reflog_entries WHERE repo_id = ?
           UNION ALL
           SELECT 'HEAD' AS ref_name, reason, ordinal
             FROM git_checkout_reflog_entries WHERE repo_id = ?
         ) WHERE ordinal > ? ORDER BY ordinal`,
        workspace.repo.store.repoId,
        workspace.repo.store.repoId,
        beforeOrdinal,
      ),
    ).toEqual([
      { ref_name: "refs/heads/recovered", reason: "update-ref" },
      { ref_name: "refs/heads/alias", reason: "update-ref" },
      { ref_name: "HEAD", reason: "update-ref" },
      { ref_name: "refs/heads/recovered", reason: "update-ref" },
      { ref_name: "HEAD", reason: "update-ref" },
    ]);

    const count = workspace.repo.store.db.scalar<number>(
      "SELECT count(*) FROM git_reflog_entries WHERE repo_id = ?",
      workspace.repo.store.repoId,
    );
    updateRef(workspace.context, workspace.repo, {
      ref: "refs/heads/recovered",
      value: second,
      force: true,
    });
    expect(() =>
      updateRef(workspace.context, workspace.repo, {
        ref: "refs/heads/recovered",
        value: first,
      }),
    ).toThrow(/already exists/);
    expect(
      workspace.repo.store.db.scalar<number>(
        "SELECT count(*) FROM git_reflog_entries WHERE repo_id = ?",
        workspace.repo.store.repoId,
      ),
    ).toBe(count);
  });

  it("logs guarded ref endpoints and emits nothing for stale or absent no-ops", () => {
    const workspace = repository();
    stage(workspace, "one\n");
    const first = commit(workspace.context, workspace.repo, { message: "first" }).oid;
    stage(workspace, "two\n");
    const second = commit(workspace.context, workspace.repo, { message: "second" }).oid;
    const ref = "refs/heads/guarded";

    updateRef(workspace.context, workspace.repo, { ref, value: first, expected: null });
    updateRef(workspace.context, workspace.repo, { ref, value: second, expected: first });
    const beforeStale = workspace.repo.store.reflog(ref);
    expect(() =>
      updateRef(workspace.context, workspace.repo, { ref, value: first, expected: first }),
    ).toThrow(expect.objectContaining({ code: "ESTALEHEAD" }));
    expect(workspace.repo.store.reflog(ref)).toEqual(beforeStale);

    updateRef(workspace.context, workspace.repo, { ref, delete: true, expected: second });
    expect(workspace.repo.store.reflog(ref)).toEqual([
      expect.objectContaining({
        oldRaw: second,
        newRaw: null,
        oldOid: second,
        newOid: null,
        reason: "update-ref",
      }),
      expect.objectContaining({
        oldRaw: first,
        newRaw: second,
        oldOid: first,
        newOid: second,
        reason: "update-ref",
      }),
      expect.objectContaining({
        oldRaw: null,
        newRaw: first,
        oldOid: null,
        newOid: first,
        reason: "update-ref",
      }),
    ]);
    const afterDelete = workspace.repo.store.reflog(ref);
    updateRef(workspace.context, workspace.repo, { ref, delete: true, expected: null });
    expect(workspace.repo.store.reflog(ref)).toEqual(afterDelete);
  });

  it("routes a shared branch publication to its owning checkout and rolls every event back", () => {
    const workspace = repository();
    const first = workspace.repo.store.write("blob", new TextEncoder().encode("first\n"));
    const second = workspace.repo.store.write("blob", new TextEncoder().encode("second\n"));
    const third = workspace.repo.store.write("blob", new TextEncoder().encode("third\n"));
    workspace.repo.store.setRef("refs/heads/main", first);
    workspace.repo.store.setRef("refs/heads/side", first);
    const checkoutB = workspace.database.createCheckout(
      workspace.repo.store.repoId,
      "/checkout-b",
      "ref: refs/heads/side",
    );
    const repositoryB = new Repository(workspace.database.openCheckout(checkoutB));
    const before = {
      direct: workspace.repo.store.reflog("refs/heads/main"),
      checkoutA: workspace.repo.checkout.reflog("HEAD"),
      checkoutB: repositoryB.checkout.reflog("HEAD"),
      ordinal: workspace.repo.store.db.scalar<number>(
        "SELECT next_ordinal FROM git_reflog_state WHERE repo_id = ?",
        workspace.repo.store.repoId,
      ),
    };
    if (before.ordinal === undefined) throw new Error("reflog allocator is missing");

    updateRef(workspace.context, repositoryB, {
      ref: "refs/heads/main",
      value: second,
      force: true,
    });

    const direct = workspace.repo.store.reflog("refs/heads/main");
    const checkoutAEntries = workspace.repo.checkout.reflog("HEAD");
    const checkoutBEntries = repositoryB.checkout.reflog("HEAD");
    expect(direct).toHaveLength(before.direct.length + 1);
    expect(checkoutAEntries).toHaveLength(before.checkoutA.length + 1);
    expect(checkoutBEntries).toEqual(before.checkoutB);
    expect(direct[0]).toMatchObject({
      oldOid: first,
      newOid: second,
      reason: "update-ref",
      ordinal: before.ordinal + 1,
    });
    expect(checkoutAEntries[0]).toMatchObject({
      oldRaw: "ref: refs/heads/main",
      newRaw: "ref: refs/heads/main",
      oldOid: first,
      newOid: second,
      reason: "update-ref",
      ordinal: before.ordinal + 2,
    });
    expect(
      workspace.repo.store.db.scalar<number>(
        "SELECT next_ordinal FROM git_reflog_state WHERE repo_id = ?",
        workspace.repo.store.repoId,
      ),
    ).toBe(before.ordinal + 2);

    const published = {
      direct,
      checkoutA: checkoutAEntries,
      checkoutB: checkoutBEntries,
      ordinal: before.ordinal + 2,
    };
    workspace.repo.store.db.run(`CREATE TRIGGER fail_causal_head_publication
      BEFORE INSERT ON git_checkout_reflog_entries
      WHEN NEW.checkout_id = ${workspace.repo.checkout.checkoutId}
      BEGIN SELECT RAISE(ABORT, 'injected causal HEAD publication failure'); END`);

    expect(() =>
      updateRef(workspace.context, repositoryB, {
        ref: "refs/heads/main",
        value: third,
        force: true,
      }),
    ).toThrow(/injected causal HEAD publication failure/);
    expect(workspace.repo.store.getRef("refs/heads/main")).toBe(second);
    expect(workspace.repo.store.reflog("refs/heads/main")).toEqual(published.direct);
    expect(workspace.repo.checkout.reflog("HEAD")).toEqual(published.checkoutA);
    expect(repositoryB.checkout.reflog("HEAD")).toEqual(published.checkoutB);
    expect(
      workspace.repo.store.db.scalar<number>(
        "SELECT next_ordinal FROM git_reflog_state WHERE repo_id = ?",
        workspace.repo.store.repoId,
      ),
    ).toBe(published.ordinal);
  });

  it("rolls a full checkout back after worktree mutation when reflog insertion fails", () => {
    const workspace = repository();
    stage(workspace, "base\n");
    const base = commit(workspace.context, workspace.repo, { message: "base" }).oid;
    branch(workspace.context, workspace.repo, { name: "side", startPoint: base });
    stage(workspace, "main\n");
    commit(workspace.context, workspace.repo, { message: "main" });
    const before = {
      head: workspace.repo.checkout.head(),
      index: workspace.repo.checkout.indexGet("tracked.txt"),
      content: utf8Decoder.decode(workspace.worktree.readFile("/tracked.txt")),
      entries: workspace.repo.store.db.scalar<number>(
        "SELECT count(*) FROM git_checkout_reflog_entries WHERE checkout_id = ?",
        workspace.repo.checkout.checkoutId,
      ),
      directEntries: workspace.repo.store.db.scalar<number>(
        "SELECT count(*) FROM git_reflog_entries WHERE repo_id = ?",
        workspace.repo.store.repoId,
      ),
      ordinal: workspace.repo.store.db.scalar<number>(
        "SELECT next_ordinal FROM git_reflog_state WHERE repo_id = ?",
        workspace.repo.store.repoId,
      ),
    };
    workspace.repo.store.db.run(`CREATE TRIGGER fail_checkout_reflog
      BEFORE INSERT ON git_checkout_reflog_entries
      BEGIN SELECT RAISE(ABORT, 'injected checkout reflog failure'); END`);

    expect(() =>
      checkout(workspace.context, workspace.repo, workspace.worktree, { ref: "side" }),
    ).toThrow(/injected checkout reflog failure/);

    expect(workspace.repo.checkout.head()).toBe(before.head);
    expect(workspace.repo.checkout.indexGet("tracked.txt")).toEqual(before.index);
    expect(utf8Decoder.decode(workspace.worktree.readFile("/tracked.txt"))).toBe(before.content);
    expect(
      workspace.repo.store.db.scalar<number>(
        "SELECT count(*) FROM git_checkout_reflog_entries WHERE checkout_id = ?",
        workspace.repo.checkout.checkoutId,
      ),
    ).toBe(before.entries);
    expect(
      workspace.repo.store.db.scalar<number>(
        "SELECT count(*) FROM git_reflog_entries WHERE repo_id = ?",
        workspace.repo.store.repoId,
      ),
    ).toBe(before.directEntries);
    expect(
      workspace.repo.store.db.scalar<number>(
        "SELECT next_ordinal FROM git_reflog_state WHERE repo_id = ?",
        workspace.repo.store.repoId,
      ),
    ).toBe(before.ordinal);
  });

  it("rolls branch creation and history back when switch checkout refuses", () => {
    const workspace = repository();
    stage(workspace, "base\n");
    const base = commit(workspace.context, workspace.repo, { message: "base" }).oid;
    branch(workspace.context, workspace.repo, { name: "side", startPoint: base });
    stage(workspace, "main\n");
    commit(workspace.context, workspace.repo, { message: "main" });
    writeWorkFile(workspace, "/tracked.txt", "dirty\n");
    const beforeHead = workspace.repo.checkout.reflog("HEAD").length;

    expect(() =>
      switchBranch(workspace.context, workspace.repo, workspace.worktree, {
        name: "topic",
        create: true,
        startPoint: "side",
      }),
    ).toThrow(expect.objectContaining({ code: "ECHECKOUTFAIL" }));

    expect(workspace.repo.store.getRef("refs/heads/topic")).toBeNull();
    expect(workspace.repo.store.reflog("refs/heads/topic")).toEqual([]);
    expect(workspace.repo.checkout.reflog("HEAD")).toHaveLength(beforeHead);
  });
});

describe("fixture import", () => {
  it("uses one bulk setup mutation and leaves clean history", async () => {
    const fixture = new GitFixture().init();
    fixtures.push(fixture);
    fixture.write("a.txt", "one\n");
    fixture.commit("one");
    fixture.git("branch", "side");
    fixture.git("tag", "v1");
    const workspace = repository();

    await importFixture(fixture, workspace.repo.checkout);

    expect(workspace.repo.checkout.reflog("HEAD")).toEqual([]);
    expect(workspace.repo.store.reflog("refs/heads/main")).toEqual([]);
    expect(workspace.repo.store.reflog("refs/heads/side")).toEqual([]);
    expect(workspace.repo.store.reflog("refs/tags/v1")).toEqual([]);
    expect(
      workspace.repo.store.db.scalar<number>(
        "SELECT next_ordinal FROM git_reflog_state WHERE repo_id = ?",
        workspace.repo.store.repoId,
      ),
    ).toBe(0);
  });
});
