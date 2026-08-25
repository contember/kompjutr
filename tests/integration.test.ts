import { describe, expect, it } from "vitest";

import { concat } from "../src/core/bytes.js";
import { DEFAULT_TEXT_MERGE_LIMITS } from "../src/core/diff/xmerge.js";
import { hasErrorCode } from "../src/core/errors.js";
import { hashObject, MODE_FILE, serializeTree } from "../src/core/objects.js";
import {
  type IntegrationEntry,
  MAX_INTEGRATION_BLOB_READ_CALLS,
  MAX_INTEGRATION_SQL_STATEMENTS,
  MAX_INTEGRATION_STATEMENTS_PER_BLOB_READ,
  MAX_INTEGRATION_TREE_STATEMENTS,
  planIntegration,
} from "../src/core/ops/integration.js";
import { reserveIntegrationPlan } from "../src/core/ops/integration-worktree.js";
import { PackWriter } from "../src/core/pack/writer.js";
import { Repository } from "../src/core/repository.js";
import { comparePaths } from "../src/core/streams.js";
import { MAX_OPERATION_MEMORY_BYTES } from "../src/sqlite/memory.js";
import { type RepoStore, SqliteGitDatabase } from "../src/sqlite/store.js";
import { TestDatabase } from "./helpers/db.js";
import { slices } from "./helpers/git.js";

interface FileValue {
  content: string | Uint8Array;
  mode?: string;
}

interface WrittenTree {
  tree: string;
  files: Map<string, { mode: string; oid: string }>;
}

function bytes(value: string | Uint8Array): Uint8Array {
  return typeof value === "string" ? new TextEncoder().encode(value) : value;
}

function writeTree(store: RepoStore, files: Record<string, FileValue>): WrittenTree {
  const identities = new Map<string, { mode: string; oid: string }>();
  const entries = Object.entries(files)
    .sort(([left], [right]) => comparePaths(left, right))
    .map(([name, value]) => {
      const mode = value.mode ?? MODE_FILE;
      const oid = store.write("blob", bytes(value.content));
      identities.set(name, { mode, oid });
      return { mode, name, oid };
    });
  return { tree: store.write("tree", serializeTree(entries)), files: identities };
}

function writeIdentityTree(
  store: RepoStore,
  files: Record<string, { mode: string; oid: string }>,
): WrittenTree {
  const entries = Object.entries(files)
    .sort(([left], [right]) => comparePaths(left, right))
    .map(([name, identity]) => ({ ...identity, name }));
  return {
    tree: store.write("tree", serializeTree(entries)),
    files: new Map(entries.map(({ mode, name, oid }) => [name, { mode, oid }])),
  };
}

function find(entries: readonly IntegrationEntry[], path: string): IntegrationEntry {
  const entry = entries.find((candidate) => candidate.path === path);
  if (entry === undefined) throw new Error(`missing integration entry for ${path}`);
  return entry;
}

function assertCoordinatorIdle(store: RepoStore): void {
  const probe = store.reserveMemory();
  try {
    probe.set("other", MAX_OPERATION_MEMORY_BYTES);
  } finally {
    probe.dispose();
  }
}

describe("bounded three-way integration plan", () => {
  it("keeps the modeled SQL ceiling below the operation limit", () => {
    expect(MAX_INTEGRATION_SQL_STATEMENTS).toBe(
      MAX_INTEGRATION_TREE_STATEMENTS +
        MAX_INTEGRATION_BLOB_READ_CALLS * MAX_INTEGRATION_STATEMENTS_PER_BLOB_READ,
    );
    expect(MAX_INTEGRATION_SQL_STATEMENTS).toBe(134);
    expect(MAX_INTEGRATION_SQL_STATEMENTS).toBeLessThan(1_000);
  });

  it("rejects concurrent operation state before opening a tree cursor", () => {
    const db = new TestDatabase();
    const database = new SqliteGitDatabase(db);
    const store = database.open(database.create("/repo", "ref: refs/heads/main"));
    const base = writeTree(store, { file: { content: "base\n" } });
    const current = writeTree(store, { file: { content: "current\n" } });
    const incoming = writeTree(store, { file: { content: "incoming\n" } });
    const blocker = store.reserveMemory();
    blocker.set("other", 1);
    db.storage.resetCounters();
    try {
      expect(() =>
        planIntegration(new Repository(store, "/repo"), {
          baseTreeOid: base.tree,
          currentTreeOid: current.tree,
          incomingTreeOid: incoming.tree,
        }),
      ).toThrowError(expect.objectContaining({ code: "E2BIG" }));
      expect(db.storage.statementCount).toBe(0);
      expect(blocker.currentBytes).toBe(1);
    } finally {
      blocker.dispose();
    }
    assertCoordinatorIdle(store);
  });

  it("coordinates retained caller state through planning and maximum rebase execution reserve", () => {
    const database = new SqliteGitDatabase(new TestDatabase());
    const store = database.open(database.create("/repo", "ref: refs/heads/main"));
    const tree = writeTree(store, { file: { content: "same\n" } });
    const repo = new Repository(store, "/repo");
    const journal = store.reserveMemory();
    journal.set("other", 4 * 1024 * 1024);
    try {
      const plan = planIntegration(repo, {
        baseTreeOid: tree.tree,
        currentTreeOid: tree.tree,
        incomingTreeOid: tree.tree,
        callerRetainedBytes: journal.currentBytes,
      });
      expect(plan.memoryHighWaterBytes).toBe(MAX_OPERATION_MEMORY_BYTES - journal.currentBytes);
      const execution = reserveIntegrationPlan(
        repo,
        { ...plan, retainedBytes: 26 * 1024 * 1024 },
        8 * 1024 * 1024,
      );
      execution.dispose();
    } finally {
      journal.dispose();
    }
    assertCoordinatorIdle(store);
  });

  it("merges mixed loose and packed blobs without mutation or leaked reservations", async () => {
    const db = new TestDatabase();
    const database = new SqliteGitDatabase(db);
    const store = database.open(database.create("/repo", "ref: refs/heads/main"));
    const packedContents = {
      cleanBase: bytes("one\ncommon\nthree\n"),
      cleanIncoming: bytes("one\ncommon\nTHREE\n"),
      conflictBase: bytes("base\n"),
      conflictIncoming: bytes("incoming\n"),
    };
    const packedIdentities = {
      cleanBase: hashObject("blob", packedContents.cleanBase),
      cleanIncoming: hashObject("blob", packedContents.cleanIncoming),
      conflictBase: hashObject("blob", packedContents.conflictBase),
      conflictIncoming: hashObject("blob", packedContents.conflictIncoming),
    };
    const packChunks: Uint8Array[] = [];
    const writer = new PackWriter((chunk) => packChunks.push(chunk));
    writer.header(4);
    writer.object("blob", packedContents.cleanBase);
    writer.object("blob", packedContents.cleanIncoming);
    writer.object("blob", packedContents.conflictBase);
    writer.object("blob", packedContents.conflictIncoming);
    writer.finish();
    await store.packs.ingest(slices(concat(packChunks), 64));

    const current = writeTree(store, {
      "clean.txt": { content: "ONE\ncommon\nthree\n" },
      "conflict.txt": { content: "current\n" },
    });
    const base = writeIdentityTree(store, {
      "clean.txt": { mode: MODE_FILE, oid: packedIdentities.cleanBase },
      "conflict.txt": { mode: MODE_FILE, oid: packedIdentities.conflictBase },
    });
    const incoming = writeIdentityTree(store, {
      "clean.txt": { mode: MODE_FILE, oid: packedIdentities.cleanIncoming },
      "conflict.txt": { mode: MODE_FILE, oid: packedIdentities.conflictIncoming },
    });
    store.setRef("refs/heads/main", current.tree);

    expect(
      store.db.scalar<number>(
        `SELECT COUNT(*) FROM git_objects
         WHERE repo_id = 1 AND oid IN (?, ?, ?, ?)`,
        packedIdentities.cleanBase,
        packedIdentities.cleanIncoming,
        packedIdentities.conflictBase,
        packedIdentities.conflictIncoming,
      ),
    ).toBe(0);
    expect(
      store.db.scalar<number>(
        `SELECT COUNT(*) FROM git_pack_objects
         WHERE repo_id = 1 AND oid IN (?, ?, ?, ?)`,
        packedIdentities.cleanBase,
        packedIdentities.cleanIncoming,
        packedIdentities.conflictBase,
        packedIdentities.conflictIncoming,
      ),
    ).toBe(4);

    const coldDatabase = new SqliteGitDatabase(db);
    const repository = coldDatabase.find("/repo");
    if (repository === null) throw new Error("missing packed integration repository");
    const coldStore = coldDatabase.open(repository);
    const before = {
      objects: coldStore.objectCount(),
      refs: coldStore.listRefs(),
      index: coldStore.indexEntries(),
    };
    db.storage.resetCounters();
    const plan = planIntegration(new Repository(coldStore, "/repo"), {
      baseTreeOid: base.tree,
      currentTreeOid: current.tree,
      incomingTreeOid: incoming.tree,
      text: { labels: { current: "HEAD", incoming: "topic" } },
    });

    expect(plan.blobReadCalls).toBe(1);
    expect(plan.memoryHighWaterBytes).toBe(MAX_OPERATION_MEMORY_BYTES);
    expect(db.storage.statementCount).toBeLessThan(1_000);

    const clean = find(plan.entries, "clean.txt");
    expect(clean).toMatchObject({
      kind: "clean",
      before: current.files.get("clean.txt"),
      result: { mode: MODE_FILE },
    });
    if (clean.kind !== "clean" || clean.content === null) {
      throw new Error("expected packed/loose clean merge content");
    }
    expect(new TextDecoder().decode(clean.content)).toBe("ONE\ncommon\nTHREE\n");
    expect(clean.result?.oid).toBe(hashObject("blob", clean.content));

    const conflict = find(plan.entries, "conflict.txt");
    expect(conflict).toMatchObject({
      kind: "conflict",
      conflict: "content",
      conflicts: 1,
      stages: {
        base: base.files.get("conflict.txt"),
        current: current.files.get("conflict.txt"),
        incoming: incoming.files.get("conflict.txt"),
      },
    });
    if (conflict.kind !== "conflict" || conflict.content === null) {
      throw new Error("expected packed/loose conflict content");
    }
    expect(new TextDecoder().decode(conflict.content)).toBe(
      "<<<<<<< HEAD\ncurrent\n=======\nincoming\n>>>>>>> topic\n",
    );

    expect({
      objects: coldStore.objectCount(),
      refs: coldStore.listRefs(),
      index: coldStore.indexEntries(),
    }).toEqual(before);
    assertCoordinatorIdle(coldStore);
  });

  it("batches content reads and returns clean, text, binary, and structural results", () => {
    const db = new TestDatabase();
    const database = new SqliteGitDatabase(db);
    const store = database.open(database.create("/repo", "ref: refs/heads/main"));
    const base = writeTree(store, {
      "a.txt": { content: "one\ncommon\nthree\n" },
      "binary.bin": { content: new Uint8Array([0, 1]) },
      "conflict.txt": { content: "base\n" },
      "delete.txt": { content: "delete me\n" },
    });
    const current = writeTree(store, {
      "a.txt": { content: "ONE\ncommon\nthree\n" },
      "binary.bin": { content: new Uint8Array([0, 2]) },
      "conflict.txt": { content: "current\n" },
      "delete.txt": { content: "delete me\n" },
    });
    const incoming = writeTree(store, {
      "a.txt": { content: "one\ncommon\nTHREE\n" },
      "binary.bin": { content: new Uint8Array([0, 3]) },
      "conflict.txt": { content: "incoming\n" },
    });
    store.setRef("refs/heads/main", current.tree);
    const repo = new Repository(store, "/repo");
    const before = {
      objects: store.objectCount(),
      refs: store.listRefs(),
      index: store.indexEntries(),
    };
    db.storage.resetCounters();

    const plan = planIntegration(repo, {
      baseTreeOid: base.tree,
      currentTreeOid: current.tree,
      incomingTreeOid: incoming.tree,
      text: { labels: { current: "HEAD", incoming: "topic" } },
    });

    expect(plan.entries.map((entry) => entry.path)).toEqual([
      "a.txt",
      "binary.bin",
      "conflict.txt",
      "delete.txt",
    ]);
    expect(plan.blobReadCalls).toBe(1);
    expect(plan.memoryHighWaterBytes).toBe(MAX_OPERATION_MEMORY_BYTES);
    expect(db.storage.statementCount).toBe(9);

    const clean = find(plan.entries, "a.txt");
    expect(clean).toMatchObject({
      kind: "clean",
      before: current.files.get("a.txt"),
      result: { mode: MODE_FILE },
    });
    if (clean.kind !== "clean" || clean.content === null) {
      throw new Error("expected merged content");
    }
    expect(new TextDecoder().decode(clean.content)).toBe("ONE\ncommon\nTHREE\n");
    expect(clean.result?.oid).toBe(hashObject("blob", clean.content));

    const binary = find(plan.entries, "binary.bin");
    expect(binary).toMatchObject({
      kind: "conflict",
      conflict: "binary",
      stages: {
        base: base.files.get("binary.bin"),
        current: current.files.get("binary.bin"),
        incoming: incoming.files.get("binary.bin"),
      },
    });
    if (binary.kind !== "conflict") throw new Error("expected binary conflict");
    expect(binary.content).toEqual(new Uint8Array([0, 2]));

    const conflict = find(plan.entries, "conflict.txt");
    expect(conflict).toMatchObject({
      kind: "conflict",
      conflict: "content",
      conflicts: 1,
      stages: {
        base: base.files.get("conflict.txt"),
        current: current.files.get("conflict.txt"),
        incoming: incoming.files.get("conflict.txt"),
      },
    });
    if (conflict.kind !== "conflict" || conflict.content === null) {
      throw new Error("expected text conflict content");
    }
    expect(new TextDecoder().decode(conflict.content)).toContain("<<<<<<< HEAD\n");

    expect(find(plan.entries, "delete.txt")).toEqual({
      kind: "clean",
      path: "delete.txt",
      before: current.files.get("delete.txt"),
      result: null,
      content: null,
    });
    expect({
      objects: store.objectCount(),
      refs: store.listRefs(),
      index: store.indexEntries(),
    }).toEqual(before);
    assertCoordinatorIdle(store);
  });

  it("fails at the blob-read boundary without leaking its reservation or mutating state", () => {
    const database = new SqliteGitDatabase(new TestDatabase());
    const store = database.open(database.create("/repo", "ref: refs/heads/main"));
    const base = writeTree(store, { file: { content: "base\n" } });
    const current = writeTree(store, { file: { content: "current\n" } });
    const incoming = writeTree(store, { file: { content: "incoming\n" } });
    const repo = new Repository(store, "/repo");
    const before = {
      objects: store.objectCount(),
      refs: store.listRefs(),
      index: store.indexEntries(),
    };

    expect(() =>
      planIntegration(repo, {
        baseTreeOid: base.tree,
        currentTreeOid: current.tree,
        incomingTreeOid: incoming.tree,
        limits: { maxBlobReadCalls: 0 },
      }),
    ).toThrowError(expect.objectContaining({ code: "E2BIG" }));
    expect({
      objects: store.objectCount(),
      refs: store.listRefs(),
      index: store.indexEntries(),
    }).toEqual(before);
    assertCoordinatorIdle(store);
  });

  it("fails closed on missing and wrong-type candidate objects", () => {
    const database = new SqliteGitDatabase(new TestDatabase());
    const store = database.open(database.create("/repo", "ref: refs/heads/main"));
    const current = writeTree(store, { file: { content: "current\n" } });
    const incoming = writeTree(store, { file: { content: "incoming\n" } });
    const missing = writeIdentityTree(store, {
      file: { mode: MODE_FILE, oid: "ffffffffffffffffffffffffffffffffffffffff" },
    });
    const wrongTypeOid = store.write("tree", serializeTree([]));
    const wrongType = writeIdentityTree(store, {
      file: { mode: MODE_FILE, oid: wrongTypeOid },
    });
    const repo = new Repository(store, "/repo");
    const before = {
      objects: store.objectCount(),
      refs: store.listRefs(),
      index: store.indexEntries(),
    };

    expect(() =>
      planIntegration(repo, {
        baseTreeOid: missing.tree,
        currentTreeOid: current.tree,
        incomingTreeOid: incoming.tree,
      }),
    ).toThrowError(expect.objectContaining({ code: "ENOTFOUND" }));
    assertCoordinatorIdle(store);
    expect(() =>
      planIntegration(repo, {
        baseTreeOid: wrongType.tree,
        currentTreeOid: current.tree,
        incomingTreeOid: incoming.tree,
      }),
    ).toThrowError(expect.objectContaining({ code: "ECORRUPT" }));
    expect({
      objects: store.objectCount(),
      refs: store.listRefs(),
      index: store.indexEntries(),
    }).toEqual(before);
    assertCoordinatorIdle(store);
  });

  it("rejects candidate bytes that do not match their object id", () => {
    const db = new TestDatabase();
    const database = new SqliteGitDatabase(db);
    const store = database.open(database.create("/repo", "ref: refs/heads/main"));
    const base = writeTree(store, { file: { content: "base\n" } });
    const current = writeTree(store, { file: { content: "current\n" } });
    const incoming = writeTree(store, { file: { content: "incoming\n" } });
    const currentIdentity = current.files.get("file");
    if (currentIdentity === undefined) throw new Error("missing current identity");
    const corrupt = bytes("corrupt\n");
    store.db.run(
      "UPDATE git_object_chunks SET data = ? WHERE repo_id = ? AND oid = ?",
      corrupt,
      1,
      currentIdentity.oid,
    );
    const coldDatabase = new SqliteGitDatabase(db);
    const repository = coldDatabase.find("/repo");
    if (repository === null) throw new Error("missing corrupt integration repository");
    const coldStore = coldDatabase.open(repository);

    expect(() =>
      planIntegration(new Repository(coldStore, "/repo"), {
        baseTreeOid: base.tree,
        currentTreeOid: current.tree,
        incomingTreeOid: incoming.tree,
      }),
    ).toThrowError(expect.objectContaining({ code: "ECORRUPT" }));
    expect(
      coldStore.db.scalar<Uint8Array>(
        "SELECT data FROM git_object_chunks WHERE repo_id = ? AND oid = ? AND seq = 0",
        1,
        currentIdentity.oid,
      ),
    ).toEqual(corrupt);
    assertCoordinatorIdle(coldStore);
  });

  it("rejects limits that try to raise a hard ceiling", () => {
    const database = new SqliteGitDatabase(new TestDatabase());
    const store = database.open(database.create("/repo", "ref: refs/heads/main"));
    const repo = new Repository(store, "/repo");
    expect(() =>
      planIntegration(repo, {
        baseTreeOid: null,
        currentTreeOid: null,
        incomingTreeOid: null,
        limits: { maxEntries: 1_001 },
      }),
    ).toThrow(RangeError);
  });

  it("uses a stable error code when the retained plan limit is crossed", () => {
    const database = new SqliteGitDatabase(new TestDatabase());
    const store = database.open(database.create("/repo", "ref: refs/heads/main"));
    const base = writeTree(store, { file: { content: "base\n" } });
    const current = writeTree(store, { file: { content: "current\n" } });
    const incoming = writeTree(store, { file: { content: "incoming\n" } });
    const repo = new Repository(store, "/repo");

    try {
      planIntegration(repo, {
        baseTreeOid: base.tree,
        currentTreeOid: current.tree,
        incomingTreeOid: incoming.tree,
        limits: { maxPlanBytes: 0 },
      });
      throw new Error("expected the integration plan limit to reject content");
    } catch (error) {
      expect(hasErrorCode(error, "E2BIG")).toBe(true);
    }
    assertCoordinatorIdle(store);
  });

  it("caps text output before merge allocation and binary content before retention", () => {
    const database = new SqliteGitDatabase(new TestDatabase());
    const store = database.open(database.create("/repo", "ref: refs/heads/main"));
    const base = writeTree(store, {
      binary: { content: new Uint8Array([0, 1]) },
      text: { content: "base\n" },
    });
    const current = writeTree(store, {
      binary: { content: new Uint8Array([0, ...Array.from({ length: 31 }, () => 2)]) },
      text: { content: "current contents\n" },
    });
    const incoming = writeTree(store, {
      binary: { content: new Uint8Array([0, 3]) },
      text: { content: "incoming contents\n" },
    });
    const repo = new Repository(store, "/repo");

    expect(() =>
      planIntegration(repo, {
        baseTreeOid: base.tree,
        currentTreeOid: current.tree,
        incomingTreeOid: incoming.tree,
        limits: { maxPlanBytes: 600 },
      }),
    ).toThrowError(expect.objectContaining({ code: "E2BIG" }));
    assertCoordinatorIdle(store);

    const textBase = writeTree(store, { text: { content: "base\n" } });
    const textCurrent = writeTree(store, { text: { content: "current contents\n" } });
    const textIncoming = writeTree(store, { text: { content: "incoming contents\n" } });
    expect(() =>
      planIntegration(repo, {
        baseTreeOid: textBase.tree,
        currentTreeOid: textCurrent.tree,
        incomingTreeOid: textIncoming.tree,
        limits: { maxPlanBytes: 600 },
      }),
    ).toThrowError(expect.objectContaining({ code: "E2BIG" }));
    assertCoordinatorIdle(store);
  });

  it("does not hide a text output limit above the xmerge hard ceiling", () => {
    const database = new SqliteGitDatabase(new TestDatabase());
    const store = database.open(database.create("/repo", "ref: refs/heads/main"));
    const base = writeTree(store, { file: { content: "base\n" } });
    const current = writeTree(store, { file: { content: "current\n" } });
    const incoming = writeTree(store, { file: { content: "incoming\n" } });

    expect(() =>
      planIntegration(new Repository(store, "/repo"), {
        baseTreeOid: base.tree,
        currentTreeOid: current.tree,
        incomingTreeOid: incoming.tree,
        text: {
          limits: { maxOutputBytes: DEFAULT_TEXT_MERGE_LIMITS.maxOutputBytes + 1 },
        },
      }),
    ).toThrowError(expect.objectContaining({ code: "EINVAL" }));
    assertCoordinatorIdle(store);
  });
});
