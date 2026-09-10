import { execFileSync } from "node:child_process";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { SqliteGitDatabase } from "../packages/git/src/store/index.js";
import { TestDatabase } from "./helpers/db.js";
import { GitFixture } from "./helpers/git.js";

const native = new GitFixture().init();
let pack: Uint8Array = new Uint8Array(0);
let objects: string[] = [];
const nativeObjects = new Map<string, Uint8Array>();

beforeAll(() => {
  native.write("content.txt", "checksum lookbehind\n".repeat(100));
  native.commit("checksum fixture");
  pack = native.packAll();
  objects = native
    .git("rev-list", "--all", "--objects")
    .split("\n")
    .map((line) => line.split(" ")[0]!);
  for (const oid of objects) {
    const type = native.git("cat-file", "-t", oid);
    nativeObjects.set(oid, new Uint8Array(native.gitBinary("cat-file", type, oid)));
  }
});

afterAll(() => native.dispose());

async function verify(source: AsyncIterable<Uint8Array>): Promise<void> {
  const db = new TestDatabase();
  try {
    const database = new SqliteGitDatabase(db);
    const checkout = database.createRepository("/repo", "ref: refs/heads/main");
    const store = database.openCheckout(checkout).shared;
    const result = await store.packs.ingest(source);
    expect(result.bytes).toBe(pack.length);
    const cold = new SqliteGitDatabase(db).openCheckout(checkout).shared;
    for (const oid of objects) expect(cold.read(oid)?.data).toEqual(nativeObjects.get(oid));
  } finally {
    db.storage.db.close();
  }
}

async function* chunks(sizes: readonly number[]): AsyncGenerator<Uint8Array> {
  let offset = 0;
  let index = 0;
  while (offset < pack.length) {
    const size = sizes[index++ % sizes.length]!;
    yield pack.subarray(offset, offset + size);
    offset += Math.min(size, pack.length - offset);
  }
}

describe("streamed pack checksum lookbehind", () => {
  it.each(Array.from({ length: 21 }, (_, index) => index))(
    "accepts the native pack with %i trailer bytes in the first trailer slice",
    async (split) => {
      async function* source(): AsyncGenerator<Uint8Array> {
        yield pack.subarray(0, pack.length - 20);
        yield pack.subarray(pack.length - 20, pack.length - 20 + split);
        yield new Uint8Array(0);
        yield pack.subarray(pack.length - 20 + split);
      }
      await verify(source());
    },
  );

  it.each([
    { name: "one-byte slices", sizes: [1] },
    { name: "exactly twenty bytes", sizes: [20] },
    { name: "larger slices", sizes: [64] },
    { name: "short initial tail followed by a large slice", sizes: [3, 64] },
    { name: "empty slices between short and large slices", sizes: [0, 7, 0, 20, 0, 64] },
  ])("accepts $name", async ({ sizes }) => {
    await verify(chunks(sizes));
  });

  it.each([7, 20, 64])("preserves reused Buffer input of %i bytes", async (size) => {
    async function* source(): AsyncGenerator<Uint8Array> {
      const buffer = Buffer.alloc(size);
      for (let offset = 0; offset < pack.length; offset += size) {
        const input = pack.subarray(offset, offset + size);
        buffer.set(input);
        yield buffer.subarray(0, input.length);
        buffer.fill(0xff);
      }
    }
    await verify(source());
  });

  it.each(["checksum", "minimum length"])("rejects native-invalid %s", async (kind) => {
    const invalid = kind === "checksum" ? new Uint8Array(pack) : pack.subarray(0, 31);
    if (kind === "checksum") invalid[invalid.length - 1] = invalid[invalid.length - 1]! ^ 1;
    expect(() =>
      execFileSync("git", ["index-pack", "--strict", "--stdin"], {
        cwd: native.dir,
        input: invalid,
        stdio: ["pipe", "pipe", "pipe"],
      }),
    ).toThrow();
    const db = new TestDatabase();
    try {
      const database = new SqliteGitDatabase(db);
      const checkout = database.createRepository("/repo", "ref: refs/heads/main");
      const store = database.openCheckout(checkout).shared;
      async function* source(): AsyncGenerator<Uint8Array> {
        yield invalid;
      }
      await expect(store.packs.ingest(source())).rejects.toThrow(
        kind === "checksum" ? /checksum/ : /too small/,
      );
      const cold = new SqliteGitDatabase(db).openCheckout(checkout).shared;
      for (const oid of objects) expect(cold.has(oid)).toBe(false);
    } finally {
      db.storage.db.close();
    }
  });
});
