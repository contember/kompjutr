import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { fromHex, utf8, utf8Decoder } from "../src/core/bytes.js";
import { serializeCommit } from "../src/core/objects.js";
import { commit } from "../src/core/ops/commit.js";
import {
  configGet,
  configSet,
  remoteAdd,
  remoteList,
  remoteRemove,
} from "../src/core/ops/config.js";
import { initRepository } from "../src/core/ops/init.js";
import type { RemoteView } from "../src/core/ops/kinds.js";
import type { MergeStateMetadata } from "../src/core/ops/merge-state.js";
import {
  catFile,
  hashObject,
  type RawRefTarget,
  readRef,
  repoRoot,
  symbolicRef,
  updateRef,
} from "../src/core/ops/plumbing.js";
import {
  branch,
  branchDelete,
  branchList,
  branchRename,
  checkout,
  checkoutBlockersOwned,
  currentBranch,
  switchBranch,
  tag,
  tagDelete,
  tagList,
} from "../src/core/ops/refs.js";
import { walkWorktree } from "../src/core/ops/worktree-io.js";
import { joinPath } from "../src/core/paths.js";
import { Repository } from "../src/core/repository.js";
import type { RemoveOptions, WriteEntry, WriteOptions } from "../src/fs/types.js";
import { type IndexEntry, SqliteGitDatabase } from "../src/sqlite/store.js";
import { GitFixture } from "./helpers/git.js";
import { importFixture } from "./helpers/import.js";
import {
  makeRepo,
  makeWorkspace,
  type TestRepository,
  writeWorkFile,
} from "./helpers/workspace.js";
import { CountingWorktree } from "./helpers/worktree.js";

/**
 * Two branches whose trees differ by an added, a deleted and a modified
 * file, plus a directory that only one of them has — so a branch switch
 * has to write, remove and prune.
 */
function buildFixture(): GitFixture {
  const fixture = new GitFixture().init("main");
  fixture.write("common.txt", "same\n");
  fixture.write("modified.txt", "base\n");
  fixture.write("deleted.txt", "gone later\n");
  fixture.write("dir/nested.txt", "nested\n");
  fixture.commit("base");
  fixture.git("checkout", "-q", "-b", "side");
  fixture.write("modified.txt", "side\n");
  fixture.remove("deleted.txt");
  fixture.write("extra/side.txt", "extra\n");
  fixture.commit("side work");
  fixture.git("checkout", "-q", "main");
  fixture.write("modified.txt", "main\n");
  fixture.write("only/main.txt", "only\n");
  fixture.commit("main work");
  fixture.git("tag", "v1");
  return fixture;
}

let fixture: GitFixture;
let ws: TestRepository;

beforeEach(async () => {
  fixture = buildFixture();
  ws = makeRepo("/");
  await importFixture(fixture, ws.repo.checkout);
});

afterEach(() => fixture.dispose());

/** Every file in the fixture's working tree, `.git` aside. */
function diskTree(dir: string, prefix = "", out = new Map<string, string>()): Map<string, string> {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === ".git") continue;
    const path = prefix === "" ? entry.name : `${prefix}/${entry.name}`;
    if (entry.isDirectory()) diskTree(join(dir, entry.name), path, out);
    else out.set(path, readFileSync(join(dir, entry.name), "utf8"));
  }
  return out;
}

function ourTree(): Map<string, string> {
  return workspaceTree(ws);
}

function workspaceTree(workspace: TestRepository): Map<string, string> {
  const out = new Map<string, string>();
  for (const path of walkWorktree(workspace.worktree, workspace.repo.root)) {
    out.set(
      path,
      utf8Decoder.decode(workspace.worktree.readFile(joinPath(workspace.repo.root, path))),
    );
  }
  return out;
}

function sorted(tree: Map<string, string>): [string, string][] {
  return [...tree].sort((a, b) => (a[0] < b[0] ? -1 : 1));
}

/** The whole working tree, ours against git's. */
function expectSameTree(): void {
  expect(sorted(ourTree())).toEqual(sorted(diskTree(fixture.dir)));
}

function indexPaths(): string[] {
  return ws.repo.checkout.indexEntries().map((entry) => entry.path);
}

function lines(output: string): string[] {
  return output === "" ? [] : output.split("\n");
}

interface GitRun {
  ok: boolean;
  output: string;
}

/** `GitFixture.git` throws on a non-zero exit; failures are the point here. */
function runGit(...args: string[]): GitRun {
  try {
    return { ok: true, output: fixture.git(...args) };
  } catch (error) {
    return { ok: false, output: stderrOf(error) };
  }
}

function stderrOf(error: unknown): string {
  if (typeof error === "object" && error !== null && "stderr" in error) {
    const stderr = error.stderr;
    if (typeof stderr === "string") return stderr;
  }
  return String(error);
}

function gitRawRefTarget(ref: string): RawRefTarget {
  const symbolic = runGit("symbolic-ref", "--no-recurse", "-q", ref);
  if (symbolic.ok) return { kind: "symbolic", target: symbolic.output };
  const oid = fixture.git("for-each-ref", "--format=%(objectname)", ref);
  return oid === "" ? { kind: "absent" } : { kind: "direct", oid };
}

function parseRemotes(output: string): RemoteView[] {
  const urls = new Map<string, string>();
  for (const line of lines(output)) {
    const [name, rest] = line.split("\t");
    if (name === undefined || rest === undefined) continue;
    urls.set(name, rest.replace(/ \((fetch|push)\)$/, ""));
  }
  return [...urls].map(([name, url]) => ({ name, url }));
}

describe("branch", () => {
  it("creates a branch at HEAD and at a start point", () => {
    branch(ws.context, ws.repo, { name: "feature" });
    branch(ws.context, ws.repo, { name: "from-side", startPoint: "side" });
    fixture.git("branch", "feature");
    fixture.git("branch", "from-side", "side");

    expect(ws.repo.resolveRef("refs/heads/feature")).toBe(fixture.git("rev-parse", "feature"));
    expect(ws.repo.resolveRef("refs/heads/from-side")).toBe(fixture.git("rev-parse", "from-side"));
    expect(branchList(ws.repo)).toEqual(lines(fixture.git("branch", "--format=%(refname:short)")));
  });

  it("points HEAD at the new branch when asked, without touching the tree", () => {
    branch(ws.context, ws.repo, { name: "feature", startPoint: "side", checkout: true });
    expect(ws.repo.head().ref).toBe("refs/heads/feature");
    expect(indexPaths()).toEqual([]);
  });

  it("expands a matched long short-name candidate", () => {
    const name = "n".repeat(1_000_001);
    const full = `refs/remotes/${name}`;
    const main = ws.repo.store.getRef("refs/heads/main");
    if (main === null) throw new Error("long ref expansion fixture is missing main");
    ws.repo.store.db.run(
      "INSERT INTO git_refs (repo_id, name, target) VALUES (?, ?, ?)",
      ws.repo.store.repoId,
      full,
      main,
    );
    expect(ws.repo.expandRef(name)).toBe(full);
    expect(
      ws.repo.store.db.scalar<string>(
        "SELECT target FROM git_refs WHERE repo_id = ? AND name = ?",
        ws.repo.store.repoId,
        full,
      ),
    ).toBe(main);
  });

  it.each([
    ["invalid character", "topic\nother", "ref name contains an invalid character"],
    ["noncanonical UTF-16", "topic\udc00", "ref name is not canonical UTF-16"],
  ])("validates an expand-ref %s before probing", (_case, name, message) => {
    expect(() => ws.repo.expandRef(name)).toThrowError(
      expect.objectContaining({ code: "EINVAL", message }),
    );
  });

  it("reads a long raw HEAD and symbolic slice", () => {
    const ref = `refs/heads/${"h".repeat(1_000_001)}`;
    const rawHead = `ref: ${ref}`;
    const main = ws.repo.store.getRef("refs/heads/main");
    if (main === null) throw new Error("long public HEAD fixture is missing main");
    ws.repo.store.db.run(
      "INSERT INTO git_refs (repo_id, name, target) VALUES (?, ?, ?)",
      ws.repo.store.repoId,
      ref,
      main,
    );
    ws.repo.store.db.run(
      "UPDATE git_checkouts SET head = ? WHERE id = ?",
      rawHead,
      ws.repo.checkout.checkoutId,
    );
    expect(readRef(ws.repo, { ref: "HEAD" })).toEqual({ kind: "symbolic", target: ref });
    expect(ws.repo.checkout.head()).toBe(rawHead);
    expect(ws.repo.head()).toEqual({ ref, oid: main });
    expect(symbolicRef(ws.repo)).toBe(ref);
    expect(currentBranch(ws.repo, { fullname: true })).toBe(ref);
  });

  it.each([{ kind: "branch" }, { kind: "tag" }])(
    "force-replaces a long symbolic $kind target",
    ({ kind }) => {
      const prepare = (): { workspace: TestRepository; full: string; raw: string } => {
        const workspace = makeRepo("/");
        commit(workspace.context, workspace.repo, {
          message: "replacement base",
          author: { name: "Fixture", email: "fixture@example.test" },
          committer: { name: "Fixture", email: "fixture@example.test" },
          allowEmpty: true,
        });
        const full = kind === "branch" ? "refs/heads/replaced" : "refs/tags/replaced";
        const raw = `ref: refs/heads/${"x".repeat(1_000_001)}`;
        workspace.repo.store.db.run(
          "INSERT INTO git_refs (repo_id, name, target) VALUES (?, ?, ?)",
          workspace.repo.store.repoId,
          full,
          raw,
        );
        return { workspace, full, raw };
      };
      const run = (workspace: TestRepository): void => {
        if (kind === "branch") {
          branch(workspace.context, workspace.repo, {
            name: "replaced",
            startPoint: "HEAD",
            force: true,
          });
        } else {
          tag(workspace.context, workspace.repo, {
            name: "replaced",
            object: "HEAD",
            force: true,
          });
        }
      };

      const prepared = prepare();
      run(prepared.workspace);
      expect(prepared.workspace.repo.store.getRef(prepared.full)).not.toBe(prepared.raw);
    },
  );

  it("deletes a branch but refuses to delete the checked-out one", () => {
    branch(ws.context, ws.repo, { name: "feature" });
    fixture.git("branch", "feature");

    branchDelete(ws.context, ws.repo, { name: "feature" });
    fixture.git("branch", "-d", "feature");
    expect(branchList(ws.repo)).toEqual(lines(fixture.git("branch", "--format=%(refname:short)")));

    expect(() => branchDelete(ws.context, ws.repo, { name: "main" })).toThrow(/checked out/);
    expect(runGit("branch", "-d", "main").ok).toBe(false);
    expect(branchList(ws.repo)).toContain("main");

    expect(() => branchDelete(ws.context, ws.repo, { name: "nope" })).toThrow(/not found/);
    expect(runGit("branch", "-d", "nope").ok).toBe(false);
  });

  it("refuses an unmerged branch unless forced", () => {
    const side = fixture.git("rev-parse", "side");

    expect(() => branchDelete(ws.context, ws.repo, { name: "side" })).toThrowError(
      expect.objectContaining({ code: "EBRANCHFAIL" }),
    );
    expect(runGit("branch", "-d", "side").ok).toBe(false);
    expect(ws.repo.store.getRef("refs/heads/side")).toBe(side);

    branchDelete(ws.context, ws.repo, { name: "side", force: true });
    fixture.git("branch", "-D", "side");
    expect(ws.repo.store.getRef("refs/heads/side")).toBeNull();
    expect(gitRawRefTarget("refs/heads/side")).toEqual({ kind: "absent" });
  });

  it("rolls back a branch-level stale delete interleaving", () => {
    branch(ws.context, ws.repo, { name: "raced", startPoint: "side" });
    const name = "refs/heads/raced";
    const tip = ws.repo.store.getRef(name);
    const replacement = ws.repo.store.getRef("refs/heads/main");
    if (tip === null || replacement === null) throw new Error("branch fixture is incomplete");
    let raced = false;
    const context = {
      ...ws.context,
      now: (): number => {
        if (!raced) {
          raced = true;
          ws.repo.store.setRef(name, replacement);
        }
        return ws.context.now();
      },
    };

    expect(() => branchDelete(context, ws.repo, { name: "raced", force: true })).toThrowError(
      expect.objectContaining({ code: "ESTALEHEAD" }),
    );
    expect(raced).toBe(true);
    expect(ws.repo.store.getRef(name)).toBe(tip);
  });

  it("uses a resolvable upstream instead of HEAD in both directions", () => {
    branch(ws.context, ws.repo, { name: "side-upstream", startPoint: "side" });
    fixture.git("branch", "side-upstream", "side");
    ws.repo.store.configSet("branch.side.remote", ".");
    ws.repo.store.configSet("branch.side.merge", "refs/heads/side-upstream");
    fixture.git("config", "branch.side.remote", ".");
    fixture.git("config", "branch.side.merge", "refs/heads/side-upstream");

    branchDelete(ws.context, ws.repo, { name: "side" });
    fixture.git("branch", "-d", "side");
    expect(ws.repo.store.getRef("refs/heads/side")).toBeNull();

    branch(ws.context, ws.repo, { name: "candidate", startPoint: "main" });
    branch(ws.context, ws.repo, { name: "unmerged-upstream", startPoint: "side-upstream" });
    fixture.git("branch", "candidate", "main");
    fixture.git("branch", "unmerged-upstream", "side-upstream");
    ws.repo.store.configSet("branch.candidate.remote", ".");
    ws.repo.store.configSet("branch.candidate.merge", "refs/heads/unmerged-upstream");
    fixture.git("config", "branch.candidate.remote", ".");
    fixture.git("config", "branch.candidate.merge", "refs/heads/unmerged-upstream");

    expect(() => branchDelete(ws.context, ws.repo, { name: "candidate" })).toThrowError(
      expect.objectContaining({ code: "EBRANCHFAIL" }),
    );
    expect(runGit("branch", "-d", "candidate").ok).toBe(false);
    expect(ws.repo.store.getRef("refs/heads/candidate")).toBe(
      fixture.git("rev-parse", "candidate"),
    );
  });

  it("falls back to attached or detached HEAD when the upstream target is missing", () => {
    branch(ws.context, ws.repo, { name: "ancestor", startPoint: "main~1" });
    fixture.git("branch", "ancestor", "main~1");
    ws.repo.store.configSet("branch.ancestor.remote", ".");
    ws.repo.store.configSet("branch.ancestor.merge", "refs/heads/missing");
    fixture.git("config", "branch.ancestor.remote", ".");
    fixture.git("config", "branch.ancestor.merge", "refs/heads/missing");

    branchDelete(ws.context, ws.repo, { name: "ancestor" });
    fixture.git("branch", "-d", "ancestor");
    expect(ws.repo.store.getRef("refs/heads/ancestor")).toBeNull();

    const main = fixture.git("rev-parse", "main");
    ws.repo.checkout.setHead(main);
    fixture.git("checkout", "-q", "--detach", main);
    branch(ws.context, ws.repo, { name: "detached-merged", startPoint: main });
    fixture.git("branch", "detached-merged", main);
    branchDelete(ws.context, ws.repo, { name: "detached-merged" });
    fixture.git("branch", "-d", "detached-merged");

    expect(() => branchDelete(ws.context, ws.repo, { name: "side" })).toThrowError(
      expect.objectContaining({ code: "EBRANCHFAIL" }),
    );
    expect(runGit("branch", "-d", "side").ok).toBe(false);
    expect(ws.repo.store.getRef("refs/heads/side")).not.toBeNull();
  });

  it("refuses safe deletion without a comparison commit and across a shallow boundary", () => {
    ws.repo.checkout.setHead("ref: refs/heads/unborn");
    expect(() => branchDelete(ws.context, ws.repo, { name: "side" })).toThrowError(
      expect.objectContaining({ code: "EBRANCHFAIL" }),
    );
    expect(ws.repo.store.getRef("refs/heads/side")).not.toBeNull();

    ws.repo.checkout.setHead("ref: refs/heads/main");
    ws.repo.store.setShallow([fixture.git("rev-parse", "main")]);
    expect(() => branchDelete(ws.context, ws.repo, { name: "side" })).toThrowError(
      expect.objectContaining({ code: "ESHALLOW" }),
    );
    expect(ws.repo.store.getRef("refs/heads/side")).not.toBeNull();
  });

  it("evaluates a graph above the former retained ceiling without deleting an unmerged branch", () => {
    const main = ws.repo.store.getRef("refs/heads/main");
    if (main === null) throw new Error("main is missing");
    const tree = ws.repo.readCommit(main).tree;
    const person = {
      name: "Fixture",
      email: "fixture@example.com",
      timestamp: 1_577_836_800,
      timezoneOffset: 0,
    };
    const tip = ws.repo.store.writeObjects((batch) => {
      let parent = main;
      for (let index = 0; index < 20; index++) {
        parent = batch.write(
          "commit",
          serializeCommit({
            tree,
            parent: [parent],
            author: person,
            committer: person,
            message: `${index}\n${"x".repeat(850_000)}`,
          }),
        );
      }
      return parent;
    });
    ws.repo.store.setRef("refs/heads/oversized-graph", tip);

    expect(() => branchDelete(ws.context, ws.repo, { name: "oversized-graph" })).toThrowError(
      expect.objectContaining({ code: "EBRANCHFAIL" }),
    );
    expect(ws.repo.store.getRef("refs/heads/oversized-graph")).toBe(tip);
  });

  it("accepts a former first-excess upstream ref and validates the tip even with force", () => {
    branch(ws.context, ws.repo, { name: "candidate" });
    ws.repo.store.configSet("branch.candidate.remote", ".");
    const prefix = "refs/heads/";
    ws.repo.store.configSet(
      "branch.candidate.merge",
      `${prefix}${"x".repeat(1_025 - prefix.length)}`,
    );
    branchDelete(ws.context, ws.repo, { name: "candidate" });
    expect(ws.repo.store.getRef("refs/heads/candidate")).toBeNull();

    const blob = ws.repo.store.write("blob", utf8.encode("not a commit\n"));
    ws.repo.store.setRef("refs/heads/not-a-commit", blob);
    expect(() =>
      branchDelete(ws.context, ws.repo, { name: "not-a-commit", force: true }),
    ).toThrowError(expect.objectContaining({ code: "ECORRUPT" }));
    expect(ws.repo.store.getRef("refs/heads/not-a-commit")).toBe(blob);

    const main = ws.repo.store.getRef("refs/heads/main");
    if (main === null) throw new Error("main is missing");
    const valid = ws.repo.store.write(
      "commit",
      serializeCommit({
        tree: ws.repo.readCommit(main).tree,
        parent: [main],
        author: {
          name: "Fixture",
          email: "fixture@example.com",
          timestamp: 1_577_836_800,
          timezoneOffset: 0,
        },
        committer: {
          name: "Fixture",
          email: "fixture@example.com",
          timestamp: 1_577_836_800,
          timezoneOffset: 0,
        },
        message: "corrupt me\n",
      }),
    );
    ws.repo.store.setRef("refs/heads/corrupt-commit", valid);
    ws.repo.store.db.run(
      "DELETE FROM git_commits WHERE repo_id = ? AND oid = ?",
      ws.repo.store.repoId,
      valid,
    );
    ws.repo.store.db.run(
      "UPDATE git_objects SET stored = 'raw' WHERE repo_id = ? AND oid = ?",
      ws.repo.store.repoId,
      valid,
    );
    ws.repo.store.db.run(
      `UPDATE git_object_chunks SET data = zeroblob((
         SELECT size FROM git_objects WHERE repo_id = ? AND oid = ?
       )) WHERE repo_id = ? AND oid = ? AND seq = 0`,
      ws.repo.store.repoId,
      valid,
      ws.repo.store.repoId,
      valid,
    );
    ws.repo.store.db.run(
      "DELETE FROM git_object_chunks WHERE repo_id = ? AND oid = ? AND seq > 0",
      ws.repo.store.repoId,
      valid,
    );
    const coldDatabase = new SqliteGitDatabase(ws.repo.store.db);
    const checkout = coldDatabase.findCheckout("/");
    if (checkout === null) throw new Error("primary checkout is missing");
    const coldRepo = new Repository(coldDatabase.openCheckout(checkout));
    const coldContext = { ...ws.context, database: coldDatabase };

    expect(() =>
      branchDelete(coldContext, coldRepo, { name: "corrupt-commit", force: true }),
    ).toThrowError(expect.objectContaining({ code: "ECORRUPT" }));
    expect(coldRepo.store.getRef("refs/heads/corrupt-commit")).toBe(valid);
  });

  it("overwrites an existing branch only with force", () => {
    branch(ws.context, ws.repo, { name: "dup", startPoint: "side" });
    fixture.git("branch", "dup", "side");
    expect(() => branch(ws.context, ws.repo, { name: "dup", startPoint: "main" })).toThrow(
      /already exists/,
    );
    expect(runGit("branch", "dup", "main").ok).toBe(false);
    expect(ws.repo.resolveRef("refs/heads/dup")).toBe(fixture.git("rev-parse", "side"));

    branch(ws.context, ws.repo, { name: "dup", startPoint: "main", force: true });
    fixture.git("branch", "-f", "dup", "main");
    expect(ws.repo.resolveRef("refs/heads/dup")).toBe(fixture.git("rev-parse", "dup"));
  });

  it("branch rename moves current HEAD, config, and causal reflogs", () => {
    ws.repo.store.configAdd("branch.main.merge", "refs/heads/main");
    ws.repo.store.configAdd("branch.main.merge", "refs/heads/integration");
    ws.repo.store.configSet("branch.main.remote", "origin");
    fixture.git("config", "--add", "branch.main.merge", "refs/heads/main");
    fixture.git("config", "--add", "branch.main.merge", "refs/heads/integration");
    fixture.git("config", "branch.main.remote", "origin");

    branchRename(ws.context, ws.repo, { newName: "primary" });
    fixture.git("branch", "-m", "primary");

    expect(currentBranch(ws.repo)).toBe(fixture.git("branch", "--show-current"));
    expect(branchList(ws.repo)).toEqual(lines(fixture.git("branch", "--format=%(refname:short)")));
    expect(ws.repo.store.configGetAll("branch.primary.merge")).toEqual(
      lines(fixture.git("config", "--get-all", "branch.primary.merge")),
    );
    expect(ws.repo.store.configGet("branch.primary.remote")).toBe(
      fixture.git("config", "--get", "branch.primary.remote"),
    );
    expect(ws.repo.store.configPaths("branch.main.")).toEqual([]);
    expect(
      ws.repo.store.db.all<Record<string, unknown>>(
        `SELECT ref_name, old_raw, new_raw, reason FROM git_reflog_entries
          WHERE repo_id = ? ORDER BY ordinal`,
        ws.repo.store.repoId,
      ),
    ).toEqual([
      {
        ref_name: "refs/heads/main",
        old_raw: fixture.git("rev-parse", "primary"),
        new_raw: null,
        reason: "branch: rename",
      },
      {
        ref_name: "refs/heads/primary",
        old_raw: null,
        new_raw: fixture.git("rev-parse", "primary"),
        reason: "branch: rename",
      },
    ]);
    expect(
      ws.repo.store.db.one<Record<string, unknown>>(
        `SELECT old_raw, new_raw, reason FROM git_checkout_reflog_entries
          WHERE checkout_id = ? ORDER BY ordinal DESC LIMIT 1`,
        ws.repo.checkout.checkoutId,
      ),
    ).toEqual({
      old_raw: "ref: refs/heads/main",
      new_raw: "ref: refs/heads/primary",
      reason: "branch: rename",
    });
  });

  it("branch rename accepts the former first byte excess", () => {
    const oldOid = ws.repo.store.getRef("refs/heads/main");
    if (oldOid === null) throw new Error("main is missing");
    const longName = "x".repeat(1_014);
    const longRef = `refs/heads/${longName}`;

    branchRename(ws.context, ws.repo, { newName: longName });

    expect(ws.repo.store.getRef("refs/heads/main")).toBeNull();
    expect(ws.repo.store.getRef(longRef)).toBe(oldOid);
    expect(ws.repo.checkout.head()).toBe(`ref: ${longRef}`);
    expect(currentBranch(ws.repo)).toBe(longName);
  });

  it("branch rename moves an inactive branch without moving the selected HEAD", () => {
    ws.repo.store.configSet("branch.side.remote", "origin");
    fixture.git("config", "branch.side.remote", "origin");

    branchRename(ws.context, ws.repo, { oldName: "side", newName: "topic" });
    fixture.git("branch", "-m", "side", "topic");

    expect(currentBranch(ws.repo)).toBe("main");
    expect(currentBranch(ws.repo)).toBe(fixture.git("branch", "--show-current"));
    expect(branchList(ws.repo)).toEqual(lines(fixture.git("branch", "--format=%(refname:short)")));
    expect(ws.repo.store.configGet("branch.topic.remote")).toBe(
      fixture.git("config", "--get", "branch.topic.remote"),
    );
    expect(ws.repo.store.configPaths("branch.side.")).toEqual([]);
  });

  it("branch rename matches Git while preserving a dotted sibling section", () => {
    branch(ws.context, ws.repo, { name: "foo" });
    branch(ws.context, ws.repo, { name: "foo.bar" });
    fixture.git("branch", "foo");
    fixture.git("branch", "foo.bar");
    ws.repo.checkout.setHead("ref: refs/heads/foo");
    fixture.git("checkout", "-q", "foo");
    ws.repo.store.configSet("branch.foo.remote", "origin");
    ws.repo.store.configSet("branch.foo.bar.remote", "sibling");
    fixture.git("config", "branch.foo.remote", "origin");
    fixture.git("config", "branch.foo.bar.remote", "sibling");

    branchRename(ws.context, ws.repo, { newName: "renamed" });
    fixture.git("branch", "-m", "renamed");

    expect(branchList(ws.repo)).toEqual(lines(fixture.git("branch", "--format=%(refname:short)")));
    expect(ws.repo.store.configGet("branch.renamed.remote")).toBe(
      fixture.git("config", "--get", "branch.renamed.remote"),
    );
    expect(ws.repo.store.configGet("branch.foo.bar.remote")).toBe(
      fixture.git("config", "--get", "branch.foo.bar.remote"),
    );
    expect(ws.repo.store.configGet("branch.foo.remote")).toBeUndefined();
    expect(runGit("config", "--get", "branch.foo.remote").ok).toBe(false);
  });

  it("branch rename rejects exact config conflicts in both dotted directions", () => {
    branch(ws.context, ws.repo, { name: "foo" });
    ws.repo.store.configSet("branch.foo.remote", "source");
    ws.repo.store.configSet("branch.foo.bar.remote", "destination");
    expect(() =>
      branchRename(ws.context, ws.repo, { oldName: "foo", newName: "foo.bar" }),
    ).toThrowError(expect.objectContaining({ code: "EEXIST" }));
    expect(ws.repo.store.getRef("refs/heads/foo")).not.toBeNull();
    expect(ws.repo.store.getRef("refs/heads/foo.bar")).toBeNull();

    ws.repo.store.configUnset("branch.foo.remote");
    ws.repo.store.configUnset("branch.foo.bar.remote");
    ws.repo.store.deleteRef("refs/heads/foo");
    branch(ws.context, ws.repo, { name: "foo.bar" });
    ws.repo.store.configSet("branch.foo.bar.remote", "source");
    ws.repo.store.configSet("branch.foo.remote", "destination");
    expect(() =>
      branchRename(ws.context, ws.repo, { oldName: "foo.bar", newName: "foo" }),
    ).toThrowError(expect.objectContaining({ code: "EEXIST" }));
    expect(ws.repo.store.getRef("refs/heads/foo.bar")).not.toBeNull();
    expect(ws.repo.store.getRef("refs/heads/foo")).toBeNull();
  });

  it("branch rename rejects collisions, missing refs, detached HEAD, and invalid names", () => {
    const before = branchList(ws.repo);
    expect(() =>
      branchRename(ws.context, ws.repo, { oldName: "side", newName: "main" }),
    ).toThrowError(expect.objectContaining({ code: "EBRANCHFAIL" }));
    expect(() =>
      branchRename(ws.context, ws.repo, { oldName: "missing", newName: "topic" }),
    ).toThrowError(expect.objectContaining({ code: "EBRANCHFAIL" }));
    expect(() =>
      branchRename(ws.context, ws.repo, { oldName: "side", newName: "bad..name" }),
    ).toThrowError(expect.objectContaining({ code: "EINVAL" }));

    const main = ws.repo.store.getRef("refs/heads/main");
    if (main === null) throw new Error("main is missing");
    ws.repo.checkout.setHead(main);
    fixture.git("checkout", "-q", "--detach", main);
    expect(() => branchRename(ws.context, ws.repo, { newName: "primary" })).toThrowError(
      expect.objectContaining({ code: "EBRANCHFAIL" }),
    );
    expect(branchList(ws.repo)).toEqual(before);
    expect(branchList(ws.repo)).toEqual(
      lines(fixture.git("for-each-ref", "--format=%(refname:short)", "refs/heads/")),
    );
  });

  it("branch rename validates runtime names before reads or transaction work", () => {
    const calls: readonly (readonly unknown[])[] = [
      [ws.context, ws.repo, {}],
      [ws.context, ws.repo, { newName: 42 }],
      [ws.context, ws.repo, { oldName: 42, newName: "topic" }],
      [ws.context, ws.repo, { oldName: "bad..old", newName: "topic" }],
      [ws.context, ws.repo, { oldName: "side", newName: "bad..topic" }],
    ];
    for (const args of calls) {
      ws.storage.resetCounters();
      expect(() => Reflect.apply(branchRename, undefined, args)).toThrowError(
        expect.objectContaining({ code: "EINVAL" }),
      );
      expect(ws.storage.statementCount).toBe(0);
    }
  });

  it("branch rename rejects an inactive branch attached to another checkout", () => {
    ws.database.createCheckout(ws.repo.store.repoId, "/linked", "ref: refs/heads/side");
    ws.repo.store.configSet("branch.side.remote", "origin");

    expect(() =>
      branchRename(ws.context, ws.repo, { oldName: "side", newName: "topic" }),
    ).toThrowError(expect.objectContaining({ code: "EBRANCHFAIL" }));
    expect(ws.repo.store.getRef("refs/heads/side")).not.toBeNull();
    expect(ws.repo.store.getRef("refs/heads/topic")).toBeNull();
    expect(ws.repo.store.configGet("branch.side.remote")).toBe("origin");
  });

  it("branch rename rejects destination config and a live operation without partial state", () => {
    ws.repo.store.configSet("branch.side.remote", "origin");
    ws.repo.store.configSet("branch.topic.merge", "refs/heads/topic");
    expect(() =>
      branchRename(ws.context, ws.repo, { oldName: "side", newName: "topic" }),
    ).toThrowError(expect.objectContaining({ code: "EEXIST" }));
    expect(ws.repo.store.getRef("refs/heads/side")).not.toBeNull();
    expect(ws.repo.store.getRef("refs/heads/topic")).toBeNull();
    expect(ws.repo.store.configGet("branch.side.remote")).toBe("origin");

    ws.repo.store.configUnset("branch.topic.merge");
    const main = ws.repo.store.getRef("refs/heads/main");
    const side = ws.repo.store.getRef("refs/heads/side");
    if (main === null || side === null) throw new Error("branch fixture is incomplete");
    const state: MergeStateMetadata = {
      originalHeadRef: "refs/heads/main",
      originalHeadOid: main,
      currentParentOid: main,
      incomingParentOid: side,
      phase: "ready",
      mode: "no-commit",
      mergeOrigin: "merge",
      currentLabel: "HEAD",
      incomingLabel: "side",
      message: "pending merge\n",
      author: null,
      committer: null,
    };
    ws.repo.checkout.writeMergeState(state, []);
    expect(() =>
      branchRename(ws.context, ws.repo, { oldName: "side", newName: "topic" }),
    ).toThrowError(expect.objectContaining({ code: "EMERGEACTIVE" }));
    expect(ws.repo.store.getRef("refs/heads/side")).toBe(side);
    expect(ws.repo.store.getRef("refs/heads/topic")).toBeNull();
    expect(ws.repo.store.configGet("branch.side.remote")).toBe("origin");
  });

  it("branch rename rolls ref, HEAD, and config back when publication fails", () => {
    const main = ws.repo.store.getRef("refs/heads/main");
    if (main === null) throw new Error("main is missing");
    ws.repo.store.configSet("branch.main.remote", "origin");
    ws.repo.store.db.run("PRAGMA ignore_check_constraints = ON");
    try {
      ws.repo.store.db.run(
        "INSERT INTO git_refs (repo_id, name, target) VALUES (?, 'refs/tags/corrupt', zeroblob(40))",
        ws.repo.store.repoId,
      );
    } finally {
      ws.repo.store.db.run("PRAGMA ignore_check_constraints = OFF");
    }

    expect(() => branchRename(ws.context, ws.repo, { newName: "primary" })).toThrowError(
      expect.objectContaining({ code: "ECORRUPT" }),
    );
    expect(ws.repo.checkout.head()).toBe("ref: refs/heads/main");
    expect(ws.repo.store.getRef("refs/heads/main")).toBe(main);
    expect(ws.repo.store.getRef("refs/heads/primary")).toBeNull();
    expect(ws.repo.store.configGet("branch.main.remote")).toBe("origin");
    expect(ws.repo.store.configGet("branch.primary.remote")).toBeUndefined();
  });

  it("branch rename authenticates source commits before moving config or refs", () => {
    const blob = ws.repo.store.write("blob", utf8.encode("not a commit\n"));
    ws.repo.store.setRef("refs/heads/blob-source", blob);
    ws.repo.store.configSet("branch.blob-source.remote", "origin");
    expect(() =>
      branchRename(ws.context, ws.repo, { oldName: "blob-source", newName: "blob-target" }),
    ).toThrowError(expect.objectContaining({ code: "ECORRUPT" }));
    expect(ws.repo.store.getRef("refs/heads/blob-source")).toBe(blob);
    expect(ws.repo.store.getRef("refs/heads/blob-target")).toBeNull();
    expect(ws.repo.store.configGet("branch.blob-source.remote")).toBe("origin");
    expect(ws.repo.store.configGet("branch.blob-target.remote")).toBeUndefined();

    const main = ws.repo.store.getRef("refs/heads/main");
    if (main === null) throw new Error("main is missing");
    const corrupt = ws.repo.store.write(
      "commit",
      serializeCommit({
        tree: ws.repo.readCommit(main).tree,
        parent: [main],
        author: {
          name: "Fixture",
          email: "fixture@example.com",
          timestamp: 1_577_836_800,
          timezoneOffset: 0,
        },
        committer: {
          name: "Fixture",
          email: "fixture@example.com",
          timestamp: 1_577_836_800,
          timezoneOffset: 0,
        },
        message: "cached then corrupted\n",
      }),
    );
    expect(ws.repo.store.cachedCommit(corrupt)).not.toBeNull();
    ws.repo.store.setRef("refs/heads/corrupt-source", corrupt);
    ws.repo.store.configSet("branch.corrupt-source.remote", "origin");
    ws.repo.store.db.run(
      "UPDATE git_objects SET stored = 'raw' WHERE repo_id = ? AND oid = ?",
      ws.repo.store.repoId,
      corrupt,
    );
    ws.repo.store.db.run(
      `UPDATE git_object_chunks SET data = zeroblob((
         SELECT size FROM git_objects WHERE repo_id = ? AND oid = ?
       )) WHERE repo_id = ? AND oid = ? AND seq = 0`,
      ws.repo.store.repoId,
      corrupt,
      ws.repo.store.repoId,
      corrupt,
    );
    ws.repo.store.db.run(
      "DELETE FROM git_object_chunks WHERE repo_id = ? AND oid = ? AND seq > 0",
      ws.repo.store.repoId,
      corrupt,
    );

    expect(() =>
      branchRename(ws.context, ws.repo, {
        oldName: "corrupt-source",
        newName: "corrupt-target",
      }),
    ).toThrowError(expect.objectContaining({ code: "ECORRUPT" }));
    expect(ws.repo.store.getRef("refs/heads/corrupt-source")).toBe(corrupt);
    expect(ws.repo.store.getRef("refs/heads/corrupt-target")).toBeNull();
    expect(ws.repo.store.configGet("branch.corrupt-source.remote")).toBe("origin");
    expect(ws.repo.store.configGet("branch.corrupt-target.remote")).toBeUndefined();
  });
});

describe("currentBranch", () => {
  it("reports the short name by default and the full ref with fullname", () => {
    expect(currentBranch(ws.repo)).toBe(fixture.git("branch", "--show-current"));
    expect(currentBranch(ws.repo, { fullname: true })).toBe(fixture.git("symbolic-ref", "HEAD"));
    expect(symbolicRef(ws.repo)).toBe("refs/heads/main");
  });

  it("is undefined on a detached HEAD", () => {
    checkout(ws.context, ws.repo, ws.worktree, { ref: "main" });
    checkout(ws.context, ws.repo, ws.worktree, { ref: "v1" });
    fixture.git("checkout", "-q", "v1");

    expect(currentBranch(ws.repo)).toBeUndefined();
    expect(symbolicRef(ws.repo)).toBeUndefined();
    expect(runGit("symbolic-ref", "HEAD").ok).toBe(false);
  });
});

describe("tag", () => {
  it("creates, lists and deletes lightweight tags", () => {
    tag(ws.context, ws.repo, { name: "v2" });
    tag(ws.context, ws.repo, { name: "old", object: "side" });
    fixture.git("tag", "v2");
    fixture.git("tag", "old", "side");

    expect(tagList(ws.repo)).toEqual(lines(fixture.git("tag", "-l")));
    expect(ws.repo.resolveRef("refs/tags/v2")).toBe(fixture.git("rev-parse", "v2"));
    expect(ws.repo.resolveRef("refs/tags/old")).toBe(fixture.git("rev-parse", "old"));
    expect(ws.repo.typeOf(ws.repo.resolveRef("refs/tags/v2") ?? "")).toBe("commit");

    tagDelete(ws.context, ws.repo, { name: "v2" });
    fixture.git("tag", "-d", "v2");
    expect(tagList(ws.repo)).toEqual(lines(fixture.git("tag", "-l")));
    expect(() => tagDelete(ws.context, ws.repo, { name: "v2" })).toThrow(/not found/);
    expect(runGit("tag", "-d", "v2").ok).toBe(false);
  });

  it("overwrites an existing tag only with force", () => {
    expect(() => tag(ws.context, ws.repo, { name: "v1", object: "side" })).toThrow(
      /already exists/,
    );
    expect(runGit("tag", "v1", "side").ok).toBe(false);

    tag(ws.context, ws.repo, { name: "v1", object: "side", force: true });
    fixture.git("tag", "-f", "v1", "side");
    expect(ws.repo.resolveRef("refs/tags/v1")).toBe(fixture.git("rev-parse", "v1"));
  });
});

describe("checkout", () => {
  it("materialises a branch and then reconciles the tree across a switch", () => {
    checkout(ws.context, ws.repo, ws.worktree, { ref: "main" });
    expectSameTree();
    expect(indexPaths()).toEqual(lines(fixture.git("ls-files")));

    checkout(ws.context, ws.repo, ws.worktree, { ref: "side" });
    fixture.git("checkout", "-q", "side");

    expectSameTree();
    expect(indexPaths()).toEqual(lines(fixture.git("ls-files")));
    expect(ws.repo.head().ref).toBe("refs/heads/side");
    expect(currentBranch(ws.repo)).toBe(fixture.git("branch", "--show-current"));
    // The added file arrived, the deleted one went, and the directory that
    // held it was pruned.
    expect(ourTree().get("extra/side.txt")).toBe("extra\n");
    expect(ws.worktree.stat("/deleted.txt")).toBeNull();
    expect(ws.worktree.stat("/only")).toBeNull();
  });

  it("materialises a blob larger than the checkout batch budget", async () => {
    const largeFixture = new GitFixture().init("main");
    const workspace = makeRepo("/");
    const bytes = new Uint8Array(3 * 1024 * 1024 + 1).fill(0x61);
    try {
      largeFixture.write("large.bin", bytes);
      largeFixture.commit("large");
      await importFixture(largeFixture, workspace.repo.checkout);

      checkout(workspace.context, workspace.repo, workspace.worktree, { ref: "main" });

      const written = workspace.worktree.readFile("/large.bin");
      expect(written.length).toBe(bytes.length);
      expect(written[0]).toBe(0x61);
      expect(written[written.length - 1]).toBe(0x61);
    } finally {
      largeFixture.dispose();
    }
  });

  it("removes exact paths through the former 17th JSON batch", () => {
    const workspace = makeRepo("/");
    workspace.repo.store.configSet("user.name", "Fixture");
    workspace.repo.store.configSet("user.email", "fixture@example.com");
    const bytes = utf8.encode("x\n");
    const oid = workspace.repo.store.write("blob", bytes);
    const suffix = "\u0001".repeat(2_100);
    const paths = Array.from(
      { length: 1_300 },
      (_, index) => `f${index.toString().padStart(4, "0")}-${suffix}`,
    );
    const writes = paths.map((path) => ({
      path: `/${path}`,
      bytes,
      contentId: fromHex(oid),
    }));
    workspace.worktree.writeFiles(writes);
    const stats = new Map(
      workspace.worktree
        .scan("/", { filesOnly: true, limit: paths.length + 1 })
        .map((entry) => [entry.path.slice(1), entry]),
    );
    const originalIndex = paths.map((path): IndexEntry => {
      const stat = stats.get(path);
      if (stat === undefined) throw new Error("long checkout path was not written");
      return {
        path,
        stage: 0,
        mode: 0o100644,
        oid,
        size: stat.size,
        mtime: stat.mtime,
        ino: stat.ino,
      };
    });
    workspace.repo.checkout.indexReplace(originalIndex);
    const base = commit(workspace.context, workspace.repo, { message: "base" });
    workspace.worktree.removeFiles(paths.map((path) => `/${path}`));
    workspace.repo.checkout.indexClear();
    const target = commit(workspace.context, workspace.repo, { message: "delete" });
    workspace.repo.store.setRef("refs/heads/target", target.oid);
    workspace.worktree.writeFiles(writes);
    workspace.repo.checkout.indexReplace(originalIndex);
    workspace.repo.checkout.setHead(base.oid);

    class RemovalWorktree extends CountingWorktree {
      batches: string[][] = [];

      override removeFiles(removals: readonly string[], options?: RemoveOptions): void {
        this.batches.push([...removals]);
        super.removeFiles(removals, options);
      }
    }

    const worktree = new RemovalWorktree(workspace.worktree);
    checkout(workspace.context, workspace.repo, worktree, { ref: "target", force: true });

    expect(worktree.batches).toHaveLength(17);
    expect(worktree.batches.flat()).toEqual(paths.map((path) => `/${path}`));
    expect(paths.every((path) => workspace.worktree.stat(`/${path}`) === null)).toBe(true);
    expect(workspace.repo.head().oid).toBe(target.oid);
  });

  it("updates only the given paths and leaves HEAD alone", () => {
    checkout(ws.context, ws.repo, ws.worktree, { ref: "side" });
    fixture.git("checkout", "-q", "side");

    checkout(ws.context, ws.repo, ws.worktree, { ref: "main", paths: ["modified.txt"] });
    fixture.git("checkout", "main", "--", "modified.txt");

    expectSameTree();
    expect(ws.repo.head().ref).toBe("refs/heads/side");
    expect(currentBranch(ws.repo)).toBe(fixture.git("branch", "--show-current"));
    expect(indexPaths()).toEqual(lines(fixture.git("ls-files")));
    expect(ws.repo.checkout.indexGet("modified.txt")?.oid).toBe(
      fixture.git("rev-parse", "main:modified.txt"),
    );
  });

  it("refuses to overwrite local changes without force", () => {
    checkout(ws.context, ws.repo, ws.worktree, { ref: "main" });
    writeWorkFile(ws, "/modified.txt", "locally changed content\n");
    fixture.write("modified.txt", "locally changed content\n");

    expect(() => checkout(ws.context, ws.repo, ws.worktree, { ref: "side" })).toThrow(
      /modified\.txt/,
    );
    expect(runGit("checkout", "side").ok).toBe(false);
    expect(ws.repo.head().ref).toBe("refs/heads/main");

    checkout(ws.context, ws.repo, ws.worktree, { ref: "side", force: true });
    fixture.git("checkout", "-f", "-q", "side");
    expectSameTree();
    expect(ws.repo.head().ref).toBe("refs/heads/side");
  });

  it("streams a dirty checkout guard beyond the former 32 MiB hash admission", () => {
    checkout(ws.context, ws.repo, ws.worktree, { ref: "main" });
    const bytes = new Uint8Array(32 * 1024 * 1024 + 1).fill(0x6c);
    ws.worktree.writeFile("/modified.txt", bytes);
    const beforeHead = ws.repo.head();
    const beforeIndex = ws.repo.checkout.indexGet("modified.txt");
    const worktree = new CountingWorktree(ws.worktree);

    expect(() => checkout(ws.context, ws.repo, worktree, { ref: "side" })).toThrowError(
      expect.objectContaining({ code: "ECHECKOUTFAIL" }),
    );

    expect(worktree.rangeReads).toBe(513);
    expect(ws.repo.head()).toEqual(beforeHead);
    expect(ws.repo.checkout.indexGet("modified.txt")).toEqual(beforeIndex);
    expect(ws.worktree.stat("/modified.txt")?.size).toBe(bytes.byteLength);
  });

  it("preserves state after an injected checkout guard range failure", () => {
    checkout(ws.context, ws.repo, ws.worktree, { ref: "main" });
    const bytes = new Uint8Array(4 * 1024 * 1024 + 1).fill(0x72);
    ws.worktree.writeFile("/modified.txt", bytes);
    const beforeHead = ws.repo.head();
    const beforeIndex = ws.repo.checkout.indexGet("modified.txt");
    class FailingRangeWorktree extends CountingWorktree {
      override readRange(path: string, offset: number, length: number): Uint8Array {
        if (this.rangeReads === 1) {
          this.rangeReads++;
          throw new Error("injected checkout range failure");
        }
        return super.readRange(path, offset, length);
      }
    }
    const worktree = new FailingRangeWorktree(ws.worktree);

    expect(() => checkout(ws.context, ws.repo, worktree, { ref: "side" })).toThrow(
      "injected checkout range failure",
    );

    expect(worktree.rangeReads).toBe(2);
    expect(ws.repo.head()).toEqual(beforeHead);
    expect(ws.repo.checkout.indexGet("modified.txt")).toEqual(beforeIndex);
    expect(ws.worktree.stat("/modified.txt")?.size).toBe(bytes.byteLength);
  });

  it("reports modified paths from the checkout guard", () => {
    checkout(ws.context, ws.repo, ws.worktree, { ref: "main" });
    writeWorkFile(ws, "/modified.txt", "locally changed content\n");
    const side = ws.repo.resolveRef("refs/heads/side");
    if (side === null) throw new Error("side branch is missing");
    const sideTree = ws.repo.readCommit(side).tree;

    expect(
      checkoutBlockersOwned(ws.repo, ws.worktree, sideTree, undefined, true).tracked,
    ).toContain("modified.txt");
    expect(ws.repo.head().ref).toBe("refs/heads/main");
  });

  it("checks full index and worktree guard pages", () => {
    const workspace = makeRepo("/");
    workspace.repo.store.configSet("user.name", "Fixture");
    workspace.repo.store.configSet("user.email", "fixture@example.com");
    const body = utf8.encode("page\n");
    const oid = workspace.repo.store.write("blob", body);
    const paths = Array.from(
      { length: 1_000 },
      (_, index) => `page-${index.toString().padStart(4, "0")}.txt`,
    );
    workspace.worktree.writeFiles(
      paths.map((path) => ({ path: `/${path}`, bytes: body, contentId: fromHex(oid) })),
    );
    const stats = new Map(
      workspace.worktree
        .scan("/", { filesOnly: true, limit: paths.length + 1 })
        .map((entry) => [entry.path.slice(1), entry]),
    );
    workspace.repo.checkout.indexReplace(
      paths.map((path): IndexEntry => {
        const stat = stats.get(path);
        if (stat === undefined) throw new Error(`full-page path was not written: ${path}`);
        return {
          path,
          stage: 0,
          mode: 0o100644,
          oid,
          size: stat.size,
          mtime: stat.mtime,
          ino: stat.ino,
        };
      }),
    );
    const current = commit(workspace.context, workspace.repo, { message: "full page" });
    const tree = workspace.repo.readCommit(current.oid).tree;

    expect(
      checkoutBlockersOwned(workspace.repo, workspace.worktree, tree, undefined, true),
    ).toEqual({ tracked: [], untracked: [] });
    expect(workspace.repo.head().oid).toBe(current.oid);
    expect(workspace.repo.checkout.indexEntries()).toHaveLength(paths.length);
  });

  it("preserves local changes when the target keeps the index entry", () => {
    checkout(ws.context, ws.repo, ws.worktree, { ref: "main" });
    writeWorkFile(ws, "/common.txt", "local common\n");
    fixture.write("common.txt", "local common\n");

    class RecordingWorktree extends CountingWorktree {
      writes: string[] = [];

      override writeFiles(entries: readonly WriteEntry[], options?: WriteOptions): void {
        this.writes.push(...entries.map((entry) => entry.path));
        super.writeFiles(entries, options);
      }
    }

    const worktree = new RecordingWorktree(ws.worktree);
    checkout(ws.context, ws.repo, worktree, { ref: "side" });
    fixture.git("checkout", "-q", "side");

    expect(worktree.writes).not.toContain("/common.txt");
    expect(utf8Decoder.decode(ws.worktree.readFile("/common.txt"))).toBe("local common\n");
    expectSameTree();

    ws.worktree.unlink("/common.txt");
    fixture.remove("common.txt");
    worktree.writes.length = 0;
    checkout(ws.context, ws.repo, worktree, { ref: "main" });
    fixture.git("checkout", "-q", "main");

    expect(worktree.writes).not.toContain("/common.txt");
    expect(ws.worktree.stat("/common.txt")).toBeNull();
    expectSameTree();
  });

  it("preserves same-target structural changes, while path checkout and force restore them", async () => {
    for (const targetShape of ["file", "directory"]) {
      for (const restoreMode of ["path", "force"]) {
        const transition = new GitFixture().init("main");
        const workspace = makeRepo("/");
        try {
          if (targetShape === "file") transition.write("node", "tracked\n");
          else transition.write("node/child.txt", "tracked\n");
          transition.write("branch.txt", "main\n");
          transition.commit(targetShape);
          transition.git("checkout", "-q", "-b", "side");
          transition.write("branch.txt", "side\n");
          transition.commit("side");
          transition.git("checkout", "-q", "main");
          await importFixture(transition, workspace.repo.checkout);
          checkout(workspace.context, workspace.repo, workspace.worktree, { ref: "main" });

          transition.remove("node");
          if (targetShape === "file") {
            workspace.worktree.unlink("/node");
            writeWorkFile(workspace, "/node/local.txt", "local\n");
            transition.write("node/local.txt", "local\n");
          } else {
            workspace.worktree.unlink("/node/child.txt");
            workspace.worktree.rmdir("/node");
            if (restoreMode === "force") {
              workspace.worktree.symlink("local-target", "/node");
              transition.symlink("local-target", "node");
            } else {
              writeWorkFile(workspace, "/node", "local\n");
              transition.write("node", "local\n");
            }
            writeWorkFile(workspace, "/node.extra", "prefix sibling\n");
            transition.write("node.extra", "prefix sibling\n");
          }

          const worktree = new CountingWorktree(workspace.worktree);
          checkout(workspace.context, workspace.repo, worktree, { ref: "side" });
          transition.git("checkout", "-q", "side");

          expect(worktree.reads).toBe(0);
          expect(worktree.rangeReads).toBe(0);
          expect(worktree.bulkReadPaths).toEqual([]);
          expect(workspace.worktree.stat("/node")?.type).toBe(
            targetShape === "file" ? "dir" : restoreMode === "force" ? "symlink" : "file",
          );

          if (restoreMode === "path") {
            checkout(workspace.context, workspace.repo, worktree, {
              ref: "side",
              paths: ["node"],
            });
            transition.git("checkout", "side", "--", "node");
          } else {
            checkout(workspace.context, workspace.repo, worktree, { ref: "side", force: true });
            transition.git("checkout", "-f", "-q", "side");
          }

          expect(worktree.reads).toBe(0);
          expect(worktree.rangeReads).toBe(0);
          expect(worktree.bulkReadPaths).toEqual([]);
          if (targetShape === "file") {
            expect(workspace.worktree.stat("/node")?.type).toBe("file");
            expect(utf8Decoder.decode(workspace.worktree.readFile("/node"))).toBe("tracked\n");
          } else {
            expect(workspace.worktree.stat("/node")?.type).toBe("dir");
            expect(utf8Decoder.decode(workspace.worktree.readFile("/node/child.txt"))).toBe(
              "tracked\n",
            );
            expect(utf8Decoder.decode(workspace.worktree.readFile("/node.extra"))).toBe(
              "prefix sibling\n",
            );
          }
          expect(sorted(workspaceTree(workspace))).toEqual(sorted(diskTree(transition.dir)));
        } finally {
          transition.dispose();
        }
      }
    }
  });

  it("carries on when a file the checkout rewrites was deleted locally", () => {
    checkout(ws.context, ws.repo, ws.worktree, { ref: "main" });
    ws.worktree.unlink("/modified.txt");
    fixture.remove("modified.txt");

    checkout(ws.context, ws.repo, ws.worktree, { ref: "side" });
    expect(runGit("checkout", "side").ok).toBe(true);
    expectSameTree();
    expect(ourTree().get("modified.txt")).toBe("side\n");
  });

  it("detaches HEAD on a tag or a raw oid", () => {
    checkout(ws.context, ws.repo, ws.worktree, { ref: "main" });

    checkout(ws.context, ws.repo, ws.worktree, { ref: "v1" });
    fixture.git("checkout", "-q", "v1");
    expect(ws.repo.head()).toEqual({ ref: null, oid: fixture.git("rev-parse", "main") });
    expect(runGit("symbolic-ref", "HEAD").ok).toBe(false);

    const sideOid = fixture.git("rev-parse", "side");
    checkout(ws.context, ws.repo, ws.worktree, { ref: sideOid });
    fixture.git("checkout", "-q", sideOid);
    expect(ws.repo.head()).toEqual({ ref: null, oid: sideOid });
    expect(currentBranch(ws.repo)).toBeUndefined();
    expectSameTree();
  });

  it("switches between a file and a directory at the same path", async () => {
    const transition = new GitFixture().init("main");
    const workspace = makeRepo("/");
    try {
      transition.write("node/child.txt", "nested\n");
      transition.commit("directory");
      transition.git("checkout", "-q", "-b", "flat");
      transition.git("rm", "-q", "-r", "node");
      transition.write("node", "flat\n");
      transition.commit("file");
      transition.git("checkout", "-q", "main");
      await importFixture(transition, workspace.repo.checkout);

      checkout(workspace.context, workspace.repo, workspace.worktree, { ref: "main" });
      checkout(workspace.context, workspace.repo, workspace.worktree, { ref: "flat" });
      expect(workspace.worktree.stat("/node")?.type).toBe("file");
      expect(utf8Decoder.decode(workspace.worktree.readFile("/node"))).toBe("flat\n");

      checkout(workspace.context, workspace.repo, workspace.worktree, { ref: "main" });
      expect(workspace.worktree.stat("/node")?.type).toBe("dir");
      expect(utf8Decoder.decode(workspace.worktree.readFile("/node/child.txt"))).toBe("nested\n");

      writeWorkFile(workspace, "/node/untracked.txt", "mine\n");
      transition.write("node/untracked.txt", "mine\n");
      expect(() =>
        checkout(workspace.context, workspace.repo, workspace.worktree, { ref: "flat" }),
      ).toThrow(/untracked working tree files/);
      expect(() => transition.git("checkout", "flat")).toThrow();
    } finally {
      transition.dispose();
    }
  });

  it("refuses an untracked file or symlink above a target path", async () => {
    for (const kind of ["file", "symlink"]) {
      const transition = new GitFixture().init("main");
      const workspace = makeRepo("/");
      try {
        transition.write("anchor.txt", "anchor\n");
        transition.commit("base");
        transition.git("checkout", "-q", "-b", "nested");
        transition.write("node/child.txt", "nested\n");
        transition.commit("nested");
        transition.git("checkout", "-q", "main");
        await importFixture(transition, workspace.repo.checkout);
        checkout(workspace.context, workspace.repo, workspace.worktree, { ref: "main" });

        if (kind === "file") {
          writeWorkFile(workspace, "/node", "mine\n");
          transition.write("node", "mine\n");
        } else {
          workspace.worktree.symlink("mine", "/node");
          transition.symlink("mine", "node");
        }

        expect(() =>
          checkout(workspace.context, workspace.repo, workspace.worktree, { ref: "nested" }),
        ).toThrow(/untracked working tree files/);
        expect(() => transition.git("checkout", "nested")).toThrow();
        expect(workspace.repo.head().ref).toBe("refs/heads/main");
      } finally {
        transition.dispose();
      }
    }
  });

  it("refuses an untracked file above a changed tracked target", async () => {
    const transition = new GitFixture().init("main");
    const workspace = makeRepo("/");
    try {
      transition.write("node/child.txt", "base\n");
      transition.commit("base");
      transition.git("checkout", "-q", "-b", "changed");
      transition.write("node/child.txt", "changed\n");
      transition.commit("changed");
      transition.git("checkout", "-q", "main");
      await importFixture(transition, workspace.repo.checkout);
      checkout(workspace.context, workspace.repo, workspace.worktree, { ref: "main" });

      workspace.worktree.unlink("/node/child.txt");
      workspace.worktree.rmdir("/node");
      writeWorkFile(workspace, "/node", "mine\n");
      transition.remove("node");
      transition.write("node", "mine\n");

      expect(() =>
        checkout(workspace.context, workspace.repo, workspace.worktree, { ref: "changed" }),
      ).toThrow(/local changes.*node\/child\.txt/);
      expect(() => transition.git("checkout", "changed")).toThrow();
      expect(workspace.repo.head().ref).toBe("refs/heads/main");
    } finally {
      transition.dispose();
    }
  });

  it("refuses dirty tracked paths on either side of a file-directory replacement", async () => {
    const cases = [
      { start: "file", target: "directory" },
      { start: "directory", target: "file" },
    ];
    for (const entry of cases) {
      const transition = new GitFixture().init("main");
      const workspace = makeRepo("/");
      try {
        if (entry.start === "file") transition.write("node", "flat\n");
        else transition.write("node/child.txt", "nested\n");
        transition.commit(entry.start);
        transition.git("checkout", "-q", "-b", "target");
        transition.remove("node");
        if (entry.target === "file") transition.write("node", "flat\n");
        else transition.write("node/child.txt", "nested\n");
        transition.commit(entry.target);
        transition.git("checkout", "-q", "main");
        await importFixture(transition, workspace.repo.checkout);
        checkout(workspace.context, workspace.repo, workspace.worktree, { ref: "main" });

        const dirtyPath = entry.start === "file" ? "/node" : "/node/child.txt";
        writeWorkFile(workspace, dirtyPath, "local\n");
        transition.write(dirtyPath.slice(1), "local\n");

        expect(() =>
          checkout(workspace.context, workspace.repo, workspace.worktree, { ref: "target" }),
        ).toThrow(/local changes/);
        expect(() => transition.git("checkout", "target")).toThrow();
        expect(workspace.repo.head().ref).toBe("refs/heads/main");
      } finally {
        transition.dispose();
      }
    }
  });

  it("refuses a tracked file locally replaced by a directory before target replacement", async () => {
    for (const target of ["directory", "deleted"]) {
      const transition = new GitFixture().init("main");
      const workspace = makeRepo("/");
      try {
        transition.write("node", "tracked\n");
        transition.write("anchor.txt", "anchor\n");
        transition.commit("file");
        transition.git("checkout", "-q", "-b", "target");
        transition.remove("node");
        if (target === "directory") transition.write("node/target.txt", "target\n");
        transition.commit(target);
        transition.git("checkout", "-q", "main");
        await importFixture(transition, workspace.repo.checkout);
        checkout(workspace.context, workspace.repo, workspace.worktree, { ref: "main" });

        workspace.worktree.unlink("/node");
        writeWorkFile(workspace, "/node/local.txt", "local\n");
        transition.remove("node");
        transition.write("node/local.txt", "local\n");

        expect(() =>
          checkout(workspace.context, workspace.repo, workspace.worktree, { ref: "target" }),
        ).toThrow(/untracked working tree files.*node/);
        expect(() => transition.git("checkout", "target")).toThrow();
        expect(workspace.repo.head().ref).toBe("refs/heads/main");
      } finally {
        transition.dispose();
      }
    }
  });

  it("force preserves an untracked structural replacement when the target deletes it", async () => {
    for (const startShape of ["file", "directory"]) {
      const transition = new GitFixture().init("main");
      const workspace = makeRepo("/");
      try {
        if (startShape === "file") transition.write("node", "tracked\n");
        else transition.write("node/child.txt", "tracked\n");
        transition.write("anchor.txt", "anchor\n");
        transition.commit(startShape);
        transition.git("checkout", "-q", "-b", "target");
        transition.remove("node");
        transition.commit("delete node");
        transition.git("checkout", "-q", "main");
        await importFixture(transition, workspace.repo.checkout);
        checkout(workspace.context, workspace.repo, workspace.worktree, { ref: "main" });

        transition.remove("node");
        if (startShape === "file") {
          workspace.worktree.unlink("/node");
          writeWorkFile(workspace, "/node/local.txt", "local\n");
          transition.write("node/local.txt", "local\n");
        } else {
          workspace.worktree.unlink("/node/child.txt");
          workspace.worktree.rmdir("/node");
          writeWorkFile(workspace, "/node", "local\n");
          transition.write("node", "local\n");
        }

        class RemovalWorktree extends CountingWorktree {
          removals: Array<{ paths: string[]; recursive: boolean }> = [];

          override removeFiles(paths: readonly string[], options?: RemoveOptions): void {
            this.removals.push({ paths: [...paths], recursive: options?.recursive === true });
            super.removeFiles(paths, options);
          }
        }

        const worktree = new RemovalWorktree(workspace.worktree);
        checkout(workspace.context, workspace.repo, worktree, { ref: "target", force: true });
        transition.git("checkout", "-f", "-q", "target");

        expect(worktree.removals).toEqual([]);
        expect(workspace.repo.head().ref).toBe("refs/heads/target");
        expect(workspace.repo.checkout.indexEntries().map((entry) => entry.path)).toEqual([
          "anchor.txt",
        ]);
        expect(sorted(workspaceTree(workspace))).toEqual(sorted(diskTree(transition.dir)));
        if (startShape === "file") {
          expect(workspace.worktree.stat("/node")?.type).toBe("dir");
          expect(utf8Decoder.decode(workspace.worktree.readFile("/node/local.txt"))).toBe(
            "local\n",
          );
        } else {
          expect(workspace.worktree.stat("/node")?.type).toBe("file");
          expect(utf8Decoder.decode(workspace.worktree.readFile("/node"))).toBe("local\n");
        }
      } finally {
        transition.dispose();
      }
    }
  });

  it("materialises exactly 1,000 changes in bounded bulk operations", () => {
    const workspace = makeRepo("/");
    workspace.repo.store.configSet("user.name", "Fixture");
    workspace.repo.store.configSet("user.email", "fixture@example.com");
    const original = utf8.encode("original\n");
    const changed = utf8.encode("changed\n");
    const originalOid = workspace.repo.store.write("blob", original);
    const changedOid = workspace.repo.store.write("blob", changed);
    const paths = Array.from({ length: 9_329 }, (_, index) => {
      const directory = index % 3_346;
      const generation = Math.floor(index / 3_346);
      return `d${directory.toString().padStart(4, "0")}/f${generation
        .toString()
        .padStart(4, "0")}.txt`;
    });
    workspace.worktree.writeFiles(
      paths.map((path) => ({ path: `/${path}`, bytes: original, contentId: fromHex(originalOid) })),
    );
    const stats = new Map(
      workspace.worktree
        .scan("/", { filesOnly: true, limit: paths.length + 1 })
        .map((entry) => [entry.path.slice(1), entry]),
    );
    const originalIndex = paths.map((path): IndexEntry => {
      const stat = stats.get(path);
      if (stat === undefined) throw new Error(`scale path was not written: ${path}`);
      return {
        path,
        stage: 0,
        mode: 0o100644,
        oid: originalOid,
        size: stat.size,
        mtime: stat.mtime,
        ino: stat.ino,
      };
    });
    workspace.repo.checkout.indexReplace(originalIndex);
    const base = commit(workspace.context, workspace.repo, { message: "base" });
    workspace.repo.checkout.indexReplace(
      originalIndex.map((entry, index) =>
        index < 1_000 ? { ...entry, oid: changedOid, size: changed.length } : entry,
      ),
    );
    const changedCommit = commit(workspace.context, workspace.repo, { message: "changed" });
    workspace.repo.store.setRef("refs/heads/changed", changedCommit.oid);
    workspace.repo.checkout.setHead(base.oid);
    workspace.repo.checkout.indexReplace(originalIndex);

    class BulkCheckoutWorktree extends CountingWorktree {
      writes: string[] = [];

      override stat(path: string): never {
        throw new Error(`scalar stat is forbidden during checkout: ${path}`);
      }

      override readFile(path: string): never {
        throw new Error(`scalar readFile is forbidden during checkout: ${path}`);
      }

      override readlink(path: string): never {
        throw new Error(`scalar readlink is forbidden during checkout: ${path}`);
      }

      override writeFiles(entries: readonly WriteEntry[], options?: WriteOptions): void {
        this.writes.push(...entries.map((entry) => entry.path));
        super.writeFiles(entries, options);
      }
    }

    const worktree = new BulkCheckoutWorktree(workspace.worktree);
    workspace.storage.resetCounters();
    checkout(workspace.context, workspace.repo, worktree, { ref: "changed" });

    expect(workspace.storage.statementCount).toBeLessThan(1_000);
    expect(worktree.writes).toHaveLength(1_000);
    expect(new Set(worktree.writes)).toEqual(
      new Set(paths.slice(0, 1_000).map((path) => `/${path}`)),
    );
    expect(
      workspace.repo.checkout.indexEntries().filter((entry) => entry.oid === changedOid),
    ).toHaveLength(1_000);
  });

  it("rewrites only 100 changes from a 24,252-file clone index", () => {
    const workspace = makeRepo("/");
    workspace.repo.store.configSet("user.name", "Fixture");
    workspace.repo.store.configSet("user.email", "fixture@example.com");
    const original = utf8.encode("original\n");
    const changed = utf8.encode("changed\n");
    const originalOid = workspace.repo.store.write("blob", original);
    const changedOid = workspace.repo.store.write("blob", changed);
    const changedFiles = 100;
    const paths = Array.from({ length: 24_252 }, (_, index) => {
      const directory = index % 8_084;
      const generation = Math.floor(index / 8_084);
      return `d${directory.toString().padStart(4, "0")}/f${generation
        .toString()
        .padStart(4, "0")}.txt`;
    });
    workspace.worktree.writeFiles(
      paths.map((path) => ({ path: `/${path}`, bytes: original, contentId: fromHex(originalOid) })),
    );
    workspace.repo.store.upsertBlobIds([{ contentId: fromHex(originalOid), oid: originalOid }]);
    const stats = new Map(
      workspace.worktree
        .scan("/", { filesOnly: true, limit: paths.length + 1 })
        .map((entry) => [entry.path.slice(1), entry]),
    );
    const originalIndex = paths.map((path): IndexEntry => {
      const stat = stats.get(path);
      if (stat === undefined) throw new Error(`scale path was not written: ${path}`);
      return {
        path,
        stage: 0,
        mode: 0o100644,
        oid: originalOid,
        size: stat.size,
        mtime: stat.mtime,
        ino: stat.ino,
      };
    });
    workspace.repo.checkout.indexReplace(originalIndex);
    const base = commit(workspace.context, workspace.repo, { message: "base" });
    workspace.repo.checkout.indexReplace(
      originalIndex.map((entry, index) =>
        index < changedFiles ? { ...entry, oid: changedOid, size: changed.length } : entry,
      ),
    );
    const changedCommit = commit(workspace.context, workspace.repo, { message: "changed" });
    workspace.repo.store.setRef("refs/heads/changed", changedCommit.oid);
    workspace.repo.checkout.setHead(base.oid);
    workspace.repo.checkout.indexReplace(
      originalIndex.map((entry) => ({ ...entry, mtime: null, ino: null, rev: null })),
    );

    class CloneCheckoutWorktree extends CountingWorktree {
      writes: string[] = [];

      override stat(path: string): never {
        throw new Error(`scalar stat is forbidden during checkout: ${path}`);
      }

      override readFile(path: string): never {
        throw new Error(`scalar readFile is forbidden during checkout: ${path}`);
      }

      override readlink(path: string): never {
        throw new Error(`scalar readlink is forbidden during checkout: ${path}`);
      }

      override writeFiles(entries: readonly WriteEntry[], options?: WriteOptions): void {
        this.writes.push(...entries.map((entry) => entry.path));
        super.writeFiles(entries, options);
      }
    }

    const worktree = new CloneCheckoutWorktree(workspace.worktree);
    workspace.storage.resetCounters();
    checkout(workspace.context, workspace.repo, worktree, { ref: "changed" });

    expect(workspace.storage.statementCount).toBeLessThan(1_000);
    expect(worktree.writes).toHaveLength(changedFiles);
    expect(worktree.writes).toEqual(paths.slice(0, changedFiles).map((path) => `/${path}`));
    expect(worktree.reads).toBe(0);
    expect(worktree.rangeReads).toBe(0);
    expect(worktree.bulkReadPaths).toEqual([]);
    expect(
      workspace.repo.checkout.indexEntries().filter((entry) => entry.oid === changedOid),
    ).toHaveLength(changedFiles);

    worktree.writes.length = 0;
    worktree.reads = 0;
    worktree.rangeReads = 0;
    worktree.bulkReadPaths.length = 0;
    workspace.storage.resetCounters();
    checkout(workspace.context, workspace.repo, worktree, { ref: base.oid, force: true });

    expect(workspace.storage.statementCount).toBeLessThan(1_000);
    expect(worktree.writes).toHaveLength(changedFiles);
    expect(worktree.writes).toEqual(paths.slice(0, changedFiles).map((path) => `/${path}`));
    expect(worktree.reads).toBe(0);
    expect(worktree.rangeReads).toBe(0);
    expect(worktree.bulkReadPaths).toEqual([]);
    expect(
      workspace.repo.checkout.indexEntries().filter((entry) => entry.oid === changedOid),
    ).toHaveLength(0);
  });
});

describe("switch", () => {
  it("moves HEAD, and creates the branch first with create", () => {
    checkout(ws.context, ws.repo, ws.worktree, { ref: "main" });

    switchBranch(ws.context, ws.repo, ws.worktree, { name: "side" });
    fixture.git("switch", "-q", "side");
    expect(ws.repo.head().ref).toBe("refs/heads/side");
    expectSameTree();

    switchBranch(ws.context, ws.repo, ws.worktree, {
      name: "topic",
      create: true,
      startPoint: "main",
    });
    fixture.git("switch", "-q", "-c", "topic", "main");
    expect(ws.repo.head().ref).toBe("refs/heads/topic");
    expect(branchList(ws.repo)).toEqual(lines(fixture.git("branch", "--format=%(refname:short)")));
    expectSameTree();

    expect(() =>
      switchBranch(ws.context, ws.repo, ws.worktree, { name: "topic", create: true }),
    ).toThrow(/already exists/);
  });
});

describe("config", () => {
  it("gets, sets, appends and unsets", () => {
    configSet(ws.repo, { path: "user.email", value: "author@example.com" });
    fixture.git("config", "user.email", "author@example.com");
    expect(configGet(ws.repo, { path: "user.email" })).toBe(fixture.git("config", "user.email"));

    configSet(ws.repo, { path: "kompjutr.item", value: "one", append: true });
    configSet(ws.repo, { path: "kompjutr.item", value: "two", append: true });
    fixture.git("config", "--add", "kompjutr.item", "one");
    fixture.git("config", "--add", "kompjutr.item", "two");
    expect(configGet(ws.repo, { path: "kompjutr.item", all: true })).toEqual(
      lines(fixture.git("config", "--get-all", "kompjutr.item")),
    );
    // `--get` reports the last value of a multi-valued key.
    expect(configGet(ws.repo, { path: "kompjutr.item" })).toBe(
      fixture.git("config", "--get", "kompjutr.item"),
    );

    configSet(ws.repo, { path: "kompjutr.flag", value: false });
    expect(configGet(ws.repo, { path: "kompjutr.flag" })).toBe("false");

    configSet(ws.repo, { path: "user.email", value: undefined });
    fixture.git("config", "--unset", "user.email");
    expect(configGet(ws.repo, { path: "user.email" })).toBeUndefined();
    expect(runGit("config", "--get", "user.email").ok).toBe(false);
  });

  it("reports a missing key as undefined", () => {
    expect(configGet(ws.repo, { path: "nothing.here" })).toBeUndefined();
    expect(configGet(ws.repo, { path: "nothing.here", all: true })).toEqual([]);
    expect(runGit("config", "--get", "nothing.here").ok).toBe(false);
  });
});

describe("remotes", () => {
  it("round-trips remotes and matches git remote -v", () => {
    remoteAdd(ws.repo, { name: "origin", url: "https://example.com/one.git" });
    remoteAdd(ws.repo, { name: "upstream", url: "https://example.com/two.git" });
    fixture.git("remote", "add", "origin", "https://example.com/one.git");
    fixture.git("remote", "add", "upstream", "https://example.com/two.git");

    expect(remoteList(ws.repo)).toEqual(parseRemotes(fixture.git("remote", "-v")));
    expect(configGet(ws.repo, { path: "remote.origin.fetch" })).toBe(
      fixture.git("config", "--get", "remote.origin.fetch"),
    );

    expect(() =>
      remoteAdd(ws.repo, { name: "origin", url: "https://example.com/three.git" }),
    ).toThrow(/already exists/);
    expect(runGit("remote", "add", "origin", "https://example.com/three.git").ok).toBe(false);

    remoteAdd(ws.repo, { name: "origin", url: "https://example.com/three.git", force: true });
    fixture.git("remote", "set-url", "origin", "https://example.com/three.git");
    expect(remoteList(ws.repo)).toEqual(parseRemotes(fixture.git("remote", "-v")));

    remoteRemove(ws.repo, { name: "origin" });
    fixture.git("remote", "remove", "origin");
    expect(remoteList(ws.repo)).toEqual(parseRemotes(fixture.git("remote", "-v")));
    expect(configGet(ws.repo, { path: "remote.origin.fetch" })).toBeUndefined();
    expect(() => remoteRemove(ws.repo, { name: "origin" })).toThrow(/no such remote/);
    expect(runGit("remote", "remove", "origin").ok).toBe(false);
  });
});

describe("plumbing", () => {
  it("hashes a blob the way git hash-object does", () => {
    const content = "hello from the fixture\n";
    fixture.write("hash-me.txt", content);
    const expected = fixture.git("hash-object", "hash-me.txt");

    expect(hashObject(ws.repo, { content })).toBe(expected);
    expect(hashObject(ws.repo, { content: utf8.encode(content) })).toBe(expected);
    expect(ws.repo.has(expected)).toBe(false);

    expect(hashObject(ws.repo, { content, write: true })).toBe(
      fixture.git("hash-object", "-w", "hash-me.txt"),
    );
    expect(utf8Decoder.decode(ws.repo.readBlob(expected))).toBe(content);
  });

  it("reads objects back, by oid, by filepath and by shorthand", () => {
    const commit = fixture.git("rev-parse", "main");
    const blob = fixture.git("rev-parse", "main:common.txt");

    expect(utf8Decoder.decode(catFile(ws.repo, { oid: blob }).bytes)).toBe("same\n");
    expect(catFile(ws.repo, { oid: commit, filepath: "common.txt" }).oid).toBe(blob);
    const shorthand = catFile(ws.repo, { oid: `${commit}:common.txt` });
    expect(shorthand.oid).toBe(blob);
    expect(utf8Decoder.decode(shorthand.bytes)).toBe(utf8Decoder.decode(fixture.catFile(blob)));
  });

  it("writes refs and symbolic refs", () => {
    const sideOid = fixture.git("rev-parse", "side");
    const mainOid = fixture.git("rev-parse", "main");

    updateRef(ws.context, ws.repo, { ref: "refs/heads/fresh", value: sideOid });
    fixture.git("update-ref", "refs/heads/fresh", sideOid);
    expect(ws.repo.resolveRef("refs/heads/fresh")).toBe(fixture.git("rev-parse", "fresh"));

    // A ref name resolves like a revision does.
    updateRef(ws.context, ws.repo, { ref: "refs/heads/named", value: "main" });
    expect(ws.repo.resolveRef("refs/heads/named")).toBe(mainOid);

    expect(() =>
      updateRef(ws.context, ws.repo, { ref: "refs/heads/fresh", value: mainOid }),
    ).toThrow(/already exists/);
    updateRef(ws.context, ws.repo, { ref: "refs/heads/fresh", value: mainOid, force: true });
    expect(ws.repo.resolveRef("refs/heads/fresh")).toBe(mainOid);

    updateRef(ws.context, ws.repo, {
      ref: "refs/heads/alias",
      value: "refs/heads/side",
      symbolic: true,
    });
    expect(ws.repo.resolveRef("refs/heads/alias")).toBe(sideOid);

    updateRef(ws.context, ws.repo, {
      ref: "HEAD",
      value: "refs/heads/side",
      symbolic: true,
      force: true,
    });
    fixture.git("symbolic-ref", "HEAD", "refs/heads/side");
    expect(symbolicRef(ws.repo)).toBe(fixture.git("symbolic-ref", "HEAD"));
  });

  it("updates and deletes direct refs only when the raw expected oid matches", () => {
    const side = fixture.git("rev-parse", "side");
    const main = fixture.git("rev-parse", "main");
    const ref = "refs/heads/guarded";

    updateRef(ws.context, ws.repo, { ref, value: side, expected: null });
    fixture.git("update-ref", ref, side, "0".repeat(40));
    expect(readRef(ws.repo, { ref })).toEqual({ kind: "direct", oid: side });

    expect(() => updateRef(ws.context, ws.repo, { ref, value: main, expected: null })).toThrow(
      expect.objectContaining({ code: "ESTALEHEAD" }),
    );
    expect(fixture.gitResult("update-ref", ref, main, "0".repeat(40)).status).not.toBe(0);
    expect(readRef(ws.repo, { ref })).toEqual({ kind: "direct", oid: side });

    updateRef(ws.context, ws.repo, { ref, value: main, expected: side });
    fixture.git("update-ref", ref, main, side);
    expect(readRef(ws.repo, { ref })).toEqual({ kind: "direct", oid: main });

    expect(() => updateRef(ws.context, ws.repo, { ref, delete: true, expected: side })).toThrow(
      expect.objectContaining({ code: "ESTALEHEAD" }),
    );
    expect(fixture.gitResult("update-ref", "-d", ref, side).status).not.toBe(0);
    expect(readRef(ws.repo, { ref })).toEqual({ kind: "direct", oid: main });

    updateRef(ws.context, ws.repo, { ref, delete: true, expected: main });
    fixture.git("update-ref", "-d", ref, main);
    expect(readRef(ws.repo, { ref })).toEqual({ kind: "absent" });
    updateRef(ws.context, ws.repo, { ref, delete: true });
    fixture.git("update-ref", "-d", ref);
    updateRef(ws.context, ws.repo, { ref, delete: true, expected: null });
    expect(readRef(ws.repo, { ref })).toEqual({ kind: "absent" });

    const coldRef = "refs/heads/cold-guarded";
    updateRef(ws.context, ws.repo, { ref: coldRef, value: side, expected: null });
    const checkout = ws.database.findCheckout("/");
    if (checkout === null) throw new Error("checkout disappeared before reopen");
    const reopened = new Repository(ws.database.openCheckout(checkout));
    updateRef(ws.context, reopened, { ref: coldRef, value: main, expected: side });
    expect(readRef(reopened, { ref: coldRef })).toEqual({ kind: "direct", oid: main });

    const checkoutB = ws.database.createCheckout(
      ws.repo.store.repoId,
      "/linked",
      "ref: refs/heads/side",
    );
    const linked = new Repository(ws.database.openCheckout(checkoutB));
    updateRef(ws.context, linked, { ref: coldRef, delete: true, expected: main });
    expect(readRef(ws.repo, { ref: coldRef })).toEqual({ kind: "absent" });
  });

  it("rejects guarded HEAD, symbolic, force, zero-oid, and missing-target forms", () => {
    const side = fixture.git("rev-parse", "side");
    const main = fixture.git("rev-parse", "main");
    const symbolic = "refs/heads/guarded-alias";
    ws.repo.store.setRef(symbolic, "ref: refs/heads/side");

    expect(() =>
      updateRef(ws.context, ws.repo, { ref: "HEAD", value: main, expected: side }),
    ).toThrow(expect.objectContaining({ code: "EINVAL" }));
    expect(() =>
      Reflect.apply(updateRef, undefined, [
        ws.context,
        ws.repo,
        { ref: "refs/heads/invalid", value: main, expected: null, symbolic: false },
      ]),
    ).toThrow(expect.objectContaining({ code: "EINVAL" }));
    expect(() =>
      Reflect.apply(updateRef, undefined, [
        ws.context,
        ws.repo,
        { ref: "refs/heads/invalid", value: main, expected: null, force: false },
      ]),
    ).toThrow(expect.objectContaining({ code: "EINVAL" }));
    expect(() =>
      updateRef(ws.context, ws.repo, {
        ref: "refs/heads/invalid",
        value: main,
        expected: "0".repeat(40),
      }),
    ).toThrow(expect.objectContaining({ code: "EINVAL" }));
    expect(() =>
      updateRef(ws.context, ws.repo, {
        ref: "refs/heads/missing-target",
        value: "f".repeat(40),
        expected: null,
      }),
    ).toThrow(expect.objectContaining({ code: "ENOTFOUND" }));
    expect(() =>
      updateRef(ws.context, ws.repo, { ref: symbolic, value: main, expected: side }),
    ).toThrow(expect.objectContaining({ code: "ESTALEHEAD" }));
    expect(readRef(ws.repo, { ref: symbolic })).toEqual({
      kind: "symbolic",
      target: "refs/heads/side",
    });
  });

  it("reads direct, absent, dangling, and chained refs like real Git without following", () => {
    const mainOid = fixture.git("rev-parse", "main");
    fixture.git("update-ref", "refs/remotes/origin/main", mainOid);
    fixture.git("symbolic-ref", "refs/remotes/origin/alias", "refs/remotes/origin/main");
    fixture.git("symbolic-ref", "refs/remotes/origin/HEAD", "refs/remotes/origin/alias");
    fixture.git("symbolic-ref", "refs/remotes/missing/HEAD", "refs/remotes/missing/main");

    ws.repo.store.setRef("refs/remotes/origin/main", mainOid);
    ws.repo.store.setRef("refs/remotes/origin/alias", "ref: refs/remotes/origin/main");
    ws.repo.store.setRef("refs/remotes/origin/HEAD", "ref: refs/remotes/origin/alias");
    ws.repo.store.setRef("refs/remotes/missing/HEAD", "ref: refs/remotes/missing/main");

    for (const ref of [
      "refs/remotes/origin/main",
      "refs/remotes/origin/alias",
      "refs/remotes/origin/HEAD",
      "refs/remotes/absent/HEAD",
    ]) {
      expect(readRef(ws.repo, { ref })).toEqual(gitRawRefTarget(ref));
    }
    expect(fixture.git("for-each-ref", "--format=%(symref)", "refs/remotes/origin/HEAD")).toBe(
      "refs/remotes/origin/main",
    );
    expect(readRef(ws.repo, { ref: "refs/remotes/origin/HEAD" })).toEqual({
      kind: "symbolic",
      target: "refs/remotes/origin/alias",
    });
    expect(readRef(ws.repo, { ref: "refs/remotes/missing/HEAD" })).toEqual({
      kind: "symbolic",
      target: fixture.git("symbolic-ref", "--no-recurse", "refs/remotes/missing/HEAD"),
    });

    const missingOid = "f".repeat(40);
    expect(ws.repo.has(missingOid)).toBe(false);
    ws.repo.store.setRef("refs/remotes/origin/missing-object", missingOid);
    expect(readRef(ws.repo, { ref: "refs/remotes/origin/missing-object" })).toEqual({
      kind: "direct",
      oid: missingOid,
    });
  });

  it("reads symbolic, detached, unborn, and chained HEAD without resolving it", () => {
    expect(readRef(ws.repo, { ref: "HEAD" })).toEqual({
      kind: "symbolic",
      target: fixture.git("symbolic-ref", "--no-recurse", "HEAD"),
    });

    const mainOid = fixture.git("rev-parse", "main");
    fixture.git("checkout", "-q", "--detach", mainOid);
    ws.repo.checkout.setHead(mainOid);
    expect(readRef(ws.repo, { ref: "HEAD" })).toEqual({
      kind: "direct",
      oid: fixture.git("rev-parse", "HEAD"),
    });

    fixture.git("symbolic-ref", "HEAD", "refs/heads/unborn");
    ws.repo.checkout.setHead("ref: refs/heads/unborn");
    expect(readRef(ws.repo, { ref: "HEAD" })).toEqual({
      kind: "symbolic",
      target: fixture.git("symbolic-ref", "--no-recurse", "HEAD"),
    });

    fixture.git("symbolic-ref", "refs/heads/alias", "refs/heads/main");
    fixture.git("symbolic-ref", "HEAD", "refs/heads/alias");
    ws.repo.store.setRef("refs/heads/alias", "ref: refs/heads/main");
    ws.repo.checkout.setHead("ref: refs/heads/alias");
    expect(readRef(ws.repo, { ref: "HEAD" })).toEqual({
      kind: "symbolic",
      target: fixture.git("symbolic-ref", "--no-recurse", "HEAD"),
    });
  });

  it("accepts a former first-excess raw ref and rejects malformed caller refs", () => {
    const exactBound = `refs/${"a".repeat(1_019)}`;
    expect(readRef(ws.repo, { ref: exactBound })).toEqual({ kind: "absent" });
    expect(readRef(ws.repo, { ref: `${exactBound}a` })).toEqual({ kind: "absent" });
    for (const ref of ["main", "refs/", "HEAD^", "refs/heads/main\nother"]) {
      expect(() => readRef(ws.repo, { ref })).toThrow(expect.objectContaining({ code: "EINVAL" }));
    }
  });

  it("finds the repository root and refuses outside one", () => {
    const other = makeWorkspace();
    initRepository(other.context, { dir: "/work" });

    expect(repoRoot(other.context, { dir: "/work/src/deep" })).toBe("/work");
    expect(repoRoot(ws.context, { dir: "/anywhere" })).toBe("/");
    expect(() => repoRoot(other.context, { dir: "/elsewhere" })).toThrow(/not a git repository/);
  });
});
