// The production agent workflow, end to end: clone (complete and blobless),
// fetch, evict, read cold, checkpoint, conflict, recover, publish, and run
// maintenance over the result. Per-operation tests each cover one of those;
// what they cannot cover is a defect that only appears when two of them meet —
// staged projections outliving an interrupted transfer, a packed base that
// stops resolving once its cache is gone, integration output that maintenance
// does not treat as rooted.
//
// Everything a journey can ask git, it asks git: the harness replays each step
// against the real binary and compares refs, index stages, porcelain v2,
// worktree bytes and modes, the log and the pending operation. The explicit
// assertions below are only where git has no equivalent at all — an evicted
// object cache, an interrupted fetch, a housekeeping pass.

import { Buffer } from "node:buffer";

import { afterEach, describe, expect, it } from "vitest";

import { createWorld, type E2EStep, type E2EWorld, WORK } from "../helpers/e2e.js";

let world: E2EWorld | undefined;

afterEach(async () => {
  await world?.dispose();
  world = undefined;
});

/** The orchestrator keeps agent turn state in refs outside `refs/heads/*`. */
const CHECKPOINT_ONE = "refs/checkpoints/session/step-1";
const CHECKPOINT_TWO = "refs/checkpoints/session/step-2";
const ZERO_OID = "0".repeat(40);

/** A file long enough for two edits to land outside each other's context. */
const PARAGRAPH = "alpha\nbravo\ncharlie\ndelta\necho\nfoxtrot\ngolf\nhotel\nindia\n";

/** PNG-shaped bytes: the NUL up front is what makes git call a blob binary. */
const LOGO_BYTES = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x00, 0x0a, 0x0b, 0x0c, 0xfe]);

/** Maintenance advances one bounded action per call; this drives a whole run. */
const MAINTENANCE_CALL_BOUND = 64;

/** Ingest yields follow stream chunking, so this bounds the search, not the test. */
const MAX_INTERRUPTIONS = 64;

/** Enough commits for the ingest to stage a batch of projections part way through. */
const IMPORTED_COMMITS = 3073;

const MIRROR_UNREACHABLE = (): never => {
  throw new Error("unreachable: runLocal never plays the mirror");
};

/** Create a checkpoint ref that must not exist yet, the guarded way both sides spell it. */
function checkpoint(ref: string, rev: string): E2EStep {
  return {
    op: "custom",
    local: async (git) => {
      const value = await git.revParse({ dir: WORK, ref: rev });
      await git.updateRef({ dir: WORK, ref, value, expected: null });
    },
    mirror: (fixture) => {
      fixture.git("update-ref", ref, fixture.git("rev-parse", rev), ZERO_OID);
    },
  };
}

/** One atomic push carrying the branch and every checkpoint ref beside it. */
function publishWithCheckpoints(): E2EStep {
  return {
    op: "custom",
    local: async (git) => {
      const pushed = await git.push({
        dir: WORK,
        remote: "origin",
        atomic: true,
        refspecs: [
          { source: "refs/heads/main", destination: "refs/heads/main" },
          { source: "refs/checkpoints/session/*", destination: "refs/checkpoints/session/*" },
        ],
      });
      if (!pushed.ok) throw new Error(`checkpoint push failed: ${pushed.error ?? "unknown"}`);
    },
    mirror: (fixture) => {
      fixture.git(
        "push",
        "-q",
        "--atomic",
        "origin",
        "refs/heads/main:refs/heads/main",
        "refs/checkpoints/session/*:refs/checkpoints/session/*",
      );
    },
  };
}

/** A filtered fetch, which the DSL's own `fetch` step has no filter for. */
function bloblessFetch(): E2EStep {
  return {
    op: "custom",
    local: async (git) => {
      await git.fetch({ dir: WORK, filter: "blob:none" });
    },
    mirror: (fixture) => {
      fixture.git("fetch", "-q", "--filter=blob:none", "origin");
    },
  };
}

/** Run one whole maintenance cycle. kompjutr-only: git has no comparable pass. */
function maintenanceRun(): E2EStep {
  return {
    op: "custom",
    local: async (git) => {
      for (let call = 0; call < MAINTENANCE_CALL_BOUND; call++) {
        const result = await git.maintenance({ dir: WORK });
        if (result.status !== "complete") continue;
        // A run that reached nothing, or rewrote nothing, would make every
        // assertion after it vacuous.
        expect(result.reachableObjects).toBeGreaterThan(0);
        expect(result.repackedObjects).toBeGreaterThan(0);
        return;
      }
      throw new Error(`maintenance did not finish within ${MAINTENANCE_CALL_BOUND} calls`);
    },
    mirror: MIRROR_UNREACHABLE,
  };
}

async function readBlob(target: E2EWorld, oid: string): Promise<Buffer> {
  const result = await target.git.catFile({ dir: WORK, oid });
  return Buffer.from(result.bytes);
}

/**
 * A `fast-import` stream of commits on top of `main`. `from` keeps the branch's
 * tree, so the imported history adds objects and length and nothing else — the
 * cheapest pack that still crosses the ingest's projection batch.
 */
function importStream(count: number): string {
  const commands: string[] = [];
  for (let index = 0; index < count; index++) {
    const message = `imported ${index}\n`;
    const from = index === 0 ? "from refs/heads/main^0\n" : "";
    commands.push(
      `commit refs/heads/main\ncommitter Fixture <fixture@example.com> 1577836800 +0000\n` +
        `data ${message.length}\n${message}${from}\n`,
    );
  }
  return commands.join("");
}

describe("production cold workflow", () => {
  it("carries a complete clone through fetch, a cold packed read and checkpoint transport", async () => {
    world = await createWorld({
      seed: { "README.md": "seed\n", "src/app.ts": "export const app = 1;\n" },
    });

    await world.run(
      {
        op: "peer",
        act: (peer) => {
          peer.write("src/lib.ts", "export const lib = 1;\n");
          peer.commit("colleague lib");
          peer.write("README.md", "seed\nupstream\n");
          peer.commit("colleague readme");
          peer.git("push", "-q", "origin", "main");
        },
      },
      { op: "fetch" },
      // The colleague's objects arrived inside a pack. Evicting the Durable
      // Object before the fast-forward makes it materialise the worktree from
      // SQLite rather than from anything the fetch left behind in memory.
      { op: "reopen" },
      { op: "merge", theirs: "origin/main", message: "merge origin", fastForwardOnly: true },
      { op: "reopen" },
    );

    // Git has no evicted object cache to mirror, so this read is explicit: it
    // is the first read a fresh incarnation makes, so it comes out of the pack
    // in storage, and git itself says what the bytes are.
    const packed = world.mirror.git("rev-parse", "HEAD:src/lib.ts");
    expect(await readBlob(world, packed)).toEqual(
      world.mirror.gitBinary("cat-file", "blob", packed),
    );

    await world.run(
      { op: "write", path: "src/app.ts", content: "export const app = 2;\n" },
      { op: "add", paths: ["src/app.ts"] },
      { op: "commit", message: "agent step one" },
      checkpoint(CHECKPOINT_ONE, "HEAD"),
      { op: "write", path: "src/app.ts", content: "export const app = 3;\n" },
      { op: "add", paths: ["src/app.ts"] },
      { op: "commit", message: "agent step two" },
      checkpoint(CHECKPOINT_TWO, "HEAD"),
      { op: "reopen" },
      publishWithCheckpoints(),
      { op: "reopen" },
    );
  });

  it("clones blobless, fetches blobless, and hydrates a filtered blob cold", async () => {
    world = await createWorld({
      filter: "blob:none",
      seed: { "README.md": "seed\n", "history.txt": "historical\n" },
      seedHistory: (fixture) => {
        fixture.remove("history.txt");
        fixture.write("README.md", "seed\nsecond\n");
        fixture.commit("drop the historical blob");
      },
    });

    // Both sides cloned with `blob:none`; the checkout still has to agree.
    await world.compare("blobless clone");

    // `history.txt` is in no tree either side checked out, so its blob was
    // filtered out of the clone pack. Checking that commit out on a cold
    // incarnation has to hydrate it through the promisor remote.
    const historical = world.mirror.git("rev-parse", "HEAD~1");

    await world.run(
      { op: "reopen" },
      { op: "checkout", ref: historical },
      { op: "checkout", ref: "main" },
      {
        op: "peer",
        act: (peer) => {
          peer.write("src/lib.ts", "export const lib = 1;\n");
          peer.commit("colleague lib");
          peer.git("push", "-q", "origin", "main");
        },
      },
      bloblessFetch(),
      { op: "reopen" },
      { op: "checkout", ref: "origin/main" },
      { op: "checkout", ref: "main" },
    );
  });

  it("recovers a merge conflict and a rebase conflict across reopens and publishes", async () => {
    world = await createWorld({ seed: { "c.txt": "base\n", "keep.txt": "keep\n" } });

    await world.run(
      {
        op: "peer",
        act: (peer) => {
          peer.write("c.txt", "upstream\n");
          peer.commit("colleague edit");
          peer.git("push", "-q", "origin", "main");
        },
      },
      { op: "write", path: "c.txt", content: "mine\n" },
      { op: "add", paths: ["c.txt"] },
      { op: "commit", message: "mine" },
      { op: "fetch" },
      // Merging a local branch rather than `origin/main` keeps the conflict
      // hunk labels identical on both sides; the objects are the fetched ones
      // either way.
      { op: "branch", name: "upstream", startPoint: "origin/main" },
      { op: "reopen" },
      {
        op: "merge",
        theirs: "upstream",
        message: "merge upstream",
        expect: { outcome: "conflicted" },
      },
      { op: "reopen" },
      { op: "mergeAbort" },
      {
        op: "merge",
        theirs: "upstream",
        message: "merge upstream",
        expect: { outcome: "conflicted" },
      },
      { op: "reopen" },
      { op: "write", path: "c.txt", content: "mine and upstream\n" },
      { op: "add", paths: ["c.txt"] },
      { op: "mergeContinue", message: "merge upstream" },
      { op: "reopen" },
      { op: "push" },
    );

    await world.run(
      { op: "branch", name: "topic", checkout: true },
      { op: "write", path: "c.txt", content: "topic\n" },
      { op: "add", paths: ["c.txt"] },
      { op: "commit", message: "topic edit" },
      { op: "checkout", ref: "main" },
      { op: "write", path: "c.txt", content: "main moves on\n" },
      { op: "add", paths: ["c.txt"] },
      { op: "commit", message: "main moves on" },
      { op: "checkout", ref: "topic" },
      { op: "rebase", upstream: "main", expect: { outcome: "conflicted" } },
      { op: "reopen" },
      { op: "rebaseAbort" },
      { op: "rebase", upstream: "main", expect: { outcome: "conflicted" } },
      { op: "reopen" },
      { op: "write", path: "c.txt", content: "topic on main\n" },
      { op: "add", paths: ["c.txt"] },
      { op: "rebaseContinue" },
      { op: "reopen" },
      { op: "push", ref: "topic" },
    );
  });

  it("keeps generated integration output rooted across a reopen and maintenance", async () => {
    world = await createWorld({ seed: { "story.txt": PARAGRAPH } });

    await world.run(
      {
        op: "peer",
        act: (peer) => {
          // Successive revisions of one file give the fetched pack real delta
          // chains, so maintenance has physical bases to preserve.
          for (let revision = 0; revision < 6; revision++) {
            peer.write("story.txt", PARAGRAPH.replace("india", `india ${revision}`));
            peer.commit(`colleague revision ${revision}`);
          }
          peer.write("story.txt", PARAGRAPH.replace("india", "INDIA"));
          peer.write("logo.png", LOGO_BYTES);
          peer.commit("colleague tail and logo");
          peer.git("push", "-q", "origin", "main");
        },
      },
      { op: "write", path: "story.txt", content: PARAGRAPH.replace("alpha", "ALPHA") },
      { op: "add", paths: ["story.txt"] },
      { op: "commit", message: "mine" },
      { op: "fetch" },
      { op: "branch", name: "upstream", startPoint: "origin/main" },
      { op: "reopen" },
      // Head and tail merge cleanly, so the merge commit records a `story.txt`
      // the integration itself produced out of packed inputs.
      { op: "merge", theirs: "upstream", message: "merge upstream" },
      { op: "reopen" },
    );

    const generated = world.mirror.git("rev-parse", "HEAD:story.txt");
    // Neither parent carries this blob: it exists only because the published
    // integration wrote it.
    expect(generated).not.toBe(world.mirror.git("rev-parse", "HEAD^1:story.txt"));
    expect(generated).not.toBe(world.mirror.git("rev-parse", "HEAD^2:story.txt"));

    await world.runLocal(maintenanceRun());

    // Git has no comparable housekeeping pass, so the mirror stays where the
    // last replayed step left it and the comparison is the assertion: a
    // maintenance run changes nothing a caller can observe, before or after
    // the eviction that follows it.
    await world.compare("maintenance changed public state");
    await world.run({ op: "reopen" });
    await world.compare("reopen after maintenance changed public state");

    expect(await readBlob(world, generated)).toEqual(
      world.mirror.gitBinary("cat-file", "blob", generated),
    );

    const firstParent = world.mirror.git("rev-parse", "HEAD^1");
    await world.run(
      // A round trip through the first parent rebuilds the merged tree out of
      // storage, generated blobs and repacked bases alike.
      { op: "checkout", ref: firstParent },
      { op: "checkout", ref: "main" },
      { op: "push" },
    );
  });

  it("never exposes pending-only history when a fetch is interrupted", async () => {
    let onYield: (() => void) | undefined;
    world = await createWorld({
      seed: { "c.txt": "base\n" },
      yieldNow: async () => {
        onYield?.();
      },
    });

    const stream = importStream(IMPORTED_COMMITS);
    await world.run({
      op: "peer",
      act: (peer) => {
        peer.gitInput(stream, "fast-import", "--quiet");
        peer.git("push", "-q", "origin", "main");
      },
    });

    // Sampled across the imported range, so a leak is caught wherever in the
    // transfer the interruption lands.
    const imported = world.peerK.git("rev-list", "main").split("\n").slice(0, IMPORTED_COMMITS);
    const probes = imported.filter((_, index) => index % 384 === 0);
    expect(probes.length).toBeGreaterThan(4);

    const target = world;
    const settled = (await target.snapshot()).kompjutr;
    const unchangedAndInvisible = async (label: string): Promise<void> => {
      expect((await target.snapshot()).kompjutr, label).toEqual(settled);
      for (const oid of probes) {
        await expect(target.git.log({ dir: WORK, ref: oid, depth: 1 }), label).rejects.toThrow();
        await expect(target.git.catFile({ dir: WORK, oid }), label).rejects.toThrow();
      }
    };

    // Cut the transfer off at each successive ingest yield. The loop ends when
    // an attempt outlives every yield, which is the retry that publishes.
    let interruptions = 0;
    for (let cut = 1; cut <= MAX_INTERRUPTIONS; cut++) {
      const controller = new AbortController();
      let reached = 0;
      onYield = () => {
        if (++reached >= cut) controller.abort();
      };
      let aborted = false;
      try {
        await world.git.fetch({ dir: WORK, signal: controller.signal });
      } catch (error) {
        aborted = true;
        expect(error).toMatchObject({ code: "EABORTED" });
      } finally {
        onYield = undefined;
      }
      if (!aborted) break;
      interruptions++;
      // Git cannot be asked to abandon a fetch part way, so the invariant is
      // stated here: an interrupted transfer moves no ref and publishes no
      // commit, in this incarnation or the one that replaces it.
      await unchangedAndInvisible(`interrupted at yield ${cut}`);
      await world.runLocal({ op: "reopen" });
      await unchangedAndInvisible(`interrupted at yield ${cut}, reopened`);
    }
    expect(interruptions, "no fetch was interrupted").toBeGreaterThan(4);

    // The attempt that survived published the transfer whole: every commit the
    // interruptions kept invisible is reachable now.
    for (const oid of probes) {
      const [commit] = await world.git.log({ dir: WORK, ref: oid, depth: 1 });
      expect(commit?.oid).toBe(oid);
    }

    // The mirror has not fetched yet, so it catches up here and the full
    // comparison resumes over the published history.
    await world.run(
      { op: "fetch" },
      { op: "reopen" },
      { op: "merge", theirs: "origin/main", message: "merge origin", fastForwardOnly: true },
      { op: "reopen" },
    );
  });
});
