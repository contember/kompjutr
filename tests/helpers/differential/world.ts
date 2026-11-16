import type { LocalWorkspace } from "@kompjutr/local";
import { type LocalFixture, localFixture } from "../../local/helpers.js";
import { GitFixture } from "../git.js";
import type { GitServer } from "../http-backend.js";
import { startGitServer } from "../http-backend.js";
import { writeFile } from "./disk.js";
import { contentBytes, type Op, type WorldStart } from "./ops.js";
import { CLEAN, type Outcome } from "./outcome.js";
import { FIXED_TIME } from "./snapshot.js";
import { applyGit } from "./world-git.js";
import { applyKompjutr, capture } from "./world-kompjutr.js";

export type { Outcome, OutcomeKind } from "./outcome.js";

const IDENTITY = { name: "Fixture", email: "fixture@example.com" };

export interface DifferentialWorld {
  readonly start: WorldStart;
  readonly workspace: LocalWorkspace;
  readonly root: string;
  readonly mirror: GitFixture;
  readonly origins: { kompjutr: GitFixture; git: GitFixture } | null;
  applyKompjutr(op: Op): Promise<Outcome>;
  applyGit(op: Op): Outcome;
  dispose(): Promise<void>;
}

/** What a cloned world's origin holds before either side clones it. */
function seedOrigin(seed: GitFixture): void {
  seed.write("README.md", "seed\n").write("dir/x.txt", "alpha\nbeta\ngamma\n");
  seed.commit("seed");
  seed.git("checkout", "-q", "-b", "feature");
  seed.write("dir/y.txt", "feature\n").commit("feature work");
  seed.git("checkout", "-q", "main");
  seed.write("README.md", "seed\nmain\n").commit("main work");
}

export async function createWorld(start: WorldStart): Promise<DifferentialWorld> {
  const fixtures: GitFixture[] = [];
  const track = (fixture: GitFixture): GitFixture => {
    fixtures.push(fixture);
    return fixture;
  };
  const local: LocalFixture = localFixture();
  const open = (): LocalWorkspace =>
    local.workspace({
      now: () => FIXED_TIME,
      timezoneOffset: () => 0,
      defaultGitIdentity: IDENTITY,
    });
  let workspace: LocalWorkspace | null = null;
  let server: GitServer | null = null;
  let origins: DifferentialWorld["origins"] = null;
  let peers: { kompjutr: GitFixture; git: GitFixture } | null = null;
  const release = async (): Promise<void> => {
    try {
      workspace?.close();
      workspace = null;
    } finally {
      try {
        await server?.close();
      } finally {
        for (const fixture of fixtures) fixture.dispose();
        local.dispose();
      }
    }
  };

  let opened: LocalWorkspace;
  let mirror: GitFixture;
  try {
    mirror = track(new GitFixture());
    opened = open();
    workspace = opened;
    if (start === "clone") {
      const seed = track(new GitFixture().init());
      seedOrigin(seed);
      origins = { kompjutr: track(bareClone(seed)), git: track(bareClone(seed)) };
      peers = { kompjutr: track(new GitFixture()), git: track(new GitFixture()) };
      peers.kompjutr.git("clone", "-q", origins.kompjutr.dir, ".");
      peers.git.git("clone", "-q", origins.git.dir, ".");
      server = await startGitServer(origins.kompjutr.dir);
      // kompjutr's clone defaults are shallow, single-branch and tagless;
      // ask for the shape `git clone` produces.
      await opened.git.clone({
        url: server.url,
        dir: "/",
        depth: 0,
        singleBranch: false,
        noTags: false,
      });
      mirror.git("clone", "-q", origins.git.dir, ".");
      mirror.git("config", "core.autocrlf", "false");
    } else {
      await opened.git.init();
      mirror.init("main");
    }
    // kompjutr's integrations detect no renames, a documented difference.
    mirror.git("config", "merge.renames", "false");
  } catch (error) {
    await release();
    throw error;
  }

  const world: DifferentialWorld = {
    start,
    get workspace() {
      return opened;
    },
    root: local.root,
    mirror,
    origins,
    async applyKompjutr(op) {
      if (op.op === "reopen") {
        workspace = null;
        opened.close();
        opened = open();
        workspace = opened;
        return CLEAN;
      }
      if (op.op === "peerCommit") return peerCommit(peers?.kompjutr, op);
      return capture(() => applyKompjutr(opened, op));
    },
    applyGit(op) {
      if (op.op === "peerCommit") return peerCommit(peers?.git, op);
      return applyGit(mirror, op);
    },
    dispose: release,
  };
  return world;
}

function bareClone(source: GitFixture): GitFixture {
  const bare = new GitFixture();
  bare.git("clone", "--bare", "-q", source.dir, ".");
  return bare;
}

/** Real git plays the colleague on one side; both sides get the same commit. */
function peerCommit(peer: GitFixture | undefined, op: Extract<Op, { op: "peerCommit" }>): Outcome {
  if (peer === undefined) throw new Error("peerCommit needs a cloned world");
  peer.git("fetch", "-q", "origin");
  const remote = `origin/${op.branch}`;
  const exists = peer.gitResult("rev-parse", "--verify", "--quiet", remote).status === 0;
  peer.git("checkout", "-q", "-B", op.branch, exists ? remote : "origin/main");
  writeFile(peer.dir, op.path, contentBytes(op.content), false);
  peer.git("add", "-A");
  peer.git("commit", "-q", "--allow-empty", "-m", op.message);
  peer.git("push", "-q", "origin", op.branch);
  return CLEAN;
}
