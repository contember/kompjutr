import { spawnSync } from "node:child_process";

import { describe, expect, it } from "vitest";

import {
  hashObject,
  MODE_COMMIT,
  MODE_EXECUTABLE,
  MODE_FILE,
  MODE_SYMLINK,
} from "../src/core/objects.js";
import {
  type IntegrationEntry,
  MAX_VIRTUAL_ANCESTOR_SQL_STATEMENTS,
  MAX_VIRTUAL_ANCESTOR_TREE_STATEMENTS,
  planIntegration,
  planVirtualAncestorIntegration,
} from "../src/core/ops/integration.js";
import { buildTree } from "../src/core/ops/tree-build.js";
import { Repository } from "../src/core/repository.js";
import { comparePaths } from "../src/core/streams.js";
import { MAX_OPERATION_MEMORY_BYTES } from "../src/sqlite/memory.js";
import { type IndexEntry, type RepoStore, SqliteGitDatabase } from "../src/sqlite/store.js";
import { TestDatabase } from "./helpers/db.js";
import { GitFixture } from "./helpers/git.js";

interface ContentValue {
  mode: typeof MODE_FILE | typeof MODE_EXECUTABLE | typeof MODE_SYMLINK;
  content: string | Uint8Array;
}

interface GitlinkValue {
  mode: typeof MODE_COMMIT;
  oid: string;
}

type StateValue = ContentValue | GitlinkValue;
type State = Record<string, StateValue>;

interface Triplet {
  fixture: GitFixture;
  baseOid: string;
  currentOid: string;
  incomingOid: string;
}

interface TreeIdentity {
  mode: string;
  oid: string;
}

function bytes(value: string | Uint8Array): Uint8Array {
  return typeof value === "string" ? new TextEncoder().encode(value) : value;
}

function writeGitState(fixture: GitFixture, state: State, message: string): string {
  fixture.git("rm", "-r", "-f", "--ignore-unmatch", "--", ".");
  for (const [path, value] of Object.entries(state)) {
    if (value.mode === MODE_SYMLINK)
      fixture.symlink(new TextDecoder().decode(bytes(value.content)), path);
    else if (value.mode === MODE_EXECUTABLE) {
      fixture.writeExecutable(path, new TextDecoder().decode(bytes(value.content)));
    } else if (value.mode === MODE_FILE) fixture.write(path, value.content);
  }
  fixture.git("add", "-A");
  for (const [path, value] of Object.entries(state)) {
    if (value.mode === MODE_COMMIT) {
      fixture.git("update-index", "--add", "--cacheinfo", `${MODE_COMMIT},${value.oid},${path}`);
    }
  }
  fixture.git("commit", "-q", "--allow-empty", "-m", message);
  return fixture.git("rev-parse", "HEAD");
}

function triplet(base: State, current: State, incoming: State): Triplet {
  const fixture = new GitFixture().init("base");
  const baseOid = writeGitState(fixture, base, "base");
  fixture.git("switch", "-q", "-c", "current");
  const currentOid = writeGitState(fixture, current, "current");
  fixture.git("switch", "-q", "-c", "incoming", baseOid);
  const incomingOid = writeGitState(fixture, incoming, "incoming");
  return { fixture, baseOid, currentOid, incomingOid };
}

function mergeTree(fixture: GitFixture): string {
  const result = spawnSync("git", ["merge-tree", "--write-tree", "current", "incoming"], {
    cwd: fixture.dir,
    encoding: "utf8",
  });
  if (result.error !== undefined) throw result.error;
  if (result.status !== 0 && result.status !== 1) {
    throw new Error(`git merge-tree exited ${result.status}: ${result.stderr}`);
  }
  const firstLine = result.stdout.split("\n")[0];
  if (firstLine === undefined || !/^[0-9a-f]{40}$/.test(firstLine)) {
    throw new Error(`git merge-tree omitted its result tree: ${result.stdout}`);
  }
  return firstLine;
}

function gitTree(fixture: GitFixture, treeOid: string): Map<string, TreeIdentity> {
  const entries = new Map<string, TreeIdentity>();
  const output = fixture.git("ls-tree", "-r", treeOid);
  if (output.length === 0) return entries;
  for (const line of output.split("\n")) {
    const separator = line.indexOf("\t");
    const fields = line.slice(0, separator).split(" ");
    const mode = fields[0];
    const oid = fields[2];
    if (separator < 0 || mode === undefined || oid === undefined) {
      throw new Error(`invalid git ls-tree row: ${line}`);
    }
    entries.set(line.slice(separator + 1), { mode, oid });
  }
  return entries;
}

function writeState(
  repo: Repository,
  state: State,
): { tree: string; files: Map<string, TreeIdentity> } {
  const files = new Map<string, TreeIdentity>();
  const entries: IndexEntry[] = [];
  for (const [path, value] of Object.entries(state).sort(([left], [right]) =>
    comparePaths(left, right),
  )) {
    const oid =
      value.mode === MODE_COMMIT ? value.oid : repo.store.write("blob", bytes(value.content));
    files.set(path, { mode: value.mode, oid });
    entries.push({
      path,
      stage: 0,
      mode: Number.parseInt(value.mode, 8),
      oid,
      size: null,
      mtime: null,
      ino: null,
    });
  }
  return { tree: buildTree(repo, entries), files };
}

function project(
  current: ReadonlyMap<string, TreeIdentity>,
  entries: readonly IntegrationEntry[],
): Map<string, TreeIdentity> {
  const result = new Map(current);
  for (const entry of entries) {
    if (entry.kind !== "clean") throw new Error(`virtual plan retained ${entry.conflict}`);
    if (entry.result === null) {
      result.delete(entry.path);
      continue;
    }
    if (entry.content !== null) expect(hashObject("blob", entry.content)).toBe(entry.result.oid);
    result.set(entry.path, entry.result);
  }
  return result;
}

function ordered(entries: ReadonlyMap<string, TreeIdentity>): [string, string, string][] {
  return [...entries]
    .sort(([left], [right]) => comparePaths(left, right))
    .map(([path, identity]) => [path, identity.mode, identity.oid]);
}

function repoFixture(): { store: RepoStore; repo: Repository } {
  const database = new SqliteGitDatabase(new TestDatabase());
  const store = database.open(database.create("/repo", "ref: refs/heads/main"));
  return { store, repo: new Repository(store, "/repo") };
}

function assertCoordinatorIdle(store: RepoStore): void {
  const probe = store.reserveMemory();
  try {
    probe.set("other", MAX_OPERATION_MEMORY_BYTES);
  } finally {
    probe.dispose();
  }
}

describe("virtual-ancestor integration planning", () => {
  it("keeps its explicit SQL proof below the operation ceiling", () => {
    expect(MAX_VIRTUAL_ANCESTOR_TREE_STATEMENTS).toBe(10);
    expect(MAX_VIRTUAL_ANCESTOR_SQL_STATEMENTS).toBe(138);
    expect(MAX_VIRTUAL_ANCESTOR_SQL_STATEMENTS).toBeLessThan(1_000);
  });

  it("materializes normal add/add worktree bytes and matches Git's virtual marker blob", () => {
    const states = {
      base: {},
      current: {
        binary: { mode: MODE_EXECUTABLE, content: new Uint8Array([0, 1]) },
        item: { mode: MODE_FILE, content: "left\n" },
        modeOnly: { mode: MODE_EXECUTABLE, content: "same\n" },
      },
      incoming: {
        binary: { mode: MODE_FILE, content: new Uint8Array([0, 2]) },
        item: { mode: MODE_FILE, content: "right\n" },
        modeOnly: { mode: MODE_FILE, content: "same\n" },
      },
    } satisfies { base: State; current: State; incoming: State };
    const git = triplet(states.base, states.current, states.incoming);
    try {
      const expected = gitTree(git.fixture, mergeTree(git.fixture));
      const expectedItem = expected.get("item");
      if (expectedItem === undefined) throw new Error("Git omitted add/add result");
      const marker = new TextDecoder().decode(git.fixture.catFile(expectedItem.oid));
      const lines = marker.trimEnd().split("\n");
      const currentLabel = lines[0]?.slice("<<<<<<< ".length);
      const incomingLabel = lines[lines.length - 1]?.slice(">>>>>>> ".length);
      if (currentLabel === undefined || incomingLabel === undefined) {
        throw new Error("Git omitted add/add marker labels");
      }

      const { store, repo } = repoFixture();
      const base = writeState(repo, states.base);
      const current = writeState(repo, states.current);
      const incoming = writeState(repo, states.incoming);
      const normal = planIntegration(repo, {
        baseTreeOid: base.tree,
        currentTreeOid: current.tree,
        incomingTreeOid: incoming.tree,
        text: { labels: { current: "ours", incoming: "theirs" } },
      });
      expect(normal.entries).toHaveLength(3);
      const conflict = normal.entries.find((entry) => entry.path === "item");
      expect(conflict).toMatchObject({
        kind: "conflict",
        conflict: "content",
        resultMode: MODE_FILE,
      });
      if (conflict?.kind !== "conflict" || conflict.content === null) {
        throw new Error("normal add/add omitted worktree content");
      }
      expect(new TextDecoder().decode(conflict.content)).toBe(
        "<<<<<<< ours\nleft\n=======\nright\n>>>>>>> theirs\n",
      );
      const binary = normal.entries.find((entry) => entry.path === "binary");
      expect(binary).toMatchObject({
        kind: "conflict",
        conflict: "binary",
        resultMode: MODE_EXECUTABLE,
        content: new Uint8Array([0, 1]),
      });
      const modeOnly = normal.entries.find((entry) => entry.path === "modeOnly");
      expect(modeOnly).toMatchObject({
        kind: "conflict",
        conflict: "add/add",
        resultMode: MODE_EXECUTABLE,
        content: bytes("same\n"),
        stages: {
          base: null,
          current: current.files.get("modeOnly"),
          incoming: incoming.files.get("modeOnly"),
        },
      });

      const recursive = planVirtualAncestorIntegration(repo, {
        baseTreeOid: base.tree,
        currentTreeOid: current.tree,
        incomingTreeOid: incoming.tree,
        labels: { current: currentLabel, incoming: incomingLabel },
      });
      const recursiveItem = recursive.entries.find((entry) => entry.path === "item");
      if (recursiveItem?.kind !== "clean" || recursiveItem.content === null) {
        throw new Error("recursive add/add omitted its marker blob");
      }
      expect(new TextDecoder().decode(recursiveItem.content)).toBe(
        `<<<<<<<<< ${currentLabel}\nleft\n=========\nright\n>>>>>>>>> ${incomingLabel}\n`,
      );

      const virtual = planVirtualAncestorIntegration(repo, {
        baseTreeOid: base.tree,
        currentTreeOid: current.tree,
        incomingTreeOid: incoming.tree,
        labels: { current: currentLabel, incoming: incomingLabel },
        depth: 0,
      });
      expect(ordered(project(current.files, virtual.entries))).toEqual(ordered(expected));
      assertCoordinatorIdle(store);
    } finally {
      git.fixture.dispose();
    }
  });

  it("matches Git for modify/delete and mode resolution independent of content", () => {
    const states = {
      base: {
        deleted: { mode: MODE_FILE, content: "base\n" },
        mode: { mode: MODE_FILE, content: "base\n" },
      },
      current: {
        deleted: { mode: MODE_FILE, content: "modified\n" },
        mode: { mode: MODE_FILE, content: "ours\n" },
      },
      incoming: { mode: { mode: MODE_EXECUTABLE, content: "theirs\n" } },
    } satisfies { base: State; current: State; incoming: State };
    const git = triplet(states.base, states.current, states.incoming);
    try {
      const expected = gitTree(git.fixture, mergeTree(git.fixture));
      const expectedMode = expected.get("mode");
      if (expectedMode === undefined) throw new Error("Git omitted mode conflict result");
      const marker = new TextDecoder().decode(git.fixture.catFile(expectedMode.oid));
      const lines = marker.trimEnd().split("\n");
      const currentLabel = lines[0]?.slice("<<<<<<< ".length);
      const incomingLabel = lines[lines.length - 1]?.slice(">>>>>>> ".length);
      if (currentLabel === undefined || incomingLabel === undefined) {
        throw new Error("Git omitted content marker labels");
      }

      const { store, repo } = repoFixture();
      const base = writeState(repo, states.base);
      const current = writeState(repo, states.current);
      const incoming = writeState(repo, states.incoming);
      const plan = planVirtualAncestorIntegration(repo, {
        baseTreeOid: base.tree,
        currentTreeOid: current.tree,
        incomingTreeOid: incoming.tree,
        labels: { current: currentLabel, incoming: incomingLabel },
        depth: 0,
      });
      expect(plan.entries.every((entry) => entry.kind === "clean")).toBe(true);
      expect(ordered(project(current.files, plan.entries))).toEqual(ordered(expected));
      assertCoordinatorIdle(store);
    } finally {
      git.fixture.dispose();
    }
  });

  it("matches Git when temporary ancestors collapse symlink and gitlink conflicts", () => {
    const fixture = new GitFixture().init("base");
    const baseOid = writeGitState(fixture, {}, "base");
    fixture.git("switch", "-q", "-c", "current");
    const currentState: State = {
      link: { mode: MODE_SYMLINK, content: "ours" },
      submodule: { mode: MODE_COMMIT, oid: baseOid },
    };
    const currentOid = writeGitState(fixture, currentState, "current");
    fixture.git("switch", "-q", "-c", "incoming", baseOid);
    const incomingState: State = {
      link: { mode: MODE_SYMLINK, content: "theirs" },
      submodule: { mode: MODE_COMMIT, oid: currentOid },
    };
    const incomingOid = writeGitState(fixture, incomingState, "incoming");
    try {
      expect(incomingOid).not.toBe(currentOid);
      const expected = gitTree(fixture, mergeTree(fixture));
      const { store, repo } = repoFixture();
      const base = writeState(repo, {});
      const current = writeState(repo, currentState);
      const incoming = writeState(repo, incomingState);
      const plan = planVirtualAncestorIntegration(repo, {
        baseTreeOid: base.tree,
        currentTreeOid: current.tree,
        incomingTreeOid: incoming.tree,
        labels: { current: "current", incoming: "incoming" },
      });
      expect(ordered(project(current.files, plan.entries))).toEqual(ordered(expected));
      assertCoordinatorIdle(store);
    } finally {
      fixture.dispose();
    }
  });

  it("matches Git's F/D and distinct-type relocation names, including suffix collisions", () => {
    const states = {
      base: {},
      current: {
        item: { mode: MODE_FILE, content: "regular\n" },
        node: { mode: MODE_FILE, content: "leaf\n" },
        "node~current/occupied": { mode: MODE_FILE, content: "occupied\n" },
        "node~current_0/child": { mode: MODE_FILE, content: "also occupied\n" },
      },
      incoming: {
        item: { mode: MODE_SYMLINK, content: "target" },
        "node/child": { mode: MODE_FILE, content: "child\n" },
      },
    } satisfies { base: State; current: State; incoming: State };
    const git = triplet(states.base, states.current, states.incoming);
    try {
      const expected = gitTree(git.fixture, mergeTree(git.fixture));
      expect([...expected.keys()]).toContain("item~current");
      expect([...expected.keys()]).toContain("node~current_1");

      const { store, repo } = repoFixture();
      const beforeObjects = store.objectCount();
      const base = writeState(repo, states.base);
      const current = writeState(repo, states.current);
      const incoming = writeState(repo, states.incoming);
      const afterSetupObjects = store.objectCount();
      expect(afterSetupObjects).toBeGreaterThan(beforeObjects);
      const plan = planVirtualAncestorIntegration(repo, {
        baseTreeOid: base.tree,
        currentTreeOid: current.tree,
        incomingTreeOid: incoming.tree,
        labels: { current: "current", incoming: "incoming" },
      });
      expect(ordered(project(current.files, plan.entries))).toEqual(ordered(expected));
      expect(store.objectCount()).toBe(afterSetupObjects);
      assertCoordinatorIdle(store);
    } finally {
      git.fixture.dispose();
    }
  });

  it("bounds every suffixed relocation path by its UTF-8 byte length", () => {
    const path = "x".repeat(2_192);
    const { store, repo } = repoFixture();
    const base = writeState(repo, {});
    const current = writeState(repo, {
      [path]: { mode: MODE_FILE, content: "leaf\n" },
      [`${path}~current`]: { mode: MODE_FILE, content: "occupied\n" },
    });
    const incoming = writeState(repo, {
      [`${path}/c`]: { mode: MODE_FILE, content: "child\n" },
    });

    expect(() =>
      planVirtualAncestorIntegration(repo, {
        baseTreeOid: base.tree,
        currentTreeOid: current.tree,
        incomingTreeOid: incoming.tree,
        labels: { current: "current", incoming: "incoming" },
      }),
    ).toThrowError(expect.objectContaining({ code: "E2BIG" }));
    assertCoordinatorIdle(store);
  });

  it("limits a relocation namespace to exactly 1000 candidate names", () => {
    const currentState: State = {
      node: { mode: MODE_FILE, content: "leaf\n" },
      "node~current": { mode: MODE_FILE, content: "occupied\n" },
    };
    for (let ordinal = 0; ordinal < 998; ordinal++) {
      currentState[`node~current_${ordinal}`] = { mode: MODE_FILE, content: "occupied\n" };
    }
    const { store, repo } = repoFixture();
    const base = writeState(repo, {});
    const incoming = writeState(repo, {
      "node/child": { mode: MODE_FILE, content: "child\n" },
    });
    const accepted = writeState(repo, currentState);
    const plan = planVirtualAncestorIntegration(repo, {
      baseTreeOid: base.tree,
      currentTreeOid: accepted.tree,
      incomingTreeOid: incoming.tree,
      labels: { current: "current", incoming: "incoming" },
    });
    expect(plan.entries.some((entry) => entry.path === "node~current_998")).toBe(true);

    currentState["node~current_998"] = { mode: MODE_FILE, content: "occupied\n" };
    const rejected = writeState(repo, currentState);
    expect(() =>
      planVirtualAncestorIntegration(repo, {
        baseTreeOid: base.tree,
        currentTreeOid: rejected.tree,
        incomingTreeOid: incoming.tree,
        labels: { current: "current", incoming: "incoming" },
      }),
    ).toThrowError(expect.objectContaining({ code: "E2BIG" }));
    assertCoordinatorIdle(store);
  });
});
