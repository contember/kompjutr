import { createGit, type Git, type GitWorkspaceBinding } from "@kompjutr/git";
import { describe, expect, it } from "vitest";
import { GIT_MUTATION_BOUNDARY_INVENTORY } from "./helpers/mutation-inventory.js";
import { makeWorkspace, type TestWorkspace } from "./helpers/workspace.js";

const DRIVE_WRITING_MUTATIONS = Object.freeze({
  clone: { publicMethod: "clone", seam: "provisional clone materializer" },
  checkout: { publicMethod: "checkout", seam: "checkout apply" },
  resetHard: { publicMethod: "reset", seam: "checkout apply" },
  rm: { publicMethod: "rm", seam: "physical removal" },
  clean: { publicMethod: "clean", seam: "clean removal" },
  merge: { publicMethod: "merge", seam: "merge snapshot apply" },
  mergeAbort: { publicMethod: "mergeAbort", seam: "merge snapshot restore" },
  cherryPick: { publicMethod: "cherryPick", seam: "replay snapshot apply" },
  cherryPickSkip: { publicMethod: "cherryPickSkip", seam: "replay snapshot restore" },
  cherryPickAbort: { publicMethod: "cherryPickAbort", seam: "replay snapshot restore" },
  revert: { publicMethod: "revert", seam: "replay snapshot apply" },
  revertSkip: { publicMethod: "revertSkip", seam: "replay snapshot restore" },
  revertAbort: { publicMethod: "revertAbort", seam: "replay snapshot restore" },
  rebase: { publicMethod: "rebase", seam: "rebase drive step" },
  rebaseContinue: { publicMethod: "rebaseContinue", seam: "rebase drive step" },
  rebaseSkip: { publicMethod: "rebaseSkip", seam: "rebase snapshot restore" },
  rebaseAbort: { publicMethod: "rebaseAbort", seam: "rebase baseline restore" },
  readTreeUpdate: { publicMethod: "readTree", seam: "checkout apply" },
  worktreeAdd: { publicMethod: "worktreeAdd", seam: "checkout creation callback" },
  worktreeRemove: { publicMethod: "worktreeRemove", seam: "checkout removal callback" },
  pull: { publicMethod: "pull", seam: "merge or rebase integration" },
});

function binding(workspace: TestWorkspace, scoped: boolean): GitWorkspaceBinding {
  return {
    database: workspace.database,
    worktree: {
      ...workspace.worktree,
      mutationScope: scoped ? workspace.worktree.mutationScope : undefined,
    },
    exactRootStates: workspace.context.exactRootStates,
    now: workspace.context.now,
    timezoneOffset: workspace.context.timezoneOffset,
    defaultIdentity: { name: "Scope Test", email: "scope@example.test" },
  };
}

async function committedWorkspace(): Promise<{ workspace: TestWorkspace; git: Git }> {
  const workspace = makeWorkspace();
  const git = createGit()(binding(workspace, true));
  await git.init();
  workspace.worktree.writeFile("/file.txt", new TextEncoder().encode("base\n"));
  await git.add({ paths: ["file.txt"] });
  await git.commit({ message: "base" });
  return { workspace, git };
}

describe("Git mutation scopes", () => {
  it("freezes the coupled public operation matrix", () => {
    expect(Object.keys(DRIVE_WRITING_MUTATIONS)).toEqual([
      "clone",
      "checkout",
      "resetHard",
      "rm",
      "clean",
      "merge",
      "mergeAbort",
      "cherryPick",
      "cherryPickSkip",
      "cherryPickAbort",
      "revert",
      "revertSkip",
      "revertAbort",
      "rebase",
      "rebaseContinue",
      "rebaseSkip",
      "rebaseAbort",
      "readTreeUpdate",
      "worktreeAdd",
      "worktreeRemove",
      "pull",
    ]);
    for (const operation of Object.values(DRIVE_WRITING_MUTATIONS)) {
      expect(GIT_MUTATION_BOUNDARY_INVENTORY.Git).toContain(operation.publicMethod);
      expect(operation.seam).not.toBe("");
    }
    expect(GIT_MUTATION_BOUNDARY_INVENTORY.Git).toEqual(expect.arrayContaining(["cli", "runCli"]));
    expect(GIT_MUTATION_BOUNDARY_INVENTORY.GitCliRunner).toEqual(["runCli"]);
    expect(GIT_MUTATION_BOUNDARY_INVENTORY.free).toEqual(
      expect.arrayContaining(["readTree", "worktreeAdd", "worktreeRemove"]),
    );
  });

  it("rejects coupled client operations before database or drive publication", async () => {
    const { workspace } = await committedWorkspace();
    const git = createGit()(binding(workspace, false));
    workspace.worktree.writeFile("/untracked.txt", new TextEncoder().encode("caller\n"));
    const head = await git.revParse({ ref: "HEAD" });
    const beforeRepositories = workspace.database.db.scalar<number>(
      "SELECT COUNT(*) FROM git_repositories",
    );

    const operations: Array<() => Promise<unknown>> = [
      () => git.checkout({ ref: "HEAD", force: true }),
      () => git.reset({ hard: true }),
      () => git.rm({ paths: ["file.txt"], force: true }),
      () => git.clean({ directories: true }),
      () => git.merge({ theirs: "HEAD" }),
      () => git.mergeAbort(),
      () => git.cherryPick({ source: "HEAD" }),
      () => git.cherryPickSkip(),
      () => git.cherryPickAbort(),
      () => git.revert({ source: "HEAD" }),
      () => git.revertSkip(),
      () => git.revertAbort(),
      () => git.rebase({ upstream: "HEAD" }),
      () => git.rebaseContinue(),
      () => git.rebaseSkip(),
      () => git.rebaseAbort(),
      () => git.readTree({ tree: "HEAD", updateWorktree: true }),
      () => git.worktreeAdd({ root: "/linked", target: { kind: "detached" } }),
      () => git.worktreeRemove({ root: "/linked", force: true }),
      () => git.pull(),
    ];
    expect(operations).toHaveLength(Object.keys(DRIVE_WRITING_MUTATIONS).length - 1);
    for (const operation of operations) {
      await expect(operation()).rejects.toMatchObject({ code: "EUNSUPPORTED" });
      expect(await git.revParse({ ref: "HEAD" })).toBe(head);
      expect(workspace.worktree.readFile("/file.txt")).toEqual(new TextEncoder().encode("base\n"));
      expect(workspace.worktree.readFile("/untracked.txt")).toEqual(
        new TextEncoder().encode("caller\n"),
      );
      expect(workspace.database.db.scalar("SELECT COUNT(*) FROM git_repositories")).toBe(
        beforeRepositories,
      );
    }
    const cliAliases: Array<() => Promise<unknown>> = [
      () => git.cli({ argv: ["reset", "--hard", "HEAD"], cwd: "/" }),
      () => git.runCli({ argv: ["checkout", "--force", "HEAD"], cwd: "/" }),
    ];
    for (const alias of cliAliases) {
      await expect(alias()).rejects.toMatchObject({ code: "EUNSUPPORTED" });
      expect(await git.revParse({ ref: "HEAD" })).toBe(head);
      expect(workspace.worktree.readFile("/file.txt")).toEqual(new TextEncoder().encode("base\n"));
    }
  });

  it("keeps Git-only variants usable without a writable drive scope", async () => {
    const { workspace } = await committedWorkspace();
    const git = createGit()(binding(workspace, false));
    workspace.worktree.writeFile("/untracked.txt", new TextEncoder().encode("caller\n"));
    await expect(git.reset()).resolves.toBeUndefined();
    await expect(git.clean({ dryRun: true })).resolves.toEqual(["untracked.txt"]);
    await expect(
      git.rm({ paths: ["file.txt"], cached: true, force: true }),
    ).resolves.toBeUndefined();
    expect(workspace.worktree.readFile("/file.txt")).toEqual(new TextEncoder().encode("base\n"));
  });

  it("rejects clone before reserving a repository or starting transport", async () => {
    const workspace = makeWorkspace();
    const git = createGit()(binding(workspace, false));
    await expect(
      git.clone({ url: "https://example.invalid/repository.git" }),
    ).rejects.toMatchObject({
      code: "EUNSUPPORTED",
    });
    expect(workspace.database.db.scalar("SELECT COUNT(*) FROM git_repositories")).toBe(0);
  });
});
