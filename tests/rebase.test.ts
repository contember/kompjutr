import { afterEach, describe, expect, it } from "vitest";

import { utf8, utf8Decoder } from "../src/git/common/bytes.js";
import { hasErrorCode } from "../src/git/common/errors.js";
import { checkoutTree } from "../src/git/ops/checkout.js";
import { openRepository } from "../src/git/ops/context.js";
import { integrationIndexMatchesTree } from "../src/git/ops/integration-worktree.js";
import { clone, fetchInto } from "../src/git/ops/network.js";
import {
  rebase,
  rebaseAbort,
  rebaseContinue,
  rebaseContinueExcluding,
  rebaseSkip,
} from "../src/git/ops/rebase.js";
import { Repository } from "../src/git/ops/repository.js";
import { add, rm } from "../src/git/ops/staging.js";
import { SqliteGitDatabase } from "../src/git/store/index.js";
import { TestDatabase } from "./helpers/db.js";
import { GitFixture } from "./helpers/git.js";
import { startGitServer } from "./helpers/http-backend.js";
import { importFixture } from "./helpers/import.js";
import {
  makeRepo,
  makeWorkspace,
  type TestRepository,
  writeWorkFile,
} from "./helpers/workspace.js";

const fixtures: GitFixture[] = [];

afterEach(() => {
  while (fixtures.length > 0) fixtures.pop()?.dispose();
});

function fixture(): GitFixture {
  const created = new GitFixture().init();
  fixtures.push(created);
  return created;
}

async function imported(source: GitFixture): Promise<TestRepository> {
  const workspace = makeRepo("/", { now: () => 1_577_836_800_000 });
  await importFixture(source, workspace.repo.checkout);
  checkoutTree(workspace.repo, workspace.worktree, workspace.repo.headTree());
  workspace.repo.store.configSet("user.name", "Fixture");
  workspace.repo.store.configSet("user.email", "fixture@example.com");
  return workspace;
}

function textAt(workspace: TestRepository, path: string): string | null {
  if (workspace.worktree.stat(`/${path}`) === null) return null;
  return utf8Decoder.decode(workspace.worktree.readFile(`/${path}`));
}

function recordingBaselineContext(workspace: TestRepository): {
  context: typeof workspace.context;
  advances: Array<{ checkoutId: number; tree: string | null }>;
} {
  const advances: Array<{ checkoutId: number; tree: string | null }> = [];
  return {
    context: {
      ...workspace.context,
      indexTracker: {
        reseal: () => true,
        advanceBaseline: (checkoutId, tree) => {
          advances.push({ checkoutId, tree });
          return true;
        },
      },
    },
    advances,
  };
}

function reopenRepo(workspace: TestRepository): Repository {
  const database = new SqliteGitDatabase(new TestDatabase(workspace.storage), {
    now: workspace.context.now,
  });
  const row = database.findCheckout("/");
  if (row === null) throw new Error("reopened repository is missing");
  return new Repository(database.openCheckout(row));
}

function expectCode(action: () => unknown, code: string): void {
  try {
    action();
  } catch (error) {
    expect(hasErrorCode(error, code)).toBe(true);
    return;
  }
  throw new Error(`expected ${code}`);
}

function divergent(
  source: GitFixture,
  conflict = false,
): {
  base: string;
  upstream: string;
  original: string;
} {
  source.write("shared.txt", "base\n");
  const base = source.commit("base");
  source.git("checkout", "-q", "-b", "upstream", base);
  source.write("upstream.txt", "upstream\n");
  if (conflict) source.write("shared.txt", "upstream\n");
  const upstream = source.commit("upstream");
  source.git("checkout", "-q", "-b", "current", base);
  source.write("one.txt", "one\n");
  source.commit("one");
  source.write("two.txt", "two\n");
  if (conflict) source.write("shared.txt", "current\n");
  const original = source.commit("two");
  return { base, upstream, original };
}

describe("rebase lifecycle", () => {
  it("fails closed before deepening and rebases after the boundary moves", async () => {
    const source = fixture();
    source.write("base.txt", "base\n");
    const base = source.commit("base");
    source.git("checkout", "-q", "-b", "upstream", base);
    source.write("upstream.txt", "upstream\n");
    const upstream = source.commit("upstream");
    source.git("checkout", "-q", "-b", "current", base);
    source.write("current.txt", "current\n");
    source.commit("current");
    const server = await startGitServer(source.dir);
    const workspace = makeWorkspace();
    try {
      await clone(workspace.context, {
        url: server.url,
        dir: "/work",
        ref: "current",
        depth: 1,
      });
      const repo = openRepository(workspace.context, "/work");
      await fetchInto(workspace.context, repo, {
        ref: "upstream",
        depth: 1,
        singleBranch: true,
        tags: false,
      });

      expectCode(
        () => rebase(workspace.context, repo, workspace.worktree, { upstream }),
        "ESHALLOW",
      );
      await fetchInto(workspace.context, repo, {
        deepen: 1,
        singleBranch: false,
        tags: false,
      });
      expect(repo.shallow()).toEqual(new Set());
      expect(rebase(workspace.context, repo, workspace.worktree, { upstream })).toMatchObject({
        outcome: "completed",
        replayed: 1,
      });
    } finally {
      await server.close();
    }
  });

  it("matches real Git for several clean commits and publishes the branch once", async () => {
    const source = fixture();
    const { original, upstream } = divergent(source);
    const originalFirst = source.git("rev-parse", `${original}^`);
    const workspace = await imported(source);
    source.git("rebase", "upstream");
    const expected = source.git("rev-parse", "HEAD");
    const originalUpdate = workspace.repo.mutateRefs.bind(workspace.repo);
    let publications = 0;
    workspace.repo.mutateRefs = (mutation, metadata) => {
      publications++;
      return originalUpdate(mutation, metadata);
    };
    const recorded = recordingBaselineContext(workspace);

    const result = rebase(recorded.context, workspace.repo, workspace.worktree, {
      upstream,
    });

    expect(result).toEqual({
      outcome: "completed",
      oid: expected,
      replayed: 2,
      skipped: 0,
      fastForward: false,
    });
    expect(workspace.repo.head()).toEqual({ ref: "refs/heads/current", oid: expected });
    const final = workspace.repo.readCommit(expected);
    const rewrittenFirst = final.parent[0];
    if (rewrittenFirst === undefined) throw new Error("rewritten history lost its first commit");
    expect(workspace.repo.readCommit(rewrittenFirst).parent).toEqual([upstream]);
    expect(final.author).toEqual(workspace.repo.readCommit(original).author);
    expect(workspace.repo.readCommit(rewrittenFirst).author).toEqual(
      workspace.repo.readCommit(originalFirst).author,
    );
    expect(workspace.repo.checkout.readOperationState()).toBeNull();
    expect(publications).toBe(1);
    expect(recorded.advances).toEqual([
      { checkoutId: workspace.repo.checkout.checkoutId, tree: final.tree },
    ]);
    expect(original).not.toBe(expected);
    const named = workspace.repo.store.reflog("refs/heads/current")[0];
    const head = workspace.repo.checkout.reflog("HEAD")[0];
    expect(named).toMatchObject({
      oldOid: original,
      newOid: expected,
      actor: { name: final.committer.name, email: final.committer.email },
      timestamp: final.committer.timestamp,
      timezoneOffset: final.committer.timezoneOffset,
      reason: "rebase: replay",
    });
    expect(head).toMatchObject({
      oldOid: original,
      newOid: expected,
      reason: "rebase: replay",
    });
    if (named === undefined || head === undefined) throw new Error("rebase reflog is missing");
    expect(head.ordinal).toBe(named.ordinal + 1);
  });

  it("handles up-to-date and fast-forward histories without a journal", async () => {
    const source = fixture();
    source.write("file.txt", "one\n");
    const first = source.commit("one");
    source.write("file.txt", "two\n");
    const second = source.commit("two");

    source.git("checkout", "-q", "-b", "behind", first);
    const behind = await imported(source);
    const behindRecorded = recordingBaselineContext(behind);
    const fastActor = { name: "Fast Forward", email: "fast-forward@example.com" };
    expect(
      rebase(behindRecorded.context, behind.repo, behind.worktree, {
        upstream: second,
        committer: fastActor,
      }),
    ).toEqual({
      outcome: "completed",
      oid: second,
      replayed: 0,
      skipped: 0,
      fastForward: true,
    });
    expect(behindRecorded.advances).toEqual([
      { checkoutId: behind.repo.checkout.checkoutId, tree: behind.repo.readCommit(second).tree },
    ]);
    expect(behind.repo.checkout.readOperationState()).toBeNull();
    const named = behind.repo.store.reflog("refs/heads/behind")[0];
    const head = behind.repo.checkout.reflog("HEAD")[0];
    expect(named).toMatchObject({
      oldOid: first,
      newOid: second,
      actor: fastActor,
      timestamp: 1_577_836_800,
      timezoneOffset: 0,
      reason: "rebase: fast-forward",
    });
    expect(head).toMatchObject({
      oldOid: first,
      newOid: second,
      reason: "rebase: fast-forward",
    });
    if (named === undefined || head === undefined) {
      throw new Error("fast-forward rebase reflog is missing");
    }
    expect(head.ordinal).toBe(named.ordinal + 1);

    source.git("checkout", "-q", "main");
    const current = await imported(source);
    const currentRecorded = recordingBaselineContext(current);
    expect(
      rebase(currentRecorded.context, current.repo, current.worktree, { upstream: first }),
    ).toEqual({
      outcome: "up-to-date",
      oid: second,
    });
    expect(currentRecorded.advances).toEqual([]);
    expect(current.repo.checkout.readOperationState()).toBeNull();
    expect(current.repo.store.reflog("refs/heads/main")).toEqual([]);
    expect(current.repo.checkout.reflog("HEAD")).toEqual([]);
  });

  it("retains a source-empty commit with its exact message and drops a result-empty commit", async () => {
    const emptySource = fixture();
    emptySource.write("base.txt", "base\n");
    const emptyBase = emptySource.commit("base");
    emptySource.git("checkout", "-q", "-b", "upstream", emptyBase);
    emptySource.write("upstream.txt", "upstream\n");
    const emptyUpstream = emptySource.commit("upstream");
    emptySource.git("checkout", "-q", "-b", "current", emptyBase);
    emptySource.git("commit", "-q", "--allow-empty", "--allow-empty-message", "-m", "");
    const originalEmpty = emptySource.git("rev-parse", "HEAD");
    const emptyWorkspace = await imported(emptySource);
    emptySource.git("rebase", "upstream");
    const expectedEmpty = emptySource.git("rev-parse", "HEAD");

    const retained = rebase(emptyWorkspace.context, emptyWorkspace.repo, emptyWorkspace.worktree, {
      upstream: emptyUpstream,
    });
    expect(retained).toMatchObject({ outcome: "completed", oid: expectedEmpty, replayed: 1 });
    expect(emptyWorkspace.repo.readCommit(expectedEmpty)).toMatchObject({
      parent: [emptyUpstream],
      message: "",
    });
    expect(expectedEmpty).not.toBe(originalEmpty);

    const redundantSource = fixture();
    redundantSource.write("base.txt", "base\n");
    const redundantBase = redundantSource.commit("base");
    redundantSource.git("checkout", "-q", "-b", "upstream", redundantBase);
    redundantSource.write("same.txt", "same\n");
    const redundantUpstream = redundantSource.commit("upstream adds change");
    redundantSource.git("checkout", "-q", "-b", "current", redundantBase);
    redundantSource.write("same.txt", "same\n");
    const redundantOriginal = redundantSource.commit("current adds same change");
    const redundantWorkspace = await imported(redundantSource);
    redundantWorkspace.repo.store.configUnset("user.name");
    redundantWorkspace.repo.store.configUnset("user.email");

    const redundantResult = rebase(
      redundantWorkspace.context,
      redundantWorkspace.repo,
      redundantWorkspace.worktree,
      {
        upstream: redundantUpstream,
        committer: { name: "Invalid <Actor", email: "invalid>actor@example.com" },
      },
    );
    expect(redundantResult).toEqual({
      outcome: "completed",
      oid: redundantUpstream,
      replayed: 0,
      skipped: 1,
      fastForward: false,
    });
    expect(redundantWorkspace.repo.store.reflog("refs/heads/current")[0]).toMatchObject({
      oldOid: redundantOriginal,
      newOid: redundantUpstream,
      actor: null,
      timestamp: 1_577_836_800,
      timezoneOffset: 0,
      reason: "rebase: replay",
    });
  });

  it("continues a conflict with the resolved index", async () => {
    const source = fixture();
    const { upstream } = divergent(source, true);
    const workspace = await imported(source);

    const suspended = rebase(workspace.context, workspace.repo, workspace.worktree, { upstream });
    expect(suspended.outcome).toBe("conflicted");
    expect(workspace.repo.head().oid).not.toBe(upstream);
    expect(workspace.repo.checkout.requireOperationState("rebase").state.phase).toBe("conflicted");

    writeWorkFile(workspace, "/shared.txt", "resolved\n");
    add(workspace.repo, workspace.worktree, { paths: ["shared.txt"] });
    const completed = rebaseContinue(workspace.context, workspace.repo, workspace.worktree);

    expect(completed.outcome).toBe("completed");
    expect(textAt(workspace, "shared.txt")).toBe("resolved\n");
    expect(workspace.repo.checkout.readOperationState()).toBeNull();
  });

  it("retains exclusions beyond the former one-megabyte component refusal", async () => {
    const source = fixture();
    const { upstream } = divergent(source, true);
    const workspace = await imported(source);
    expect(
      rebase(workspace.context, workspace.repo, workspace.worktree, { upstream }).outcome,
    ).toBe("conflicted");
    const roots = Array.from(
      { length: 64 },
      (_, ordinal) => `/foreign-${ordinal}-${"x".repeat(17_000)}`,
    );

    expectCode(
      () => rebaseContinueExcluding(workspace.context, workspace.repo, workspace.worktree, roots),
      "EUNMERGED",
    );
  });

  it("keeps a cold distinct-type rebase journal until structural abort blockers clear", async () => {
    const source = fixture();
    source.write("target.txt", "target\n");
    const base = source.commit("base");
    source.git("checkout", "-q", "-b", "upstream", base);
    source.write("lnk", "upstream file\n");
    const upstream = source.commit("upstream file");
    source.git("checkout", "-q", "-b", "current", base);
    source.symlink("target.txt", "lnk");
    const original = source.commit("current symlink");
    const workspace = await imported(source);

    expect(
      rebase(workspace.context, workspace.repo, workspace.worktree, { upstream }),
    ).toMatchObject({ outcome: "conflicted", replayed: 0 });
    expect(workspace.worktree.readlink("/lnk")).toBe("target.txt");
    expect(textAt(workspace, "lnk~HEAD")).toBe("upstream file\n");

    const cold = reopenRepo(workspace);
    expect(cold.checkout.requireOperationState("rebase").touched).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ path: "lnk", logicalPath: "lnk", purpose: "primary" }),
        expect.objectContaining({
          path: "lnk~HEAD",
          logicalPath: "lnk",
          purpose: "current-relocation",
        }),
      ]),
    );
    workspace.worktree.removeFiles(["/lnk~HEAD"]);
    writeWorkFile(workspace, "/lnk~HEAD/outside.txt", "outside\n");

    expectCode(() => rebaseAbort(cold, workspace.worktree), "ECHECKOUTFAIL");
    expect(textAt(workspace, "lnk~HEAD/outside.txt")).toBe("outside\n");
    expect(cold.checkout.readOperationState()).not.toBeNull();
    expect(cold.head().oid).toBe(original);

    workspace.worktree.removeFiles(["/lnk~HEAD/outside.txt"]);
    workspace.worktree.rmdir("/lnk~HEAD");
    rebaseAbort(cold, workspace.worktree);
    expect(cold.head().oid).toBe(original);
    expect(workspace.worktree.readlink("/lnk")).toBe("target.txt");
    expect(workspace.worktree.stat("/lnk~HEAD")).toBeNull();
    expect(cold.checkout.readOperationState()).toBeNull();
  });

  it("resumes the remaining queue after a conflict in the first step", async () => {
    const source = fixture();
    source.write("shared.txt", "base\n");
    const base = source.commit("base");
    source.git("checkout", "-q", "-b", "upstream", base);
    source.write("shared.txt", "upstream\n");
    const upstream = source.commit("upstream");
    source.git("checkout", "-q", "-b", "current", base);
    source.write("shared.txt", "current\n");
    source.commit("conflicting first");
    source.write("later.txt", "later\n");
    source.commit("clean second");
    const workspace = await imported(source);

    expect(
      rebase(workspace.context, workspace.repo, workspace.worktree, { upstream }),
    ).toMatchObject({ outcome: "conflicted", replayed: 0 });
    expect(workspace.repo.checkout.requireOperationState("rebase").state.currentStep).toBe(0);
    writeWorkFile(workspace, "/shared.txt", "resolved first\n");
    add(workspace.repo, workspace.worktree, { paths: ["shared.txt"] });

    expect(rebaseContinue(workspace.context, workspace.repo, workspace.worktree)).toMatchObject({
      outcome: "completed",
      replayed: 2,
    });
    expect(textAt(workspace, "later.txt")).toBe("later\n");
  });

  it("drops a conflicted step when its resolution equals the current parent", async () => {
    const source = fixture();
    source.write("shared.txt", "base\n");
    const base = source.commit("base");
    source.git("checkout", "-q", "-b", "upstream", base);
    source.write("shared.txt", "upstream\n");
    const upstream = source.commit("upstream");
    source.git("checkout", "-q", "-b", "current", base);
    source.write("shared.txt", "current\n");
    source.commit("conflicting change");
    const workspace = await imported(source);

    expect(
      rebase(workspace.context, workspace.repo, workspace.worktree, { upstream }).outcome,
    ).toBe("conflicted");
    writeWorkFile(workspace, "/shared.txt", "upstream\n");
    add(workspace.repo, workspace.worktree, { paths: ["shared.txt"] });

    expect(rebaseContinue(workspace.context, workspace.repo, workspace.worktree)).toEqual({
      outcome: "completed",
      oid: upstream,
      replayed: 0,
      skipped: 1,
      fastForward: false,
    });
    expect(textAt(workspace, "shared.txt")).toBe("upstream\n");
  });

  it("continues a modify-delete conflict after native rm resolution", async () => {
    const source = fixture();
    source.write("deleted.txt", "base\n");
    const base = source.commit("base");
    source.git("checkout", "-q", "-b", "upstream", base);
    source.write("deleted.txt", "upstream\n");
    const upstream = source.commit("upstream modifies");
    source.git("checkout", "-q", "-b", "current", base);
    source.remove("deleted.txt");
    source.commit("current deletes");
    const workspace = await imported(source);

    expect(
      rebase(workspace.context, workspace.repo, workspace.worktree, { upstream }).outcome,
    ).toBe("conflicted");
    rm(workspace.repo, workspace.worktree, { paths: ["deleted.txt"] });
    const result = rebaseContinue(workspace.context, workspace.repo, workspace.worktree);

    expect(result.outcome).toBe("completed");
    if (result.outcome !== "completed") throw new Error("delete resolution did not complete");
    expect(
      workspace.repo
        .readTree(workspace.repo.readCommit(result.oid).tree)
        .map((entry) => entry.name),
    ).not.toContain("deleted.txt");
  });

  it("clears modify-delete conflict stages and files on abort", async () => {
    const source = fixture();
    source.write("deleted.txt", "base\n");
    const base = source.commit("base");
    source.git("checkout", "-q", "-b", "upstream", base);
    source.write("deleted.txt", "upstream\n");
    const upstream = source.commit("upstream modifies");
    source.git("checkout", "-q", "-b", "current", base);
    source.remove("deleted.txt");
    const original = source.commit("current deletes");
    const workspace = await imported(source);

    expect(
      rebase(workspace.context, workspace.repo, workspace.worktree, { upstream }).outcome,
    ).toBe("conflicted");
    expect(workspace.repo.checkout.hasConflicts()).toBe(true);
    expect(textAt(workspace, "deleted.txt")).toBe("upstream\n");

    rebaseAbort(workspace.repo, workspace.worktree);

    expect(workspace.repo.head().oid).toBe(original);
    expect(workspace.repo.checkout.hasConflicts()).toBe(false);
    expect(textAt(workspace, "deleted.txt")).toBeNull();
    expect(
      integrationIndexMatchesTree(workspace.repo, workspace.repo.readCommit(original).tree),
    ).toBe(true);
    expect(workspace.repo.checkout.readOperationState()).toBeNull();
  });

  it("restores the current replay parent on skip and original HEAD on abort", async () => {
    const skippedSource = fixture();
    const { upstream: skippedUpstream } = divergent(skippedSource, true);
    const skipped = await imported(skippedSource);
    expect(
      rebase(skipped.context, skipped.repo, skipped.worktree, { upstream: skippedUpstream })
        .outcome,
    ).toBe("conflicted");
    const skippedResult = rebaseSkip(skipped.context, skipped.repo, skipped.worktree);
    expect(skippedResult.outcome).toBe("completed");
    expect(textAt(skipped, "shared.txt")).toBe("upstream\n");

    const abortedSource = fixture();
    const { original, upstream } = divergent(abortedSource, true);
    const aborted = await imported(abortedSource);
    expect(rebase(aborted.context, aborted.repo, aborted.worktree, { upstream }).outcome).toBe(
      "conflicted",
    );
    writeWorkFile(aborted, "/keep.txt", "untracked\n");
    rebaseAbort(aborted.repo, aborted.worktree);
    expect(aborted.repo.head().oid).toBe(original);
    expect(textAt(aborted, "shared.txt")).toBe("current\n");
    expect(textAt(aborted, "keep.txt")).toBe("untracked\n");
    expect(aborted.repo.checkout.readOperationState()).toBeNull();
  });

  it("discards all tracked conflict-time edits on skip and abort but preserves untracked files", async () => {
    const prepare = async (): Promise<{ workspace: TestRepository; upstream: string }> => {
      const source = fixture();
      source.write("shared.txt", "base\n");
      source.write("staged.txt", "base staged\n");
      source.write("unstaged.txt", "base unstaged\n");
      source.write("deleted.txt", "base deleted\n");
      const base = source.commit("base");
      source.git("checkout", "-q", "-b", "upstream", base);
      source.write("shared.txt", "upstream\n");
      const upstream = source.commit("upstream");
      source.git("checkout", "-q", "-b", "current", base);
      source.write("shared.txt", "current\n");
      source.commit("conflict");
      const workspace = await imported(source);
      expect(
        rebase(workspace.context, workspace.repo, workspace.worktree, { upstream }).outcome,
      ).toBe("conflicted");
      writeWorkFile(workspace, "/staged.txt", "staged edit\n");
      writeWorkFile(workspace, "/staged-add.txt", "staged addition\n");
      add(workspace.repo, workspace.worktree, { paths: ["staged.txt", "staged-add.txt"] });
      writeWorkFile(workspace, "/unstaged.txt", "unstaged edit\n");
      workspace.worktree.removeFiles(["/deleted.txt"]);
      writeWorkFile(workspace, "/untracked.txt", "keep me\n");
      return { workspace, upstream };
    };

    const skipped = await prepare();
    expect(
      rebaseSkip(skipped.workspace.context, skipped.workspace.repo, skipped.workspace.worktree),
    ).toMatchObject({ outcome: "completed", oid: skipped.upstream, skipped: 1 });
    for (const expected of [
      { path: "staged.txt", content: "base staged\n" },
      { path: "unstaged.txt", content: "base unstaged\n" },
      { path: "deleted.txt", content: "base deleted\n" },
    ]) {
      expect(textAt(skipped.workspace, expected.path)).toBe(expected.content);
    }
    expect(textAt(skipped.workspace, "staged-add.txt")).toBeNull();
    expect(textAt(skipped.workspace, "untracked.txt")).toBe("keep me\n");

    const aborted = await prepare();
    rebaseAbort(aborted.workspace.repo, aborted.workspace.worktree);
    for (const expected of [
      { path: "staged.txt", content: "base staged\n" },
      { path: "unstaged.txt", content: "base unstaged\n" },
      { path: "deleted.txt", content: "base deleted\n" },
    ]) {
      expect(textAt(aborted.workspace, expected.path)).toBe(expected.content);
    }
    expect(textAt(aborted.workspace, "staged-add.txt")).toBeNull();
    expect(textAt(aborted.workspace, "untracked.txt")).toBe("keep me\n");
    expect(aborted.workspace.repo.checkout.readOperationState()).toBeNull();
  });

  it("refuses dirty starts before mutation", async () => {
    const source = fixture();
    const { original, upstream } = divergent(source);
    const workspace = await imported(source);
    writeWorkFile(workspace, "/one.txt", "dirty\n");

    expectCode(
      () => rebase(workspace.context, workspace.repo, workspace.worktree, { upstream }),
      "ECHECKOUTFAIL",
    );
    expect(workspace.repo.head().oid).toBe(original);
    expect(workspace.repo.checkout.readOperationState()).toBeNull();
  });

  it("rejects unsupported source message bytes and encoding headers before mutation", async () => {
    for (const variant of ["invalid-utf8", "encoding-header"]) {
      const source = fixture();
      source.write("base.txt", "base\n");
      const base = source.commit("base");
      source.git("checkout", "-q", "-b", "upstream", base);
      source.write("upstream.txt", "upstream\n");
      const upstream = source.commit("upstream");
      source.git("checkout", "-q", "-b", "current", base);
      source.write("current.txt", "current\n");
      const ordinary = source.commit("raw-message");
      const raw = source.catFile(ordinary);
      let rewritten: Uint8Array;
      if (variant === "invalid-utf8") {
        rewritten = raw.slice();
        rewritten[rewritten.length - 2] = 0xff;
      } else {
        const text = utf8Decoder.decode(raw);
        rewritten = utf8.encode(text.replace("\n\n", "\nencoding ISO-8859-1\n\n"));
      }
      const unsupported = source.writeObject("commit", rewritten);
      source.git("update-ref", "refs/heads/current", unsupported);
      const workspace = await imported(source);

      expectCode(
        () => rebase(workspace.context, workspace.repo, workspace.worktree, { upstream }),
        "EUNSUPPORTED",
      );
      expect(workspace.repo.head()).toEqual({ ref: "refs/heads/current", oid: unsupported });
      expect(workspace.repo.checkout.readOperationState()).toBeNull();
      expect(textAt(workspace, "current.txt")).toBe("current\n");
      expect(textAt(workspace, "upstream.txt")).toBeNull();
    }
  });

  it("preserves an untracked relocation collision in a running journal, then aborts cold", async () => {
    const source = fixture();
    source.write("base.txt", "base\n");
    const base = source.commit("base");
    source.git("checkout", "-q", "-b", "upstream", base);
    source.write("x", "upstream file\n");
    const upstream = source.commit("upstream file");
    source.git("checkout", "-q", "-b", "current", base);
    source.write("x/y.txt", "current child\n");
    const original = source.commit("current directory");
    const workspace = await imported(source);
    writeWorkFile(workspace, "/x~HEAD", "pre-existing untracked\n");

    expectCode(
      () => rebase(workspace.context, workspace.repo, workspace.worktree, { upstream }),
      "ECHECKOUTFAIL",
    );
    expect(textAt(workspace, "x~HEAD")).toBe("pre-existing untracked\n");
    expect(workspace.repo.checkout.requireOperationState("rebase").state).toMatchObject({
      phase: "running",
      currentStep: 0,
      currentParentOid: upstream,
    });
    expect(textAt(workspace, "x")).toBe("upstream file\n");

    const cold = reopenRepo(workspace);
    rebaseAbort(cold, workspace.worktree);
    expect(cold.head().oid).toBe(original);
    expect(textAt(workspace, "x/y.txt")).toBe("current child\n");
    expect(textAt(workspace, "x~HEAD")).toBe("pre-existing untracked\n");
    expect(cold.checkout.readOperationState()).toBeNull();
  });

  it("authenticates only absent or directory snapshots for baseline-absent relocations", async () => {
    const source = fixture();
    source.write("base.txt", "base\n");
    const base = source.commit("base");
    source.git("checkout", "-q", "-b", "upstream", base);
    source.write("x", "upstream file\n");
    const upstream = source.commit("upstream file");
    source.git("checkout", "-q", "-b", "current", base);
    source.write("x/y.txt", "current child\n");
    source.commit("current directory");

    const absent = await imported(source);
    const upstreamTree = absent.repo.readCommit(upstream).tree;
    const upstreamFile = absent.repo.readTree(upstreamTree).find((entry) => entry.name === "x");
    if (upstreamFile === undefined) throw new Error("upstream file is missing");
    expect(rebase(absent.context, absent.repo, absent.worktree, { upstream }).outcome).toBe(
      "conflicted",
    );
    const relocation = absent.repo.checkout
      .requireOperationState("rebase")
      .touched.find((entry) => entry.path === "x~HEAD");
    expect(relocation).toMatchObject({ index: null, worktree: { kind: "absent" } });
    absent.repo.store.db.run(
      `UPDATE git_operation_touched
       SET worktree_kind = 'file', worktree_mode = ?, worktree_oid = ?, worktree_revision = 0
       WHERE checkout_id = ? AND path = 'x~HEAD'`,
      Number.parseInt(upstreamFile.mode, 8),
      upstreamFile.oid,
      absent.repo.checkout.checkoutId,
    );
    expectCode(() => rebaseSkip(absent.context, absent.repo, absent.worktree), "ECORRUPT");

    const directory = await imported(source);
    directory.worktree.writeFiles([{ path: "/x~HEAD", mode: 0o755 }]);
    expect(
      rebase(directory.context, directory.repo, directory.worktree, { upstream }).outcome,
    ).toBe("conflicted");
    expect(
      directory.repo.checkout
        .requireOperationState("rebase")
        .touched.find((entry) => entry.path === "x~HEAD"),
    ).toMatchObject({ index: null, worktree: { kind: "directory" } });
  });
});
