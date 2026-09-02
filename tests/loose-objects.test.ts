import { describe, expect, it } from "vitest";
import { readBlob, type SqlDatabase } from "../src/db/db.js";
import { hashObject } from "../src/git/common/objects.js";
import { SqliteGitDatabase } from "../src/git/store/index.js";
import { TestDatabase } from "./helpers/db.js";

class RecordingDatabase implements SqlDatabase {
  readonly objectChunkQueries: string[] = [];

  constructor(readonly inner: TestDatabase) {}

  run(query: string, ...bindings: unknown[]): void {
    this.#record(query);
    this.inner.run(query, ...bindings);
  }

  all<Row extends object>(query: string, ...bindings: unknown[]): Row[] {
    this.#record(query);
    return this.inner.all<Row>(query, ...bindings);
  }

  one<Row extends object>(query: string, ...bindings: unknown[]): Row | undefined {
    this.#record(query);
    return this.inner.one<Row>(query, ...bindings);
  }

  scalar<T>(query: string, ...bindings: unknown[]): T | undefined {
    this.#record(query);
    return this.inner.scalar<T>(query, ...bindings);
  }

  iterate(query: string, ...bindings: unknown[]): Iterable<Record<string, unknown>> {
    this.#record(query);
    return this.inner.iterate(query, ...bindings);
  }

  transactionSync<T>(closure: () => T): T {
    return this.inner.transactionSync(closure);
  }

  resetObjectChunkQueries(): void {
    this.objectChunkQueries.length = 0;
  }

  #record(query: string): void {
    if (query.includes("git_object_chunks")) this.objectChunkQueries.push(query);
  }
}

function open() {
  const db = new TestDatabase();
  const recording = new RecordingDatabase(db);
  const database = new SqliteGitDatabase(recording, { objectCacheBytes: 0, chunkBytes: 0 });
  const repository = database.createRepository("/repo", "ref: refs/heads/main");
  return { db, recording, store: database.openCheckout(repository) };
}

function deterministicBytes(size: number, seed = 0x9e3779b9): Uint8Array {
  const data = new Uint8Array(size);
  let state = seed;
  for (let index = 0; index < size; index++) {
    state ^= state << 13;
    state ^= state >>> 17;
    state ^= state << 5;
    data[index] = state & 0xff;
  }
  return data;
}

function rechunk(db: TestDatabase, oid: string, chunkBytes: number): number {
  const row = db.one<{ data: unknown }>(
    "SELECT data FROM git_object_chunks WHERE repo_id = 1 AND oid = ? AND seq = 0",
    oid,
  );
  if (row === undefined) throw new Error(`missing payload for ${oid}`);
  const encoded = readBlob(row.data);
  db.run("DELETE FROM git_object_chunks WHERE repo_id = 1 AND oid = ?", oid);
  let rows = 0;
  for (let offset = 0; offset < encoded.length; offset += chunkBytes) {
    db.run(
      "INSERT INTO git_object_chunks (repo_id, oid, seq, data) VALUES (1, ?, ?, ?)",
      oid,
      rows++,
      encoded.subarray(offset, offset + chunkBytes),
    );
  }
  return rows;
}

describe("loose object payload streaming", () => {
  it("reads scalar raw and many-chunk zlib encodings with exactly one payload query each", () => {
    const { db, recording, store } = open();
    const raw = deterministicBytes(4_096, 0x1020_3040);
    const compressed = deterministicBytes(96 * 1024, 0x5060_7080);
    const rawOid = store.write("blob", raw);
    const compressedOid = store.write("blob", compressed);
    expect(rechunk(db, compressedOid, 997)).toBeGreaterThan(2);

    const cases: readonly (readonly [string, Uint8Array])[] = [
      [rawOid, raw],
      [compressedOid, compressed],
    ];
    for (const [oid, expected] of cases) {
      recording.resetObjectChunkQueries();
      const object = store.read(oid);
      expect(object).toEqual({ type: "blob", data: expected });
      expect(recording.objectChunkQueries).toHaveLength(1);
      expect(recording.objectChunkQueries[0]).toContain("loose-object-payload");
    }
  });

  it("reads a mixed-encoding batch with exactly one ordered payload query", () => {
    const { db, recording, store } = open();
    const raw = deterministicBytes(37, 0x1111_1111);
    const compressed = deterministicBytes(128 * 1024, 0x2222_2222);
    const rawOid = store.write("blob", raw);
    const compressedOid = store.write("blob", compressed);
    expect(rechunk(db, compressedOid, 2_003)).toBeGreaterThan(2);
    recording.resetObjectChunkQueries();

    const batch = store.readBlobs([rawOid, compressedOid], { budgetBytes: 1024 * 1024 });

    expect(batch).toEqual({
      blobs: new Map([
        [rawOid, raw],
        [compressedOid, compressed],
      ]),
      remaining: [],
      bytes: raw.length + compressed.length,
    });
    expect(recording.objectChunkQueries).toHaveLength(1);
    expect(recording.objectChunkQueries[0]).toContain("loose-object-payload");
  });

  it("rejects a malformed payload row shape", () => {
    const { db, store } = open();
    const data = deterministicBytes(96 * 1024);
    const oid = store.write("blob", data);
    expect(rechunk(db, oid, 997)).toBeGreaterThan(2);
    db.run(
      "UPDATE git_object_chunks SET seq = 'invalid' WHERE repo_id = 1 AND oid = ? AND seq = 1",
      oid,
    );

    expect(() => store.read(oid)).toThrowError(expect.objectContaining({ code: "ECORRUPT" }));
  });

  it("rejects gaps in an otherwise ordered chunk sequence", () => {
    const { db, store } = open();
    const data = deterministicBytes(96 * 1024);
    const oid = store.write("blob", data);
    expect(rechunk(db, oid, 997)).toBeGreaterThan(2);
    db.run("DELETE FROM git_object_chunks WHERE repo_id = 1 AND oid = ? AND seq = 1", oid);

    expect(() => store.read(oid)).toThrowError(
      expect.objectContaining({ code: "ECORRUPT", message: expect.stringContaining("sequence") }),
    );
  });

  it("rejects raw encoded bytes that disagree with the indexed size", () => {
    const { db, store } = open();
    const data = deterministicBytes(257);
    const oid = store.write("blob", data);
    db.run("UPDATE git_objects SET size = size - 1 WHERE repo_id = 1 AND oid = ?", oid);

    expect(() => store.read(oid)).toThrowError(
      expect.objectContaining({ code: "ECORRUPT", message: expect.stringContaining("size") }),
    );
  });

  it("rejects invalid, truncated, oversized, and non-progressing zlib streams", () => {
    const cases: readonly [string, (db: TestDatabase, oid: string) => void, string][] = [
      [
        "invalid bytes",
        (db, oid) => {
          db.run(
            "UPDATE git_object_chunks SET data = x'00010203' WHERE repo_id = 1 AND oid = ? AND seq = 0",
            oid,
          );
        },
        "invalid compressed bytes",
      ],
      [
        "truncated stream",
        (db, oid) => {
          db.run(
            "UPDATE git_object_chunks SET data = substr(data, 1, length(data) - 1) WHERE repo_id = 1 AND oid = ? AND seq = 0",
            oid,
          );
        },
        "size does not match",
      ],
      [
        "oversized output",
        (db, oid) => {
          db.run("UPDATE git_objects SET size = size - 1 WHERE repo_id = 1 AND oid = ?", oid);
        },
        "exceeds its indexed size",
      ],
      [
        "second stream",
        (db, oid) => {
          const row = db.one<{ data: unknown }>(
            "SELECT data FROM git_object_chunks WHERE repo_id = 1 AND oid = ? AND seq = 0",
            oid,
          );
          if (row === undefined) throw new Error(`missing payload for ${oid}`);
          db.run(
            "INSERT INTO git_object_chunks (repo_id, oid, seq, data) VALUES (1, ?, 1, ?)",
            oid,
            readBlob(row.data),
          );
        },
        "inflater made no progress",
      ],
    ];

    for (const [label, corrupt, message] of cases) {
      const { db, store } = open();
      const data = deterministicBytes(32 * 1024, label.length);
      const oid = store.write("blob", data);
      expect(oid).toBe(hashObject("blob", data));
      corrupt(db, oid);

      expect(() => store.read(oid), label).toThrowError(
        expect.objectContaining({ code: "ECORRUPT", message: expect.stringContaining(message) }),
      );
    }
  });
});
