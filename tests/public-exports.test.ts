import { describe, expect, it } from "vitest";
import type {
  GitCherryPickContinueOptions,
  GitCherryPickOptions,
  Git as GitEntrypointGit,
  GitRebaseContinueOptions,
  GitRebaseOptions,
  RebaseResult as GitRebaseResult,
  ReplayEmptyReason as GitReplayEmptyReason,
  ReplayResult as GitReplayResult,
  GitRevertContinueOptions,
  GitRevertOptions,
} from "../src/git/index.js";
import type {
  GitCherryPickContinueOptions as RootCherryPickContinueOptions,
  GitCherryPickOptions as RootCherryPickOptions,
  Git as RootGit,
  GitRebaseContinueOptions as RootRebaseContinueOptions,
  GitRebaseOptions as RootRebaseOptions,
  RebaseResult as RootRebaseResult,
  ReplayEmptyReason as RootReplayEmptyReason,
  ReplayResult as RootReplayResult,
  GitRevertContinueOptions as RootRevertContinueOptions,
  GitRevertOptions as RootRevertOptions,
} from "../src/index.js";

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
