import { describe, expect, it } from "vitest";
import type {
  GitAbortableNetworkOptions,
  GitBranchRenameOptions,
  GitCherryPickContinueOptions,
  GitCherryPickOptions,
  GitCloneOptions,
  GitCommitTreeOptions,
  AbortableNetworkOptions as GitCoreAbortableNetworkOptions,
  CloneOptions as GitCoreCloneOptions,
  CommitTreeOptions as GitCoreCommitTreeOptions,
  DivergenceOptions as GitCoreDivergenceOptions,
  FetchOptions as GitCoreFetchOptions,
  IndexStore as GitCoreIndexStore,
  LogOptions as GitCoreLogOptions,
  LsTreeOptions as GitCoreLsTreeOptions,
  MergeBaseKind as GitCoreMergeBaseKind,
  MergeBaseOptions as GitCoreMergeBaseOptions,
  MergeBaseResult as GitCoreMergeBaseResult,
  PushOptions as GitCorePushOptions,
  ReadRefOptions as GitCoreReadRefOptions,
  ReadTreeOptions as GitCoreReadTreeOptions,
  ReplaySnapshotConflict as GitCoreReplaySnapshotConflict,
  ReplaySnapshotOptions as GitCoreReplaySnapshotOptions,
  ReplaySnapshotResult as GitCoreReplaySnapshotResult,
  ShowOptions as GitCoreShowOptions,
  ShowResult as GitCoreShowResult,
  StatusReport as GitCoreStatusReport,
  UpdateRefDeleteOptions as GitCoreUpdateRefDeleteOptions,
  UpdateRefGuardedOptions as GitCoreUpdateRefGuardedOptions,
  UpdateRefOptions as GitCoreUpdateRefOptions,
  UpdateRefWriteOptions as GitCoreUpdateRefWriteOptions,
  WorktreeAddOptions as GitCoreWorktreeAddOptions,
  WorktreeRemoveOptions as GitCoreWorktreeRemoveOptions,
  GitDivergenceOptions,
  DivergenceRelationship as GitDivergenceRelationship,
  DivergenceResult as GitDivergenceResult,
  GitCliInput as GitEntrypointCliInput,
  GitCliResult as GitEntrypointCliResult,
  GitCliRunner as GitEntrypointCliRunner,
  GitCliRunOptions as GitEntrypointCliRunOptions,
  Git as GitEntrypointGit,
  GitStatusOptions as GitEntrypointStatusOptions,
  GitStatusReport as GitEntrypointStatusReport,
  GitStatusReportOptions as GitEntrypointStatusReportOptions,
  GitFetchOptions,
  FetchRefspec as GitFetchRefspec,
  FetchRefUpdate as GitFetchRefUpdate,
  GitLogOptions,
  GitLsFilesOptions,
  GitLsRemoteOptions,
  LsRemoteResult as GitLsRemoteResult,
  GitLsTreeOptions,
  GitMergeBaseOptions,
  PushLeaseExpectation as GitPushLeaseExpectation,
  GitPushOptions,
  PushRefStatus as GitPushRefStatus,
  PushRefspec as GitPushRefspec,
  PushTrackingResult as GitPushTrackingResult,
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
  GitRemoteGetUrlOptions,
  RemoteRefView as GitRemoteRefView,
  GitRemoteSetUrlOptions,
  RemoteTarget as GitRemoteTarget,
  ReplayEmptyReason as GitReplayEmptyReason,
  ReplayResult as GitReplayResult,
  GitRevertContinueOptions,
  GitRevertOptions,
  RevisionResolution as GitRevisionResolution,
  GitRevParseOptions,
  GitScratchAddOptions,
  GitScratchCommitTreeOptions,
  GitScratchIndex,
  GitScratchIndexCallback,
  GitScratchIndexOptions,
  GitScratchReadTreeOptions,
  GitScratchReplaySnapshotOptions,
  GitShowOptions,
  GitShowResult,
  StatusFormatOptions as GitStatusFormatOptions,
  FetchResult as GitStructuredFetchResult,
  PushResult as GitStructuredPushResult,
  GitUpdateRefOptions,
  GitWorktreeAddOptions,
  WorktreeAddTarget as GitWorktreeAddTarget,
  WorktreeInfo as GitWorktreeInfo,
  GitWorktreeRemoveOptions,
  GitWriteTreeOptions,
} from "../src/git/index.js";
import {
  MAX_LS_REMOTE_PATTERNS as GIT_MAX_LS_REMOTE_PATTERNS,
  MAX_LS_REMOTE_REFS as GIT_MAX_LS_REMOTE_REFS,
  MAX_REFSPEC_EXPANDED_DESTINATIONS as GIT_MAX_REFSPEC_EXPANDED_DESTINATIONS,
  MAX_REFSPEC_MAPPINGS as GIT_MAX_REFSPEC_MAPPINGS,
  commitTree as gitCommitTree,
  divergence as gitDivergence,
  mergeBase as gitMergeBase,
  readRef as gitReadRef,
  readTree as gitReadTree,
  replaySnapshot as gitReplaySnapshot,
  statusFormatOptions as gitStatusFormatOptions,
  updateRef as gitUpdateRef,
  worktreeAdd as gitWorktreeAdd,
  worktreeList as gitWorktreeList,
  worktreePrune as gitWorktreePrune,
  worktreeRemove as gitWorktreeRemove,
  writeTree as gitWriteTree,
} from "../src/git/index.js";
import { createGitCommand } from "../src/git/shell.js";
import type {
  GitBranchRenameOptions as RootBranchRenameOptions,
  GitCherryPickContinueOptions as RootCherryPickContinueOptions,
  GitCherryPickOptions as RootCherryPickOptions,
  GitCommitTreeOptions as RootCommitTreeOptions,
  CommitTreeOptions as RootCoreCommitTreeOptions,
  DivergenceOptions as RootCoreDivergenceOptions,
  IndexStore as RootCoreIndexStore,
  LogOptions as RootCoreLogOptions,
  LsTreeOptions as RootCoreLsTreeOptions,
  MergeBaseKind as RootCoreMergeBaseKind,
  MergeBaseOptions as RootCoreMergeBaseOptions,
  MergeBaseResult as RootCoreMergeBaseResult,
  ReadRefOptions as RootCoreReadRefOptions,
  ReadTreeOptions as RootCoreReadTreeOptions,
  ReplaySnapshotConflict as RootCoreReplaySnapshotConflict,
  ReplaySnapshotOptions as RootCoreReplaySnapshotOptions,
  ReplaySnapshotResult as RootCoreReplaySnapshotResult,
  ShowOptions as RootCoreShowOptions,
  ShowResult as RootCoreShowResult,
  StatusReport as RootCoreStatusReport,
  UpdateRefDeleteOptions as RootCoreUpdateRefDeleteOptions,
  UpdateRefGuardedOptions as RootCoreUpdateRefGuardedOptions,
  UpdateRefOptions as RootCoreUpdateRefOptions,
  UpdateRefWriteOptions as RootCoreUpdateRefWriteOptions,
  WorktreeAddOptions as RootCoreWorktreeAddOptions,
  WorktreeRemoveOptions as RootCoreWorktreeRemoveOptions,
  DivergenceRelationship as RootDivergenceRelationship,
  DivergenceResult as RootDivergenceResult,
  FetchRefspec as RootFetchRefspec,
  FetchRefUpdate as RootFetchRefUpdate,
  Git as RootGit,
  GitCliInput as RootGitCliInput,
  GitCliResult as RootGitCliResult,
  GitCliRunner as RootGitCliRunner,
  GitCliRunOptions as RootGitCliRunOptions,
  GitDivergenceOptions as RootGitDivergenceOptions,
  GitFetchOptions as RootGitFetchOptions,
  GitLogOptions as RootGitLogOptions,
  GitLsRemoteOptions as RootGitLsRemoteOptions,
  GitLsTreeOptions as RootGitLsTreeOptions,
  GitMergeBaseOptions as RootGitMergeBaseOptions,
  GitPushOptions as RootGitPushOptions,
  GitReadRefOptions as RootGitReadRefOptions,
  GitRevParseOptions as RootGitRevParseOptions,
  GitShowOptions as RootGitShowOptions,
  GitShowResult as RootGitShowResult,
  GitUpdateRefOptions as RootGitUpdateRefOptions,
  GitWorktreeAddOptions as RootGitWorktreeAddOptions,
  GitWorktreeRemoveOptions as RootGitWorktreeRemoveOptions,
  GitLsFilesOptions as RootLsFilesOptions,
  LsRemoteResult as RootLsRemoteResult,
  PushRefStatus as RootPushRefStatus,
  PushRefspec as RootPushRefspec,
  PushTrackingResult as RootPushTrackingResult,
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
  GitRemoteGetUrlOptions as RootRemoteGetUrlOptions,
  RemoteRefView as RootRemoteRefView,
  GitRemoteSetUrlOptions as RootRemoteSetUrlOptions,
  RemoteTarget as RootRemoteTarget,
  ReplayEmptyReason as RootReplayEmptyReason,
  ReplayResult as RootReplayResult,
  GitRevertContinueOptions as RootRevertContinueOptions,
  GitRevertOptions as RootRevertOptions,
  RevisionResolution as RootRevisionResolution,
  GitScratchAddOptions as RootScratchAddOptions,
  GitScratchCommitTreeOptions as RootScratchCommitTreeOptions,
  GitScratchIndex as RootScratchIndex,
  GitScratchIndexCallback as RootScratchIndexCallback,
  GitScratchIndexOptions as RootScratchIndexOptions,
  GitScratchReadTreeOptions as RootScratchReadTreeOptions,
  GitScratchReplaySnapshotOptions as RootScratchReplaySnapshotOptions,
  StatusFormatOptions as RootStatusFormatOptions,
  GitStatusOptions as RootStatusOptions,
  GitStatusReport as RootStatusReport,
  GitStatusReportOptions as RootStatusReportOptions,
  FetchResult as RootStructuredFetchResult,
  PushResult as RootStructuredPushResult,
  WorktreeAddTarget as RootWorktreeAddTarget,
  WorktreeInfo as RootWorktreeInfo,
  GitWriteTreeOptions as RootWriteTreeOptions,
} from "../src/index.js";
import {
  MAX_LS_REMOTE_PATTERNS as ROOT_MAX_LS_REMOTE_PATTERNS,
  MAX_LS_REMOTE_REFS as ROOT_MAX_LS_REMOTE_REFS,
  MAX_REFSPEC_EXPANDED_DESTINATIONS as ROOT_MAX_REFSPEC_EXPANDED_DESTINATIONS,
  MAX_REFSPEC_MAPPINGS as ROOT_MAX_REFSPEC_MAPPINGS,
  commitTree as rootCommitTree,
  divergence as rootDivergence,
  mergeBase as rootMergeBase,
  readRef as rootReadRef,
  readTree as rootReadTree,
  replaySnapshot as rootReplaySnapshot,
  statusFormatOptions as rootStatusFormatOptions,
  updateRef as rootUpdateRef,
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
  it("exposes matching scratch snapshot replay contracts", () => {
    const coreOptions: RootCoreReplaySnapshotOptions = { snapshot: "checkpoint", onto: "HEAD" };
    const gitCoreOptions: GitCoreReplaySnapshotOptions = coreOptions;
    const scratchOptions: RootScratchReplaySnapshotOptions = coreOptions;
    const gitScratchOptions: GitScratchReplaySnapshotOptions = scratchOptions;
    const conflict: RootCoreReplaySnapshotConflict = {
      path: "file.txt",
      kind: "content",
      stages: [{ stage: 2, mode: "100644", oid: "1".repeat(40) }],
    };
    const gitConflict: GitCoreReplaySnapshotConflict = conflict;
    const result: RootCoreReplaySnapshotResult = {
      outcome: "conflicted",
      conflicts: [conflict],
    };
    const gitResult: GitCoreReplaySnapshotResult = result;
    const methods: readonly (keyof RootScratchIndex)[] = ["replaySnapshot"];
    const gitMethods: readonly (keyof GitScratchIndex)[] = methods;
    expect([
      gitCoreOptions.snapshot,
      gitScratchOptions.onto,
      gitConflict.stages[0]?.stage,
      gitResult.outcome,
      gitMethods,
      gitReplaySnapshot,
    ]).toEqual(["checkpoint", "HEAD", 2, "conflicted", methods, rootReplaySnapshot]);
  });
});
describe("public bounded read exports", () => {
  it("exposes matching branch-rename and ls-files facade contracts", () => {
    const rootRename: RootBranchRenameOptions = {
      dir: "/repo",
      oldName: "main",
      newName: "primary",
    };
    const gitRename: GitBranchRenameOptions = rootRename;
    const rootLsFiles: RootLsFilesOptions = {
      dir: "/repo",
      ref: "HEAD",
      paths: ["src/*.ts"],
    };
    const gitLsFiles: GitLsFilesOptions = rootLsFiles;
    const rootMethods: readonly (keyof RootGit)[] = ["branchRename", "lsFiles"];
    const gitMethods: readonly (keyof GitEntrypointGit)[] = rootMethods;
    expect([
      gitRename.oldName,
      gitRename.newName,
      gitLsFiles.ref,
      gitLsFiles.paths,
      gitMethods,
    ]).toEqual(["main", "primary", "HEAD", ["src/*.ts"], rootMethods]);
  });
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
    const revision: RootGitRevParseOptions = { dir: "/repo", ref: "HEAD^{tree}" };
    const gitRevision: GitRevParseOptions = revision;
    const resolved: RootRevisionResolution = { oid: "1".repeat(40), mode: "40000" };
    const gitResolved: GitRevisionResolution = resolved;
    const rootMethods: readonly (keyof RootGit)[] = ["revParse", "tryRevParse"];
    const gitMethods: readonly (keyof GitEntrypointGit)[] = rootMethods;
    expect([
      gitCoreDivergence.current,
      gitOptions.dir,
      gitRelationship,
      gitResult.ahead,
      gitCoreRead.ref,
      gitRead.dir,
      gitTarget.kind,
      gitRevision.ref,
      gitResolved.mode,
      gitMethods,
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
      "HEAD^{tree}",
      "40000",
      rootMethods,
      gitDivergence,
      rootDivergence,
      gitReadRef,
      rootReadRef,
    ]);
  });
  it("exposes matching merge-base and recursive tree types from both entrypoints", () => {
    const coreMergeBase: RootCoreMergeBaseOptions = { current: "HEAD", incoming: "main" };
    const gitCoreMergeBase: GitCoreMergeBaseOptions = coreMergeBase;
    const mergeBaseOptions: RootGitMergeBaseOptions = { ...coreMergeBase, dir: "/repo" };
    const gitMergeBaseOptions: GitMergeBaseOptions = mergeBaseOptions;
    const kind: RootCoreMergeBaseKind = "divergent";
    const gitKind: GitCoreMergeBaseKind = kind;
    const result: RootCoreMergeBaseResult = { kind, bases: ["1".repeat(40)] };
    const gitResult: GitCoreMergeBaseResult = result;
    const coreLsTree: RootCoreLsTreeOptions = { recursive: true };
    const gitCoreLsTree: GitCoreLsTreeOptions = coreLsTree;
    const lsTreeOptions: RootGitLsTreeOptions = {
      dir: "/repo",
      ref: "HEAD",
      path: "src",
      recursive: true,
    };
    const gitLsTreeOptions: GitLsTreeOptions = lsTreeOptions;
    const rootMethods: readonly (keyof RootGit)[] = ["mergeBase", "lsTree"];
    const gitMethods: readonly (keyof GitEntrypointGit)[] = rootMethods;
    expect([
      gitCoreMergeBase.current,
      gitMergeBaseOptions.dir,
      gitKind,
      gitResult.bases,
      gitCoreLsTree.recursive,
      gitLsTreeOptions.path,
      gitMethods,
      gitMergeBase,
    ]).toEqual([
      "HEAD",
      "/repo",
      "divergent",
      ["1".repeat(40)],
      true,
      "src",
      rootMethods,
      rootMergeBase,
    ]);
  });
  it("exposes matching history read types from both entrypoints", () => {
    const coreLog: RootCoreLogOptions = { ref: "HEAD", paths: ["src"], firstParent: true };
    const gitCoreLog: GitCoreLogOptions = coreLog;
    const logOptions: RootGitLogOptions = { ...coreLog, dir: "/repo" };
    const gitLogOptions: GitLogOptions = logOptions;
    const coreShow: RootCoreShowOptions = { ref: "HEAD", patch: true, mainline: 1 };
    const gitCoreShow: GitCoreShowOptions = coreShow;
    const showOptions: RootGitShowOptions = { ...coreShow, dir: "/repo" };
    const gitShowOptions: GitShowOptions = showOptions;
    const commit = {
      oid: "1".repeat(40),
      message: "message\n",
      tree: "2".repeat(40),
      parent: [],
      author: { name: "Author", email: "author@example.test", timestamp: 1, timezoneOffset: 0 },
      committer: {
        name: "Committer",
        email: "committer@example.test",
        timestamp: 1,
        timezoneOffset: 0,
      },
    };
    const showResult: RootGitShowResult = { commit, patch: "" };
    const rootCoreResult: RootCoreShowResult = showResult;
    const gitShowResult: GitShowResult = rootCoreResult;
    const gitCoreResult: GitCoreShowResult = gitShowResult;
    expect([
      gitCoreLog.firstParent,
      gitLogOptions.dir,
      gitCoreShow.mainline,
      gitShowOptions.patch,
      gitCoreResult.commit.oid,
    ]).toEqual([true, "/repo", 1, true, "1".repeat(40)]);
  });
});
describe("public guarded ref exports", () => {
  it("exposes matching write, guarded, delete, and facade unions", () => {
    const write: RootCoreUpdateRefWriteOptions = {
      ref: "HEAD",
      value: "refs/heads/main",
      force: true,
      symbolic: true,
    };
    const gitWrite: GitCoreUpdateRefWriteOptions = write;
    const guarded: RootCoreUpdateRefGuardedOptions = {
      ref: "refs/heads/main",
      value: "2".repeat(40),
      expected: "1".repeat(40),
    };
    const gitGuarded: GitCoreUpdateRefGuardedOptions = guarded;
    const deletion: RootCoreUpdateRefDeleteOptions = {
      ref: "refs/heads/checkpoint",
      delete: true,
      expected: null,
    };
    const gitDeletion: GitCoreUpdateRefDeleteOptions = deletion;
    const core: RootCoreUpdateRefOptions = guarded;
    const gitCore: GitCoreUpdateRefOptions = core;
    const facade: RootGitUpdateRefOptions = { ...deletion, dir: "/repo" };
    const gitFacade: GitUpdateRefOptions = facade;
    const rootMethods: readonly (keyof RootGit)[] = ["updateRef"];
    const gitMethods: readonly (keyof GitEntrypointGit)[] = rootMethods;
    expect([
      gitWrite.symbolic,
      gitGuarded.expected,
      gitDeletion.delete,
      gitCore.ref,
      gitFacade.dir,
      gitMethods,
      gitUpdateRef,
    ]).toEqual([
      true,
      "1".repeat(40),
      true,
      "refs/heads/main",
      "/repo",
      rootMethods,
      rootUpdateRef,
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
describe("public structured refspec exports", () => {
  it("exposes native cancellation, deepening, unshallow, and lease contracts", () => {
    const signal = new AbortController().signal;
    const coreAbortable: GitCoreAbortableNetworkOptions = { signal };
    const abortable: GitAbortableNetworkOptions = coreAbortable;
    const coreClone: GitCoreCloneOptions = {
      url: "https://example.test/repo.git",
      ...abortable,
    };
    const clone: GitCloneOptions = coreClone;
    const coreDeepen: GitCoreFetchOptions = { remote: "origin", deepen: 3, ...abortable };
    const deepen: GitFetchOptions = coreDeepen;
    const coreUnshallow: GitCoreFetchOptions = { remote: "origin", unshallow: true };
    const unshallow: GitFetchOptions = coreUnshallow;
    const lease: GitPushLeaseExpectation = { expected: "1".repeat(40) };
    const corePush: GitCorePushOptions = {
      remote: "origin",
      leases: { main: lease },
      ...abortable,
    };
    const push: GitPushOptions = corePush;
    expect([
      clone.signal,
      deepen.deepen,
      unshallow.unshallow,
      push.signal,
      push.leases?.main,
    ]).toEqual([signal, 3, true, signal, lease]);
  });
  it("exposes matching frozen mapping, result, target, and limit types", () => {
    const fetch: RootFetchRefspec = {
      source: "refs/heads/*",
      destination: "refs/remotes/origin/*",
      force: true,
    };
    const gitFetch: GitFetchRefspec = fetch;
    const gitFetchOptions: GitFetchOptions = {
      dir: "/repo",
      url: "https://example.test/repo.git",
      refspecs: [fetch],
    };
    const fetchOptions: RootGitFetchOptions = gitFetchOptions;
    const push: RootPushRefspec = {
      source: null,
      destination: "refs/checkpoints/old",
    };
    const gitPush: GitPushRefspec = push;
    const pushOptions: RootGitPushOptions = {
      dir: "/repo",
      remote: "origin",
      atomic: true,
      pushOptions: ["ci.skip=true"],
      refspecs: [
        {
          source: "refs/heads/main",
          destination: "refs/heads/main",
        },
        push,
      ],
    };
    const gitPushOptions: GitPushOptions = pushOptions;
    const legacyPushOptions: GitPushOptions = {
      url: "https://example.test/repo.git",
      ref: "main",
      remoteRef: "release",
      force: true,
      delete: false,
    };
    const rootLegacyPushOptions: RootGitPushOptions = legacyPushOptions;
    const namedTarget: RootRemoteTarget = { remote: "origin" };
    const gitNamedTarget: GitRemoteTarget = namedTarget;
    const urlTarget: GitRemoteTarget = { url: "https://example.test/repo.git" };
    const rootUrlTarget: RootRemoteTarget = urlTarget;
    const update: RootFetchRefUpdate = {
      source: "refs/heads/main",
      destination: "refs/remotes/origin/main",
      oid: "1".repeat(40),
    };
    const gitUpdate: GitFetchRefUpdate = update;
    const fetchResult: RootStructuredFetchResult = {
      mode: "mapped",
      defaultBranch: "main",
      fetchHead: null,
      updates: [update],
    };
    const gitFetchResult: GitStructuredFetchResult = fetchResult;
    const remoteRef: RootRemoteRefView = { name: update.source, oid: update.oid };
    const gitRemoteRef: GitRemoteRefView = remoteRef;
    const lsRemote: RootLsRemoteResult = { refs: [remoteRef], headRef: update.source };
    const gitLsRemote: GitLsRemoteResult = lsRemote;
    const lsRemoteOptions: RootGitLsRemoteOptions = {
      dir: "/repo",
      remote: "origin",
      patterns: ["refs/heads/*"],
    };
    const gitLsRemoteOptions: GitLsRemoteOptions = lsRemoteOptions;
    const urlLsRemoteOptions: GitLsRemoteOptions = {
      url: "https://example.test/repo.git",
    };
    const rootUrlLsRemoteOptions: RootGitLsRemoteOptions = urlLsRemoteOptions;
    const rootMethods: readonly (keyof RootGit)[] = ["lsRemote", "push"];
    const gitMethods: readonly (keyof GitEntrypointGit)[] = rootMethods;
    const status: RootPushRefStatus = { ref: push.destination, ok: true, error: null };
    const gitStatus: GitPushRefStatus = status;
    const tracking: RootPushTrackingResult = { outcome: "not-applicable" };
    const gitTracking: GitPushTrackingResult = tracking;
    const pushResult: RootStructuredPushResult = {
      ok: true,
      error: null,
      unpack: { ok: true },
      refs: [status],
      tracking,
    };
    const gitPushResult: GitStructuredPushResult = pushResult;
    const pushMethod = async (_input?: RootGitPushOptions): Promise<RootStructuredPushResult> =>
      pushResult;
    const rootPushMethod: RootGit["push"] = pushMethod;
    const gitPushMethod: GitEntrypointGit["push"] = rootPushMethod;
    expect([
      gitFetch.destination,
      fetchOptions.url,
      gitPush.destination,
      gitPushOptions.atomic,
      rootLegacyPushOptions.remoteRef,
      gitNamedTarget.remote,
      rootUrlTarget.url,
      gitUpdate.destination,
      gitFetchResult.mode,
      gitRemoteRef.name,
      gitLsRemote.headRef,
      gitLsRemoteOptions.patterns,
      rootUrlLsRemoteOptions.url,
      gitMethods,
      gitStatus.ok,
      gitTracking.outcome,
      gitPushResult.ok,
      typeof gitPushMethod,
      GIT_MAX_REFSPEC_MAPPINGS,
      GIT_MAX_REFSPEC_EXPANDED_DESTINATIONS,
      ROOT_MAX_REFSPEC_MAPPINGS,
      ROOT_MAX_REFSPEC_EXPANDED_DESTINATIONS,
      GIT_MAX_LS_REMOTE_PATTERNS,
      GIT_MAX_LS_REMOTE_REFS,
      ROOT_MAX_LS_REMOTE_PATTERNS,
      ROOT_MAX_LS_REMOTE_REFS,
    ]).toEqual([
      "refs/remotes/origin/*",
      "https://example.test/repo.git",
      "refs/checkpoints/old",
      true,
      "release",
      "origin",
      "https://example.test/repo.git",
      "refs/remotes/origin/main",
      "mapped",
      "refs/heads/main",
      "refs/heads/main",
      ["refs/heads/*"],
      "https://example.test/repo.git",
      rootMethods,
      true,
      "not-applicable",
      true,
      "function",
      1024,
      1024,
      1024,
      1024,
      1024,
      16384,
      1024,
      16384,
    ]);
  });
});
describe("retired fixed policy exports", () => {
  it("does not expose retired fixed ref and config policies", async () => {
    const [gitEntrypoint, rootEntrypoint] = await Promise.all([
      import("../src/git/index.js"),
      import("../src/index.js"),
    ]);
    for (const name of [
      "MAX_LS_REMOTE_PATTERN_BYTES",
      "MAX_REFSPEC_REF_BYTES",
      "MAX_REMOTE_NAME_BYTES",
      "MAX_REMOTE_URL_BYTES",
    ]) {
      expect(gitEntrypoint).not.toHaveProperty(name);
      expect(rootEntrypoint).not.toHaveProperty(name);
    }
  });
});
describe("public remote URL exports", () => {
  it("exposes matching typed get and set options from both entrypoints", () => {
    const rootGet: RootRemoteGetUrlOptions = { dir: "/repo", name: "origin" };
    const gitGet: GitRemoteGetUrlOptions = rootGet;
    const rootSet: RootRemoteSetUrlOptions = {
      dir: "/repo",
      name: "origin",
      url: "https://example.test/repo.git",
    };
    const gitSet: GitRemoteSetUrlOptions = rootSet;
    const rootMethods: readonly (keyof RootGit)[] = ["remoteGetUrl", "remoteSetUrl"];
    const gitMethods: readonly (keyof GitEntrypointGit)[] = rootMethods;
    expect([gitGet.name, gitSet.url, gitMethods]).toEqual([
      "origin",
      "https://example.test/repo.git",
      rootMethods,
    ]);
  });
});
describe("public Git CLI exports", () => {
  it("exposes one runner contract and the explicit shell adapter subpath", async () => {
    const rootInput: RootGitCliInput = { argv: ["status", "--porcelain"], cwd: "/repo" };
    const gitInput: GitEntrypointCliInput = rootInput;
    const rootOptions: RootGitCliRunOptions = { logLimitHint: 3 };
    const gitOptions: GitEntrypointCliRunOptions = rootOptions;
    const rootResult: RootGitCliResult = {
      stdout: "",
      stderr: "",
      exitCode: 0,
      truncated: false,
    };
    const gitResult: GitEntrypointCliResult = rootResult;
    const rootRunner: RootGitCliRunner = {
      async runCli(input, options) {
        expect(input).toBe(rootInput);
        expect(options).toBe(rootOptions);
        return rootResult;
      },
    };
    const gitRunner: GitEntrypointCliRunner = rootRunner;
    expect(await gitRunner.runCli(gitInput, gitOptions)).toBe(gitResult);
    expect(typeof createGitCommand).toBe("function");
  });
});
