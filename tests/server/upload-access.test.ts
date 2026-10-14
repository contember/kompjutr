import { afterEach, describe, expect, it } from "vitest";
import { concat, utf8 } from "../../packages/git/src/common/bytes.js";
import type { ServerRuntime } from "../../packages/git/src/ops/server/runtime.js";
import { uploadPack } from "../../packages/git/src/ops/server/upload.js";
import type { ServerUploadRequest } from "../../packages/git/src/protocol/server/index.js";
import { type SharedRepoStore, SqliteGitDatabase } from "../../packages/git/src/store/index.js";
import { TestDatabase } from "../helpers/db.js";
import { GitFixture, slices } from "../helpers/git.js";
import { frames, packetText } from "../helpers/server-oracle.js";
import { runGit } from "../helpers/server-oracle-http.js";

const fixtures: GitFixture[] = [];
afterEach(() => {
  for (const git of fixtures.splice(0)) git.dispose();
});
function fixture(): GitFixture {
  const git = new GitFixture().init();
  fixtures.push(git);
  return git;
}
function runtime(signal = new AbortController().signal): ServerRuntime {
  return { now: Date.now, yieldNow: async () => {}, signal };
}
function request(want: string, haves: string[] = []): ServerUploadRequest {
  return { wants: [want], haves, done: true, detailedAck: true, sideband: false };
}
async function collect(body: AsyncIterable<Uint8Array>): Promise<Buffer> {
  const chunks: Uint8Array[] = [];
  for await (const chunk of body) chunks.push(chunk);
  return Buffer.from(concat(chunks));
}
function live(store: SharedRepoStore): number | undefined {
  return store.db.scalar<number>(
    "SELECT count(*) FROM git_transfers WHERE repo_id = ? AND released = 0",
    store.repoId,
  );
}
async function populated() {
  const git = fixture();
  git.write("public", "visible");
  const main = git.commit("public");
  git.git("checkout", "--orphan", "private");
  git.remove("public").write("private", "secret");
  const hidden = git.commit("private");
  git.git("tag", "-a", "release", "-m", "release", main);
  const tag = git.git("rev-parse", "release");
  const store = new SqliteGitDatabase(new TestDatabase()).createBareRepository();
  await store.packs.ingest(slices(git.packAll(), 8192));
  store.setRef("refs/heads/main", main);
  store.setRef("refs/private/secret", hidden);
  store.setRef("refs/tags/release", tag);
  return { git, store, main, hidden, tag };
}

describe("upload access and ownership", () => {
  it("rejects hidden, arbitrary stored and stale wants but accepts advertised peeled targets", async () => {
    const { store, main, hidden } = await populated();
    const blob = store.write("blob", utf8.encode("unadvertised"));
    for (const oid of [hidden, blob, "1".repeat(40)]) {
      await expect(uploadPack(store, request(oid), runtime())).rejects.toMatchObject({
        code: "EINVALIDREF",
      });
    }
    store.deleteRef("refs/heads/main");
    const response = await collect(await uploadPack(store, request(main), runtime()));
    expect(packetText(response)).toEqual(["NAK\n"]);
    expect(frames(response).rest.subarray(0, 4).toString()).toBe("PACK");
    store.deleteRef("refs/tags/release");
    await expect(uploadPack(store, request(main), runtime())).rejects.toMatchObject({
      code: "EINVALIDREF",
    });
    expect(live(store)).toBe(0);
  });

  it("never acknowledges a hidden stored have and produces the full native-valid closure", async () => {
    const { store, main, hidden } = await populated();
    const bytes = await collect(await uploadPack(store, request(main, [hidden]), runtime()));
    expect(packetText(bytes)).toEqual(["NAK\n"]);
    const destination = fixture();
    await runGit(destination.dir, ["index-pack", "--stdin"], frames(bytes).rest);
    destination.git("update-ref", "refs/heads/main", main);
    await runGit(destination.dir, ["fsck", "--full"]);
    expect(destination.gitResult("cat-file", "-e", hidden).status).not.toBe(0);
    expect(live(store)).toBe(0);
  });

  it("releases a response cancelled before first next, and an unconsumed aborted response", async () => {
    const { store, main } = await populated();
    const body = await uploadPack(store, request(main), runtime());
    expect(live(store)).toBe(1);
    await body[Symbol.asyncIterator]().return?.();
    expect(live(store)).toBe(0);
    const abort = new AbortController();
    const unconsumed = await uploadPack(store, request(main), runtime(abort.signal));
    expect(live(store)).toBe(1);
    abort.abort();
    expect(live(store)).toBe(0);
    await expect(unconsumed[Symbol.asyncIterator]().next()).rejects.toMatchObject({
      code: "EABORTED",
    });
  });

  it("keeps accepted roots after refs move and releases on midstream cancellation", async () => {
    const { store, main, hidden } = await populated();
    const body = await uploadPack(store, request(main), runtime());
    store.setRef("refs/heads/main", hidden);
    store.deleteRef("refs/tags/release");
    const bytes = await collect(body);
    const destination = fixture();
    await runGit(destination.dir, ["index-pack", "--stdin"], frames(bytes).rest);
    expect(destination.git("show", `${main}:public`)).toBe("visible");
    expect(live(store)).toBe(0);
    const next = await uploadPack(store, request(hidden), runtime());
    const iterator = next[Symbol.asyncIterator]();
    await iterator.next();
    await iterator.next();
    await iterator.return?.();
    expect(live(store)).toBe(0);
  });

  it("aborts a planning yield without leaking retained roots", async () => {
    const git = fixture();
    for (let index = 0; index < 80; index++) git.write(`file-${index}`, `content-${index}`);
    const main = git.commit("wide tree");
    const store = new SqliteGitDatabase(new TestDatabase()).createBareRepository();
    await store.packs.ingest(slices(git.packAll(), 8192));
    store.setRef("refs/heads/main", main);
    const abort = new AbortController();
    let entered = false;
    const operation = uploadPack(store, request(main), {
      now: Date.now,
      signal: abort.signal,
      yieldNow: () => {
        entered = true;
        abort.abort();
        return new Promise<void>(() => {});
      },
    });
    await expect(operation).rejects.toMatchObject({ code: "EABORTED" });
    expect(entered).toBe(true);
    expect(live(store)).toBe(0);
  });

  it("rejects an expired response before opening its pack reader", async () => {
    const { store, main } = await populated();
    let now = 0;
    const body = await uploadPack(store, request(main), { ...runtime(), now: () => now });
    const iterator = body[Symbol.asyncIterator]();
    expect((await iterator.next()).done).toBe(false);
    now = 5 * 60 * 1000;
    await expect(iterator.next()).rejects.toMatchObject({ code: "ESTALE" });
    expect(live(store)).toBe(0);
  });

  it("can abort an unconsumed response after its repository was destroyed", async () => {
    const { store, main } = await populated();
    const abort = new AbortController();
    const body = await uploadPack(store, request(main), runtime(abort.signal));
    store.destroy();
    expect(() => abort.abort()).not.toThrow();
    await expect(body[Symbol.asyncIterator]().next()).rejects.toMatchObject({ code: "EABORTED" });
  });
});
