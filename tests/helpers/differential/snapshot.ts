// The compared repository state, read the same way from both sides wherever
// the two can be asked the same question.

import { existsSync } from "node:fs";
import { join } from "node:path";

import type { LocalWorkspace } from "@kompjutr/local";
import { comparePaths } from "../../../packages/git/src/common/streams.js";
import type { GitContext } from "../../../packages/git/src/ops/core/context.js";
import { openRepository } from "../../../packages/git/src/ops/core/context.js";
import { SqliteGitDatabase } from "../../../packages/git/src/store/index.js";
import type { GitFixture } from "../git.js";
import { type DiskEntry, readDisk } from "./disk.js";

export type Operation = "merge" | "cherry-pick" | "revert" | "rebase" | null;

/** Both sides commit at this instant, so equal commits get equal OIDs. */
export const FIXED_TIME = 1_577_836_800_000; // 2020-01-01T00:00:00Z

export function gitOperation(fixture: GitFixture): Operation {
  const at = (path: string): boolean => existsSync(join(fixture.dir, ".git", path));
  if (at("rebase-merge") || at("rebase-apply")) return "rebase";
  if (at("CHERRY_PICK_HEAD")) return "cherry-pick";
  if (at("REVERT_HEAD")) return "revert";
  if (at("MERGE_HEAD")) return "merge";
  return null;
}

export interface Snapshot {
  head: string | null;
  branch: string | null;
  /** `<name> <oid>`, symbolic refs and `refs/remotes/<r>/HEAD` dropped. */
  refs: string[];
  /** `<mode> <oid> <stage>\t<path>`, as `git ls-files -s` prints it. */
  index: string[];
  /** `git status --porcelain=v2`. */
  status: string;
  worktree: DiskEntry[];
  operation: Operation;
  originRefs: string[];
}

/** Written by `git clone`; kompjutr never records a remote's default branch. */
const REMOTE_HEAD = /^refs\/remotes\/[^/]+\/HEAD /;

function sortedRefs(refs: string[]): string[] {
  return refs.filter((ref) => !REMOTE_HEAD.test(ref)).sort(comparePaths);
}

/**
 * A fresh database handle per snapshot, so a reader never answers from a
 * cache the operation under test populated.
 */
function probe(workspace: LocalWorkspace): GitContext {
  return {
    database: new SqliteGitDatabase(workspace.database),
    worktree: workspace.drive,
    now: () => FIXED_TIME,
    timezoneOffset: () => 0,
  };
}

export function kompjutrOperation(workspace: LocalWorkspace): Operation {
  return openRepository(probe(workspace), "/").checkout.readOperationState()?.kind ?? null;
}

export async function snapshotKompjutr(
  workspace: LocalWorkspace,
  root: string,
  origin: GitFixture | null,
): Promise<Snapshot> {
  const repo = openRepository(probe(workspace), "/");
  let head: string | null = null;
  try {
    head = repo.head().oid;
  } catch {
    head = null;
  }
  const status = await workspace.git.runCli({ argv: ["status", "--porcelain=v2"], cwd: "/" });
  return {
    head,
    branch: (await workspace.git.currentBranch({ fullname: true })) ?? null,
    refs: sortedRefs(
      repo.store
        .listRefs("refs/")
        .filter((row) => !row.target.startsWith("ref: "))
        .map((row) => `${row.name} ${row.target}`),
    ),
    index: [...repo.checkout.indexScan()].map(
      (entry) => `${entry.mode.toString(8)} ${entry.oid} ${entry.stage}\t${entry.path}`,
    ),
    status:
      status.exitCode === 0
        ? status.stdout.trimEnd()
        : `exit ${status.exitCode}: ${status.stderr.trimEnd()}`,
    worktree: readDisk(root),
    operation: repo.checkout.readOperationState()?.kind ?? null,
    originRefs: origin === null ? [] : gitRefs(origin),
  };
}

export function snapshotGit(fixture: GitFixture, origin: GitFixture | null): Snapshot {
  const head = fixture.gitResult("rev-parse", "--verify", "--quiet", "HEAD");
  const branch = fixture.gitResult("symbolic-ref", "--quiet", "HEAD");
  return {
    head: head.status === 0 ? head.stdout.trim() : null,
    branch: branch.status === 0 ? branch.stdout.trim() : null,
    refs: gitRefs(fixture),
    index: nulRecords(fixture.gitBinary("ls-files", "-s", "-z")),
    // kompjutr detects exact renames only; ask git for the same.
    status: fixture.git("status", "--porcelain=v2", "--find-renames=100%"),
    worktree: readDisk(fixture.dir, ".git"),
    operation: gitOperation(fixture),
    originRefs: origin === null ? [] : gitRefs(origin),
  };
}

function gitRefs(fixture: GitFixture): string[] {
  const output = fixture.git("for-each-ref", "--format=%(refname) %(objectname)");
  return output === "" ? [] : sortedRefs(output.split("\n"));
}

function nulRecords(bytes: Uint8Array): string[] {
  const output = Buffer.from(bytes).toString("utf8");
  return output === "" ? [] : output.split("\0").filter((record) => record !== "");
}

export interface StateDifference {
  field: keyof Snapshot;
  kompjutr: unknown;
  git: unknown;
}

/**
 * The first field that differs, or null. While a rebase is pending, git
 * detaches onto the new base and kompjutr keeps the branch at its original
 * OID (`docs/reference/git-support.md`, `git rebase`), so HEAD, the branch
 * and every HEAD-relative status row are left out; tests/CLAUDE.md fixes
 * exactly this narrowing for the journey harness too.
 */
export function compareSnapshots(kompjutr: Snapshot, git: Snapshot): StateDifference | null {
  const rebasing = kompjutr.operation === "rebase" && git.operation === "rebase";
  const fields: (keyof Snapshot)[] = [
    "operation",
    "refs",
    "head",
    "branch",
    "index",
    "worktree",
    "status",
    "originRefs",
  ];
  for (const field of fields) {
    if (rebasing && (field === "head" || field === "branch")) continue;
    const left = rebasing && field === "status" ? headless(kompjutr.status) : kompjutr[field];
    const right = rebasing && field === "status" ? headless(git.status) : git[field];
    if (JSON.stringify(left) !== JSON.stringify(right)) {
      return { field, kompjutr: left, git: right };
    }
  }
  return null;
}

/** Unmerged, untracked and ignored rows: the ones independent of HEAD. */
function headless(status: string): string {
  return status
    .split("\n")
    .filter((line) => line.startsWith("u ") || line.startsWith("? ") || line.startsWith("! "))
    .join("\n");
}
