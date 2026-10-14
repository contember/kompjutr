import { execFileSync } from "node:child_process";
import { afterEach, describe, expect, it } from "vitest";
import { concat, utf8 } from "../../packages/git/src/common/bytes.js";
import { serializeTree } from "../../packages/git/src/common/objects.js";
import { planTransfer } from "../../packages/git/src/ops/server/transfer.js";
import { streamTransferPack } from "../../packages/git/src/ops/server/transfer-stream.js";
import { type SharedRepoStore, SqliteGitDatabase } from "../../packages/git/src/store/index.js";
import {
  countTransferObjects,
  readTransferObjectPage,
  validateCompleteClosure,
} from "../../packages/git/src/store/transfer/closure.js";
import {
  releaseTransfer,
  type TransferOwner,
} from "../../packages/git/src/store/transfer/lifetime.js";
import { TestDatabase } from "../helpers/db.js";
import { GitFixture, slices } from "../helpers/git.js";

const fixtures: GitFixture[] = [];
afterEach(() => {
  for (const fixture of fixtures.splice(0)) fixture.dispose();
});
function fixture(): GitFixture {
  const git = new GitFixture();
  fixtures.push(git);
  git.git("init", "-q", "-b", "main");
  return git;
}
function open() {
  return new SqliteGitDatabase(new TestDatabase()).createBareRepository();
}
function allOids(store: SharedRepoStore, owner: TransferOwner): string[] {
  const result: string[] = [];
  let after: string | null = null;
  for (;;) {
    const page = readTransferObjectPage(store, owner, Date.now(), after);
    if (page.length === 0) return result;
    result.push(...page);
    after = page[page.length - 1] ?? null;
  }
}
async function pack(store: SharedRepoStore, owner: TransferOwner): Promise<Uint8Array> {
  const chunks: Uint8Array[] = [];
  for await (const chunk of streamTransferPack(store, owner)) chunks.push(chunk);
  return concat(chunks);
}
function install(git: GitFixture, bytes: Uint8Array): void {
  execFileSync("git", ["index-pack", "--stdin"], {
    cwd: git.dir,
    input: bytes,
    stdio: ["pipe", "pipe", "pipe"],
  });
}

describe("server transfer closure and pack stream", () => {
  it("matches Git's reachable set minus common history and emits a usable full pack", async () => {
    const git = fixture();
    git.write("same", "same");
    const common = git.commit("base");
    git.write("nested/new", "new");
    const wanted = git.commit("next");
    git.git("tag", "-a", "v1", "-m", "tag");
    const tag = git.git("rev-parse", "v1");
    const store = open();
    await store.packs.ingest(slices(git.packAll(), 8192));
    const owner = await planTransfer(store, {
      wanted: [{ oid: tag }],
      common: [{ oid: common, type: "commit" }],
    });
    const expected = git
      .git("rev-list", "--objects", tag, `^${common}`)
      .split("\n")
      .map((line) => line.split(" ")[0]);
    expect(new Set(allOids(store, owner))).toEqual(new Set(expected));
    expect(countTransferObjects(store, owner, Date.now())).toBe(expected.length);
    releaseTransfer(store, owner);
    const full = await planTransfer(store, { wanted: [{ oid: tag }] });
    const destination = fixture();
    install(destination, await pack(store, full));
    destination.git("update-ref", "refs/heads/main", wanted);
    destination.git("update-ref", "refs/tags/v1", tag);
    expect(destination.git("fsck", "--full")).toBe("");
    expect(destination.git("show", "main:nested/new")).toBe("new");
  });

  it("matches Git for merged and divergent histories, shared trees, nested tags, and a local gitlink", async () => {
    const git = fixture();
    git.write("shared/file", "shared");
    const base = git.commit("base");
    git.git("checkout", "-q", "-b", "left");
    git.write("left", "left");
    const left = git.commit("left");
    git.git("checkout", "-q", "-b", "right", base);
    git.write("right", "right");
    const right = git.commit("right");
    git.git("checkout", "-q", "left");
    git.git("merge", "--no-ff", "-q", "-m", "merge", "right");
    const merged = git.git("rev-parse", "HEAD");
    const foreignTree = git.gitInput("", "mktree");
    const foreign = git.gitInput("foreign", "commit-tree", foreignTree);
    git.git("update-index", "--add", "--cacheinfo", `160000,${foreign},submodule`);
    git.git("commit", "-q", "-m", "gitlink");
    const linked = git.git("rev-parse", "HEAD");
    git.git("tag", "-a", "inner", linked, "-m", "inner");
    git.git("tag", "-a", "outer", "inner", "-m", "outer");
    const tag = git.git("rev-parse", "outer");
    const store = open();
    await store.packs.ingest(slices(git.packAll(), 8192));
    expect(store.write("tree", git.gitBinary("cat-file", "tree", foreignTree))).toBe(foreignTree);
    expect(store.write("commit", git.gitBinary("cat-file", "commit", foreign))).toBe(foreign);
    for (const common of [base, left, right, merged]) {
      const owner = await planTransfer(store, {
        wanted: [{ oid: tag }],
        common: [{ oid: common }],
      });
      const expected = git
        .git("rev-list", "--objects", tag, `^${common}`)
        .split("\n")
        .map((line) => line.split(" ")[0]);
      expect(new Set(allOids(store, owner))).toEqual(new Set(expected));
      expect(allOids(store, owner)).not.toContain(foreign);
      releaseTransfer(store, owner);
    }
    const divergent = await planTransfer(store, {
      wanted: [{ oid: right }],
      common: [{ oid: left }],
    });
    const expected = git
      .git("rev-list", "--objects", right, `^${left}`)
      .split("\n")
      .map((line) => line.split(" ")[0]);
    expect(new Set(allOids(store, divergent))).toEqual(new Set(expected));
    releaseTransfer(store, divergent);
  });

  it("clones history beyond the client's push commit bound with a durable paged plan", async () => {
    const git = fixture();
    const tree = git.gitInput("", "mktree");
    let tip = git.gitInput("root", "commit-tree", tree);
    for (let index = 0; index < 520; index++)
      tip = git.gitInput(`commit ${index}`, "commit-tree", tree, "-p", tip);
    git.git("update-ref", "refs/heads/main", tip);
    const store = open();
    await store.packs.ingest(slices(git.packAll(), 8192));
    let yields = 0;
    const owner = await planTransfer(
      store,
      { wanted: [{ oid: tip }] },
      {
        yieldNow: async () => {
          yields++;
        },
      },
    );
    expect(yields).toBeGreaterThan(1);
    expect(countTransferObjects(store, owner, Date.now())).toBe(522);
    const destination = fixture();
    install(destination, await pack(store, owner));
    destination.git("update-ref", "refs/heads/main", tip);
    expect(destination.git("rev-list", "--count", "main")).toBe("521");
    expect(destination.git("fsck", "--full")).toBe("");
  });

  it("excludes local gitlink targets and rejects missing or mismatched required edges", () => {
    const store = open();
    const blob = store.write("blob", utf8.encode("unrelated"));
    const tree = store.write("tree", serializeTree([{ mode: "160000", name: "sub", oid: blob }]));
    expect(() => validateCompleteClosure(store, [{ oid: tree, type: "tree" }])).not.toThrow();
    const missing = "1234567890123456789012345678901234567890";
    const broken = store.write(
      "tag",
      utf8.encode(`object ${missing}\ntype blob\ntag broken\n\nmissing\n`),
    );
    expect(() => validateCompleteClosure(store, [{ oid: broken }])).toThrow();
    const mismatch = store.write(
      "tag",
      utf8.encode(`object ${blob}\ntype tree\ntag bad\n\nwrong type\n`),
    );
    expect(() => validateCompleteClosure(store, [{ oid: blob }, { oid: mismatch }])).toThrow(
      /expected tree/,
    );
  });
});
