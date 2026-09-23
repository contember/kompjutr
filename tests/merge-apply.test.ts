import { describe, expect, it } from "vitest";
import { utf8, utf8Decoder } from "../packages/git/src/common/bytes.js";
import { hashObject, type Person, serializeCommit } from "../packages/git/src/common/objects.js";
import { comparePaths } from "../packages/git/src/common/streams.js";
import { checkoutTree } from "../packages/git/src/ops/checkout/checkout.js";
import { merge, mergeAbort } from "../packages/git/src/ops/merge/merge.js";
import { buildTree } from "../packages/git/src/ops/tree/tree-build-full.js";
import type { Worktree } from "../packages/git/src/ops/worktree/worktree.js";
import { PACK_BLOB_BATCH_TARGET_BYTES } from "../packages/git/src/store/index.js";
import { makeRepo, type TestRepository } from "./helpers/workspace.js";

const PERSON: Person = {
  name: "Fixture",
  email: "fixture@example.com",
  timestamp: 1_577_836_800,
  timezoneOffset: 0,
};

type Files = Record<string, string | Uint8Array>;

function bytes(value: string | Uint8Array): Uint8Array {
  return typeof value === "string" ? utf8.encode(value) : value;
}

function commitFiles(
  workspace: TestRepository,
  files: Files,
  parent: readonly string[],
  message: string,
): string {
  const repo = workspace.repo;
  const entries = Object.entries(files)
    .sort(([left], [right]) => comparePaths(left, right))
    .map(([path, content]) => ({
      path,
      stage: 0,
      mode: 0o100644,
      oid: repo.store.write("blob", bytes(content)),
      size: null,
      mtime: null,
      ino: null,
    }));
  return repo.store.write(
    "commit",
    serializeCommit({
      tree: buildTree(repo, entries),
      parent: [...parent],
      author: PERSON,
      committer: PERSON,
      message: `${message}\n`,
    }),
  );
}

/** Check out `main` at the current side, with `topic` at the incoming side of one shared base. */
function history(workspace: TestRepository, base: Files, current: Files, incoming: Files): void {
  const baseOid = commitFiles(workspace, base, [], "base");
  const currentOid = commitFiles(workspace, current, [baseOid], "current");
  const incomingOid = commitFiles(workspace, incoming, [baseOid], "incoming");
  const repo = workspace.repo;
  repo.store.setRef("refs/heads/main", currentOid);
  repo.store.setRef("refs/heads/topic", incomingOid);
  repo.store.configSet("user.name", PERSON.name);
  repo.store.configSet("user.email", PERSON.email);
  checkoutTree(repo, workspace.worktree, repo.headTree());
}

function mergeTopic(
  workspace: TestRepository,
  commit = true,
  worktree: Worktree = workspace.worktree,
): ReturnType<typeof merge> {
  return merge(workspace.context, workspace.repo, worktree, { theirs: "topic", commit });
}

function textAt(workspace: TestRepository, path: string): string | null {
  const stat = workspace.worktree.stat(`/${path}`);
  return stat === null ? null : utf8Decoder.decode(workspace.worktree.readFile(`/${path}`));
}

describe("merge apply and abort", () => {
  it("does not retain rollback blobs for a clean commit-mode outcome", () => {
    const workspace = makeRepo();
    history(
      workspace,
      { "clean.txt": "old\n" },
      { "clean.txt": "old\n" },
      { "clean.txt": "next\n" },
    );
    const oldBytes = utf8.encode("unretained original\n");
    const oldOid = hashObject("blob", oldBytes);
    // Stat-matching index data makes the unhashed bytes count as clean, as Git's racy check does.
    workspace.worktree.writeFiles([{ path: "/clean.txt", bytes: oldBytes }]);
    const stat = workspace.worktree.stat("/clean.txt");
    const indexed = workspace.repo.checkout.indexGet("clean.txt");
    if (stat === null || indexed === null) throw new Error("clean.txt was not checked out");
    workspace.repo.checkout.indexPut({
      ...indexed,
      size: stat.size,
      mtime: stat.mtime,
      ino: stat.ino,
      rev: stat.rev,
    });

    const result = mergeTopic(workspace);

    expect(result.oid).toBeDefined();
    expect(workspace.repo.checkout.readMergeState()).toBeNull();
    expect(workspace.repo.has(oldOid)).toBe(false);
    expect(textAt(workspace, "clean.txt")).toBe("next\n");
  });

  it("applies a small merge", () => {
    const workspace = makeRepo();
    history(
      workspace,
      { "small.txt": "old\n" },
      { "small.txt": "old\n" },
      { "small.txt": "next\n" },
    );

    const result = mergeTopic(workspace);

    expect(result.oid).toBeDefined();
    expect(workspace.repo.checkout.readMergeState()).toBeNull();
    expect(textAt(workspace, "small.txt")).toBe("next\n");
  });

  it("reads one valid merge blob above the batching target as a singleton", () => {
    const workspace = makeRepo();
    const content = new Uint8Array(PACK_BLOB_BATCH_TARGET_BYTES + 1).fill(0x61);
    history(
      workspace,
      { "large.bin": "old\n" },
      { "large.bin": "old\n" },
      { "large.bin": content },
    );

    const result = mergeTopic(workspace);

    expect(result.oid).toBeDefined();
    expect(workspace.repo.checkout.readMergeState()).toBeNull();
    expect(workspace.worktree.readFile("/large.bin")).toEqual(content);
  });

  it("applies content one byte past the former standalone ceiling", () => {
    const workspace = makeRepo();
    const added: Files = {};
    let remaining = 32 * 1024 * 1024 + 1;
    for (let ordinal = 0; remaining > 0; ordinal++) {
      const content = new Uint8Array(Math.min(1024 * 1024, remaining));
      content[0] = ordinal;
      added[`large-${ordinal.toString().padStart(2, "0")}.bin`] = content;
      remaining -= content.byteLength;
    }
    history(
      workspace,
      { "base.txt": "base\n" },
      { "base.txt": "base\n" },
      {
        "base.txt": "base\n",
        ...added,
      },
    );

    const result = mergeTopic(workspace);

    expect(result.oid).toBeDefined();
    expect(workspace.repo.checkout.readMergeState()).toBeNull();
    expect(Object.keys(added)).toHaveLength(33);
    expect(workspace.worktree.stat("/large-00.bin")?.size).toBe(1024 * 1024);
    expect(workspace.worktree.stat("/large-32.bin")?.size).toBe(1);
  });

  it("applies the operation that the former exhausted prior budget rejected", () => {
    const workspace = makeRepo();
    history(
      workspace,
      { "guarded.txt": "old\n" },
      { "guarded.txt": "old\n" },
      { "guarded.txt": "next\n" },
    );

    const result = mergeTopic(workspace);

    expect(result.oid).toBeDefined();
    expect(textAt(workspace, "guarded.txt")).toBe("next\n");
    expect(workspace.repo.checkout.indexGet("guarded.txt")).toMatchObject({
      stage: 0,
      oid: hashObject("blob", utf8.encode("next\n")),
    });
    expect(workspace.repo.checkout.readMergeState()).toBeNull();
  });

  it("snapshots and restores files past the former read-call caps", () => {
    const workspace = makeRepo();
    const old: Files = {};
    const next: Files = {};
    for (let ordinal = 0; ordinal < 9; ordinal++) {
      old[`file-${ordinal}`] = `old-${ordinal}\n`;
      next[`file-${ordinal}`] = `next-${ordinal}\n`;
    }
    history(workspace, old, old, next);
    const readFiles = workspace.worktree.readFiles.bind(workspace.worktree);
    let snapshotReads = 0;
    workspace.worktree.readFiles = (paths, options) => {
      const first = paths[0];
      if (first === undefined) throw new Error("test snapshot batch is empty");
      snapshotReads++;
      const batch = readFiles([first], options);
      return { files: batch.files, remaining: [...batch.remaining, ...paths.slice(1)] };
    };
    const readBlobs = workspace.repo.store.readBlobs.bind(workspace.repo.store);
    let blobReads = 0;
    workspace.repo.store.readBlobs = (oids, options) => {
      const first = oids[0];
      if (first === undefined) throw new Error("test blob batch is empty");
      blobReads++;
      const batch = readBlobs([first], options);
      return {
        blobs: batch.blobs,
        remaining: [...batch.remaining, ...oids.slice(1)],
        bytes: batch.bytes,
      };
    };

    expect(mergeTopic(workspace, false)).toEqual({ pendingCommit: true });
    expect(workspace.repo.checkout.requireMergeState().state.phase).toBe("ready");
    expect(snapshotReads).toBe(9);
    expect(blobReads).toBe(9);
    const restoreStart = blobReads;
    mergeAbort(workspace.repo, workspace.worktree);

    expect(blobReads - restoreStart).toBe(9);
    for (let ordinal = 0; ordinal < 9; ordinal++) {
      expect(textAt(workspace, `file-${ordinal}`)).toBe(`old-${ordinal}\n`);
    }
    expect(workspace.repo.checkout.readMergeState()).toBeNull();
  });

  it("pages structural ancestors of a long valid path instead of refusing it", () => {
    const workspace = makeRepo();
    const path = `${"a/".repeat(1_000)}z`;
    history(
      workspace,
      { "base.txt": "base\n" },
      { "base.txt": "base\n" },
      {
        "base.txt": "base\n",
        [path]: "deep\n",
      },
    );

    expect(mergeTopic(workspace, false)).toEqual({ pendingCommit: true });

    const ancestors = Array.from({ length: 1_000 }, (_, depth) => `${"a/".repeat(depth)}a`);
    const owned = [...ancestors, path];
    const durable = workspace.repo.checkout.requireMergeState();
    expect(durable.state.phase).toBe("ready");
    expect(durable.touched.map((entry) => entry.path)).toEqual(owned);
    expect(durable.touched.every((entry) => entry.purpose === "primary")).toBe(true);
    expect(durable.touched.every((entry) => entry.index === null)).toBe(true);

    mergeAbort(workspace.repo, workspace.worktree);
    expect(workspace.repo.checkout.readMergeState()).toBeNull();
    expect(workspace.repo.checkout.indexEntries().map((entry) => entry.path)).toEqual(["base.txt"]);
    expect(workspace.worktree.stat("/a")).toBeNull();
  });

  it("applies clean text, add, and delete entries and durably restores them", () => {
    const workspace = makeRepo();
    const currentText = "ONE\ntwo\nthree\n";
    const mergedText = "ONE\ntwo\nTHREE\n";
    history(
      workspace,
      { "a.txt": "one\ntwo\nthree\n", "deleted.txt": "keep me\n" },
      { "a.txt": currentText, "deleted.txt": "keep me\n" },
      { "a.txt": "one\ntwo\nTHREE\n", "added.txt": "added\n" },
    );
    const oldA = hashObject("blob", utf8.encode(currentText));
    const oldDeleted = hashObject("blob", utf8.encode("keep me\n"));

    expect(mergeTopic(workspace, false)).toEqual({ pendingCommit: true });

    expect(workspace.repo.checkout.requireMergeState().state.phase).toBe("ready");
    expect(textAt(workspace, "a.txt")).toBe(mergedText);
    expect(textAt(workspace, "added.txt")).toBe("added\n");
    expect(textAt(workspace, "deleted.txt")).toBeNull();
    expect(workspace.repo.checkout.indexGet("a.txt")?.oid).toBe(
      hashObject("blob", utf8.encode(mergedText)),
    );
    expect(workspace.repo.checkout.indexGet("added.txt")?.oid).toBe(
      hashObject("blob", utf8.encode("added\n")),
    );
    expect(workspace.repo.checkout.indexGet("deleted.txt")).toBeNull();

    mergeAbort(workspace.repo, workspace.worktree);

    expect(workspace.repo.checkout.readMergeState()).toBeNull();
    expect(textAt(workspace, "a.txt")).toBe(currentText);
    expect(textAt(workspace, "added.txt")).toBeNull();
    expect(textAt(workspace, "deleted.txt")).toBe("keep me\n");
    expect(workspace.repo.checkout.indexGet("a.txt")?.oid).toBe(oldA);
    expect(workspace.repo.checkout.indexGet("deleted.txt")?.oid).toBe(oldDeleted);
  });

  it("writes binary conflict content and replaces stage zero with stages 1, 2, and 3", () => {
    const workspace = makeRepo();
    history(
      workspace,
      { "binary.dat": "base\0bytes" },
      { "binary.dat": "current\0bytes" },
      { "binary.dat": "incoming\0bytes" },
    );
    const oid = (text: string) => hashObject("blob", utf8.encode(text));

    expect(mergeTopic(workspace)).toEqual({ conflicted: true, pendingCommit: true });

    expect(workspace.repo.checkout.indexGet("binary.dat", 0)).toBeNull();
    expect(workspace.repo.checkout.indexGet("binary.dat", 1)?.oid).toBe(oid("base\0bytes"));
    expect(workspace.repo.checkout.indexGet("binary.dat", 2)?.oid).toBe(oid("current\0bytes"));
    expect(workspace.repo.checkout.indexGet("binary.dat", 3)?.oid).toBe(oid("incoming\0bytes"));
    expect(textAt(workspace, "binary.dat")).toBe("current\0bytes");
    expect(workspace.repo.checkout.requireMergeState().state.phase).toBe("conflicted");
  });

  it("applies and aborts a current-file/incoming-directory merge", () => {
    const workspace = makeRepo();
    history(
      workspace,
      { "base.txt": "base\n" },
      { "base.txt": "base\n", x: "current file\n" },
      { "base.txt": "base\n", "x/y": "incoming child\n" },
    );
    const current = hashObject("blob", utf8.encode("current file\n"));
    const incoming = hashObject("blob", utf8.encode("incoming child\n"));

    mergeTopic(workspace);

    expect(workspace.worktree.stat("/x")?.type).toBe("dir");
    expect(textAt(workspace, "x/y")).toBe("incoming child\n");
    expect(textAt(workspace, "x~HEAD")).toBe("current file\n");
    expect(workspace.repo.checkout.indexGet("x")).toBeNull();
    expect(workspace.repo.checkout.indexGet("x/y")?.oid).toBe(incoming);
    expect(workspace.repo.checkout.indexGet("x~HEAD", 2)?.oid).toBe(current);
    expect(workspace.repo.checkout.requireMergeState().touched.map((entry) => entry.path)).toEqual([
      "x",
      "x/y",
      "x~HEAD",
    ]);

    mergeAbort(workspace.repo, workspace.worktree);
    expect(textAt(workspace, "x")).toBe("current file\n");
    expect(workspace.worktree.stat("/x/y")).toBeNull();
    expect(workspace.worktree.stat("/x~HEAD")).toBeNull();
    expect(workspace.repo.checkout.indexGet("x")?.oid).toBe(current);
  });

  it("refuses abort when restoring a file would remove an outside path", () => {
    const workspace = makeRepo();
    history(
      workspace,
      { "base.txt": "base\n" },
      { "base.txt": "base\n", x: "current file\n" },
      { "base.txt": "base\n", "x/y": "incoming child\n" },
    );
    mergeTopic(workspace);
    workspace.worktree.writeFiles([{ path: "/x/outside.txt", bytes: utf8.encode("outside\n") }]);

    expect(() => mergeAbort(workspace.repo, workspace.worktree)).toThrow(
      expect.objectContaining({ code: "ECHECKOUTFAIL" }),
    );
    expect(textAt(workspace, "x/outside.txt")).toBe("outside\n");
    expect(workspace.repo.checkout.readMergeState()).not.toBeNull();
  });

  it("removes a merge-created parent but preserves a pre-existing empty parent on abort", () => {
    for (const preExisting of [false, true]) {
      const workspace = makeRepo();
      history(
        workspace,
        { "base.txt": "base\n" },
        { "base.txt": "base\n" },
        {
          "base.txt": "base\n",
          "d/f.txt": "added\n",
        },
      );
      if (preExisting) workspace.worktree.makeDirectories(["/d"]);
      mergeTopic(workspace, false);
      const journal = workspace.repo.checkout.requireMergeState();
      expect(journal.touched.map((entry) => entry.path)).toEqual(["d", "d/f.txt"]);

      mergeAbort(workspace.repo, workspace.worktree);
      expect(workspace.worktree.stat("/d/f.txt")).toBeNull();
      expect(workspace.worktree.stat("/d")?.type ?? null).toBe(preExisting ? "dir" : null);
    }
  });
});
