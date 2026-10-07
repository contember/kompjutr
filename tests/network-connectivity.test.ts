import { describe, expect, it, vi } from "vitest";
import { concat, utf8 } from "../packages/git/src/common/bytes.js";
import {
  hashObject,
  MODE_FILE,
  MODE_TREE,
  type ObjectType,
  serializeTree,
} from "../packages/git/src/common/objects.js";
import { fetchInto } from "../packages/git/src/ops/network/network.js";
import { validateFetchedConnectivity } from "../packages/git/src/ops/network/network-connectivity.js";
import { hydratePromisedBlobs } from "../packages/git/src/ops/network/network-promisor.js";
import type { Repository } from "../packages/git/src/ops/repository/repository.js";
import { MAX_BLOB_BATCH_OIDS } from "../packages/git/src/store/objects/objects.js";
import { PackWriter } from "../packages/git/src/store/pack/writer.js";
import { commitObject, packRemote } from "./helpers/fetch-pack.js";
import { slices } from "./helpers/git.js";
import { startStubServer } from "./helpers/http-backend.js";
import { makeRepo } from "./helpers/workspace.js";

const REMOTE = "https://example.test/repo.git";

interface PackObject {
  type: ObjectType;
  data: Uint8Array;
}

function packOf(objects: readonly PackObject[]): Uint8Array {
  const chunks: Uint8Array[] = [];
  const writer = new PackWriter((chunk) => chunks.push(chunk));
  writer.header(objects.length);
  for (const object of objects) writer.object(object.type, object.data);
  writer.finish();
  return concat(chunks);
}

function packet(payload: Uint8Array): Uint8Array {
  return concat([utf8.encode((payload.length + 4).toString(16).padStart(4, "0")), payload]);
}

// A pkt-line carries at most 65,516 payload bytes, one of which names the band.
function sidebandPackets(pack: Uint8Array): Uint8Array[] {
  const packets: Uint8Array[] = [];
  for (let offset = 0; offset < pack.length; offset += 65_515) {
    packets.push(packet(concat([new Uint8Array([1]), pack.subarray(offset, offset + 65_515)])));
  }
  return packets;
}

/** A protocol v0 remote that answers every upload-pack request with one fixed pack. */
async function packServer(pack: Uint8Array, tip: string) {
  const advertisement = concat([
    packet(utf8.encode("# service=git-upload-pack\n")),
    utf8.encode("0000"),
    packet(utf8.encode(`${tip} HEAD\0side-band-64k allow-reachable-sha1-in-want\n`)),
    utf8.encode("0000"),
  ]);
  const response = concat([
    packet(utf8.encode("NAK\n")),
    ...sidebandPackets(pack),
    utf8.encode("0000"),
  ]);
  return startStubServer((request, reply) => {
    reply.setHeader(
      "Content-Type",
      request.method === "POST"
        ? "application/x-git-upload-pack-result"
        : "application/x-git-upload-pack-advertisement",
    );
    reply.end(request.method === "POST" ? response : advertisement);
  });
}

/** Fetch, filtered, `count` trees that each name the same blob once plus one blob of their own. */
async function sharedBlobFetch(count: number, before: (repo: Repository) => Promise<void>) {
  const shared = hashObject("blob", utf8.encode("shared"));
  const trees = Array.from({ length: count }, (_, index) =>
    serializeTree([
      { mode: MODE_FILE, name: `shared-${index}`, oid: shared },
      { mode: MODE_FILE, name: `own-${index}`, oid: hashObject("blob", utf8.encode(`${index}`)) },
    ]),
  );
  const root = serializeTree(
    trees.map((data, index) => ({
      mode: MODE_TREE,
      name: `dir-${String(index).padStart(3, "0")}`,
      oid: hashObject("tree", data),
    })),
  );
  const commit = commitObject(hashObject("tree", root));
  const server = await packRemote(
    packOf([
      commit,
      { type: "tree", data: root },
      ...trees.map((data): PackObject => ({ type: "tree", data })),
    ]),
    commit.oid,
    { filter: true },
  );
  const { repo, context } = makeRepo("/work");
  try {
    repo.store.configSet("remote.origin.url", server.url);
    await before(repo);
    const run = vi.spyOn(repo.store.db, "run");
    await fetchInto(context, repo, { remote: "origin", tags: false, filter: "blob:none" });
    return { db: repo.store.db, store: repo.store, run, shared };
  } finally {
    await server.close();
  }
}

describe("set-based promise insert", () => {
  it("plans availability probes over distinct candidates, not tree edges", async () => {
    const fixture = await sharedBlobFetch(64, async () => {});
    const insert = fixture.run.mock.calls.find(([query]) =>
      query.includes("INSERT INTO git_promised"),
    );
    if (insert === undefined) throw new Error("promise insert was not observed");
    const [query, ...bindings] = insert;
    const candidates = bindings.find(
      (binding) => typeof binding === "string" && binding.startsWith("["),
    );
    if (typeof candidates !== "string") throw new Error("promise candidates were not bound");
    expect(JSON.parse(candidates)).toHaveLength(65);
    const plan = fixture.db
      .all<{ detail: string }>(`EXPLAIN QUERY PLAN ${query}`, ...bindings)
      .map((row) => row.detail);
    expect(fixture.store.promisedBlobCount()).toBe(65);
    expect(fixture.store.promisedMissing([fixture.shared])).toEqual([fixture.shared]);
    const scan = plan.findIndex((detail) => detail.startsWith("SCAN candidate"));
    const probe = plan.findIndex((detail) => detail.startsWith("SEARCH loose"));
    expect(scan).toBeGreaterThanOrEqual(0);
    expect(probe).toBeGreaterThan(scan);
  });

  it("does not promise a blob that a complete pack already holds", async () => {
    const fixture = await sharedBlobFetch(4, async (repo) => {
      await repo.store.packs.ingest(
        slices(packOf([{ type: "blob", data: utf8.encode("shared") }]), 4096),
      );
    });
    expect(fixture.store.promisedBlobCount()).toBe(4);
    expect(fixture.store.promisedMissing([fixture.shared])).toEqual([]);
  });
});

describe("fetched graph connectivity failures", () => {
  const validate = (repo: ReturnType<typeof makeRepo>["repo"], roots: string[]) =>
    repo.store.db.transactionSync(() => validateFetchedConnectivity(repo, roots, new Set()));

  it("rejects a subtree entry whose object is a blob", () => {
    const { repo } = makeRepo("/work");
    const blob = repo.store.write("blob", utf8.encode("not a tree"));
    const root = repo.store.write(
      "tree",
      serializeTree([{ mode: MODE_TREE, name: "dir", oid: blob }]),
    );
    expect(() => validate(repo, [root])).toThrowError(
      expect.objectContaining({
        code: "ECORRUPT",
        message: `tree ${blob} has no complete parsed source`,
      }),
    );
  });

  it("rejects a file entry whose object is a tree", () => {
    const { repo } = makeRepo("/work");
    const leaf = repo.store.write("blob", utf8.encode("leaf"));
    const tree = repo.store.write(
      "tree",
      serializeTree([{ mode: MODE_FILE, name: "leaf", oid: leaf }]),
    );
    const root = repo.store.write(
      "tree",
      serializeTree([{ mode: MODE_FILE, name: "file", oid: tree }]),
    );
    expect(() => validate(repo, [root])).toThrowError(
      expect.objectContaining({
        code: "ECORRUPT",
        message: `fetched graph requires ${tree} to be a blob`,
      }),
    );
  });

  it("rejects a subtree present only in an incomplete pack", async () => {
    const { repo } = makeRepo("/work");
    const blob = repo.store.write("blob", utf8.encode("file"));
    const subtree = serializeTree([{ mode: MODE_FILE, name: "file", oid: blob }]);
    const subtreeOid = hashObject("tree", subtree);
    await expect(
      repo.store.packs.ingest(slices(packOf([{ type: "tree", data: subtree }]), 4096), {
        lifecycle: {
          reserved: () => undefined,
          published: () => {
            throw new Error("interrupted publication");
          },
        },
      }),
    ).rejects.toThrow(/interrupted publication/);
    expect(repo.store.db.all("SELECT state FROM git_pack_meta")).toEqual([{ state: "pending" }]);
    expect(
      repo.store.db.scalar("SELECT complete FROM git_tree_sources WHERE tree_oid = ?", subtreeOid),
    ).toBe(1);
    const root = repo.store.write(
      "tree",
      serializeTree([{ mode: MODE_TREE, name: "dir", oid: subtreeOid }]),
    );
    expect(repo.store.has(subtreeOid)).toBe(false);
    expect(() => validate(repo, [root])).toThrowError(
      expect.objectContaining({
        code: "EFETCHFAIL",
        message: "fetched graph references a missing object",
      }),
    );
  });

  it("rejects a blob present only in an incomplete pack", async () => {
    const { repo } = makeRepo("/work");
    const data = utf8.encode("pending");
    await expect(
      repo.store.packs.ingest(slices(packOf([{ type: "blob", data }]), 4096), {
        lifecycle: {
          reserved: () => undefined,
          published: () => {
            throw new Error("interrupted publication");
          },
        },
      }),
    ).rejects.toThrow(/interrupted publication/);
    expect(repo.store.db.all("SELECT state FROM git_pack_meta")).toEqual([{ state: "pending" }]);
    const root = repo.store.write(
      "tree",
      serializeTree([{ mode: MODE_FILE, name: "file", oid: hashObject("blob", data) }]),
    );
    expect(() => validate(repo, [root])).toThrowError(
      expect.objectContaining({
        code: "EFETCHFAIL",
        message: "fetched graph references a missing object",
      }),
    );
  });

  it("does not let a promise exempt an object that is physically a tree", () => {
    const { repo } = makeRepo("/work");
    const leaf = repo.store.write("blob", utf8.encode("leaf"));
    const tree = serializeTree([{ mode: MODE_FILE, name: "leaf", oid: leaf }]);
    const treeOid = hashObject("tree", tree);
    repo.store.registerPromisorRemote("origin", REMOTE);
    repo.store.addPromisedBlobs("origin", [treeOid]);
    repo.store.write("tree", tree);
    const root = repo.store.write(
      "tree",
      serializeTree([{ mode: MODE_FILE, name: "file", oid: treeOid }]),
    );
    expect(() => validate(repo, [root])).toThrowError(
      expect.objectContaining({
        code: "ECORRUPT",
        message: `fetched graph requires ${treeOid} to be a blob`,
      }),
    );
  });
});

describe("promisor hydration response", () => {
  async function hydrate(promised: string | string[], pack: Uint8Array) {
    const wants = typeof promised === "string" ? [promised] : promised;
    const { repo, context } = makeRepo("/work");
    const server = await packServer(pack, wants[0] ?? "");
    try {
      repo.store.configSet("remote.origin.url", server.url);
      repo.store.registerPromisorRemote("origin", server.url);
      repo.store.addPromisedBlobs("origin", wants);
      return await hydratePromisedBlobs(context, repo, wants).then(
        () => null,
        (error: unknown) => error,
      );
    } finally {
      await server.close();
    }
  }

  it("rejects a response that omits a requested blob", async () => {
    const wanted = hashObject("blob", utf8.encode("wanted"));
    const outcome = await hydrate(
      wanted,
      packOf([{ type: "blob", data: utf8.encode("something else") }]),
    );
    expect(outcome).toMatchObject({
      code: "EFETCHFAIL",
      message: "promisor remote did not return every requested blob",
    });
  });

  it("rejects a response whose requested object is not a blob", async () => {
    const tree = serializeTree([
      { mode: MODE_FILE, name: "file", oid: hashObject("blob", utf8.encode("x")) },
    ]);
    const wanted = hashObject("tree", tree);
    const outcome = await hydrate(wanted, packOf([{ type: "tree", data: tree }]));
    expect(outcome).toMatchObject({
      code: "ECORRUPT",
      message: `promisor returned a non-blob object for ${wanted}`,
    });
  });

  it("reports a missing want on a later page over a wrong type on an earlier page", async () => {
    const tree = serializeTree([
      { mode: MODE_FILE, name: "file", oid: hashObject("blob", utf8.encode("x")) },
    ]);
    const blobs = Array.from({ length: MAX_BLOB_BATCH_OIDS }, (_, index) =>
      utf8.encode(`returned ${index}`),
    );
    const missing = hashObject("blob", utf8.encode("never returned"));
    const outcome = await hydrate(
      [hashObject("tree", tree), ...blobs.map((data) => hashObject("blob", data)), missing],
      packOf([
        { type: "tree", data: tree },
        ...blobs.map((data): PackObject => ({ type: "blob", data })),
      ]),
    );
    expect(outcome).toMatchObject({
      code: "EFETCHFAIL",
      message: "promisor remote did not return every requested blob",
    });
  });

  it("accepts a response that holds every requested blob", async () => {
    const data = utf8.encode("wanted");
    const wanted = hashObject("blob", data);
    expect(await hydrate(wanted, packOf([{ type: "blob", data }]))).toBeNull();
  });
});
