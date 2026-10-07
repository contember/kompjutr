import { execFile, execFileSync } from "node:child_process";
import { promisify } from "node:util";
import { describe, expect, it, vi } from "vitest";
import { concat } from "../packages/git/src/common/bytes.js";
import {
  MODE_FILE,
  MODE_TREE,
  serializeCommit,
  serializeTree,
} from "../packages/git/src/common/objects.js";
import { openRepository } from "../packages/git/src/ops/core/context.js";
import { clone, fetchInto } from "../packages/git/src/ops/network/network.js";
import { validateFetchedConnectivity } from "../packages/git/src/ops/network/network-connectivity.js";
import { maintenance } from "../packages/git/src/ops/repository/maintenance.js";
import { statusBranch } from "../packages/git/src/ops/status/status.js";
import { GC_GRACE_MS } from "../packages/git/src/store/maintenance/sweep.js";
import { PackWriter } from "../packages/git/src/store/pack/writer.js";
import {
  CONNECTIVITY_FAILURES_SQL,
  MAX_CONNECTIVITY_FAILURES,
  readConnectivityFailures,
} from "../packages/git/src/store/trees/connectivity.js";
import { GitFixture, slices } from "./helpers/git.js";
import { startGitServer, startStubServer } from "./helpers/http-backend.js";
import { faultyRemote, nativeClone, publicationState } from "./helpers/network-integrity.js";
import { reopenTestRepository } from "./helpers/repository-invariants.js";
import { makeRepo, makeWorkspace, type TestRepository } from "./helpers/workspace.js";

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

/** One validation's statement count, rows returned to JS, and OIDs handed to `objectInfo`. */
function measureConnectivity(workspace: TestRepository, roots: string[]) {
  const info = vi.spyOn(workspace.repo.store, "objectInfo");
  workspace.storage.resetCounters();
  workspace.repo.store.db.transactionSync(() =>
    validateFetchedConnectivity(workspace.repo, roots, new Set()),
  );
  const cost = { statements: workspace.storage.statementCount, rows: workspace.storage.rowCount };
  const exported = info.mock.calls.flatMap(([oids]) => oids);
  info.mockRestore();
  return { cost, exported };
}

describe("fetched graph connectivity", () => {
  it("expands shared historical trees once and matches native Git's reachable objects", async () => {
    const fixture = new GitFixture().init();
    try {
      for (let index = 0; index < 140; index++) {
        fixture.write(`shared/dir-${index}/file`, `content ${index}\n`);
      }
      fixture.commit("shared trees");
      for (let index = 0; index < 4; index++) {
        fixture.write("changing", `${index}\n`);
        fixture.commit(`change ${index}`);
      }
      const tip = fixture.git("rev-parse", "HEAD");
      const commits = new Set(fixture.git("rev-list", "HEAD").split("\n"));
      const blobs = new Set(
        fixture
          .git("rev-list", "--objects", "--filter=blob:none", "--filter-print-omitted", "HEAD")
          .split("\n")
          .filter((line) => line.startsWith("~"))
          .map((line) => line.slice(1)),
      );
      const withoutBlobs = execFileSync("git", ["pack-objects", "--stdout", "-q"], {
        cwd: fixture.dir,
        input: fixture
          .git("rev-list", "--objects", "--filter=blob:none", "HEAD")
          .split("\n")
          .map((line) => `${line.split(" ")[0]}\n`)
          .join(""),
      });
      const partial = makeRepo("/partial");
      await partial.repo.store.packs.ingest(slices(new Uint8Array(withoutBlobs), 4096));
      const missing = readConnectivityFailures(
        partial.repo.store.db,
        partial.repo.store.repoId,
        [{ oid: tip, type: "commit" }],
        [],
        MAX_CONNECTIVITY_FAILURES,
      );
      expect(missing.every((failure) => failure.kind === "missing")).toBe(true);
      expect(missing).toHaveLength(144);
      expect(new Set(missing.map((failure) => failure.oid))).toEqual(blobs);

      const sharedTree = fixture.git("rev-parse", "HEAD:shared");
      const rootsOnly = execFileSync("git", ["pack-objects", "--stdout", "-q"], {
        cwd: fixture.dir,
        input: [...commits]
          .map((oid) => `${oid}\n${fixture.git("rev-parse", `${oid}^{tree}`)}\n`)
          .join(""),
      });
      const shallowTrees = makeRepo("/roots");
      await shallowTrees.repo.store.packs.ingest(slices(new Uint8Array(rootsOnly), 4096));
      const sourceless = readConnectivityFailures(
        shallowTrees.repo.store.db,
        shallowTrees.repo.store.repoId,
        [{ oid: tip, type: "commit" }],
        [],
        MAX_CONNECTIVITY_FAILURES,
      ).filter((failure) => failure.kind === "source");
      expect(sourceless).toEqual([{ kind: "source", oid: sharedTree }]);

      const complete = makeRepo("/work");
      await complete.repo.store.packs.ingest(slices(fixture.packAll(), 4096));
      const { cost, exported } = measureConnectivity(complete, [tip]);
      expect(exported.filter((oid) => !commits.has(oid))).toEqual([]);
      expect(cost.statements).toBeLessThanOrEqual(5);
      expect(cost.rows).toBeLessThanOrEqual(591);
      const plan = complete.repo.store.db
        .all<{ detail: string }>(
          `EXPLAIN QUERY PLAN ${CONNECTIVITY_FAILURES_SQL}`,
          complete.repo.store.repoId,
          JSON.stringify([{ oid: tip, type: "commit" }]),
          "[]",
          1,
        )
        .map((row) => row.detail);
      expect(plan).toContain("USE TEMP B-TREE FOR DISTINCT");
      expect(plan.some((detail) => detail.startsWith("SCAN entry"))).toBe(false);
      expect(plan).toContain("SEARCH entry USING PRIMARY KEY (source_key=?)");
    } finally {
      fixture.dispose();
    }
  });

  it("clones complete history beyond the parsed-commit graph capacity like native Git", async () => {
    const fixture = new GitFixture().init();
    fixture.write(".git/message", `${"M".repeat(1024 * 1024)}\n`);
    for (let index = 0; index < 34; index++) {
      fixture.git("commit", "--allow-empty", "-q", "-F", ".git/message");
    }
    fixture.git("config", "uploadpack.allowFilter", "true");
    const origin = await startGitServer(fixture.dir);
    const workspace = makeWorkspace();
    try {
      expect(await nativeClone(origin.url, ["--filter=blob:none"])).toBe(true);
      await clone(workspace.context, {
        url: origin.url,
        dir: "/work",
        filter: "blob:none",
        singleBranch: true,
        noTags: true,
      });
      const repo = openRepository(workspace.context, "/work");
      expect(repo.head().oid).toBe(fixture.git("rev-parse", "HEAD"));
      expect(repo.shallow().size).toBe(0);
      expect(repo.store.db.scalar<number>("SELECT count(*) FROM git_commits")).toBe(
        Number(fixture.git("rev-list", "--count", "HEAD")),
      );
      expect(() => [...repo.store.commitGraph(fixture.git("rev-parse", "HEAD"))]).toThrow(
        /fixed state capacity/,
      );
      expect(statusBranch(repo)).toMatchObject({ ahead: 0, behind: 0 });
      const previous = fixture.git("rev-parse", "HEAD~1");
      repo.store.setRef("refs/heads/main", previous);
      const [ahead, behind] = fixture
        .git("rev-list", "--left-right", "--count", `${previous}...HEAD`)
        .split(/\s+/)
        .map(Number);
      expect(statusBranch(repo)).toMatchObject({ ahead, behind });
    } finally {
      await origin.close();
      fixture.dispose();
    }
  });

  it("checks shared nested blobs once per invocation and starts the next invocation cold", async () => {
    const fixture = new GitFixture().init();
    fixture.write("shared/file", "shared\n");
    fixture.write("changing", "first\n");
    fixture.commit("first");
    const first = fixture.git("rev-parse", "HEAD^{tree}");
    fixture.write("changing", "second\n");
    fixture.commit("second");
    const second = fixture.git("rev-parse", "HEAD^{tree}");
    const shared = fixture.git("rev-parse", "HEAD:shared/file");
    const workspace = makeRepo("/work");
    const { repo } = workspace;
    try {
      await repo.store.packs.ingest(slices(fixture.packAll(), 4096));
      const warm = measureConnectivity(workspace, [first, second]);
      expect(warm.exported).not.toContain(shared);
      expect(warm.cost.statements).toBeLessThanOrEqual(4);
      expect(warm.cost.rows).toBeLessThanOrEqual(14);
      const cold = measureConnectivity(workspace, [first, second]);
      expect(cold.exported).not.toContain(shared);
      expect(cold.cost).toEqual(warm.cost);
      for (const entry of repo.store.walkTree(second)) {
        expect(repo.store.read(entry.oid)?.data).toEqual(fixture.catFile(entry.oid));
      }
    } finally {
      fixture.dispose();
    }
  });

  it("rejects a missing blob in the final metadata batch of shared roots", () => {
    const { repo } = makeRepo("/work");
    const missing = "1".repeat(40);
    const child = repo.store.write(
      "tree",
      serializeTree([{ mode: MODE_FILE, name: "missing", oid: missing }]),
    );
    const root = repo.store.write(
      "tree",
      serializeTree([{ mode: MODE_TREE, name: "shared", oid: child }]),
    );
    expect(() =>
      repo.store.db.transactionSync(() =>
        validateFetchedConnectivity(repo, [child, root], new Set()),
      ),
    ).toThrow();
  });

  it("rejects a new missing subtree after successfully caching a shared subtree", () => {
    const { repo } = makeRepo("/work");
    const blob = repo.store.write("blob", utf8("good"));
    const child = repo.store.write(
      "tree",
      serializeTree([{ mode: MODE_FILE, name: "file", oid: blob }]),
    );
    const bad = repo.store.write(
      "tree",
      serializeTree([{ mode: MODE_FILE, name: "missing", oid: "1".repeat(40) }]),
    );
    const root = repo.store.write(
      "tree",
      serializeTree([
        { mode: MODE_TREE, name: "shared", oid: child },
        { mode: MODE_TREE, name: "unchecked", oid: bad },
      ]),
    );
    expect(() =>
      repo.store.db.transactionSync(() =>
        validateFetchedConnectivity(repo, [child, root], new Set()),
      ),
    ).toThrow();
  });

  it("expands each tree once even when shared roots exceed the former cache size", () => {
    const workspace = makeRepo("/work");
    const { repo } = workspace;
    const blob = repo.store.write("blob", utf8("shared"));
    const roots = Array.from({ length: 129 }, (_, index) =>
      repo.store.write(
        "tree",
        serializeTree([{ mode: MODE_FILE, name: `file-${index}`, oid: blob }]),
      ),
    );
    const first = roots[0];
    if (first === undefined) throw new Error("missing first root");
    const revisit = repo.store.write(
      "tree",
      serializeTree([{ mode: MODE_TREE, name: "revisit", oid: first }]),
    );
    const { cost, exported } = measureConnectivity(workspace, [...roots, revisit]);
    expect(exported).not.toContain(blob);
    expect(cost.statements).toBeLessThanOrEqual(4);
    expect(cost.rows).toBeLessThanOrEqual(520);
  });

  it("allows promised missing blobs but never promised missing trees or commits", () => {
    const { repo } = makeRepo("/work");
    const missing = "1".repeat(40);
    repo.store.registerPromisorRemote("origin", "https://example.com/repo.git");
    repo.store.addPromisedBlobs("origin", [missing]);
    const blobTree = repo.store.write(
      "tree",
      serializeTree([{ mode: MODE_FILE, name: "promised", oid: missing }]),
    );
    const treeTree = repo.store.write(
      "tree",
      serializeTree([{ mode: MODE_TREE, name: "promised", oid: missing }]),
    );
    const person = { name: "Test", email: "test@example.com", timestamp: 1, timezoneOffset: 0 };
    const commit = repo.store.write(
      "commit",
      serializeCommit({
        tree: blobTree,
        parent: [missing],
        author: person,
        committer: person,
        message: "missing parent\n",
      }),
    );
    const validate = (roots: string[]) =>
      repo.store.db.transactionSync(() => validateFetchedConnectivity(repo, roots, new Set()));
    expect(() => validate([blobTree])).not.toThrow();
    expect(() => validate([blobTree, treeTree])).toThrow();
    expect(() => validate([blobTree, commit])).toThrow();
  });

  it("deduplicates shared descendants beyond the former candidate cache size", () => {
    const workspace = makeRepo("/work");
    const { repo } = workspace;
    const blob = repo.store.write("blob", utf8("shared"));
    const children = Array.from({ length: 129 }, (_, index) => ({
      mode: MODE_TREE,
      name: `tree-${String(index).padStart(3, "0")}`,
      oid: repo.store.write(
        "tree",
        serializeTree([{ mode: MODE_FILE, name: `file-${index}`, oid: blob }]),
      ),
    }));
    const last = children[128];
    if (last === undefined) throw new Error("missing last child");
    const first = repo.store.write("tree", serializeTree(children));
    const second = repo.store.write("tree", serializeTree([last]));
    const { cost, exported } = measureConnectivity(workspace, [first, second]);
    expect(exported).not.toContain(blob);
    expect(cost.statements).toBeLessThanOrEqual(4);
    expect(cost.rows).toBeLessThanOrEqual(394);
  });

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

  it("rejects mapped publication when public maintenance removes its reused aged pack", async () => {
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
      const outcome = await fetchInto(
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
            let reclaimed = 0;
            for (let call = 0; call < 40; call++) {
              const progress = await maintenance(context, repo);
              reclaimed = progress.reclaimedPacks;
              if (progress.status === "complete") break;
              if (call === 39) throw new Error("mapped sweep did not finish");
            }
            expect(reclaimed).toBe(1);
            expect(repo.store.has(tip)).toBe(false);
            seam = true;
          },
        },
      ).then(
        () => "accepted",
        (error: unknown) => error,
      );
      expect(seam).toBe(true);
      expect(outcome).toMatchObject({ code: "EFETCHFAIL" });
      expect(server.requests.filter((request) => request.method === "POST")).toHaveLength(0);
      const cold = reopenTestRepository(workspace, "/work");
      expect(cold.repo.store.getRef("refs/remotes/origin/main")).toBeNull();
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
