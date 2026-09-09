import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { deflateSync } from "node:zlib";
import { describe, expect, it } from "vitest";
import { concat, utf8 } from "../packages/git/src/common/bytes.js";
import { hashObject } from "../packages/git/src/common/objects.js";
import { SqliteGitDatabase } from "../packages/git/src/store/index.js";
import { encodeDeltaHeader } from "../packages/git/src/store/pack/delta.js";
import { OFFSET_WINDOW } from "../packages/git/src/store/pack/shared.js";
import { TestDatabase } from "./helpers/db.js";
import { GitFixture, slices } from "./helpers/git.js";

function entryHeader(type: number, size: number): Uint8Array {
  const bytes: number[] = [];
  let first = (type << 4) | (size & 15);
  let rest = Math.floor(size / 16);
  while (rest > 0) {
    bytes.push(first | 128);
    first = rest & 127;
    rest = Math.floor(rest / 128);
  }
  bytes.push(first);
  return new Uint8Array(bytes);
}

function offsetDistance(distance: number): Uint8Array {
  const bytes = [distance & 127];
  distance = Math.floor(distance / 128);
  while (distance > 0) {
    distance--;
    bytes.unshift(128 | (distance & 127));
    distance = Math.floor(distance / 128);
  }
  return new Uint8Array(bytes);
}

const BASE = utf8.encode("physical full base\n");
const TARGET = utf8.encode("physical delta target\n");
const BASE_OID = hashObject("blob", BASE);
const TARGET_OID = hashObject("blob", TARGET);

function pack(fillers: number | null): { bytes: Uint8Array; targetOffset: number | null } {
  const header = new Uint8Array(12);
  header.set(utf8.encode("PACK"));
  const view = new DataView(header.buffer);
  view.setUint32(4, 2);
  view.setUint32(8, fillers === null ? 1 : fillers + 2);
  const chunks = [header, entryHeader(3, BASE.length), new Uint8Array(deflateSync(BASE))];
  let offset = chunks.reduce((sum, chunk) => sum + chunk.length, 0);
  if (fillers !== null) {
    for (let index = 0; index < fillers; index++) {
      const data = utf8.encode(`filler ${index}\n`);
      const entry = concat([entryHeader(3, data.length), new Uint8Array(deflateSync(data))]);
      chunks.push(entry);
      offset += entry.length;
    }
    const delta = concat([
      encodeDeltaHeader(BASE.length, TARGET.length),
      new Uint8Array([TARGET.length]),
      TARGET,
    ]);
    chunks.push(
      entryHeader(6, delta.length),
      offsetDistance(offset - 12),
      new Uint8Array(deflateSync(delta)),
    );
  }
  const body = concat(chunks);
  return {
    bytes: concat([body, createHash("sha1").update(body).digest()]),
    targetOffset: fillers === null ? null : offset,
  };
}

describe("pack physical offset membership", () => {
  it.each([
    { prior: true, fillers: OFFSET_WINDOW * 2 - 2, label: "retained offset window" },
    {
      prior: false,
      fillers: OFFSET_WINDOW * 2 - 1,
      label: "evicted offset with canonical base in this pack",
    },
    {
      prior: true,
      fillers: OFFSET_WINDOW * 2 - 1,
      label: "evicted offset with canonical base in older pack",
    },
  ])("accepts native-valid full pack: $label", async ({ prior, fillers, label }) => {
    const native = new GitFixture().init();
    const db = new TestDatabase();
    const database = new SqliteGitDatabase(db, { objectCacheBytes: 0 });
    const checkout = database.createRepository("/repo", "ref: refs/heads/main");
    const store = database.openCheckout(checkout).shared;
    const incoming = pack(fillers);
    try {
      if (prior) {
        execFileSync("git", ["index-pack", "--strict", "--stdin"], {
          cwd: native.dir,
          input: pack(null).bytes,
          stdio: ["pipe", "pipe", "pipe"],
        });
      }
      execFileSync("git", ["index-pack", "--strict", "--stdin"], {
        cwd: native.dir,
        input: incoming.bytes,
        stdio: ["pipe", "pipe", "pipe"],
      });
      expect(native.catFile(TARGET_OID)).toEqual(TARGET);
      if (prior) await store.packs.ingest(slices(pack(null).bytes, 4096));
      let failure: unknown;
      try {
        await store.packs.ingest(slices(incoming.bytes, 4096));
      } catch (error) {
        failure = error;
      }
      const evidence = db.all<{
        base_offset: number;
        canonical_oid: string | null;
        physical_oid: string | null;
      }>(
        `SELECT pending.base_offset, canonical.oid AS canonical_oid, physical.oid AS physical_oid
          FROM git_pack_pending pending
          LEFT JOIN git_pack_objects canonical ON canonical.repo_id = pending.repo_id
            AND canonical.pack_id = pending.pack_id AND canonical.offset = pending.base_offset
          LEFT JOIN git_pack_entries physical ON physical.repo_id = pending.repo_id
            AND physical.pack_id = pending.pack_id AND physical.offset = pending.base_offset
          WHERE pending.repo_id = ? LIMIT 2`,
        store.repoId,
      );
      const cold = new SqliteGitDatabase(db, { objectCacheBytes: 0 }).openCheckout(checkout).shared;
      expect(cold.read(BASE_OID)?.data).toEqual(BASE);
      if (failure !== undefined) expect(cold.has(TARGET_OID)).toBe(false);
      expect(
        failure,
        JSON.stringify({
          label,
          packBytes: incoming.bytes.length,
          targetOffset: incoming.targetOffset,
          evidence,
        }),
      ).toBeUndefined();
      expect(cold.read(TARGET_OID)?.data).toEqual(native.catFile(TARGET_OID));
    } finally {
      native.dispose();
      db.storage.db.close();
    }
  });
});
