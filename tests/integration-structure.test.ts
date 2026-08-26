import { describe, expect, it } from "vitest";

import { hasErrorCode } from "../src/core/errors.js";
import {
  MODE_COMMIT,
  MODE_EXECUTABLE,
  MODE_FILE,
  MODE_SYMLINK,
  serializeTree,
} from "../src/core/objects.js";
import {
  classifyIntegrationStructure,
  classifyStructuralStreams,
  type IntegrationIdentity,
  type StructuralIntegrationEntry,
} from "../src/core/ops/integration-structure.js";
import type { TargetEntry } from "../src/core/ops/tree-stream.js";
import { Repository } from "../src/core/repository.js";
import { comparePaths } from "../src/core/streams.js";
import { SqliteGitDatabase } from "../src/sqlite/store.js";
import { TestDatabase } from "./helpers/db.js";
import { GitFixture } from "./helpers/git.js";

function oid(number: number): string {
  return number.toString(16).padStart(40, "0");
}

function entry(path: string, number: number, mode = MODE_FILE): TargetEntry {
  return { path, mode, oid: oid(number) };
}

function identity(number: number, mode = MODE_FILE): IntegrationIdentity {
  return { mode, oid: oid(number) };
}

function classify(
  base: TargetEntry[],
  current: TargetEntry[],
  incoming: TargetEntry[],
): readonly StructuralIntegrationEntry[] {
  return classifyStructuralStreams(base, current, incoming).entries;
}

describe("three-tree structural identities", () => {
  const cases: {
    name: string;
    base: TargetEntry[];
    current: TargetEntry[];
    incoming: TargetEntry[];
    expected: readonly StructuralIntegrationEntry[];
  }[] = [
    {
      name: "unchanged",
      base: [entry("file", 1)],
      current: [entry("file", 1)],
      incoming: [entry("file", 1)],
      expected: [],
    },
    {
      name: "current-only edit is already present",
      base: [entry("file", 1)],
      current: [entry("file", 2)],
      incoming: [entry("file", 1)],
      expected: [],
    },
    {
      name: "incoming-only edit is a clean delta",
      base: [entry("file", 1)],
      current: [entry("file", 1)],
      incoming: [entry("file", 2)],
      expected: [
        {
          kind: "clean",
          path: "file",
          before: identity(1),
          result: identity(2),
        },
      ],
    },
    {
      name: "identical edits need no delta",
      base: [entry("file", 1)],
      current: [entry("file", 2)],
      incoming: [entry("file", 2)],
      expected: [],
    },
    {
      name: "identical additions need no delta",
      base: [],
      current: [entry("file", 2)],
      incoming: [entry("file", 2)],
      expected: [],
    },
    {
      name: "different additions conflict",
      base: [],
      current: [entry("file", 2)],
      incoming: [entry("file", 3)],
      expected: [
        {
          kind: "conflict",
          path: "file",
          conflict: "add/add",
          stages: { base: null, current: identity(2), incoming: identity(3) },
        },
      ],
    },
    {
      name: "modify/delete conflicts",
      base: [entry("file", 1)],
      current: [],
      incoming: [entry("file", 2)],
      expected: [
        {
          kind: "conflict",
          path: "file",
          conflict: "modify/delete",
          stages: { base: identity(1), current: null, incoming: identity(2) },
        },
      ],
    },
    {
      name: "divergent regular files defer to content merge",
      base: [entry("file", 1)],
      current: [entry("file", 2)],
      incoming: [entry("file", 3)],
      expected: [
        {
          kind: "content",
          path: "file",
          base: identity(1),
          current: identity(2),
          incoming: identity(3),
          resultMode: MODE_FILE,
        },
      ],
    },
    {
      name: "mode and content changes on opposite sides combine",
      base: [entry("file", 1)],
      current: [entry("file", 1, MODE_EXECUTABLE)],
      incoming: [entry("file", 2)],
      expected: [
        {
          kind: "clean",
          path: "file",
          before: identity(1, MODE_EXECUTABLE),
          result: identity(2, MODE_EXECUTABLE),
        },
      ],
    },
    {
      name: "divergent symlinks stay structural conflicts",
      base: [entry("link", 1, MODE_SYMLINK)],
      current: [entry("link", 2, MODE_SYMLINK)],
      incoming: [entry("link", 3, MODE_SYMLINK)],
      expected: [
        {
          kind: "conflict",
          path: "link",
          conflict: "symlink",
          stages: {
            base: identity(1, MODE_SYMLINK),
            current: identity(2, MODE_SYMLINK),
            incoming: identity(3, MODE_SYMLINK),
          },
        },
      ],
    },
    {
      name: "divergent gitlinks stay structural conflicts",
      base: [entry("module", 1, MODE_COMMIT)],
      current: [entry("module", 2, MODE_COMMIT)],
      incoming: [entry("module", 3, MODE_COMMIT)],
      expected: [
        {
          kind: "conflict",
          path: "module",
          conflict: "gitlink",
          stages: {
            base: identity(1, MODE_COMMIT),
            current: identity(2, MODE_COMMIT),
            incoming: identity(3, MODE_COMMIT),
          },
        },
      ],
    },
  ];

  for (const fixture of cases) {
    it(fixture.name, () => {
      expect(classify(fixture.base, fixture.current, fixture.incoming)).toEqual(fixture.expected);
    });
  }
});

describe("file/directory prefixes", () => {
  it("keeps a one-sided directory-to-file replacement clean", () => {
    expect(classify([entry("node/leaf", 1)], [entry("node", 2)], [entry("node/leaf", 1)])).toEqual(
      [],
    );
  });

  it("emits a clean one-sided file-to-directory delta", () => {
    expect(classify([entry("node", 1)], [entry("node", 1)], [entry("node/leaf", 2)])).toEqual([
      { kind: "clean", path: "node", before: identity(1), result: null },
      { kind: "clean", path: "node/leaf", before: null, result: identity(2) },
    ]);
  });

  it("marks both sides of independently added file/directory names", () => {
    expect(classify([], [entry("node", 1)], [entry("node/leaf", 2)])).toEqual([
      {
        kind: "conflict",
        path: "node",
        conflict: "file/directory",
        stages: { base: null, current: identity(1), incoming: null },
      },
      {
        kind: "conflict",
        path: "node/leaf",
        conflict: "file/directory",
        stages: { base: null, current: null, incoming: identity(2) },
      },
    ]);
  });

  it("does not buffer a conflicting descendant subtree", () => {
    const incoming = Array.from({ length: 200 }, (_, index) =>
      entry(`node/${String(index).padStart(3, "0")}`, index + 2),
    );
    const plan = classifyStructuralStreams([], [entry("node", 1)], incoming);
    expect(plan.entries).toHaveLength(201);
    expect(plan.entries[0]).toMatchObject({ path: "node", conflict: "file/directory" });
    expect(plan.entries[200]).toMatchObject({
      path: "node/199",
      conflict: "file/directory",
    });
  });
});

describe("ordering, bounds, and trust", () => {
  it("preserves Git UTF-8 path order above the BMP", () => {
    const paths = ["\ue000", "😀"];
    paths.sort(comparePaths);
    const plan = classifyStructuralStreams(
      [],
      [],
      paths.map((path, index) => entry(path, index + 1)),
    );
    expect(plan.entries.map(({ path }) => path)).toEqual(["\ue000", "😀"]);
  });

  it("accepts the exact row and retained-byte boundaries", () => {
    const incoming = [entry("a", 1)];
    expect(
      classifyStructuralStreams([], [], incoming, {
        maxRows: 1,
        maxEntries: 1,
        maxRetainedBytes: 676,
      }).entries,
    ).toHaveLength(1);
    expect(() => classifyStructuralStreams([], [], incoming, { maxRows: 0 })).toThrowError(
      expect.objectContaining({ code: "E2BIG" }),
    );
    expect(() => classifyStructuralStreams([], [], incoming, { maxEntries: 0 })).toThrowError(
      expect.objectContaining({ code: "E2BIG" }),
    );
    expect(() =>
      classifyStructuralStreams([], [], incoming, { maxRetainedBytes: 675 }),
    ).toThrowError(expect.objectContaining({ code: "E2BIG" }));
  });

  it("bounds many no-output prefix candidates without counting them as entries", () => {
    const current = Array.from({ length: 1_000 }, (_, index) =>
      entry(`p${String(index).padStart(3, "0")}`, index + 1),
    );
    expect(
      classifyStructuralStreams([], current, [], {
        maxRows: 1_000,
        maxEntries: 0,
        maxRetainedBytes: 312,
      }),
    ).toEqual({ entries: [], sourceRows: 1_000 });
    expect(() =>
      classifyStructuralStreams([], current, [], {
        maxRows: 1_000,
        maxEntries: 0,
        maxRetainedBytes: 311,
      }),
    ).toThrowError(expect.objectContaining({ code: "E2BIG" }));
  });

  it("accounts for nested live prefixes at the exact peak", () => {
    expect(
      classifyStructuralStreams([], [entry("a", 1)], [entry("a/b", 2)], {
        maxRows: 2,
        maxEntries: 2,
        maxRetainedBytes: 1_360,
      }).entries,
    ).toHaveLength(2);
    expect(() =>
      classifyStructuralStreams([], [entry("a", 1)], [entry("a/b", 2)], {
        maxRows: 2,
        maxEntries: 2,
        maxRetainedBytes: 1_359,
      }),
    ).toThrowError(expect.objectContaining({ code: "E2BIG" }));
  });

  it("charges the complete retained deep-prefix path", () => {
    const path = `${"d/".repeat(999)}f`;
    expect(
      classifyStructuralStreams([], [entry(path, 1)], [], {
        maxRows: 1,
        maxEntries: 0,
        maxRetainedBytes: 4_302,
      }),
    ).toEqual({ entries: [], sourceRows: 1 });
    expect(() =>
      classifyStructuralStreams([], [entry(path, 1)], [], {
        maxRows: 1,
        maxEntries: 0,
        maxRetainedBytes: 4_301,
      }),
    ).toThrowError(expect.objectContaining({ code: "E2BIG" }));
  });

  it("does not pull beyond the first rejected source row", () => {
    let pulls = 0;
    function* guarded(): Generator<TargetEntry> {
      pulls++;
      yield entry("a", 1);
      pulls++;
      yield entry("b", 2);
      throw new Error("over-consumed source");
    }
    try {
      classifyStructuralStreams([], [], guarded(), { maxRows: 1 });
      throw new Error("expected a row bound failure");
    } catch (error) {
      expect(hasErrorCode(error, "E2BIG")).toBe(true);
    }
    expect(pulls).toBe(2);
  });

  it("fails closed on corrupt stream rows and order", () => {
    expect(() => classifyStructuralStreams([], [], [entry("", 1)])).toThrowError(
      expect.objectContaining({ code: "ECORRUPT" }),
    );
    expect(() =>
      classifyStructuralStreams([], [], [{ ...entry("a", 1), oid: "bad" }]),
    ).toThrowError(expect.objectContaining({ code: "ECORRUPT" }));
    expect(() => classifyStructuralStreams([], [], [entry("b", 1), entry("a", 2)])).toThrowError(
      expect.objectContaining({ code: "ECORRUPT" }),
    );
  });

  it("rejects limits above the hard ceiling", () => {
    expect(() =>
      classifyStructuralStreams([], [], [], { maxRows: Number.MAX_SAFE_INTEGER }),
    ).toThrow(RangeError);
  });

  it("prunes equal roots only after validating the authoritative object", () => {
    const database = new SqliteGitDatabase(new TestDatabase());
    const store = database.openCheckout(database.createRepository("/repo", "ref: refs/heads/main"));
    const written = store.writeObjects((batch) => {
      const blob = batch.write("blob", new TextEncoder().encode("content\n"));
      const tree = batch.write(
        "tree",
        serializeTree([{ mode: MODE_FILE, name: "file", oid: blob }]),
      );
      return { blob, tree };
    });
    const repo = new Repository(store);

    expect(
      classifyIntegrationStructure(repo, {
        baseTreeOid: written.tree,
        currentTreeOid: written.tree,
        incomingTreeOid: written.tree,
      }),
    ).toEqual({ entries: [], sourceRows: 0 });
    expect(() =>
      classifyIntegrationStructure(repo, {
        baseTreeOid: written.blob,
        currentTreeOid: written.blob,
        incomingTreeOid: written.blob,
      }),
    ).toThrowError(expect.objectContaining({ code: "ECORRUPT" }));
    expect(() =>
      classifyIntegrationStructure(repo, {
        baseTreeOid: oid(999),
        currentTreeOid: oid(999),
        incomingTreeOid: oid(999),
      }),
    ).toThrowError(expect.objectContaining({ code: "ENOTFOUND" }));
  });

  it("rejects corrupt authoritative metadata on the equal-root fast path", () => {
    const database = new SqliteGitDatabase(new TestDatabase());
    const store = database.openCheckout(database.createRepository("/repo", "ref: refs/heads/main"));
    const blob = store.write("blob", new TextEncoder().encode("content\n"));
    const tree = store.write("tree", serializeTree([{ mode: MODE_FILE, name: "file", oid: blob }]));
    const repo = new Repository(store);
    const classifyEqual = (oid: string): ReturnType<typeof classifyIntegrationStructure> =>
      classifyIntegrationStructure(repo, {
        baseTreeOid: oid,
        currentTreeOid: oid,
        incomingTreeOid: oid,
      });

    store.db.run("UPDATE git_objects SET type = 'tree' WHERE repo_id = ? AND oid = ?", 1, blob);
    expect(() => classifyEqual(blob)).toThrowError(expect.objectContaining({ code: "ECORRUPT" }));

    store.db.run("PRAGMA ignore_check_constraints = ON");
    try {
      store.db.run("UPDATE git_objects SET size = -1 WHERE repo_id = ? AND oid = ?", 1, tree);
    } finally {
      store.db.run("PRAGMA ignore_check_constraints = OFF");
    }
    expect(() => classifyEqual(tree)).toThrowError(expect.objectContaining({ code: "ECORRUPT" }));

    store.db.run(
      "UPDATE git_objects SET size = ? WHERE repo_id = ? AND oid = ?",
      serializeTree([{ mode: MODE_FILE, name: "file", oid: blob }]).length,
      1,
      tree,
    );
    store.db.run("DELETE FROM git_object_chunks WHERE repo_id = ? AND oid = ?", 1, tree);
    expect(() => classifyEqual(tree)).toThrowError(expect.objectContaining({ code: "ECORRUPT" }));
  });
});

function gitTree(fixture: GitFixture, revision: string): TargetEntry[] {
  const output = fixture.git("ls-tree", "-r", "--full-tree", revision);
  if (output === "") return [];
  return output.split("\n").map((line) => {
    const tab = line.indexOf("\t");
    const metadata = line.slice(0, tab).split(" ");
    const mode = metadata[0];
    const objectId = metadata[2];
    if (tab < 0 || mode === undefined || objectId === undefined) {
      throw new Error(`unexpected ls-tree row: ${line}`);
    }
    return { path: line.slice(tab + 1), mode, oid: objectId };
  });
}

describe("real Git structural parity", () => {
  it("matches Git when executable mode and content change on opposite sides", () => {
    const fixture = new GitFixture().init();
    try {
      fixture.write("file", "base\n");
      const baseCommit = fixture.commit("base");
      fixture.git("checkout", "-q", "-b", "current", baseCommit);
      fixture.chmod("file", 0o755);
      const currentCommit = fixture.commit("current mode");
      fixture.git("checkout", "-q", "-b", "incoming", baseCommit);
      fixture.write("file", "incoming\n");
      const incomingCommit = fixture.commit("incoming content");

      const plan = classifyStructuralStreams(
        gitTree(fixture, baseCommit),
        gitTree(fixture, currentCommit),
        gitTree(fixture, incomingCommit),
      );
      expect(plan.entries).toHaveLength(1);
      expect(plan.entries[0]).toMatchObject({ kind: "clean", path: "file" });

      fixture.git("checkout", "-q", "current");
      fixture.git("merge", "-q", "--no-commit", "--no-ff", "incoming");
      const merged = gitTree(fixture, fixture.git("write-tree"))[0];
      const planned = plan.entries[0];
      if (planned?.kind !== "clean" || planned.result === null || merged === undefined) {
        throw new Error("expected a clean planned and Git result");
      }
      expect(planned.result).toEqual({ mode: merged.mode, oid: merged.oid });
    } finally {
      fixture.dispose();
    }
  });

  it("matches Git's three conflict-stage identities", () => {
    const fixture = new GitFixture().init();
    try {
      fixture.write("file", "base\n");
      const baseCommit = fixture.commit("base");
      fixture.git("checkout", "-q", "-b", "current", baseCommit);
      fixture.write("file", "current\n");
      const currentCommit = fixture.commit("current");
      fixture.git("checkout", "-q", "-b", "incoming", baseCommit);
      fixture.write("file", "incoming\n");
      const incomingCommit = fixture.commit("incoming");

      const plan = classifyStructuralStreams(
        gitTree(fixture, baseCommit),
        gitTree(fixture, currentCommit),
        gitTree(fixture, incomingCommit),
      );
      expect(plan.entries[0]).toMatchObject({ kind: "content", path: "file" });

      fixture.git("checkout", "-q", "current");
      expect(() => fixture.git("merge", "--no-commit", "--no-ff", "incoming")).toThrow();
      const gitStages = fixture.git("ls-files", "-s", "file").split("\n");
      const planned = plan.entries[0];
      if (planned?.kind !== "content") throw new Error("expected a content candidate");
      const plannedStages = [planned.base, planned.current, planned.incoming];
      expect(
        gitStages.map((line) => {
          const fields = line.split(/[ \t]/);
          return { mode: fields[0], oid: fields[1] };
        }),
      ).toEqual(plannedStages);
    } finally {
      fixture.dispose();
    }
  });
});
