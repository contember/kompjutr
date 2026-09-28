import { existsSync, lstatSync, readFileSync, symlinkSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { utf8Decoder } from "../packages/git/src/common/bytes.js";
import { hasErrorCode } from "../packages/git/src/common/errors.js";
import {
  createSqliteSparseCapability,
  invalidateIndexTracker,
  readIndexTrackerState,
} from "../packages/git/src/do-fs/index.js";
import { checkoutTree } from "../packages/git/src/ops/checkout/checkout.js";
import type { GitContext } from "../packages/git/src/ops/core/context.js";
import { integrationIndexMatchesTree } from "../packages/git/src/ops/integration/integration-worktree.js";
import { rebase } from "../packages/git/src/ops/rebase/rebase.js";
import { checkout } from "../packages/git/src/ops/refs/refs.js";
import { eagerStatus } from "../packages/git/src/ops/status/status.js";
import { dirtyPaths } from "../packages/git/src/ops/worktree/worktree-io.js";
import { GitFixture } from "./helpers/git.js";
import { importFixture } from "./helpers/import.js";
import { makeRepo, type TestRepository, writeWorkFile } from "./helpers/workspace.js";

// An untracked non-directory where a tracked directory goes. Real Git replaces
// it when it is ignored and refuses otherwise; each case asks the git binary.

const fixtures: GitFixture[] = [];

afterEach(() => {
  while (fixtures.length > 0) fixtures.pop()?.dispose();
});

interface Shape {
  name: string;
  gitignore: string;
  tracked: string;
  blocker: { kind: "file" | "symlink"; path: string };
  /** Paths whose final kind is compared with Git. */
  compare: string[];
}

const IGNORED_SHAPES: readonly Shape[] = [
  {
    name: "an ignored file",
    gitignore: "logs\n",
    tracked: "logs/a.txt",
    blocker: { kind: "file", path: "logs" },
    compare: ["logs", "logs/a.txt"],
  },
  {
    name: "a nested ignored file",
    gitignore: "a/b\n",
    tracked: "a/b/c/d",
    blocker: { kind: "file", path: "a/b" },
    compare: ["a", "a/b", "a/b/c", "a/b/c/d"],
  },
  {
    name: "an ignored symlink",
    gitignore: "link\n",
    tracked: "link/x",
    blocker: { kind: "symlink", path: "link" },
    compare: ["link", "link/x", "target.txt"],
  },
];

const UNIGNORED: Shape = {
  name: "an untracked file",
  gitignore: "other\n",
  tracked: "logs/a.txt",
  blocker: { kind: "file", path: "logs" },
  compare: ["logs"],
};

type Operation = "checkout" | "rebase";

interface Prepared {
  source: GitFixture;
  workspace: TestRepository;
  context: GitContext;
}

/** `main` lacks the tracked path; `feature` adds it; `current` is a pick on `main`. */
function history(shape: Shape): GitFixture {
  const source = new GitFixture().init();
  fixtures.push(source);
  source.write(".gitignore", shape.gitignore);
  source.write("shared.txt", "base\n");
  source.write("target.txt", "target\n");
  const base = source.commit("base");
  source.git("checkout", "-q", "-b", "feature", base);
  source.write(shape.tracked, "tracked\n");
  source.git("add", "-f", shape.tracked);
  source.commit("feature");
  source.git("checkout", "-q", "-b", "current", base);
  source.write("shared.txt", "current\n");
  source.commit("current");
  return source;
}

function placeBlocker(source: GitFixture, workspace: TestRepository, shape: Shape): void {
  if (shape.blocker.kind === "file") {
    source.write(shape.blocker.path, "ignored\n");
    writeWorkFile(workspace, `/${shape.blocker.path}`, "ignored\n");
    return;
  }
  symlinkSync("target.txt", join(source.dir, shape.blocker.path));
  workspace.worktree.symlink("target.txt", `/${shape.blocker.path}`);
}

/** Every tracker mode is one a host reaches through the tracker contract. */
type TrackerMode = "none" | "written-after-seal" | "status-reseal";

async function prepared(shape: Shape, operation: Operation, mode: TrackerMode): Promise<Prepared> {
  const source = history(shape);
  if (operation === "checkout") source.git("checkout", "-q", "main");
  const workspace = makeRepo("/", { now: () => 1_577_836_800_000 });
  await importFixture(source, workspace.repo.checkout);
  checkoutTree(workspace.repo, workspace.worktree, workspace.repo.headTree());
  workspace.repo.store.configSet("user.name", "Fixture");
  workspace.repo.store.configSet("user.email", "fixture@example.com");
  if (mode === "none") {
    placeBlocker(source, workspace, shape);
    return { source, workspace, context: workspace.context };
  }
  const sparse = createSqliteSparseCapability(workspace.database.db);
  const checkoutId = workspace.repo.checkout.checkoutId;
  const context: GitContext = {
    ...workspace.context,
    indexTracker: sparse.tracker,
    selectedPaths: sparse.selected,
    commitTrees: sparse.commitTrees,
  };
  const headTree = workspace.repo.readCommit(source.git("rev-parse", "HEAD")).tree;
  if (mode === "written-after-seal") {
    expect(sparse.tracker.reseal(checkoutId, headTree, [])).toBe(true);
    placeBlocker(source, workspace, shape);
  } else {
    placeBlocker(source, workspace, shape);
    invalidateIndexTracker(workspace.database.db, checkoutId);
    eagerStatus(workspace.repo, workspace.worktree, {}, context);
  }
  const state = readIndexTrackerState(workspace.database.db, checkoutId);
  expect(state).toEqual({ available: true, baselineTreeOid: headTree });
  // The tracker records the blocker, ignored or not, so the checkout cannot take
  // the diff-bounded path around it.
  const dirty = [...sparse.workspace.dirtyPaths(checkoutId)].map((entry) => entry.path);
  expect(dirty).toContain(shape.blocker.path);
  return { source, workspace, context };
}

function kindAt(workspace: TestRepository, path: string): string {
  const stat = workspace.worktree.stat(`/${path}`);
  if (stat === null) return "absent";
  if (stat.type === "symlink") return `symlink:${workspace.worktree.readlink(`/${path}`)}`;
  if (stat.type !== "file") return stat.type;
  return `file:${utf8Decoder.decode(workspace.worktree.readFile(`/${path}`))}`;
}

function gitKindAt(source: GitFixture, path: string): string {
  const full = join(source.dir, path);
  let stat: ReturnType<typeof lstatSync>;
  try {
    stat = lstatSync(full);
  } catch {
    return "absent";
  }
  if (stat.isSymbolicLink()) return "symlink:target.txt";
  if (stat.isDirectory()) return "dir";
  return existsSync(full) ? `file:${readFileSync(full, "utf8")}` : "absent";
}

function run(prepared: Prepared, operation: Operation): void {
  const { context, workspace } = prepared;
  if (operation === "checkout") {
    checkout(context, workspace.repo, workspace.worktree, { ref: "feature" });
    return;
  }
  expect(
    rebase(context, workspace.repo, workspace.worktree, [], { upstream: "feature" }),
  ).toMatchObject({ outcome: "completed", replayed: 1 });
}

function nativeArgs(operation: Operation): string[] {
  return operation === "checkout" ? ["checkout", "-q", "feature"] : ["rebase", "-q", "feature"];
}

describe("an untracked non-directory ancestor of an added path", () => {
  for (const operation of ["checkout", "rebase"] as const) {
    for (const tracker of ["none", "written-after-seal", "status-reseal"] as const) {
      const mode = `tracker ${tracker}`;
      for (const shape of IGNORED_SHAPES) {
        it(`${operation} with ${mode} replaces ${shape.name} like Git`, async () => {
          const setup = await prepared(shape, operation, tracker);
          expect(setup.source.gitResult(...nativeArgs(operation)).status).toBe(0);

          run(setup, operation);

          const expectedTree = setup.source.git("rev-parse", "HEAD^{tree}");
          expect(setup.workspace.repo.headTree()).toBe(expectedTree);
          expect(integrationIndexMatchesTree(setup.workspace.repo, expectedTree)).toBe(true);
          expect(dirtyPaths(setup.workspace.repo, setup.workspace.worktree)).toEqual([]);
          for (const path of shape.compare) {
            expect(kindAt(setup.workspace, path), path).toBe(gitKindAt(setup.source, path));
          }
        });
      }

      it(`${operation} with ${mode} refuses ${UNIGNORED.name} like Git`, async () => {
        const setup = await prepared(UNIGNORED, operation, tracker);
        const headBefore = setup.workspace.repo.head();
        expect(setup.source.gitResult(...nativeArgs(operation)).status).not.toBe(0);

        let caught: unknown = null;
        try {
          run(setup, operation);
        } catch (error) {
          caught = error;
        }
        expect(hasErrorCode(caught, "ECHECKOUTFAIL")).toBe(true);
        expect(setup.workspace.repo.head()).toEqual(headBefore);
        expect(kindAt(setup.workspace, "logs")).toBe("file:ignored\n");
      });
    }
  }
});
