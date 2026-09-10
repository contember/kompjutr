import { writeFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { concat, utf8 } from "../packages/git/src/common/bytes.js";
import { openRepository } from "../packages/git/src/ops/core/context.js";
import { fetchInto } from "../packages/git/src/ops/network/network.js";
import { SqliteGitDatabase } from "../packages/git/src/store/index.js";
import { MAX_BLOB_BATCH_OIDS, OBJECT_CHUNK } from "../packages/git/src/store/objects/objects.js";
import { PackWriter } from "../packages/git/src/store/pack/writer.js";
import { TestDatabase } from "./helpers/db.js";
import { GitFixture, slices } from "./helpers/git.js";
import { startGitServer } from "./helpers/http-backend.js";
import { publicationState } from "./helpers/network-integrity.js";
import { makeRepo } from "./helpers/workspace.js";

interface Instruction {
  addr: number;
  opcode: string;
  p1: number;
  p2: number;
  p3: number;
  p4: string | null;
  p5: number;
}

class MetadataDatabase extends TestDatabase {
  observe: ((query: string, bindings: unknown[]) => void) | undefined;

  override all<Row extends object>(query: string, ...bindings: unknown[]): Row[] {
    if (query.startsWith("WITH wanted(ordinal, oid)") && query.includes("git_object_chunks")) {
      this.observe?.(query, bindings);
    }
    return super.all<Row>(query, ...bindings);
  }
}

function chunkAccess(db: TestDatabase, query: string, bindings: unknown[]) {
  return db
    .all<{ detail: string }>(`EXPLAIN QUERY PLAN ${query}`, ...bindings)
    .map((row) => row.detail)
    .filter((detail) => /(?:SEARCH|SCAN) chunk\b/.test(detail));
}

function randomPayload(size: number): Uint8Array {
  const data = new Uint8Array(size);
  let state = 0x12345678;
  for (let index = 0; index < data.length; index++) {
    state ^= state << 13;
    state ^= state >>> 17;
    state ^= state << 5;
    data[index] = state & 255;
  }
  return data;
}

describe("object metadata lookup growth", () => {
  it("probes wanted loose OIDs and materializes lengths before the grouping sorter", () => {
    const db = new MetadataDatabase();
    const database = new SqliteGitDatabase(db);
    const checkout = database.createRepository("/repo", "ref: refs/heads/main");
    const store = database.openCheckout(checkout).shared;
    try {
      for (let index = 0; index < 1024; index++)
        store.write("blob", utf8.encode(`unrelated ${index}`));
      const oid = store.write("blob", randomPayload(OBJECT_CHUNK + 137));
      let observed = false;
      db.observe = (query, bindings) => {
        const plan = db.all<{ detail: string }>(`EXPLAIN QUERY PLAN ${query}`, ...bindings);
        const bytecode = db.all<Instruction>(`EXPLAIN ${query}`, ...bindings);
        const evidence = process.env.KOMPJUTR_OBJECT_QUERY_EVIDENCE;
        if (evidence !== undefined)
          writeFileSync(evidence, `${JSON.stringify({ query, plan, bytecode }, null, 2)}\n`);
        observed = true;
        expect(chunkAccess(db, query, bindings)).toEqual([
          expect.stringContaining("(repo_id=? AND oid=?)"),
        ]);
        const length = bytecode.find((row) => row.opcode === "Function" && row.p4 === "length(1)");
        expect(length).toBeDefined();
        if (length === undefined) throw new Error("missing length instruction");
        const record = bytecode.find(
          (row) =>
            row.addr > length.addr &&
            row.opcode === "MakeRecord" &&
            row.p1 <= length.p3 &&
            row.p1 + row.p2 > length.p3,
        );
        if (record === undefined) throw new Error("length is not materialized in a record");
        const insert = bytecode.find(
          (row) => row.addr > record.addr && row.opcode === "Insert" && row.p2 === record.p3,
        );
        if (insert === undefined) throw new Error("length record is not materialized");
        const sorter = bytecode.find((row) => row.opcode === "SorterInsert");
        if (sorter === undefined) throw new Error("fixture does not exercise the grouping sorter");
        const sorterRecord = bytecode
          .filter(
            (row) => row.addr < sorter.addr && row.opcode === "MakeRecord" && row.p3 === sorter.p2,
          )
          .at(-1);
        if (sorterRecord === undefined) throw new Error("missing sorter record");
        const inputs = bytecode
          .filter(
            (row) =>
              row.addr < sorterRecord.addr &&
              row.opcode === "Column" &&
              row.p3 >= sorterRecord.p1 &&
              row.p3 < sorterRecord.p1 + sorterRecord.p2,
          )
          .slice(-sorterRecord.p2);
        expect(inputs).toHaveLength(3);
        expect(inputs.map((row) => row.p1)).toEqual([insert.p1, insert.p1, insert.p1]);
        expect(inputs.map((row) => row.p2)).toEqual([0, 1, 2]);
      };
      expect(store.objectInfo([oid])[0]).toMatchObject({
        oid,
        type: "blob",
        source: "loose",
        chunkRows: 2,
      });
      expect(observed).toBe(true);
    } finally {
      db.storage.db.close();
    }
  });

  it("preserves mixed source metadata, duplicate order, and loose precedence", async () => {
    const db = new TestDatabase();
    const database = new SqliteGitDatabase(db);
    const checkout = database.createRepository("/repo", "ref: refs/heads/main");
    const store = database.openCheckout(checkout).shared;
    try {
      const payload = randomPayload(OBJECT_CHUNK + 137);
      const loose = store.write("blob", payload);
      const empty = store.write("blob", new Uint8Array());
      const compressed = store.write("blob", new Uint8Array(65536));
      const packedData = utf8.encode("packed-only\n");
      const chunks: Uint8Array[] = [];
      const writer = new PackWriter((chunk) => chunks.push(chunk));
      writer.header(2);
      writer.object("blob", payload);
      writer.object("blob", packedData);
      writer.finish();
      await store.packs.ingest(slices(concat(chunks), 4096));
      const packed = store.write("blob", packedData);
      expect(store.objectInfo([packed, loose, empty, compressed, loose])).toEqual([
        { oid: packed, type: "blob", size: packedData.length, source: "pack", chunkRows: 0 },
        { oid: loose, type: "blob", size: payload.length, source: "loose", chunkRows: 2 },
        { oid: empty, type: "blob", size: 0, source: "loose", chunkRows: 1 },
        { oid: compressed, type: "blob", size: 65536, source: "loose", chunkRows: 1 },
      ]);
    } finally {
      db.storage.db.close();
    }
  });

  it("keeps unchanged legacy fetch metadata pages selective in a populated loose repository", async () => {
    const fixture = new GitFixture().init();
    const workspace = makeRepo("/repo");
    const db = new MetadataDatabase(workspace.storage);
    const context = { ...workspace.context, database: new SqliteGitDatabase(db) };
    const repo = openRepository(context, "/repo");
    const server = await startGitServer(fixture.dir);
    try {
      for (let index = 0; index <= MAX_BLOB_BATCH_OIDS; index++) {
        const content = `file ${index}\n`;
        fixture.write(`file-${index}.txt`, content);
        repo.store.write("blob", utf8.encode(content));
      }
      const head = fixture.commit("many loose files");
      const tree = fixture.git("rev-parse", "HEAD^{tree}");
      repo.store.write("tree", fixture.gitBinary("cat-file", "tree", tree));
      repo.store.write("commit", fixture.catFile(head));
      repo.store.setRef("refs/heads/main", head);
      repo.store.setRef("refs/remotes/origin/main", head);
      repo.store.setRef("refs/remotes/origin/HEAD", "ref: refs/remotes/origin/main");
      let fullPages = 0;
      let tailPages = 0;
      db.observe = (query, bindings) => {
        const value = bindings[0];
        if (typeof value !== "string") throw new Error("metadata wanted input is missing");
        const wanted: unknown = JSON.parse(value);
        if (!Array.isArray(wanted)) throw new Error("metadata wanted input is not an array");
        if (wanted.length === MAX_BLOB_BATCH_OIDS) fullPages++;
        else if (wanted.length > 1) tailPages++;
        expect(chunkAccess(db, query, bindings)).toEqual([
          expect.stringContaining("(repo_id=? AND oid=?)"),
        ]);
      };
      const before = publicationState(repo);
      await fetchInto(context, repo, {
        remote: "origin",
        url: server.url,
        singleBranch: true,
        tags: false,
      });
      expect(fullPages).toBeGreaterThan(0);
      expect(tailPages).toBeGreaterThan(0);
      expect(server.requests.filter((request) => request.method === "POST")).toHaveLength(0);
      expect(publicationState(repo)).toEqual(before);
    } finally {
      await server.close();
      fixture.dispose();
      workspace.storage.db.close();
    }
  });
});
