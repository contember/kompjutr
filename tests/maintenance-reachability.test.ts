import { describe, expect, it } from "vitest";
import type { SqlDatabase } from "../src/db/db.js";
import { concat, utf8 } from "../src/git/common/bytes.js";
import {
  hashObject,
  MODE_COMMIT,
  MODE_FILE,
  type ObjectType,
  serializeCommit,
  serializeTag,
  serializeTree,
} from "../src/git/common/objects.js";
import { deflate } from "../src/git/common/zlib.js";
import { SqliteGitDatabase } from "../src/git/store/index.js";
import { advanceMaintenanceReachability } from "../src/git/store/maintenance/reachability.js";
import { encodeDeltaHeader } from "../src/git/store/pack/delta.js";
import { PackWriter } from "../src/git/store/pack/writer.js";
import { TestDatabase } from "./helpers/db.js";
import { slices } from "./helpers/git.js";

const PERSON = {
  name: "Reachability Fixture",
  email: "fixture@example.com",
  timestamp: 1_700_000_000,
  timezoneOffset: 0,
};

function open(db = new TestDatabase()) {
  const database = new SqliteGitDatabase(db, { objectCacheBytes: 16 * 1024 * 1024 });
  const checkout = database.createRepository("/repo", "ref: refs/heads/main");
  const store = database.openCheckout(checkout);
  return { db, database, checkout, store };
}

type ReachabilityFailure = "sql" | "source" | "parser" | "publication";

class FailingReachabilityDatabase implements SqlDatabase {
  failure: ReachabilityFailure | null = null;
  activeHeaderIterators = 0;
  closedHeaderIterators = 0;

  constructor(readonly inner: TestDatabase) {}

  run(query: string, ...bindings: unknown[]): void {
    if (this.failure === "publication" && query.includes("INSERT INTO git_maintenance_objects")) {
      this.failure = null;
      throw new Error("injected reachability publication failure");
    }
    this.inner.run(query, ...bindings);
  }

  all<Row extends object>(query: string, ...bindings: unknown[]): Row[] {
    return this.inner.all<Row>(query, ...bindings);
  }

  one<Row extends object>(query: string, ...bindings: unknown[]): Row | undefined {
    return this.inner.one<Row>(query, ...bindings);
  }

  scalar<T>(query: string, ...bindings: unknown[]): T | undefined {
    return this.inner.scalar<T>(query, ...bindings);
  }

  iterate(query: string, ...bindings: unknown[]): Iterable<Record<string, unknown>> {
    if (!query.includes("maintenance-loose-headers")) {
      return this.inner.iterate(query, ...bindings);
    }
    if (this.failure === "sql") {
      this.failure = null;
      throw new Error("injected reachability SQL failure");
    }
    const source = this.inner.iterate(query, ...bindings);
    const owner = this;
    return {
      [Symbol.iterator](): IterableIterator<Record<string, unknown>> {
        const iterator = source[Symbol.iterator]();
        let finished = false;
        let rows = 0;
        owner.activeHeaderIterators++;
        const close = (): void => {
          if (finished) return;
          finished = true;
          owner.activeHeaderIterators--;
          owner.closedHeaderIterators++;
        };
        const wrapped: IterableIterator<Record<string, unknown>> = {
          [Symbol.iterator]: () => wrapped,
          next(): IteratorResult<Record<string, unknown>> {
            const next = iterator.next();
            if (next.done) {
              close();
              return next;
            }
            rows++;
            if (rows === 2 && owner.failure === "source") {
              owner.failure = null;
              iterator.return?.();
              close();
              throw new Error("injected reachability source failure");
            }
            if (rows === 2 && owner.failure === "parser") {
              owner.failure = null;
              const value = next.value.data;
              const data =
                value instanceof Uint8Array
                  ? value
                  : value instanceof ArrayBuffer
                    ? new Uint8Array(value)
                    : null;
              if (data === null) throw new Error("parser fixture did not receive a BLOB");
              const malformed = data.slice();
              const corruptAt = Math.floor(malformed.length / 2);
              const byte = malformed[corruptAt];
              if (byte === undefined) throw new Error("parser fixture received an empty BLOB");
              malformed[corruptAt] = byte ^ 0xff;
              return { done: false, value: { ...next.value, data: malformed } };
            }
            return next;
          },
          return(): IteratorResult<Record<string, unknown>> {
            iterator.return?.();
            close();
            return { done: true, value: undefined };
          },
        };
        return wrapped;
      },
    };
  }

  transactionSync<T>(closure: () => T): T {
    return this.inner.transactionSync(closure);
  }
}

function seedMark(
  db: TestDatabase,
  repoId: number,
  roots: readonly { oid: string; shallow?: boolean }[],
): void {
  db.run(
    `INSERT OR IGNORE INTO git_maintenance_control (repo_id, root_epoch, next_run_id)
     VALUES (?, 0, 2)`,
    repoId,
  );
  db.run(
    `INSERT INTO git_maintenance_runs
       (repo_id, run_id, observed_root_epoch, phase, started_ms, root_source,
        reachable_objects, queued_objects)
     VALUES (?, 1, 0, 'mark', 1, 'done', 0, ?)`,
    repoId,
    roots.length,
  );
  for (const root of roots) {
    db.run(
      `INSERT INTO git_maintenance_objects
         (repo_id, run_id, oid, source_mask, expanded, shallow_boundary,
          physical_only, edge_cursor)
       VALUES (?, 1, ?, 1, 0, ?, 0, 0)`,
      repoId,
      root.oid,
      root.shallow === true ? 1 : 0,
    );
    if (root.shallow === true) {
      db.run(
        `INSERT INTO git_maintenance_shallow (repo_id, run_id, oid)
         VALUES (?, 1, ?)`,
        repoId,
        root.oid,
      );
    }
  }
}

function promiseBlob(db: TestDatabase, repoId: number, oid: string): void {
  db.run(
    `INSERT INTO git_promisor_remotes (repo_id, remote_name, url, filter)
     VALUES (?, 'origin', 'https://example.com/repo.git', 'blob:none')`,
    repoId,
  );
  db.run(
    `INSERT INTO git_promised_blobs (repo_id, oid, remote_name, type)
     VALUES (?, ?, 'origin', 'blob')`,
    repoId,
    oid,
  );
}

function commit(tree: string, parent: string[] = [], message = "fixture\n"): Uint8Array {
  return serializeCommit({
    tree,
    parent,
    author: PERSON,
    committer: PERSON,
    message,
  });
}

function marks(db: TestDatabase, repoId: number) {
  return db.all<{
    oid: string;
    expanded: number;
    physical_only: number;
    edge_cursor: number;
  }>(
    `SELECT oid, expanded, physical_only, edge_cursor
       FROM git_maintenance_objects WHERE repo_id = ? ORDER BY oid`,
    repoId,
  );
}

function drain(
  db: TestDatabase,
  shared: ReturnType<typeof open>["store"]["shared"],
  limit = 10_000,
): void {
  for (let call = 0; call < limit; call++) {
    db.storage.resetCounters();
    const progress = advanceMaintenanceReachability(shared);
    expect(db.storage.statementCount).toBeLessThan(1_000);
    if (progress.status === "complete") return;
  }
  throw new Error("reachability did not complete within the test bound");
}

function literalDelta(baseSize: number, target: Uint8Array): Uint8Array {
  const chunks = [encodeDeltaHeader(baseSize, target.length)];
  for (let offset = 0; offset < target.length; offset += 127) {
    const part = target.subarray(offset, offset + 127);
    chunks.push(new Uint8Array([part.length]), part);
  }
  return concat(chunks);
}

function packedDelta(
  type: ObjectType,
  base: Uint8Array,
  target: Uint8Array,
): { bytes: Uint8Array; baseOid: string; targetOid: string } {
  const chunks: Uint8Array[] = [];
  const writer = new PackWriter((chunk) => chunks.push(chunk));
  const baseOid = hashObject(type, base);
  writer.header(2);
  writer.object(type, base);
  writer.refDelta(baseOid, literalDelta(base.length, target));
  writer.finish();
  return { bytes: concat(chunks), baseOid, targetOid: hashObject(type, target) };
}

function fullBlobPack(values: readonly Uint8Array[]): Uint8Array {
  const chunks: Uint8Array[] = [];
  const writer = new PackWriter((chunk) => chunks.push(chunk));
  writer.header(values.length);
  for (const value of values) writer.object("blob", value);
  writer.finish();
  return concat(chunks);
}

function fullObjectPack(type: ObjectType, value: Uint8Array): Uint8Array {
  const chunks: Uint8Array[] = [];
  const writer = new PackWriter((chunk) => chunks.push(chunk));
  writer.header(1);
  writer.object(type, value);
  writer.finish();
  return concat(chunks);
}

const FORMER_HEADER_OBJECT_BYTES = 48 * 1024 * 1024;
const LARGE_HEADER_OBJECT_BYTES = FORMER_HEADER_OBJECT_BYTES + 64 * 1024;

function deterministicIncompressibleBytes(size: number, prefix: Uint8Array): Uint8Array {
  if (prefix.length > size) throw new Error("deterministic fixture prefix exceeds its size");
  const data = new Uint8Array(size);
  const words = new Uint32Array(data.buffer, 0, Math.floor(size / 4));
  let state = 0x9e3779b9;
  for (let index = 0; index < words.length; index++) {
    state ^= state << 13;
    state ^= state >>> 17;
    state ^= state << 5;
    words[index] = state;
  }
  data.set(prefix);
  return data;
}

function installLargeLooseHeader(
  db: TestDatabase,
  repoId: number,
  type: "commit" | "tag",
  prefix: string,
  size = LARGE_HEADER_OBJECT_BYTES,
): string {
  const start = utf8.encode(`${prefix}\n\n`);
  const data = deterministicIncompressibleBytes(size, start);
  const oid = hashObject(type, data);
  const compressed = deflate(data);
  db.run(
    "INSERT INTO git_objects (repo_id, oid, type, size, stored) VALUES (?, ?, ?, ?, 'zlib')",
    repoId,
    oid,
    type,
    size,
  );
  let seq = 0;
  for (let offset = 0; offset < compressed.length; offset += 1024 * 1024) {
    db.run(
      "INSERT INTO git_object_chunks (repo_id, oid, seq, data) VALUES (?, ?, ?, ?)",
      repoId,
      oid,
      seq++,
      compressed.subarray(offset, offset + 1024 * 1024),
    );
  }
  return oid;
}

describe("maintenance reachability", () => {
  it("marks the direct tag, commit, tree, blob, and gitlink closure", () => {
    const { db, checkout, store } = open();
    const blob = store.write("blob", utf8.encode("file\n"));
    const gitlinkTree = store.write("tree", serializeTree([]));
    const gitlinkCommit = store.write("commit", commit(gitlinkTree, [], "gitlink\n"));
    const missingGitlink = "f".repeat(40);
    const tree = store.write(
      "tree",
      serializeTree([
        { mode: MODE_FILE, name: "file", oid: blob },
        { mode: MODE_COMMIT, name: "missing", oid: missingGitlink },
        { mode: MODE_COMMIT, name: "present", oid: gitlinkCommit },
      ]),
    );
    const commitOid = store.write("commit", commit(tree));
    const tag = store.write(
      "tag",
      serializeTag({ object: commitOid, type: "commit", tag: "v1", message: "release\n" }),
    );
    seedMark(db, checkout.repoId, [{ oid: tag }]);

    drain(db, store.shared);

    const reachable = new Set(marks(db, checkout.repoId).map((row) => row.oid));
    expect(reachable).toEqual(new Set([tag, commitOid, tree, blob, gitlinkCommit, gitlinkTree]));
    expect(reachable.has(missingGitlink)).toBe(false);
    expect(
      db.one<{ phase: string; queued_objects: number; reachable_objects: number }>(
        `SELECT phase, queued_objects, reachable_objects
           FROM git_maintenance_runs WHERE repo_id = ?`,
        checkout.repoId,
      ),
    ).toEqual({ phase: "classify-loose", queued_objects: 0, reachable_objects: 6 });
  });

  it("pages more than 256 commit parents and persists the exact cursor", () => {
    const { db, checkout, store } = open();
    const tree = store.write("tree", serializeTree([]));
    const parents: string[] = [];
    for (let index = 0; index < 300; index++) {
      parents.push(store.write("commit", commit(tree, [], `parent ${index}\n`)));
    }
    const root = store.write("commit", commit(tree, parents, "octopus\n"));
    seedMark(db, checkout.repoId, [{ oid: root }]);
    db.storage.histogram = new Map();
    db.storage.resetCounters();

    const progress = advanceMaintenanceReachability(store.shared);

    expect(progress).toMatchObject({
      status: "progress",
      processedOid: root,
      discoveredObjects: 256,
      discoveredLogicalObjects: 256,
    });
    expect(db.storage.statementCount).toBeLessThan(1_000);
    expect([...db.storage.histogram.keys()].join("\n")).toContain("maintenance-loose-headers");
    expect(
      db.one<{ expanded: number; edge_cursor: number }>(
        `SELECT expanded, edge_cursor FROM git_maintenance_objects
          WHERE repo_id = ? AND run_id = 1 AND oid = ?`,
        checkout.repoId,
        root,
      ),
    ).toEqual({ expanded: 0, edge_cursor: 256 });
    expect(
      db.one<{ queued_objects: number; reachable_objects: number }>(
        "SELECT queued_objects, reachable_objects FROM git_maintenance_runs WHERE repo_id = ?",
        checkout.repoId,
      ),
    ).toEqual({ queued_objects: 257, reachable_objects: 257 });
  });

  it("retains a shallow commit tree and stops all parent edges", () => {
    const { db, checkout, store } = open();
    const parentTree = store.write("tree", serializeTree([]));
    const parent = store.write("commit", commit(parentTree, [], "parent\n"));
    const shallowTree = store.write("tree", serializeTree([]));
    const shallow = store.write("commit", commit(shallowTree, [parent], "shallow\n"));
    seedMark(db, checkout.repoId, [{ oid: shallow, shallow: true }]);

    drain(db, store.shared);

    const reachable = new Set(marks(db, checkout.repoId).map((row) => row.oid));
    expect(reachable).toEqual(new Set([shallow, shallowTree]));
    expect(reachable.has(parent)).toBe(false);
  });

  it("pages direct tree entries and resumes after a cold reopen", () => {
    const { db, checkout, store } = open();
    const entries: { mode: string; name: string; oid: string }[] = [];
    for (let index = 0; index < 300; index++) {
      const oid = store.write("blob", utf8.encode(`blob ${index}\n`));
      entries.push({ mode: MODE_FILE, name: `file-${String(index).padStart(3, "0")}`, oid });
    }
    const tree = store.write("tree", serializeTree(entries));
    seedMark(db, checkout.repoId, [{ oid: tree }]);
    db.storage.resetCounters();

    const first = advanceMaintenanceReachability(store.shared);
    expect(first).toMatchObject({ processedOid: tree, discoveredObjects: 256 });
    expect(db.storage.statementCount).toBeLessThan(1_000);
    expect(
      db.scalar<number>(
        `SELECT edge_cursor FROM git_maintenance_objects
          WHERE repo_id = ? AND run_id = 1 AND oid = ?`,
        checkout.repoId,
        tree,
      ),
    ).toBe(256);
    db.run(
      `UPDATE git_maintenance_objects SET expanded = 1
        WHERE repo_id = ? AND run_id = 1 AND oid != ?`,
      checkout.repoId,
      tree,
    );
    db.run("UPDATE git_maintenance_runs SET queued_objects = 1 WHERE repo_id = ?", checkout.repoId);
    const reopened = new SqliteGitDatabase(db, { objectCacheBytes: 16 * 1024 * 1024 });
    const cold = reopened.openCheckout(checkout.id);

    const second = advanceMaintenanceReachability(cold.shared);

    expect(second).toMatchObject({ processedOid: tree, discoveredObjects: 44 });
    expect(
      db.one<{ expanded: number; edge_cursor: number }>(
        `SELECT expanded, edge_cursor FROM git_maintenance_objects
          WHERE repo_id = ? AND run_id = 1 AND oid = ?`,
        checkout.repoId,
        tree,
      ),
    ).toEqual({ expanded: 1, edge_cursor: 300 });
  });

  it("accepts the former tree-name excess in one edge page", () => {
    const fixture = () => {
      const { db, checkout, store } = open();
      const target = store.write("blob", utf8.encode("owned\n"));
      const tree = store.write(
        "tree",
        serializeTree([{ mode: MODE_FILE, name: "n".repeat(2_201), oid: target }]),
      );
      seedMark(db, checkout.repoId, [{ oid: tree }]);
      const reopened = new SqliteGitDatabase(db, { objectCacheBytes: 16 * 1024 * 1024 });
      return { db, shared: reopened.openCheckout(checkout.id).shared, tree };
    };

    const current = fixture();
    expect(advanceMaintenanceReachability(current.shared)).toMatchObject({
      processedOid: current.tree,
      discoveredObjects: 1,
    });
  });

  it("streams large unknown and continuation tag headers without retaining the message", () => {
    const { db, checkout, store } = open();
    const target = store.write("blob", utf8.encode("target\n"));
    const header = `object ${target}\ntype blob\ntag large\nx ${"a".repeat(2 * 1024 * 1024)}\n ${"b".repeat(
      1024 * 1024,
    )}\n\n`;
    const tag = store.write("tag", concat([utf8.encode(header), new Uint8Array(2 * 1024 * 1024)]));
    seedMark(db, checkout.repoId, [{ oid: tag }]);
    const reopened = new SqliteGitDatabase(db, { objectCacheBytes: 16 * 1024 * 1024 });
    const cold = reopened.openCheckout(checkout.id);
    db.storage.resetCounters();

    const progress = advanceMaintenanceReachability(cold.shared);

    expect(progress).toMatchObject({
      processedOid: tag,
      discoveredObjects: 1,
      discoveredLogicalObjects: 1,
    });
    expect(db.storage.statementCount).toBeLessThan(1_000);
    expect(marks(db, checkout.repoId).map((row) => row.oid)).toContain(target);
  });

  describe("WU6g reachability ownership", () => {
    it("streams valid loose commit and tag headers beyond 48 MiB with bounded live memory", () => {
      const { db, checkout, store } = open();
      const tree = store.write("tree", serializeTree([]));
      const target = store.write("blob", utf8.encode("large tag target\n"));
      const identity = "Reachability Fixture <fixture@example.com> 1700000000 +0000";
      const commitOid = installLargeLooseHeader(
        db,
        checkout.repoId,
        "commit",
        `tree ${tree}\nauthor ${identity}\ncommitter ${identity}\nx `,
      );
      const tagOid = installLargeLooseHeader(
        db,
        checkout.repoId,
        "tag",
        `object ${target}\ntype blob\ntag large\ntagger ${identity}\nx `,
      );
      const chunkCounts = db.all<{ chunks: number }>(
        `SELECT count(*) AS chunks FROM git_object_chunks
          WHERE repo_id = ? AND oid IN (?, ?) GROUP BY oid`,
        checkout.repoId,
        commitOid,
        tagOid,
      );
      expect(chunkCounts).toHaveLength(2);
      expect(chunkCounts.every((row) => row.chunks > 1)).toBe(true);
      seedMark(db, checkout.repoId, [{ oid: commitOid }, { oid: tagOid }]);
      const reopened = new SqliteGitDatabase(db, { objectCacheBytes: 0, chunkBytes: 0 });
      const cold = reopened.openCheckout(checkout.id);

      for (let call = 0; call < 8; call++) {
        advanceMaintenanceReachability(cold.shared);
        const expanded = db.scalar<number>(
          `SELECT count(*) FROM git_maintenance_objects
            WHERE repo_id = ? AND oid IN (?, ?) AND expanded = 1`,
          checkout.repoId,
          commitOid,
          tagOid,
        );
        if (expanded === 2) break;
      }

      const reached = new Set(marks(db, checkout.repoId).map((row) => row.oid));
      expect(reached.has(tree)).toBe(true);
      expect(reached.has(target)).toBe(true);
      expect(
        db.scalar<number>(
          `SELECT count(*) FROM git_maintenance_objects
            WHERE repo_id = ? AND oid IN (?, ?) AND expanded = 1`,
          checkout.repoId,
          commitOid,
          tagOid,
        ),
      ).toBe(2);

      const last = db.one<{ seq: number; data: unknown }>(
        `SELECT seq, data FROM git_object_chunks
          WHERE repo_id = ? AND oid = ? ORDER BY seq DESC LIMIT 1`,
        checkout.repoId,
        commitOid,
      );
      if (last === undefined) throw new Error("large commit has no final storage chunk");
      const finalChunk =
        last.data instanceof Uint8Array
          ? last.data
          : last.data instanceof ArrayBuffer
            ? new Uint8Array(last.data)
            : null;
      if (finalChunk === null || finalChunk.length === 0) {
        throw new Error("large commit final storage chunk is empty");
      }
      db.run("DELETE FROM git_maintenance_runs WHERE repo_id = ?", checkout.repoId);
      db.run(
        `UPDATE git_object_chunks SET data = substr(data, 1, length(data) - 1)
          WHERE repo_id = ? AND oid = ? AND seq = ?`,
        checkout.repoId,
        commitOid,
        last.seq,
      );
      seedMark(db, checkout.repoId, [{ oid: commitOid }]);

      expect(() => advanceMaintenanceReachability(cold.shared)).toThrowError(
        expect.objectContaining({ code: "ECORRUPT" }),
      );
      expect(
        db.scalar<number>(
          "SELECT expanded FROM git_maintenance_objects WHERE repo_id = ? AND oid = ?",
          checkout.repoId,
          commitOid,
        ),
      ).toBe(0);

      db.run(
        "UPDATE git_object_chunks SET data = ? WHERE repo_id = ? AND oid = ? AND seq = ?",
        finalChunk,
        checkout.repoId,
        commitOid,
        last.seq,
      );
      expect(advanceMaintenanceReachability(cold.shared)).toMatchObject({
        processedOid: commitOid,
        discoveredLogicalObjects: 1,
      });

      db.run("DELETE FROM git_maintenance_runs WHERE repo_id = ?", checkout.repoId);
      const malformedOid = installLargeLooseHeader(
        db,
        checkout.repoId,
        "commit",
        `tree ${"z".repeat(40)}\nauthor ${identity}\ncommitter ${identity}\nx `,
        3 * 1024 * 1024,
      );
      seedMark(db, checkout.repoId, [{ oid: malformedOid }]);
      expect(() => advanceMaintenanceReachability(cold.shared)).toThrowError(
        expect.objectContaining({
          code: "ECORRUPT",
          message: expect.stringContaining("malformed tree oid"),
        }),
      );
      expect(
        db.scalar<number>(
          "SELECT expanded FROM git_maintenance_objects WHERE repo_id = ? AND oid = ?",
          checkout.repoId,
          malformedOid,
        ),
      ).toBe(0);
    });

    it("releases ownership and restarts after SQL, source, parser, and publication failures", () => {
      const failures: readonly ReachabilityFailure[] = ["sql", "source", "parser", "publication"];
      for (const failure of failures) {
        const inner = new TestDatabase();
        const failing = new FailingReachabilityDatabase(inner);
        const database = new SqliteGitDatabase(failing, { objectCacheBytes: 0, chunkBytes: 0 });
        const checkout = database.createRepository("/repo", "ref: refs/heads/main");
        const store = database.openCheckout(checkout);
        const tree = store.write("tree", serializeTree([]));
        const root =
          failure === "source" || failure === "parser"
            ? installLargeLooseHeader(
                inner,
                checkout.repoId,
                "commit",
                `tree ${tree}`,
                3 * 1024 * 1024,
              )
            : store.write("commit", commit(tree));
        seedMark(inner, checkout.repoId, [{ oid: root }]);
        failing.failure = failure;

        expect(() => advanceMaintenanceReachability(store.shared)).toThrow();
        expect(failing.activeHeaderIterators).toBe(0);
        expect(
          inner.one<{ expanded: number; reachable_objects: number; queued_objects: number }>(
            `SELECT object.expanded, run.reachable_objects, run.queued_objects
               FROM git_maintenance_objects object
               JOIN git_maintenance_runs run
                 ON run.repo_id = object.repo_id AND run.run_id = object.run_id
              WHERE object.repo_id = ? AND object.oid = ?`,
            checkout.repoId,
            root,
          ),
        ).toEqual({ expanded: 0, reachable_objects: 0, queued_objects: 1 });

        expect(advanceMaintenanceReachability(store.shared)).toMatchObject({
          processedOid: root,
          discoveredLogicalObjects: 1,
        });
        expect(failing.activeHeaderIterators).toBe(0);
        expect(failing.closedHeaderIterators).toBeGreaterThan(0);
      }
    });

    it("fails a corrupt loose commit shadow instead of reading its valid packed copy", async () => {
      const { db, checkout, store } = open();
      const tree = store.write("tree", serializeTree([]));
      const packedBytes = commit(tree);
      const oid = hashObject("commit", packedBytes);
      await store.packs.ingest(slices(fullObjectPack("commit", packedBytes), 17));
      const corrupt = utf8.encode(`tree ${"z".repeat(40)}\n\n`);
      db.run(
        "INSERT INTO git_objects (repo_id, oid, type, size, stored) VALUES (?, ?, 'commit', ?, 'raw')",
        checkout.repoId,
        oid,
        corrupt.length,
      );
      db.run(
        "INSERT INTO git_object_chunks (repo_id, oid, seq, data) VALUES (?, ?, 0, ?)",
        checkout.repoId,
        oid,
        corrupt,
      );
      seedMark(db, checkout.repoId, [{ oid }]);
      db.storage.histogram = new Map();

      expect(() => advanceMaintenanceReachability(store.shared)).toThrowError(
        expect.objectContaining({
          code: "ECORRUPT",
          message: expect.stringContaining("malformed tree oid"),
        }),
      );
      const queries = [...db.storage.histogram.keys()].join("\n");
      expect(queries).toContain("maintenance-loose-headers");
      expect(queries).not.toContain("git_pack_data");
      expect(
        db.scalar<number>(
          "SELECT expanded FROM git_maintenance_objects WHERE repo_id = ? AND oid = ?",
          checkout.repoId,
          oid,
        ),
      ).toBe(0);
    });
  });

  it("promotes an expanded physical mark to logical exactly once and requeues it", () => {
    const { db, checkout, store } = open();
    const target = store.write("blob", utf8.encode("promoted\n"));
    const tag = store.write(
      "tag",
      serializeTag({ object: target, type: "blob", tag: "promote", message: "\n" }),
    );
    seedMark(db, checkout.repoId, [{ oid: tag }]);
    db.run(
      `INSERT INTO git_maintenance_objects
         (repo_id, run_id, oid, source_mask, expanded, shallow_boundary,
          physical_only, edge_cursor)
       VALUES (?, 1, ?, 0, 1, 0, 1, 0)`,
      checkout.repoId,
      target,
    );
    db.run(
      "UPDATE git_maintenance_runs SET reachable_objects = 1 WHERE repo_id = ?",
      checkout.repoId,
    );

    const progress = advanceMaintenanceReachability(store.shared);

    expect(progress).toMatchObject({
      processedOid: tag,
      discoveredObjects: 0,
      discoveredLogicalObjects: 1,
    });
    expect(
      db.one<{ expanded: number; physical_only: number; edge_cursor: number }>(
        `SELECT expanded, physical_only, edge_cursor FROM git_maintenance_objects
          WHERE repo_id = ? AND run_id = 1 AND oid = ?`,
        checkout.repoId,
        target,
      ),
    ).toEqual({ expanded: 0, physical_only: 0, edge_cursor: 0 });
    expect(
      db.one<{ queued_objects: number; reachable_objects: number }>(
        "SELECT queued_objects, reachable_objects FROM git_maintenance_runs WHERE repo_id = ?",
        checkout.repoId,
      ),
    ).toEqual({ queued_objects: 1, reachable_objects: 2 });
  });

  it("marks exact packed delta bases as physical without expanding semantic bytes", async () => {
    const { db, checkout, store } = open();
    const base = utf8.encode("base blob\n");
    const target = utf8.encode("target blob\n");
    const pack = packedDelta("blob", base, target);
    await store.packs.ingest(slices(pack.bytes, 17));
    seedMark(db, checkout.repoId, [{ oid: pack.targetOid }]);

    const logical = advanceMaintenanceReachability(store.shared);
    expect(logical).toMatchObject({ processedOid: pack.targetOid, discoveredObjects: 1 });
    expect(
      db.one<{ physical_only: number; expanded: number }>(
        `SELECT physical_only, expanded FROM git_maintenance_objects
          WHERE repo_id = ? AND run_id = 1 AND oid = ?`,
        checkout.repoId,
        pack.baseOid,
      ),
    ).toEqual({ physical_only: 1, expanded: 0 });

    const physical = advanceMaintenanceReachability(store.shared);
    expect(physical).toMatchObject({
      processedOid: pack.baseOid,
      discoveredLogicalObjects: 0,
    });
    expect(
      db.scalar<number>(
        `SELECT physical_only FROM git_maintenance_objects
          WHERE repo_id = ? AND run_id = 1 AND oid = ?`,
        checkout.repoId,
        pack.baseOid,
      ),
    ).toBe(1);
  });

  it("rejects self, two-node, and longer complete-pack delta cycles in one bounded query", async () => {
    for (const links of [[0], [1, 0], [1, 2, 0]]) {
      const { db, checkout, store } = open();
      const values = links.map((_, index) => utf8.encode(`cycle ${links.length} ${index}\n`));
      const oids = values.map((value) => hashObject("blob", value));
      await store.packs.ingest(slices(fullBlobPack(values), 17));
      for (let index = 0; index < links.length; index++) {
        const baseIndex = links[index];
        const oid = oids[index];
        const baseOid = baseIndex === undefined ? undefined : oids[baseIndex];
        if (oid === undefined || baseOid === undefined) throw new Error("cycle fixture is invalid");
        db.run(
          "UPDATE git_pack_objects SET base_oid = ? WHERE repo_id = ? AND oid = ?",
          baseOid,
          checkout.repoId,
          oid,
        );
      }
      const root = oids[0];
      if (root === undefined) throw new Error("cycle fixture has no root");
      seedMark(db, checkout.repoId, [{ oid: root }]);
      db.storage.histogram = new Map();

      expect(() => advanceMaintenanceReachability(store.shared)).toThrow(/contains a cycle/);
      const chainQueries = [...db.storage.histogram.entries()].filter(([query]) =>
        query.includes("maintenance-pack-chain"),
      );
      expect(chainQueries).toHaveLength(1);
      expect(chainQueries[0]?.[1]).toBe(1);
    }
  });

  it("rejects wrong-type and missing packed delta terminals", async () => {
    const wrong = open();
    const blobBytes = utf8.encode("wrong type source\n");
    const treeBytes = serializeTree([]);
    const chunks: Uint8Array[] = [];
    const writer = new PackWriter((chunk) => chunks.push(chunk));
    writer.header(2);
    writer.object("blob", blobBytes);
    writer.object("tree", treeBytes);
    writer.finish();
    await wrong.store.packs.ingest(slices(concat(chunks), 23));
    const blobOid = hashObject("blob", blobBytes);
    const treeOid = hashObject("tree", treeBytes);
    wrong.db.run(
      "UPDATE git_pack_objects SET base_oid = ? WHERE repo_id = ? AND oid = ?",
      treeOid,
      wrong.checkout.repoId,
      blobOid,
    );
    seedMark(wrong.db, wrong.checkout.repoId, [{ oid: blobOid }]);
    expect(() => advanceMaintenanceReachability(wrong.store.shared)).toThrow(/wrong type/);

    const missing = open();
    const source = utf8.encode("missing terminal\n");
    const sourceOid = hashObject("blob", source);
    await missing.store.packs.ingest(slices(fullBlobPack([source]), 19));
    missing.db.run(
      "UPDATE git_pack_objects SET base_oid = ? WHERE repo_id = ? AND oid = ?",
      "d".repeat(40),
      missing.checkout.repoId,
      sourceOid,
    );
    seedMark(missing.db, missing.checkout.repoId, [{ oid: sourceOid }]);
    expect(() => advanceMaintenanceReachability(missing.store.shared)).toThrow(/is missing/);
  });

  it("accepts a source-qualified packed delta chain ending at a same-type loose object", async () => {
    const { db, checkout, store } = open();
    const base = utf8.encode("external loose base\n");
    const target = utf8.encode("external loose target\n");
    const baseOid = store.write("blob", base);
    const targetOid = hashObject("blob", target);
    const chunks: Uint8Array[] = [];
    const writer = new PackWriter((chunk) => chunks.push(chunk));
    writer.header(1);
    writer.refDelta(baseOid, literalDelta(base.length, target));
    writer.finish();
    await store.packs.ingest(slices(concat(chunks), 13));
    seedMark(db, checkout.repoId, [{ oid: targetOid }]);
    db.storage.histogram = new Map();

    const progress = advanceMaintenanceReachability(store.shared);

    expect(progress).toMatchObject({ processedOid: targetOid, discoveredObjects: 1 });
    expect(
      db.one<{ physical_only: number; expanded: number }>(
        `SELECT physical_only, expanded FROM git_maintenance_objects
          WHERE repo_id = ? AND run_id = 1 AND oid = ?`,
        checkout.repoId,
        baseOid,
      ),
    ).toEqual({ physical_only: 1, expanded: 0 });
    const chainQueries = [...db.storage.histogram.entries()].filter(([query]) =>
      query.includes("maintenance-pack-chain"),
    );
    expect(chainQueries).toHaveLength(1);
    expect(chainQueries[0]?.[1]).toBe(1);
  });

  it("accepts complete pack id zero in the bounded base-chain validator", () => {
    const { db, checkout, store } = open();
    const bytes = utf8.encode("pack zero\n");
    const oid = hashObject("blob", bytes);
    db.run(
      `INSERT INTO git_pack_meta (repo_id, pack_id, size, count, state, created)
       VALUES (?, 0, 0, 1, 'complete', 1)`,
      checkout.repoId,
    );
    db.run(
      `INSERT INTO git_pack_objects
         (repo_id, oid, pack_id, offset, data_off, data_len, type, size, entry_size, base_oid)
       VALUES (?, ?, 0, 0, 0, 0, 'blob', ?, 0, NULL)`,
      checkout.repoId,
      oid,
      bytes.length,
    );
    expect(store.packs.completePackedEntry(oid)?.packId).toBe(0);
    seedMark(db, checkout.repoId, [{ oid }]);

    expect(advanceMaintenanceReachability(store.shared)).toMatchObject({
      processedOid: oid,
      discoveredObjects: 0,
    });
  });

  it("does not expand semantic commit edges from a physical-only packed base", async () => {
    const { db, checkout, store } = open();
    const baseBlob = store.write("blob", utf8.encode("base-only\n"));
    const baseTree = store.write(
      "tree",
      serializeTree([{ mode: MODE_FILE, name: "base-only", oid: baseBlob }]),
    );
    const baseParent = store.write("commit", commit(baseTree, [], "base parent\n"));
    const targetTree = store.write("tree", serializeTree([]));
    const baseBytes = commit(baseTree, [baseParent], "packed base\n");
    const targetBytes = commit(targetTree, [], "packed target\n");
    const pack = packedDelta("commit", baseBytes, targetBytes);
    await store.packs.ingest(slices(pack.bytes, 23));
    seedMark(db, checkout.repoId, [{ oid: pack.targetOid }]);

    advanceMaintenanceReachability(store.shared);
    db.run(
      `UPDATE git_maintenance_objects SET expanded = 1
        WHERE repo_id = ? AND run_id = 1 AND oid = ?`,
      checkout.repoId,
      targetTree,
    );
    db.run("UPDATE git_maintenance_runs SET queued_objects = 1 WHERE repo_id = ?", checkout.repoId);

    const physical = advanceMaintenanceReachability(store.shared);

    expect(physical).toMatchObject({
      processedOid: pack.baseOid,
      discoveredObjects: 0,
      discoveredLogicalObjects: 0,
    });
    const reachable = new Set(marks(db, checkout.repoId).map((row) => row.oid));
    expect(reachable.has(baseTree)).toBe(false);
    expect(reachable.has(baseParent)).toBe(false);
  });

  it("defers packed commit and tree bases after an exact 256-edge semantic page", async () => {
    const packedCommit = open();
    const commitTree = packedCommit.store.write("tree", serializeTree([]));
    const parents: string[] = [];
    for (let index = 0; index < 255; index++) {
      parents.push(
        packedCommit.store.write("commit", commit(commitTree, [], `packed parent ${index}\n`)),
      );
    }
    const baseCommit = commit(commitTree, [], "delta base\n");
    const targetCommit = commit(commitTree, parents, "delta target\n");
    const commitPack = packedDelta("commit", baseCommit, targetCommit);
    await packedCommit.store.packs.ingest(slices(commitPack.bytes, 37));
    seedMark(packedCommit.db, packedCommit.checkout.repoId, [{ oid: commitPack.targetOid }]);

    advanceMaintenanceReachability(packedCommit.store.shared);

    expect(
      packedCommit.db.one<{ expanded: number; edge_cursor: number }>(
        `SELECT expanded, edge_cursor FROM git_maintenance_objects
          WHERE repo_id = ? AND run_id = 1 AND oid = ?`,
        packedCommit.checkout.repoId,
        commitPack.targetOid,
      ),
    ).toEqual({ expanded: 0, edge_cursor: 256 });
    expect(
      packedCommit.db.scalar<number>(
        `SELECT count(*) FROM git_maintenance_objects
          WHERE repo_id = ? AND run_id = 1 AND oid = ?`,
        packedCommit.checkout.repoId,
        commitPack.baseOid,
      ),
    ).toBe(0);
    packedCommit.db.run(
      `UPDATE git_maintenance_objects SET expanded = 1
        WHERE repo_id = ? AND run_id = 1 AND oid != ?`,
      packedCommit.checkout.repoId,
      commitPack.targetOid,
    );
    packedCommit.db.run(
      "UPDATE git_maintenance_runs SET queued_objects = 1 WHERE repo_id = ?",
      packedCommit.checkout.repoId,
    );
    advanceMaintenanceReachability(packedCommit.store.shared);
    expect(
      packedCommit.db.one<{ physical_only: number; expanded: number }>(
        `SELECT physical_only, expanded FROM git_maintenance_objects
          WHERE repo_id = ? AND run_id = 1 AND oid = ?`,
        packedCommit.checkout.repoId,
        commitPack.baseOid,
      ),
    ).toEqual({ physical_only: 1, expanded: 0 });

    const packedTree = open();
    const entries: { mode: string; name: string; oid: string }[] = [];
    for (let index = 0; index < 256; index++) {
      const oid = packedTree.store.write("blob", utf8.encode(`packed tree blob ${index}\n`));
      entries.push({ mode: MODE_FILE, name: `file-${String(index).padStart(3, "0")}`, oid });
    }
    const baseTree = serializeTree([]);
    const targetTree = serializeTree(entries);
    const treePack = packedDelta("tree", baseTree, targetTree);
    await packedTree.store.packs.ingest(slices(treePack.bytes, 41));
    seedMark(packedTree.db, packedTree.checkout.repoId, [{ oid: treePack.targetOid }]);

    advanceMaintenanceReachability(packedTree.store.shared);

    expect(
      packedTree.db.one<{ expanded: number; edge_cursor: number }>(
        `SELECT expanded, edge_cursor FROM git_maintenance_objects
          WHERE repo_id = ? AND run_id = 1 AND oid = ?`,
        packedTree.checkout.repoId,
        treePack.targetOid,
      ),
    ).toEqual({ expanded: 0, edge_cursor: 256 });
    expect(
      packedTree.db.scalar<number>(
        `SELECT count(*) FROM git_maintenance_objects
          WHERE repo_id = ? AND run_id = 1 AND oid = ?`,
        packedTree.checkout.repoId,
        treePack.baseOid,
      ),
    ).toBe(0);
    packedTree.db.run(
      `UPDATE git_maintenance_objects SET expanded = 1
        WHERE repo_id = ? AND run_id = 1 AND oid != ?`,
      packedTree.checkout.repoId,
      treePack.targetOid,
    );
    packedTree.db.run(
      "UPDATE git_maintenance_runs SET queued_objects = 1 WHERE repo_id = ?",
      packedTree.checkout.repoId,
    );
    advanceMaintenanceReachability(packedTree.store.shared);
    expect(
      packedTree.db.one<{ physical_only: number; expanded: number }>(
        `SELECT physical_only, expanded FROM git_maintenance_objects
          WHERE repo_id = ? AND run_id = 1 AND oid = ?`,
        packedTree.checkout.repoId,
        treePack.baseOid,
      ),
    ).toEqual({ physical_only: 1, expanded: 0 });
  });

  it("fails closed on missing mandatory edges", () => {
    const missing = open();
    const absent = "e".repeat(40);
    const other = missing.database.createRepository("/other", "ref: refs/heads/main");
    promiseBlob(missing.db, other.repoId, absent);
    const missingTree = missing.store.write(
      "tree",
      serializeTree([{ mode: MODE_FILE, name: "missing", oid: absent }]),
    );
    seedMark(missing.db, missing.checkout.repoId, [{ oid: missingTree }]);
    expect(() => advanceMaintenanceReachability(missing.store.shared)).toThrow(
      /references a missing object/,
    );
    expect(
      missing.db.scalar<number>(
        `SELECT expanded FROM git_maintenance_objects
          WHERE repo_id = ? AND oid = ?`,
        missing.checkout.repoId,
        missingTree,
      ),
    ).toBe(0);
  });

  it("accepts a repository-owned promised blob as an unmarked tree-edge terminal", () => {
    const { db, checkout, store } = open();
    const promised = "a".repeat(40);
    const tree = store.write(
      "tree",
      serializeTree([{ mode: MODE_FILE, name: "promised", oid: promised }]),
    );
    promiseBlob(db, checkout.repoId, promised);
    seedMark(db, checkout.repoId, [{ oid: tree }]);

    expect(advanceMaintenanceReachability(store.shared)).toMatchObject({
      processedOid: tree,
      discoveredObjects: 0,
      discoveredLogicalObjects: 0,
    });
    drain(db, store.shared);

    expect(marks(db, checkout.repoId)).toEqual([
      { oid: tree, expanded: 1, physical_only: 0, edge_cursor: 1 },
    ]);
    expect(
      db.scalar<number>(
        "SELECT count(*) FROM git_maintenance_objects WHERE repo_id = ? AND oid = ?",
        checkout.repoId,
        promised,
      ),
    ).toBe(0);
    expect(
      db.scalar<number>(
        "SELECT count(*) FROM git_maintenance_repack_objects WHERE repo_id = ? AND oid = ?",
        checkout.repoId,
        promised,
      ),
    ).toBe(0);
    expect(
      db.one<{ phase: string; reachable_objects: number; queued_objects: number }>(
        `SELECT phase, reachable_objects, queued_objects
           FROM git_maintenance_runs WHERE repo_id = ?`,
        checkout.repoId,
      ),
    ).toEqual({ phase: "classify-loose", reachable_objects: 1, queued_objects: 0 });
  });

  it("does not apply blob promises to missing non-blob edges or roots", () => {
    const nonBlob = open();
    const promisedTree = "b".repeat(40);
    const tree = nonBlob.store.write(
      "tree",
      serializeTree([{ mode: "40000", name: "missing-tree", oid: promisedTree }]),
    );
    promiseBlob(nonBlob.db, nonBlob.checkout.repoId, promisedTree);
    seedMark(nonBlob.db, nonBlob.checkout.repoId, [{ oid: tree }]);

    expect(() => advanceMaintenanceReachability(nonBlob.store.shared)).toThrow(
      /references a missing object/,
    );

    const tagEdge = open();
    const promisedTagTarget = "d".repeat(40);
    const tag = tagEdge.store.write(
      "tag",
      serializeTag({
        object: promisedTagTarget,
        type: "blob",
        tag: "missing-blob",
        message: "\n",
      }),
    );
    promiseBlob(tagEdge.db, tagEdge.checkout.repoId, promisedTagTarget);
    seedMark(tagEdge.db, tagEdge.checkout.repoId, [{ oid: tag }]);

    expect(() => advanceMaintenanceReachability(tagEdge.store.shared)).toThrow(
      /references a missing object/,
    );

    const root = open();
    const promisedRoot = "c".repeat(40);
    promiseBlob(root.db, root.checkout.repoId, promisedRoot);
    seedMark(root.db, root.checkout.repoId, [{ oid: promisedRoot }]);

    expect(() => advanceMaintenanceReachability(root.store.shared)).toThrow(
      /reachable object .* is missing/,
    );
  });

  it("returns root-changed without publishing or changing counters", () => {
    const { db, checkout, store } = open();
    const blob = store.write("blob", utf8.encode("root\n"));
    seedMark(db, checkout.repoId, [{ oid: blob }]);
    const before = marks(db, checkout.repoId);
    db.run("UPDATE git_maintenance_control SET root_epoch = 1 WHERE repo_id = ?", checkout.repoId);

    const progress = advanceMaintenanceReachability(store.shared);

    expect(progress).toEqual({
      runId: 1,
      status: "root-changed",
      processedOid: null,
      discoveredObjects: 0,
      discoveredLogicalObjects: 0,
    });
    expect(marks(db, checkout.repoId)).toEqual(before);
    expect(
      db.one<{ reachable_objects: number; queued_objects: number }>(
        "SELECT reachable_objects, queued_objects FROM git_maintenance_runs WHERE repo_id = ?",
        checkout.repoId,
      ),
    ).toEqual({ reachable_objects: 0, queued_objects: 1 });
  });

  it("rejects drifted queue and logical counters at their exact audit boundaries", () => {
    const initialized = open();
    const first = initialized.store.write("blob", utf8.encode("first\n"));
    seedMark(initialized.db, initialized.checkout.repoId, [{ oid: first }]);
    initialized.db.run(
      "UPDATE git_maintenance_runs SET queued_objects = 2 WHERE repo_id = ?",
      initialized.checkout.repoId,
    );
    expect(() => advanceMaintenanceReachability(initialized.store.shared)).toThrow(
      /initial maintenance counters disagree/,
    );

    const completed = open();
    const second = completed.store.write("blob", utf8.encode("second\n"));
    seedMark(completed.db, completed.checkout.repoId, [{ oid: second }]);
    advanceMaintenanceReachability(completed.store.shared);
    completed.db.run(
      "UPDATE git_maintenance_runs SET reachable_objects = 2 WHERE repo_id = ?",
      completed.checkout.repoId,
    );
    expect(() => advanceMaintenanceReachability(completed.store.shared)).toThrow(
      /completed maintenance counters disagree/,
    );
  });

  it("returns completion after a cold classify-loose reopen", () => {
    const stable = open();
    const stableBlob = stable.store.write("blob", utf8.encode("stable complete\n"));
    seedMark(stable.db, stable.checkout.repoId, [{ oid: stableBlob }]);
    drain(stable.db, stable.store.shared);
    const stableReopen = new SqliteGitDatabase(stable.db, { objectCacheBytes: 1024 * 1024 });
    expect(
      advanceMaintenanceReachability(stableReopen.openCheckout(stable.checkout.id).shared),
    ).toMatchObject({ status: "complete", processedOid: null });
  });

  it("ignores valid-looking corrupt and oversized commit cache rows in favor of raw headers", () => {
    const { db, checkout, store } = open();
    const tree = store.write("tree", serializeTree([]));
    const parentTreeBlob = store.write("blob", utf8.encode("parent tree\n"));
    const parentTree = store.write(
      "tree",
      serializeTree([{ mode: MODE_FILE, name: "parent", oid: parentTreeBlob }]),
    );
    const parent = store.write("commit", commit(parentTree, [], "actual parent\n"));
    const root = store.write("commit", commit(tree, [parent], "actual root\n"));
    const decoyBlob = store.write("blob", utf8.encode("decoy tree\n"));
    const decoyTree = store.write(
      "tree",
      serializeTree([{ mode: MODE_FILE, name: "decoy", oid: decoyBlob }]),
    );
    const decoyParent = store.write("commit", commit(decoyTree, [], "decoy parent\n"));
    db.run(
      `UPDATE git_commits
          SET tree = ?, parents = json_array(?), cache_bytes = ?
        WHERE repo_id = ? AND oid = ?`,
      decoyTree,
      decoyParent,
      101 * 1024 * 1024,
      checkout.repoId,
      root,
    );
    seedMark(db, checkout.repoId, [{ oid: root }]);
    db.storage.histogram = new Map();

    const progress = advanceMaintenanceReachability(store.shared);

    expect(progress).toMatchObject({ processedOid: root, discoveredLogicalObjects: 2 });
    const queryText = [...db.storage.histogram.keys()].join("\n");
    expect(queryText).toContain("maintenance-loose-headers");
    expect(queryText).not.toContain("git_commits");
    const reached = new Set(marks(db, checkout.repoId).map((row) => row.oid));
    expect(reached.has(tree)).toBe(true);
    expect(reached.has(parent)).toBe(true);
    expect(reached.has(decoyTree)).toBe(false);
    expect(reached.has(decoyParent)).toBe(false);
  });

  it("uses raw loose and packed commit headers regardless of derived cache qualification", async () => {
    const loose = open();
    const looseTree = loose.store.write("tree", serializeTree([]));
    const looseCommit = loose.store.write("commit", commit(looseTree));
    loose.db.run(
      "UPDATE git_commits SET object_size = object_size + 1 WHERE repo_id = ? AND oid = ?",
      loose.checkout.repoId,
      looseCommit,
    );
    seedMark(loose.db, loose.checkout.repoId, [{ oid: looseCommit }]);
    loose.db.storage.histogram = new Map();

    advanceMaintenanceReachability(loose.store.shared);

    expect([...loose.db.storage.histogram.keys()].join("\n")).toContain(
      "maintenance-loose-headers",
    );
    expect(marks(loose.db, loose.checkout.repoId).map((row) => row.oid)).toContain(looseTree);

    const packed = open();
    const packedTree = packed.store.write("tree", serializeTree([]));
    const packedBytes = commit(packedTree);
    const chunks: Uint8Array[] = [];
    const writer = new PackWriter((chunk) => chunks.push(chunk));
    writer.header(1);
    writer.object("commit", packedBytes);
    writer.finish();
    await packed.store.packs.ingest(slices(concat(chunks), 19));
    const packedCommit = hashObject("commit", packedBytes);
    packed.db.run(
      "UPDATE git_commits SET object_size = object_size + 1 WHERE repo_id = ? AND oid = ?",
      packed.checkout.repoId,
      packedCommit,
    );
    seedMark(packed.db, packed.checkout.repoId, [{ oid: packedCommit }]);

    const progress = advanceMaintenanceReachability(packed.store.shared);

    expect(progress).toMatchObject({ processedOid: packedCommit, discoveredLogicalObjects: 1 });
    expect(marks(packed.db, packed.checkout.repoId).map((row) => row.oid)).toContain(packedTree);
  });

  it("resumes a 50,001-commit history cold beyond the bounded graph-reader limit", () => {
    const { db, checkout, store } = open();
    const tree = store.write("tree", serializeTree([]));
    const chain: string[] = [];
    store.writeObjects(
      (batch) => {
        let parent: string[] = [];
        for (let index = 0; index < 50_001; index++) {
          const oid = batch.write("commit", commit(tree, parent, `history ${index}\n`));
          chain.push(oid);
          parent = [oid];
        }
      },
      { flushEvery: 2_048 },
    );
    const root = chain[chain.length - 1];
    if (root === undefined) throw new Error("history fixture is empty");
    seedMark(db, checkout.repoId, [{ oid: root }]);
    const queuePlan = db.all<{ detail: string }>(
      `EXPLAIN QUERY PLAN
       SELECT oid FROM git_maintenance_objects
        WHERE repo_id = ? AND run_id = 1 AND expanded = 0
        ORDER BY physical_only ASC, oid COLLATE BINARY LIMIT 2`,
      checkout.repoId,
    );
    expect(queuePlan.some((row) => row.detail.includes("git_maintenance_objects_queue"))).toBe(
      true,
    );
    expect(queuePlan.some((row) => row.detail.includes("USE TEMP B-TREE"))).toBe(false);

    let shared = store.shared;
    db.storage.resetCounters();
    let progress = advanceMaintenanceReachability(shared);
    let maximumStatements = db.storage.statementCount;
    if (db.storage.statementCount >= 900) {
      throw new Error(`reachability slice used ${db.storage.statementCount} statements`);
    }
    for (let call = 1; progress.status !== "complete"; call++) {
      if (call === 25_000) {
        const reopened = new SqliteGitDatabase(db, { objectCacheBytes: 1024 * 1024 });
        shared = reopened.openCheckout(checkout.id).shared;
      }
      db.storage.resetCounters();
      progress = advanceMaintenanceReachability(shared);
      maximumStatements = Math.max(maximumStatements, db.storage.statementCount);
      if (db.storage.statementCount >= 900) {
        throw new Error(`reachability slice used ${db.storage.statementCount} statements`);
      }
      if (call > 50_005) throw new Error("large history did not terminate");
    }

    expect(maximumStatements).toBeLessThan(1_000);
    expect(
      db.one<{ phase: string; queued_objects: number; reachable_objects: number }>(
        `SELECT phase, queued_objects, reachable_objects
           FROM git_maintenance_runs WHERE repo_id = ?`,
        checkout.repoId,
      ),
    ).toEqual({
      phase: "classify-loose",
      queued_objects: 0,
      reachable_objects: 50_002,
    });
    expect(
      db.scalar<number>(
        "SELECT count(*) FROM git_maintenance_objects WHERE repo_id = ? AND physical_only = 0",
        checkout.repoId,
      ),
    ).toBe(50_002);
  }, 300_000);
});
