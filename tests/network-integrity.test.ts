import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";
import { concat } from "../packages/git/src/common/bytes.js";
import { openRepository } from "../packages/git/src/ops/core/context.js";
import { clone, fetchInto } from "../packages/git/src/ops/network/network.js";
import { maintenance } from "../packages/git/src/ops/repository/maintenance.js";
import { GC_GRACE_MS } from "../packages/git/src/store/maintenance/sweep.js";
import { PackWriter } from "../packages/git/src/store/pack/writer.js";
import { GitFixture, slices } from "./helpers/git.js";
import { startGitServer, startStubServer } from "./helpers/http-backend.js";
import { faultyRemote, nativeClone, publicationState } from "./helpers/network-integrity.js";
import { reopenTestRepository } from "./helpers/repository-invariants.js";
import { makeRepo, makeWorkspace } from "./helpers/workspace.js";

const execFileAsync = promisify(execFile);
const utf8 = (text: string): Uint8Array => new TextEncoder().encode(text);

function packet(payload: Uint8Array): Uint8Array {
  return concat([utf8((payload.length + 4).toString(16).padStart(4, "0")), payload]);
}

describe("network integrity", () => {
  it("rejects a clone whose valid pack omits the tip's parent, like native Git", async () => {
    const fixture = new GitFixture().init();
    const native = new GitFixture();
    fixture.write("file.txt", "first\n");
    const parent = fixture.commit("parent");
    fixture.write("file.txt", "second\n");
    const tip = fixture.commit("tip");
    const tree = fixture.git("rev-parse", "HEAD^{tree}");
    const blob = fixture.git("rev-parse", "HEAD:file.txt");
    const chunks: Uint8Array[] = [];
    const writer = new PackWriter((chunk) => chunks.push(chunk));
    writer.header(3);
    writer.object("commit", fixture.catFile(tip));
    writer.object("tree", fixture.gitBinary("cat-file", "tree", tree));
    writer.object("blob", fixture.catFile(blob));
    writer.finish();
    const advertisement = concat([
      packet(utf8("# service=git-upload-pack\n")),
      utf8("0000"),
      packet(utf8(`${tip} HEAD\0side-band-64k symref=HEAD:refs/heads/main\n`)),
      packet(utf8(`${tip} refs/heads/main\n`)),
      utf8("0000"),
    ]);
    const response = concat([
      packet(utf8("NAK\n")),
      packet(concat([new Uint8Array([1]), concat(chunks)])),
      utf8("0000"),
    ]);
    const server = await startStubServer((request, reply) => {
      reply.setHeader(
        "Content-Type",
        request.method === "POST"
          ? "application/x-git-upload-pack-result"
          : "application/x-git-upload-pack-advertisement",
      );
      reply.end(request.method === "POST" ? response : advertisement);
    });
    const workspace = makeWorkspace();
    try {
      await expect(
        execFileAsync("git", ["clone", server.url, "clone"], {
          cwd: native.dir,
          env: { ...process.env, GIT_TERMINAL_PROMPT: "0" },
        }),
      ).rejects.toMatchObject({ stderr: expect.stringContaining(parent) });
      const cloning = clone(workspace.context, {
        url: server.url,
        dir: "/work",
        depth: 0,
        noTags: true,
      });
      const outcome = await cloning.then(
        () => "accepted",
        () => "rejected",
      );
      if (outcome === "accepted") {
        const repo = openRepository(workspace.context, "/work");
        console.log("incomplete clone pre-fix", {
          head: repo.head().oid,
          missingParent: !repo.store.has(parent),
        });
      }
      expect(outcome).toBe("rejected");
    } finally {
      await server.close();
      fixture.dispose();
      native.dispose();
    }
  });

  it("rejects legacy publication when public maintenance removes its reused aged pack", async () => {
    const fixture = new GitFixture().init();
    fixture.write("file.txt", "unreferenced transfer\n");
    const tip = fixture.commit("aged tip");
    const server = await startGitServer(fixture.dir);
    const workspace = makeRepo("/work");
    const { repo, context } = workspace;
    try {
      await repo.store.packs.ingest(slices(fixture.packAll(), 17), { now: context.now });
      for (let call = 0; call < 40; call++) {
        const progress = await maintenance(context, repo);
        if (progress.status === "complete") break;
        if (call === 39) throw new Error("classification did not finish");
      }
      expect(repo.store.has(tip)).toBe(true);
      workspace.tick(GC_GRACE_MS + 1);
      const before = {
        refs: repo.store.listRefs(),
        shallow: repo.shallow(),
        index: repo.checkout.indexEntries(),
      };
      let sweptAtPublication = false;
      const fetching = fetchInto(
        context,
        repo,
        {
          remote: "origin",
          url: server.url,
          singleBranch: false,
          tags: false,
        },
        "fetch",
        {
          async checkpoint(stage) {
            if (stage !== "before-ref-publication") return;
            for (let call = 0; call < 40; call++) {
              const progress = await maintenance(context, repo);
              if (progress.status === "complete") break;
              if (call === 39) throw new Error("aged sweep did not finish");
            }
            expect(repo.store.has(tip)).toBe(false);
            sweptAtPublication = true;
          },
        },
      );
      const outcome = await fetching.then(
        () => "accepted",
        () => "rejected",
      );
      expect(sweptAtPublication).toBe(true);
      expect(server.requests.filter((request) => request.method === "POST")).toHaveLength(0);
      const cold = reopenTestRepository(workspace, "/work");
      expect(outcome).toBe("rejected");
      expect(cold.repo.store.listRefs()).toEqual(before.refs);
      expect(cold.repo.shallow()).toEqual(before.shallow);
      expect(cold.repo.checkout.indexEntries()).toEqual(before.index);
    } finally {
      await server.close();
      fixture.dispose();
    }
  });
});

describe("fetched graph connectivity", () => {
  it("preserves durable blob promises on legacy and mapped fetch of an unmaterialized branch", async () => {
    const fixture = new GitFixture().init();
    fixture.write("main.txt", "main\n");
    fixture.commit("main");
    fixture.git("checkout", "-q", "-b", "topic");
    fixture.write("promised.txt", "promised offbranch\n");
    fixture.commit("topic");
    const blob = fixture.git("rev-parse", "HEAD:promised.txt");
    fixture.git("checkout", "-q", "main");
    fixture.git("config", "uploadpack.allowFilter", "true");
    const server = await startGitServer(fixture.dir);
    const workspace = makeWorkspace();
    try {
      await clone(workspace.context, {
        url: server.url,
        dir: "/work",
        depth: 0,
        filter: "blob:none",
      });
      const repo = openRepository(workspace.context, "/work");
      expect(repo.store.promisedMissing([blob])).toEqual([blob]);
      await fetchInto(workspace.context, repo, { singleBranch: false, filter: "blob:none" });
      await fetchInto(workspace.context, repo, {
        filter: "blob:none",
        refspecs: [{ source: "refs/heads/topic", destination: "refs/remotes/origin/topic" }],
      });
      const cold = reopenTestRepository(workspace, "/work");
      expect(cold.repo.store.promisedMissing([blob])).toEqual([blob]);
      expect(cold.repo.store.has(blob)).toBe(false);
    } finally {
      await server.close();
      fixture.dispose();
    }
  });

  it("mapped publication retains a fresh transferred pack when maintenance deletes the aged copy", async () => {
    const fixture = new GitFixture().init();
    fixture.write("file.txt", "mapped lifetime\n");
    const tip = fixture.commit("mapped lifetime");
    const server = await startGitServer(fixture.dir);
    const workspace = makeRepo("/work");
    const { repo, context } = workspace;
    let seam = false;
    try {
      await repo.store.packs.ingest(slices(fixture.packAll(), 4096), { now: context.now });
      for (let call = 0; call < 40; call++) {
        if ((await maintenance(context, repo)).status === "complete") break;
        if (call === 39) throw new Error("classification did not finish");
      }
      workspace.tick(GC_GRACE_MS + 1);
      const before = publicationState(repo);
      await fetchInto(
        context,
        repo,
        {
          url: server.url,
          refspecs: [{ source: "refs/heads/main", destination: "refs/remotes/origin/main" }],
        },
        "fetch",
        {
          async checkpoint(stage) {
            if (stage !== "before-ref-publication") return;
            expect(
              repo.store.db.scalar("SELECT count(*) FROM git_pack_meta WHERE state='complete'"),
            ).toBe(2);
            let reclaimed = 0;
            for (let call = 0; call < 40; call++) {
              const progress = await maintenance(context, repo);
              reclaimed = progress.reclaimedPacks;
              if (progress.status === "complete") break;
              if (call === 39) throw new Error("mapped sweep did not finish");
            }
            expect(reclaimed).toBe(1);
            expect(repo.store.has(tip)).toBe(true);
            seam = true;
          },
        },
      );
      expect(seam).toBe(true);
      expect(server.requests.filter((request) => request.method === "POST")).toHaveLength(1);
      const cold = reopenTestRepository(workspace, "/work");
      expect(cold.repo.store.getRef("refs/remotes/origin/main")).toBe(tip);
      expect(cold.repo.readCommit(tip).message).toContain("mapped lifetime");
      for (const entry of cold.repo.store.walkTree(cold.repo.readCommit(tip).tree)) {
        expect(cold.repo.store.read(entry.oid)?.data).toEqual(fixture.catFile(entry.oid));
      }
      expect(cold.repo.shallow()).toEqual(before.shallow);
      expect(cold.repo.checkout.indexEntries()).toEqual(before.index);
      expect(cold.repo.head()).toEqual(before.head);
    } finally {
      await server.close();
      fixture.dispose();
    }
  });
  for (const operation of ["clone", "legacy", "mapped"]) {
    for (const missing of ["parent", "tree", "blob"]) {
      it(`rejects ${operation} with a missing ${missing} in an unmaterialized branch`, async () => {
        const fixture = new GitFixture().init();
        fixture.write("main.txt", "main\n");
        const main = fixture.commit("main");
        const initialPack = fixture.packAll();
        fixture.git("checkout", "-q", "--orphan", "topic");
        fixture.write("topic.txt", "topic parent\n");
        const parent = fixture.commit("topic parent");
        fixture.write("topic.txt", "topic tip\n");
        fixture.commit("topic tip");
        const omitted =
          missing === "parent"
            ? parent
            : fixture.git("rev-parse", missing === "tree" ? "HEAD^{tree}" : "HEAD:topic.txt");
        fixture.git("checkout", "-q", "main");
        const server = await faultyRemote(fixture, { omit: [omitted] });
        const workspace = makeRepo("/work");
        const { repo, context } = workspace;
        try {
          expect(await nativeClone(server.url, ["--no-tags"])).toBe(false);
          if (operation === "clone") {
            await expect(
              clone(context, { url: server.url, dir: "/clone", depth: 0, noTags: true }),
            ).rejects.toBeDefined();
            expect(context.database.findCheckout("/clone")).toBeNull();
          } else {
            await repo.store.packs.ingest(slices(initialPack, 4096));
            repo.store.setRef("refs/heads/main", main);
            repo.store.setRef("refs/remotes/origin/main", main);
            const local = repo.store.write("blob", utf8("local ref\n"));
            repo.store.setRef("refs/remotes/origin/sentinel", local);
            repo.checkout.indexPut({
              path: "staged.txt",
              stage: 0,
              mode: 0o100644,
              oid: local,
              size: null,
              mtime: null,
              ino: null,
            });
            context.worktree.writeFiles([
              { path: "/work/unstaged.txt", bytes: utf8("unstaged local bytes\n") },
            ]);
            const before = publicationState(repo);
            await expect(
              fetchInto(context, repo, {
                remote: "origin",
                url: server.url,
                ...(operation === "legacy"
                  ? { singleBranch: false, tags: false }
                  : {
                      refspecs: [{ source: "refs/heads/*", destination: "refs/remotes/origin/*" }],
                    }),
              }),
            ).rejects.toBeDefined();
            expect(publicationState(repo)).toEqual(before);
            expect(context.worktree.readFile("/work/unstaged.txt")).toEqual(
              utf8("unstaged local bytes\n"),
            );
            expect(repo.store.has(main)).toBe(true);
          }
        } finally {
          await server.close();
          fixture.dispose();
        }
      });
    }
  }

  for (const missing of ["parent", "tree", "blob"]) {
    it(`shallow boundary exempts only parents: missing ${missing}`, async () => {
      const fixture = new GitFixture().init();
      fixture.write("file.txt", "parent\n");
      const parent = fixture.commit("parent");
      fixture.write("file.txt", "tip\n");
      const tip = fixture.commit("tip");
      const omitted =
        missing === "parent"
          ? parent
          : fixture.git("rev-parse", missing === "tree" ? "HEAD^{tree}" : "HEAD:file.txt");
      const server = await faultyRemote(fixture, { omit: [omitted], shallow: tip });
      const workspace = makeRepo("/work");
      try {
        const native = await nativeClone(server.url, ["--depth=1", "--no-tags"]);
        expect(native).toBe(missing === "parent");
        const before = publicationState(workspace.repo);
        const result = fetchInto(workspace.context, workspace.repo, {
          remote: "origin",
          url: server.url,
          depth: 1,
          singleBranch: false,
          tags: false,
        });
        if (native) {
          await result;
          expect(workspace.repo.shallow()).toEqual(new Set([tip]));
          expect(workspace.repo.readCommit(tip).tree).toBe(fixture.git("rev-parse", "HEAD^{tree}"));
        } else {
          await expect(result).rejects.toBeDefined();
          expect(publicationState(workspace.repo)).toEqual(before);
        }
      } finally {
        await server.close();
        fixture.dispose();
      }
    });
  }

  it("accepts a missing gitlink through clone, legacy fetch, and mapped fetch", async () => {
    const fixture = new GitFixture().init();
    fixture.write("file.txt", "parent\n");
    const gitlink = fixture.commit("gitlink target");
    fixture.git("checkout", "-q", "--orphan", "fresh");
    fixture.git("update-index", "--add", "--cacheinfo", `160000,${gitlink},module`);
    fixture.git("commit", "-q", "-m", "gitlink");
    fixture.git("branch", "-D", "main");
    fixture.git("branch", "-m", "main");
    const server = await startGitServer(fixture.dir);
    const workspace = makeWorkspace();
    try {
      expect(await nativeClone(server.url)).toBe(true);
      await clone(workspace.context, { url: server.url, dir: "/work", depth: 0 });
      const repo = openRepository(workspace.context, "/work");
      expect(repo.store.has(gitlink)).toBe(false);
      await fetchInto(workspace.context, repo, { singleBranch: false });
      await fetchInto(workspace.context, repo, {
        refspecs: [{ source: "refs/heads/main", destination: "refs/remotes/origin/main" }],
      });
      expect(repo.store.has(gitlink)).toBe(false);
    } finally {
      await server.close();
      fixture.dispose();
    }
  });

  for (const missing of ["parent", "tree", "blob"]) {
    it(`rejects a mapped annotated tag whose graph lacks a ${missing}`, async () => {
      const fixture = new GitFixture().init();
      fixture.write("file.txt", "parent\n");
      const parent = fixture.commit("parent");
      fixture.write("file.txt", "tip\n");
      fixture.commit("tip");
      fixture.git("tag", "-a", "release", "-m", "release");
      const omitted =
        missing === "parent"
          ? parent
          : fixture.git("rev-parse", missing === "tree" ? "HEAD^{tree}" : "HEAD:file.txt");
      const server = await faultyRemote(fixture, { omit: [omitted] });
      const workspace = makeRepo("/work");
      try {
        const before = publicationState(workspace.repo);
        await expect(
          fetchInto(workspace.context, workspace.repo, {
            url: server.url,
            refspecs: [{ source: "refs/tags/release", destination: "refs/tags/release" }],
          }),
        ).rejects.toBeDefined();
        expect(publicationState(workspace.repo)).toEqual(before);
      } finally {
        await server.close();
        fixture.dispose();
      }
    });
  }
});
