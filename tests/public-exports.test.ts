import { describe, expect, it } from "vitest";
import type {
  GitCherryPickContinueOptions,
  GitCherryPickOptions,
  GitCommitTreeOptions,
  CommitTreeOptions as GitCoreCommitTreeOptions,
  DivergenceOptions as GitCoreDivergenceOptions,
  IndexStore as GitCoreIndexStore,
  ReadRefOptions as GitCoreReadRefOptions,
  ReadTreeOptions as GitCoreReadTreeOptions,
  StatusReport as GitCoreStatusReport,
  WorktreeAddOptions as GitCoreWorktreeAddOptions,
  WorktreeRemoveOptions as GitCoreWorktreeRemoveOptions,
  GitDivergenceOptions,
  DivergenceRelationship as GitDivergenceRelationship,
  DivergenceResult as GitDivergenceResult,
  Git as GitEntrypointGit,
  GitStatusOptions as GitEntrypointStatusOptions,
  GitStatusReport as GitEntrypointStatusReport,
  GitStatusReportOptions as GitEntrypointStatusReportOptions,
  RawRefTarget as GitRawRefTarget,
  GitReadRefOptions,
  GitReadTreeOptions,
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
  GitScratchAddOptions,
  GitScratchCommitTreeOptions,
  GitScratchIndex,
  GitScratchIndexCallback,
  GitScratchIndexOptions,
  GitScratchReadTreeOptions,
  StatusFormatOptions as GitStatusFormatOptions,
  GitWorktreeAddOptions,
  WorktreeAddTarget as GitWorktreeAddTarget,
  WorktreeInfo as GitWorktreeInfo,
  GitWorktreeRemoveOptions,
  GitWriteTreeOptions,
} from "../src/git/index.js";
import {
  commitTree as gitCommitTree,
  divergence as gitDivergence,
  readRef as gitReadRef,
  readTree as gitReadTree,
  statusFormatOptions as gitStatusFormatOptions,
  worktreeAdd as gitWorktreeAdd,
  worktreeList as gitWorktreeList,
  worktreePrune as gitWorktreePrune,
  worktreeRemove as gitWorktreeRemove,
  writeTree as gitWriteTree,
} from "../src/git/index.js";
import type {
  GitCherryPickContinueOptions as RootCherryPickContinueOptions,
  GitCherryPickOptions as RootCherryPickOptions,
  GitCommitTreeOptions as RootCommitTreeOptions,
  CommitTreeOptions as RootCoreCommitTreeOptions,
  DivergenceOptions as RootCoreDivergenceOptions,
  IndexStore as RootCoreIndexStore,
  ReadRefOptions as RootCoreReadRefOptions,
  ReadTreeOptions as RootCoreReadTreeOptions,
  StatusReport as RootCoreStatusReport,
  WorktreeAddOptions as RootCoreWorktreeAddOptions,
  WorktreeRemoveOptions as RootCoreWorktreeRemoveOptions,
  DivergenceRelationship as RootDivergenceRelationship,
  DivergenceResult as RootDivergenceResult,
  Git as RootGit,
  GitDivergenceOptions as RootGitDivergenceOptions,
  GitReadRefOptions as RootGitReadRefOptions,
  GitWorktreeAddOptions as RootGitWorktreeAddOptions,
  GitWorktreeRemoveOptions as RootGitWorktreeRemoveOptions,
  RawRefTarget as RootRawRefTarget,
  GitReadTreeOptions as RootReadTreeOptions,
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
  GitScratchAddOptions as RootScratchAddOptions,
  GitScratchCommitTreeOptions as RootScratchCommitTreeOptions,
  GitScratchIndex as RootScratchIndex,
  GitScratchIndexCallback as RootScratchIndexCallback,
  GitScratchIndexOptions as RootScratchIndexOptions,
  GitScratchReadTreeOptions as RootScratchReadTreeOptions,
  StatusFormatOptions as RootStatusFormatOptions,
  GitStatusOptions as RootStatusOptions,
  GitStatusReport as RootStatusReport,
  GitStatusReportOptions as RootStatusReportOptions,
  WorktreeAddTarget as RootWorktreeAddTarget,
  WorktreeInfo as RootWorktreeInfo,
  GitWriteTreeOptions as RootWriteTreeOptions,
} from "../src/index.js";
import {
  commitTree as rootCommitTree,
  divergence as rootDivergence,
  readRef as rootReadRef,
  readTree as rootReadTree,
  statusFormatOptions as rootStatusFormatOptions,
  worktreeAdd as rootWorktreeAdd,
  worktreeList as rootWorktreeList,
  worktreePrune as rootWorktreePrune,
  worktreeRemove as rootWorktreeRemove,
  writeTree as rootWriteTree,
} from "../src/index.js";

describe("public object-write plumbing exports", () => {
  it("exposes matching core operations, facade options, scratch handles, and methods", () => {
    const coreRead: RootCoreReadTreeOptions = { tree: "HEAD" };
    const gitCoreRead: GitCoreReadTreeOptions = coreRead;
    const read: RootReadTreeOptions = { ...coreRead, dir: "/repo" };
    const gitRead: GitReadTreeOptions = read;
    const write: RootWriteTreeOptions = { dir: "/repo" };
    const gitWrite: GitWriteTreeOptions = write;
    const coreCommit: RootCoreCommitTreeOptions = {
      tree: "HEAD^{tree}",
      message: "snapshot\n",
      parent: ["HEAD"],
    };
    const gitCoreCommit: GitCoreCommitTreeOptions = coreCommit;
    const commit: RootCommitTreeOptions = { ...coreCommit, dir: "/repo" };
    const gitCommit: GitCommitTreeOptions = commit;
    const scratchOptions: RootScratchIndexOptions = { dir: "/repo", name: "snapshot" };
    const gitScratchOptions: GitScratchIndexOptions = scratchOptions;
    const scratchRead: RootScratchReadTreeOptions = { empty: true };
    const gitScratchRead: GitScratchReadTreeOptions = scratchRead;
    const scratchAdd: RootScratchAddOptions = { paths: [], all: true };
    const gitScratchAdd: GitScratchAddOptions = scratchAdd;
    const scratchCommit: RootScratchCommitTreeOptions = coreCommit;
    const gitScratchCommit: GitScratchCommitTreeOptions = scratchCommit;
    const callback: RootScratchIndexCallback<string> = (scratch: RootScratchIndex) => {
      scratch.readTree(scratchRead);
      scratch.add(scratchAdd);
      const tree = scratch.writeTree();
      return scratch.commitTree({ ...scratchCommit, tree });
    };
    const gitCallback: GitScratchIndexCallback<string> = (scratch: GitScratchIndex) =>
      callback(scratch);
    const rootIndex: RootCoreIndexStore | undefined = undefined;
    const gitIndex: GitCoreIndexStore | undefined = rootIndex;
    const rootMethods: readonly (keyof RootGit)[] = [
      "readTree",
      "writeTree",
      "commitTree",
      "withScratchIndex",
    ];
    const gitMethods: readonly (keyof GitEntrypointGit)[] = rootMethods;

    expect([
      gitCoreRead.tree,
      gitRead.dir,
      gitWrite.dir,
      gitCoreCommit.message,
      gitCommit.dir,
      gitScratchOptions.name,
      gitScratchRead.empty,
      gitScratchAdd.all,
      gitScratchCommit.parent,
      gitCallback,
      gitIndex,
      gitMethods,
      gitReadTree,
      rootReadTree,
      gitWriteTree,
      rootWriteTree,
      gitCommitTree,
      rootCommitTree,
    ]).toEqual([
      "HEAD",
      "/repo",
      "/repo",
      "snapshot\n",
      "/repo",
      "snapshot",
      true,
      true,
      ["HEAD"],
      gitCallback,
      undefined,
      rootMethods,
      gitReadTree,
      rootReadTree,
      gitWriteTree,
      rootWriteTree,
      gitCommitTree,
      rootCommitTree,
    ]);
  });
});

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

describe("public status formatting exports", () => {
  it("exposes matching options and configuration resolvers from both entrypoints", () => {
    const options: RootStatusFormatOptions = { quotePath: false, zeroTerminate: true };
    const gitOptions: GitStatusFormatOptions = options;

    expect([gitOptions.quotePath, gitOptions.zeroTerminate, gitStatusFormatOptions]).toEqual([
      false,
      true,
      rootStatusFormatOptions,
    ]);
  });
});

describe("public worktree lifecycle exports", () => {
  it("exposes matching core operations, public options, results, and Git methods", () => {
    const target: RootWorktreeAddTarget = {
      kind: "new-branch",
      name: "session",
      startPoint: "HEAD",
    };
    const gitTarget: GitWorktreeAddTarget = target;
    const coreAdd: RootCoreWorktreeAddOptions = { root: "/session", target };
    const gitCoreAdd: GitCoreWorktreeAddOptions = coreAdd;
    const add: RootGitWorktreeAddOptions = { ...coreAdd, dir: "/primary" };
    const gitAdd: GitWorktreeAddOptions = add;
    const coreRemove: RootCoreWorktreeRemoveOptions = { root: "/session", force: true };
    const gitCoreRemove: GitCoreWorktreeRemoveOptions = coreRemove;
    const remove: RootGitWorktreeRemoveOptions = { ...coreRemove, dir: "/primary" };
    const gitRemove: GitWorktreeRemoveOptions = remove;
    const result: RootWorktreeInfo = {
      checkoutId: 2,
      root: "/session",
      head: "ref: refs/heads/session",
      isPrimary: false,
      state: "present",
    };
    const gitResult: GitWorktreeInfo = result;
    const rootMethods: readonly (keyof RootGit)[] = [
      "worktreeAdd",
      "worktreeList",
      "worktreeRemove",
      "worktreePrune",
    ];
    const gitMethods: readonly (keyof GitEntrypointGit)[] = rootMethods;

    expect([
      gitTarget.kind,
      gitCoreAdd.root,
      gitAdd.dir,
      gitCoreRemove.force,
      gitRemove.dir,
      gitResult.state,
      gitMethods,
      gitWorktreeAdd,
      gitWorktreeList,
      gitWorktreeRemove,
      gitWorktreePrune,
      rootWorktreeAdd,
      rootWorktreeList,
      rootWorktreeRemove,
      rootWorktreePrune,
    ]).toEqual([
      "new-branch",
      "/session",
      "/primary",
      true,
      "/primary",
      "present",
      rootMethods,
      gitWorktreeAdd,
      gitWorktreeList,
      gitWorktreeRemove,
      gitWorktreePrune,
      rootWorktreeAdd,
      rootWorktreeList,
      rootWorktreeRemove,
      rootWorktreePrune,
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
