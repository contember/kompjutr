import { describe, expect, it } from "vitest";
import { concat, utf8, utf8Decoder } from "../src/core/bytes.js";
import { parseTreeStream, serializeTree, type TreeEntry, TreeParser } from "../src/core/objects.js";
import { readBlob, type SqlDatabase } from "../src/sqlite/db.js";
import { PackTreeIndex } from "../src/sqlite/pack-ingest-index.js";
import {
  createTreeIndexSink,
  indexTreeSource,
  indexTreeSources,
  initializeGitSchema,
  TREE_QUEUE_ROW_FIXED_BYTES,
  type TreeSource,
} from "../src/sqlite/schema.js";
import { indexSeededTreeSource } from "../src/sqlite/tree-index.js";
import { TestDatabase } from "./helpers/db.js";

const OID = "11".repeat(20);
const TREE_OID = "22".repeat(20);
const ONE_MIB = 1024 * 1024;

function initializeTreeSchema(db: SqlDatabase): void {
  initializeGitSchema(db);
  db.run("INSERT INTO git_repositories (id) VALUES (1)");
}

it("loads the pack tree index directly without a schema module cycle", () => {
  expect(typeof PackTreeIndex).toBe("function");
});

function rawEntry(mode: string, name: string, oid = OID): Uint8Array {
  const oidBytes = new Uint8Array(20);
  for (let at = 0; at < oidBytes.length; at++) {
    oidBytes[at] = Number.parseInt(oid.slice(at * 2, at * 2 + 2), 16);
  }
  return concat([utf8.encode(`${mode} ${name}\0`), oidBytes]);
}

function source(objectSize: number, sourceId = 0): TreeSource {
  return {
    repoId: 1,
    treeOid: TREE_OID,
    storage: sourceId === 0 ? "loose" : "pack",
    sourceId,
    objectSize,
  };
}

function consume(parser: TreeParser, chunk: Uint8Array): void {
  for (const _entry of parser.push(chunk)) {
    // Parsing the entry is the assertion vehicle; no output needs retaining.
  }
}

class ObservedDatabase implements SqlDatabase {
  maxEntryRows = 0;
  maxBoundBytes = 0;
  entryInserts = 0;
  markerInserts = 0;
  failEntryInsert = 0;
  entryRowCounts: number[] = [];
  markerRowCounts: number[] = [];
  sharedEntryPayload = true;
  writes: string[] = [];

  constructor(readonly inner: TestDatabase) {}

  run(query: string, ...bindings: unknown[]): void {
    if (query.startsWith("INSERT INTO git_tree_entries")) {
      this.entryInserts++;
      if (this.entryInserts === this.failEntryInsert) throw new Error("injected tree INSERT");
      const encoded = bindings[3];
      const offset = bindings[4];
      const length = bindings[5];
      if (
        !(encoded instanceof Uint8Array) ||
        typeof offset !== "number" ||
        typeof length !== "number"
      ) {
        throw new Error("tree entry JSON binding missing");
      }
      const parsed: unknown = JSON.parse(
        utf8Decoder.decode(encoded.subarray(offset - 1, offset - 1 + length)),
      );
      if (!Array.isArray(parsed)) throw new Error("tree entry JSON binding is not an array");
      this.maxEntryRows = Math.max(this.maxEntryRows, parsed.length);
      this.entryRowCounts.push(parsed.length);
      this.sharedEntryPayload &&=
        bindings[0] === bindings[1] && bindings[1] === bindings[2] && bindings[2] === bindings[3];
      for (const binding of bindings) {
        const bytes =
          typeof binding === "string"
            ? utf8.encode(binding).length
            : binding instanceof Uint8Array
              ? binding.length
              : 0;
        this.maxBoundBytes = Math.max(this.maxBoundBytes, bytes);
      }
      this.writes.push("entries");
    } else if (query.startsWith("INSERT INTO git_tree_sources")) {
      this.markerInserts++;
      const encoded = bindings[0];
      const length = bindings[1];
      if (!(encoded instanceof Uint8Array) || typeof length !== "number") {
        throw new Error("tree marker JSON binding missing");
      }
      const parsed: unknown = JSON.parse(utf8Decoder.decode(encoded.subarray(0, length)));
      if (!Array.isArray(parsed)) throw new Error("tree marker JSON binding is not an array");
      this.markerRowCounts.push(parsed.length);
      this.writes.push("marker");
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
    return this.inner.iterate(query, ...bindings);
  }

  transactionSync<T>(closure: () => T): T {
    return this.inner.transactionSync(closure);
  }
}

describe("incremental tree parser", () => {
  it("preserves scalar parsing at every chunk boundary", () => {
    const entries: TreeEntry[] = [
      { mode: "100644", name: "a", oid: OID },
      { mode: "100755", name: "žluť", oid: "33".repeat(20) },
      { mode: "40000", name: "z", oid: "44".repeat(20) },
    ];
    const data = serializeTree(entries);
    const scalar = [...parseTreeStream([data])].map(({ entry, nameBytes, rawEntry }) => ({
      entry,
      nameBytes,
      rawEntry,
    }));

    for (let split = 0; split <= data.length; split++) {
      const parsed = [...parseTreeStream([data.subarray(0, split), data.subarray(split)])].map(
        ({ entry, nameBytes, rawEntry }) => ({ entry, nameBytes, rawEntry }),
      );
      expect(parsed).toEqual(scalar);
    }

    const bytewise = [...parseTreeStream([...data].map((byte) => new Uint8Array([byte])))];
    expect(bytewise.map(({ entry }) => entry)).toEqual(scalar.map(({ entry }) => entry));
    expect(bytewise.at(-1)?.observedSize).toBe(data.length);
  });

  it("fails closed for every partial field and while an overlong field grows", () => {
    const partialOid = concat([utf8.encode("100644 file\0"), new Uint8Array(19)]);
    for (const partial of [utf8.encode("100644"), utf8.encode("100644 file"), partialOid]) {
      const parser = new TreeParser();
      consume(parser, partial);
      expect(() => parser.finish()).toThrow("malformed tree entry");
    }

    const mode = new TreeParser();
    expect(() => consume(mode, utf8.encode("1006444"))).toThrow("tree mode is too long");
    const name = new TreeParser();
    expect(() => consume(name, utf8.encode(`100644 ${"a".repeat(2_201)}`))).toThrow(
      "tree entry name is too long",
    );
  });
});

describe("incremental tree index sink", () => {
  it("indexes a >16 MiB tree from tiny chunks within the exact state and SQL bounds", () => {
    const inner = new TestDatabase();
    initializeTreeSchema(inner);
    inner.storage.resetCounters();
    const db = new ObservedDatabase(inner);
    const nameLength = 2_180;
    const entrySize = 6 + nameLength + 22;
    const count = Math.floor((16 * ONE_MIB) / entrySize) + 1;
    const objectSize = count * entrySize;
    const sink = createTreeIndexSink(db, source(objectSize));
    let maxRetainedBytes = sink.retainedBytes;
    let maxRetainedRows = sink.retainedRows;
    const byteChunk = new Uint8Array(1);

    db.transactionSync(() => {
      for (let ordinal = 0; ordinal < count; ordinal++) {
        const name = `${"a".repeat(nameLength - 6)}${String(ordinal).padStart(6, "0")}`;
        const raw = rawEntry("100644", name);
        for (const byte of raw) {
          byteChunk[0] = byte;
          sink.push(byteChunk);
        }
        maxRetainedBytes = Math.max(maxRetainedBytes, sink.retainedBytes);
        maxRetainedRows = Math.max(maxRetainedRows, sink.retainedRows);
      }
      sink.finish();
    });

    const marker = inner.one<{
      object_size: number;
      entry_count: number;
      base_cost: number;
    }>(
      "SELECT object_size, entry_count, base_cost FROM git_tree_sources WHERE repo_id = 1 AND tree_oid = ?",
      TREE_OID,
    );
    const perEntryBase = TREE_QUEUE_ROW_FIXED_BYTES + nameLength + 6 + OID.length;
    expect(objectSize).toBeGreaterThan(16 * ONE_MIB);
    expect(marker).toEqual({
      object_size: objectSize,
      entry_count: count,
      base_cost: count * perEntryBase,
    });
    expect(
      inner.scalar<number>(
        "SELECT COUNT(*) FROM git_tree_entries_wide WHERE repo_id = 1 AND tree_oid = ?",
        TREE_OID,
      ),
    ).toBe(count);
    const edges = inner.all<{
      ordinal: number;
      raw_entry: Uint8Array;
      cumulative_base: number;
    }>(
      `SELECT ordinal, raw_entry, cumulative_base FROM git_tree_entries_wide
        WHERE repo_id = 1 AND tree_oid = ? AND ordinal IN (0, ?)
        ORDER BY ordinal`,
      TREE_OID,
      count - 1,
    );
    expect(readBlob(edges[0]?.raw_entry).length).toBe(entrySize);
    expect(edges[0]?.cumulative_base).toBe(perEntryBase);
    expect(readBlob(edges[1]?.raw_entry).length).toBe(entrySize);
    expect(edges[1]?.cumulative_base).toBe(count * perEntryBase);
    expect(maxRetainedBytes).toBeLessThanOrEqual(ONE_MIB);
    expect(sink.peakBytes).toBeLessThanOrEqual(ONE_MIB);
    expect(sink.peakBytes).toBeGreaterThan(maxRetainedBytes);
    expect(maxRetainedRows).toBeLessThanOrEqual(2_048);
    expect(db.maxEntryRows).toBeLessThanOrEqual(2_048);
    expect(db.maxBoundBytes).toBeLessThanOrEqual(ONE_MIB);
    expect(db.sharedEntryPayload).toBe(true);
    expect(db.writes.at(-1)).toBe("marker");
    expect(inner.storage.statementCount).toBeLessThanOrEqual(50);
  });

  it("keeps marker formulas and legacy adapters byte-exact", () => {
    const db = new TestDatabase();
    initializeTreeSchema(db);
    const entries: TreeEntry[] = [
      { mode: "100644", name: "a", oid: OID },
      { mode: "100755", name: "b", oid: "33".repeat(20) },
    ];
    const data = serializeTree(entries);
    db.transactionSync(() => {
      const sink = createTreeIndexSink(db, source(data.length));
      sink.push(data.subarray(0, 1));
      sink.push(data.subarray(1));
      sink.finish();
      indexTreeSource(db, { ...source(data.length, 7), treeOid: "55".repeat(20) }, [data]);
    });

    const direct = db.all<Record<string, unknown>>(
      `SELECT ordinal, mode, name, hex(name_bytes) AS name_bytes, oid,
              hex(raw_entry) AS raw_entry, cumulative_base
         FROM git_tree_entries_wide WHERE tree_oid = ? ORDER BY ordinal`,
      TREE_OID,
    );
    const legacy = db.all<Record<string, unknown>>(
      `SELECT ordinal, mode, name, hex(name_bytes) AS name_bytes, oid,
              hex(raw_entry) AS raw_entry, cumulative_base
         FROM git_tree_entries_wide WHERE tree_oid = ? ORDER BY ordinal`,
      "55".repeat(20),
    );
    expect(legacy).toEqual(direct);
  });

  it("fails closed when a seeded loose source is missing", () => {
    const db = new TestDatabase();
    initializeTreeSchema(db);
    const data = rawEntry("100644", "file");

    expect(() =>
      db.transactionSync(() => indexSeededTreeSource(db, source(data.length), [data])),
    ).toThrowError(expect.objectContaining({ code: "ECORRUPT" }));
    expect(db.scalar<number>("SELECT COUNT(*) FROM git_tree_entries")).toBe(0);
  });

  it("rejects invalid modes, names, and object sizes without a marker", () => {
    for (const raw of [
      rawEntry("100600", "file"),
      rawEntry("100644", ""),
      rawEntry("100644", "a/b"),
    ]) {
      const db = new TestDatabase();
      initializeTreeSchema(db);
      const sink = createTreeIndexSink(db, source(raw.length));
      expect(() => sink.push(raw)).toThrow(/invalid tree/);
      expect(db.scalar<number>("SELECT COUNT(*) FROM git_tree_sources")).toBe(0);
    }

    const db = new TestDatabase();
    initializeTreeSchema(db);
    const valid = rawEntry("100644", "file");
    const sink = createTreeIndexSink(db, source(valid.length + 1));
    sink.push(valid);
    expect(() => sink.finish()).toThrow(/parsed .* expected/);
    expect(db.scalar<number>("SELECT COUNT(*) FROM git_tree_sources")).toBe(0);
  });

  it("rejects excess chunk bytes before parsing or flushing in both adapters", () => {
    const entry = rawEntry("100644", "file");
    const many = new Uint8Array(entry.length * 2_500);
    for (let at = 0; at < many.length; at += entry.length) many.set(entry, at);

    const directInner = new TestDatabase();
    initializeTreeSchema(directInner);
    const direct = new ObservedDatabase(directInner);
    const sink = createTreeIndexSink(direct, source(entry.length));
    expect(() => sink.push(many)).toThrow("exceeds its declared size");
    expect(direct.entryInserts).toBe(0);
    expect(direct.markerInserts).toBe(0);

    const legacyInner = new TestDatabase();
    initializeTreeSchema(legacyInner);
    const legacy = new ObservedDatabase(legacyInner);
    expect(() => indexTreeSources(legacy, [{ ...source(entry.length), chunks: [many] }])).toThrow(
      "exceeds its declared size",
    );
    expect(legacy.entryInserts).toBe(0);
    expect(legacy.markerInserts).toBe(0);
  });

  it("flushes mixed entries and markers at the combined 2,048-row boundary", () => {
    const inner = new TestDatabase();
    initializeTreeSchema(inner);
    inner.storage.resetCounters();
    const db = new ObservedDatabase(inner);
    const entry = rawEntry("100644", "file");

    function* sources() {
      for (let at = 1; at <= 1_500; at++) {
        yield { ...source(0, at), treeOid: at.toString(16).padStart(40, "0"), chunks: [] };
      }
      yield {
        ...source(entry.length * 700, 2_000),
        treeOid: "aa".repeat(20),
        chunks: Array.from({ length: 700 }, () => entry),
      };
    }

    db.transactionSync(() => indexTreeSources(db, sources()));

    expect(db.entryRowCounts).toEqual([548, 152]);
    expect(db.markerRowCounts).toEqual([1_500, 1]);
    expect(inner.storage.statementCount).toBeLessThanOrEqual(10);
  });

  it("rolls back entries and never writes a marker after an injected SQL failure", () => {
    const inner = new TestDatabase();
    initializeTreeSchema(inner);
    const db = new ObservedDatabase(inner);
    db.failEntryInsert = 2;
    const entry = rawEntry("100644", "file");
    const count = 2_500;

    expect(() =>
      db.transactionSync(() => {
        const sink = createTreeIndexSink(db, source(entry.length * count));
        for (let at = 0; at < count; at++) sink.push(entry);
        sink.finish();
      }),
    ).toThrow("injected tree INSERT");

    expect(db.entryInserts).toBe(2);
    expect(db.markerInserts).toBe(0);
    expect(inner.scalar<number>("SELECT COUNT(*) FROM git_tree_entries")).toBe(0);
    expect(inner.scalar<number>("SELECT COUNT(*) FROM git_tree_sources")).toBe(0);
  });
});
