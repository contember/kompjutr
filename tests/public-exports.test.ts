import { describe, expect, it } from "vitest";
import type {
  GitCherryPickContinueOptions,
  GitCherryPickOptions,
  DivergenceOptions as GitCoreDivergenceOptions,
  ReadRefOptions as GitCoreReadRefOptions,
  StatusReport as GitCoreStatusReport,
  GitDivergenceOptions,
  DivergenceRelationship as GitDivergenceRelationship,
  DivergenceResult as GitDivergenceResult,
  Git as GitEntrypointGit,
  GitStatusOptions as GitEntrypointStatusOptions,
  GitStatusReport as GitEntrypointStatusReport,
  GitStatusReportOptions as GitEntrypointStatusReportOptions,
  RawRefTarget as GitRawRefTarget,
  GitReadRefOptions,
  GitRebaseContinueOptions,
  GitRebaseOptions,
  RebaseResult as GitRebaseResult,
  GitRecoverRefOptions,
  RefLogEndpoint as GitRefLogEndpoint,
  RefLogEntry as GitRefLogEntry,
  GitRefLogOptions,
  RefLogRecoverySource as GitRefLogRecoverySource,
  ReplayEmptyReason as GitReplayEmptyReason,
  ReplayResult as GitReplayResult,
  GitRevertContinueOptions,
  GitRevertOptions,
} from "../src/git/index.js";
import { divergence as gitDivergence, readRef as gitReadRef } from "../src/git/index.js";
import type {
  GitCherryPickContinueOptions as RootCherryPickContinueOptions,
  GitCherryPickOptions as RootCherryPickOptions,
  DivergenceOptions as RootCoreDivergenceOptions,
  ReadRefOptions as RootCoreReadRefOptions,
  StatusReport as RootCoreStatusReport,
  DivergenceRelationship as RootDivergenceRelationship,
  DivergenceResult as RootDivergenceResult,
  Git as RootGit,
  GitDivergenceOptions as RootGitDivergenceOptions,
  GitReadRefOptions as RootGitReadRefOptions,
  RawRefTarget as RootRawRefTarget,
  GitRebaseContinueOptions as RootRebaseContinueOptions,
  GitRebaseOptions as RootRebaseOptions,
  RebaseResult as RootRebaseResult,
  GitRecoverRefOptions as RootRecoverRefOptions,
  RefLogEndpoint as RootRefLogEndpoint,
  RefLogEntry as RootRefLogEntry,
  GitRefLogOptions as RootRefLogOptions,
  RefLogRecoverySource as RootRefLogRecoverySource,
  ReplayEmptyReason as RootReplayEmptyReason,
  ReplayResult as RootReplayResult,
  GitRevertContinueOptions as RootRevertContinueOptions,
  GitRevertOptions as RootRevertOptions,
  GitStatusOptions as RootStatusOptions,
  GitStatusReport as RootStatusReport,
  GitStatusReportOptions as RootStatusReportOptions,
} from "../src/index.js";
import { divergence as rootDivergence, readRef as rootReadRef } from "../src/index.js";

describe("public bounded read exports", () => {
  it("exposes matching divergence and raw-ref operations from both entrypoints", () => {
    const coreDivergence: RootCoreDivergenceOptions = { current: "HEAD", upstream: "main" };
    const gitCoreDivergence: GitCoreDivergenceOptions = coreDivergence;
    const options: RootGitDivergenceOptions = { ...coreDivergence, dir: "/repo" };
    const gitOptions: GitDivergenceOptions = options;
    const relationship: RootDivergenceRelationship = "diverged";
    const gitRelationship: GitDivergenceRelationship = relationship;
    const result: RootDivergenceResult = { relationship, ahead: 3, behind: 2 };
    const gitResult: GitDivergenceResult = result;

    const coreRead: RootCoreReadRefOptions = { ref: "refs/remotes/origin/HEAD" };
    const gitCoreRead: GitCoreReadRefOptions = coreRead;
    const read: RootGitReadRefOptions = { ...coreRead, dir: "/repo" };
    const gitRead: GitReadRefOptions = read;
    const target: RootRawRefTarget = {
      kind: "symbolic",
      target: "refs/remotes/origin/main",
    };
    const gitTarget: GitRawRefTarget = target;

    expect([
      gitCoreDivergence.current,
      gitOptions.dir,
      gitRelationship,
      gitResult.ahead,
      gitCoreRead.ref,
      gitRead.dir,
      gitTarget.kind,
      gitDivergence,
      rootDivergence,
      gitReadRef,
      rootReadRef,
    ]).toEqual([
      "HEAD",
      "/repo",
      "diverged",
      3,
      "refs/remotes/origin/HEAD",
      "/repo",
      "symbolic",
      gitDivergence,
      rootDivergence,
      gitReadRef,
      rootReadRef,
    ]);
  });
});

describe("public reflog exports", () => {
  it("exposes matching listing and recovery types from both entrypoints", () => {
    const endpoint: RootRefLogEndpoint = "old";
    const gitEndpoint: GitRefLogEndpoint = endpoint;
    const source: RootRefLogRecoverySource = {
      ref: "HEAD",
      ordinal: 7,
      endpoint,
    };
    const gitSource: GitRefLogRecoverySource = source;
    const read: RootRefLogOptions = { dir: "/repo", ref: "HEAD", limit: 100, before: 9 };
    const gitRead: GitRefLogOptions = read;
    const recovery: RootRecoverRefOptions = {
      dir: "/repo",
      ref: "refs/heads/main",
      source,
      expectedCurrent: null,
    };
    const gitRecovery: GitRecoverRefOptions = recovery;
    const entry: RootRefLogEntry = {
      refName: "HEAD",
      ordinal: 7,
      oldRaw: null,
      newRaw: "1".repeat(40),
      oldOid: null,
      newOid: "1".repeat(40),
      actor: null,
      timestamp: 1,
      timezoneOffset: 0,
      reason: "commit (initial)",
    };
    const gitEntry: GitRefLogEntry = entry;

    expect([
      gitEndpoint,
      gitSource.ordinal,
      gitRead.limit,
      gitRecovery.ref,
      gitEntry.newOid,
    ]).toEqual(["old", 7, 100, "refs/heads/main", "1".repeat(40)]);
  });
});

interface ReplayMethods {
  cherryPick(input: RootCherryPickOptions): Promise<RootReplayResult>;
  cherryPickContinue(input?: RootCherryPickContinueOptions): Promise<RootReplayResult>;
  cherryPickSkip(input?: { dir?: string }): Promise<void>;
  cherryPickAbort(input?: { dir?: string }): Promise<void>;
  revert(input: RootRevertOptions): Promise<RootReplayResult>;
  revertContinue(input?: RootRevertContinueOptions): Promise<RootReplayResult>;
  revertSkip(input?: { dir?: string }): Promise<void>;
  revertAbort(input?: { dir?: string }): Promise<void>;
  rebase(input: RootRebaseOptions): Promise<RootRebaseResult>;
  rebaseContinue(input?: RootRebaseContinueOptions): Promise<RootRebaseResult>;
  rebaseSkip(input?: RootRebaseContinueOptions): Promise<RootRebaseResult>;
  rebaseAbort(input?: { dir?: string }): Promise<void>;
}

function rootReplayMethods(git: RootGit): ReplayMethods {
  return {
    cherryPick: git.cherryPick,
    cherryPickContinue: git.cherryPickContinue,
    cherryPickSkip: git.cherryPickSkip,
    cherryPickAbort: git.cherryPickAbort,
    revert: git.revert,
    revertContinue: git.revertContinue,
    revertSkip: git.revertSkip,
    revertAbort: git.revertAbort,
    rebase: git.rebase,
    rebaseContinue: git.rebaseContinue,
    rebaseSkip: git.rebaseSkip,
    rebaseAbort: git.rebaseAbort,
  };
}

function gitEntrypointReplayMethods(git: GitEntrypointGit): ReplayMethods {
  return {
    cherryPick: git.cherryPick,
    cherryPickContinue: git.cherryPickContinue,
    cherryPickSkip: git.cherryPickSkip,
    cherryPickAbort: git.cherryPickAbort,
    revert: git.revert,
    revertContinue: git.revertContinue,
    revertSkip: git.revertSkip,
    revertAbort: git.revertAbort,
    rebase: git.rebase,
    rebaseContinue: git.rebaseContinue,
    rebaseSkip: git.rebaseSkip,
    rebaseAbort: git.rebaseAbort,
  };
}

describe("public replay exports", () => {
  it("exposes matching types from the root and git source entrypoints", () => {
    const rootCherryPick: RootCherryPickOptions = { source: "HEAD", dir: "/repo" };
    const gitCherryPick: GitCherryPickOptions = rootCherryPick;
    const rootCherryContinue: RootCherryPickContinueOptions = { message: "continue" };
    const gitCherryContinue: GitCherryPickContinueOptions = rootCherryContinue;
    const rootRevert: RootRevertOptions = { source: "HEAD", mainline: 1 };
    const gitRevert: GitRevertOptions = rootRevert;
    const rootRevertContinue: RootRevertContinueOptions = { dir: "/repo" };
    const gitRevertContinue: GitRevertContinueOptions = rootRevertContinue;
    const rootReason: RootReplayEmptyReason = "result";
    const gitReason: GitReplayEmptyReason = rootReason;
    const rootResult: RootReplayResult = { outcome: "empty", reason: rootReason };
    const gitResult: GitReplayResult = rootResult;
    const rootRebase: RootRebaseOptions = { upstream: "main", dir: "/repo" };
    const gitRebase: GitRebaseOptions = rootRebase;
    const rootRebaseContinue: RootRebaseContinueOptions = { dir: "/repo" };
    const gitRebaseContinue: GitRebaseContinueOptions = rootRebaseContinue;
    const rootRebaseResult: RootRebaseResult = {
      outcome: "conflicted",
      replayed: 1,
      skipped: 0,
    };
    const gitRebaseResult: GitRebaseResult = rootRebaseResult;

    expect([
      gitCherryPick.source,
      gitCherryContinue.message,
      gitRevert.source,
      gitRevertContinue.dir,
      gitReason,
      gitResult.outcome,
      gitRebase.upstream,
      gitRebaseContinue.dir,
      gitRebaseResult.outcome,
    ]).toEqual([
      "HEAD",
      "continue",
      "HEAD",
      "/repo",
      "result",
      "empty",
      "main",
      "/repo",
      "conflicted",
    ]);
    expect([rootReplayMethods, gitEntrypointReplayMethods]).toHaveLength(2);
  });
});

describe("public status exports", () => {
  it("exposes matching native option and report types from both entrypoints", () => {
    const rootOptions: RootStatusOptions = {
      dir: "/repo",
      paths: ["src"],
      includeIgnored: true,
      renames: true,
      untrackedFiles: "all",
    };
    const gitOptions: GitEntrypointStatusOptions = rootOptions;
    const rootReportOptions: RootStatusReportOptions = { ...rootOptions, branch: true };
    const gitReportOptions: GitEntrypointStatusReportOptions = rootReportOptions;
    const rootReport: RootStatusReport = {
      entries: [
        {
          path: "new.txt",
          originalPath: "old.txt",
          similarity: 100,
          index: "R",
          worktree: " ",
        },
      ],
      branch: { oid: null, head: "main" },
    };
    const gitReport: GitEntrypointStatusReport = rootReport;
    const rootCore: RootCoreStatusReport = { entries: [], branch: rootReport.branch };
    const gitCore: GitCoreStatusReport = rootCore;

    expect([
      gitOptions.dir,
      gitOptions.renames,
      gitReportOptions.branch,
      gitReport.entries[0]?.originalPath,
      gitCore.branch?.head,
    ]).toEqual(["/repo", true, true, "old.txt", "main"]);
  });
});
