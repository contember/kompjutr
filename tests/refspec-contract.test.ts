import { readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { type GitCommandResult, GitFixture } from "./helpers/git.js";

interface RefspecFixture {
  readonly fixture: GitFixture;
  readonly origin: string;
  readonly base: string;
  readonly next: string;
  readonly divergent: string;
  readonly blob: string;
  readonly tree: string;
  readonly annotatedTag: string;
}

function refspecFixture(): RefspecFixture {
  const fixture = new GitFixture().init();
  fixture.write("tracked.txt", "base\n");
  const base = fixture.commit("base");
  fixture.write("tracked.txt", "next\n");
  const next = fixture.commit("next");
  const tree = fixture.git("rev-parse", `${next}^{tree}`);
  const blob = fixture.gitInput("standalone blob\n", "hash-object", "-w", "--stdin");
  const divergent = fixture.gitInput("divergent\n", "commit-tree", tree, "-p", base);
  fixture.git("update-ref", "refs/heads/divergent", divergent);
  fixture.git("update-ref", "refs/checkpoints/local/one", next);
  fixture.git("update-ref", "refs/checkpoints/local/two", divergent);
  fixture.git("tag", "-a", "candidate", "-m", "candidate", next);
  fixture.git("tag", "light", next);
  const annotatedTag = fixture.git("rev-parse", "refs/tags/candidate");
  const origin = join(fixture.dir, "origin.git");
  fixture.git("clone", "-q", "--bare", ".", origin);
  fixture.git("remote", "add", "origin", origin);
  fixture.git(`--git-dir=${origin}`, "config", "receive.advertisePushOptions", "true");
  return { fixture, origin, base, next, divergent, blob, tree, annotatedTag };
}

function bareGit(world: RefspecFixture, ...args: string[]): string {
  return world.fixture.git(`--git-dir=${world.origin}`, ...args);
}

function bareResult(world: RefspecFixture, ...args: string[]): GitCommandResult {
  return world.fixture.gitResult(`--git-dir=${world.origin}`, ...args);
}

function updateRemote(world: RefspecFixture, ref: string, oid: string): void {
  bareGit(world, "update-ref", ref, oid);
}

function remoteRef(world: RefspecFixture, ref: string): string | null {
  const result = bareResult(world, "show-ref", "--verify", "--hash", ref);
  if (result.status !== 0) return null;
  return result.stdout;
}

function clientGit(world: RefspecFixture, ...args: string[]): string {
  return world.fixture.git("-C", "client", ...args);
}

function clientResult(world: RefspecFixture, ...args: string[]): GitCommandResult {
  return world.fixture.gitResult("-C", "client", ...args);
}

function initClient(world: RefspecFixture): void {
  world.fixture.git("init", "-q", "-b", "scratch", "client");
  clientGit(world, "remote", "add", "origin", world.origin);
  clientGit(world, "fetch", "-q", "origin", "refs/heads/main:refs/remotes/origin/main");
  clientGit(world, "checkout", "-q", "-b", "work", "refs/remotes/origin/main");
}

function output(result: GitCommandResult): string {
  return `${result.stdout}\n${result.stderr}`;
}

describe("real Git refspec transport contract", () => {
  it("pins ls-remote tail wildmatch, HEAD symref, and peeled tag rows", () => {
    const world = refspecFixture();
    try {
      updateRemote(world, "refs/heads/team/alpha", world.next);
      updateRemote(world, "refs/checkpoints/team/alpha", world.divergent);

      const all = world.fixture.git("ls-remote", world.origin).split("\n");
      expect(all).toContain(`${world.next}\tHEAD`);
      expect(all).toContain(`${world.annotatedTag}\trefs/tags/candidate`);
      expect(all).toContain(`${world.next}\trefs/tags/candidate^{}`);
      expect(all).toContain(`${world.next}\trefs/tags/light`);

      const symref = world.fixture.git("ls-remote", "--symref", world.origin);
      expect(symref).toContain("ref: refs/heads/main\tHEAD");

      for (const pattern of ["team/*", "refs/*/team/*", "t?am/a[lp]pha", "alpha"]) {
        const rows = world.fixture.git("ls-remote", world.origin, pattern).split("\n");
        expect(rows).toContain(`${world.next}\trefs/heads/team/alpha`);
        expect(rows).toContain(`${world.divergent}\trefs/checkpoints/team/alpha`);
      }

      const heads = world.fixture.git("ls-remote", world.origin, "heads/*");
      expect(heads).toContain("refs/heads/team/alpha");
      expect(heads).not.toContain("refs/checkpoints/team/alpha");
      expect(world.fixture.gitResult("ls-remote", world.origin, "missing/*")).toEqual({
        status: 0,
        stdout: "",
        stderr: "",
      });
    } finally {
      world.fixture.dispose();
    }
  });

  it("pins exact and wildcard fetch, no-match, force, type, and checkout rules", () => {
    const world = refspecFixture();
    try {
      updateRemote(world, "refs/checkpoints/one", world.next);
      updateRemote(world, "refs/checkpoints/two", world.divergent);
      updateRemote(world, "refs/heads/old", world.base);
      updateRemote(world, "refs/tags/replace", world.base);
      updateRemote(world, "refs/custom/tree", world.tree);
      updateRemote(world, "refs/custom/blob", world.blob);
      initClient(world);

      clientGit(world, "fetch", "-q", "origin", "refs/checkpoints/one:refs/checkpoints/exact");
      expect(clientGit(world, "rev-parse", "refs/checkpoints/exact")).toBe(world.next);

      clientGit(world, "fetch", "-q", "origin", "+refs/checkpoints/*:refs/restored/*");
      expect(clientGit(world, "rev-parse", "refs/restored/one")).toBe(world.next);
      expect(clientGit(world, "rev-parse", "refs/restored/two")).toBe(world.divergent);

      const beforeNoMatch = clientGit(world, "show-ref");
      expect(
        clientResult(world, "fetch", "-q", "origin", "+refs/absent/*:refs/absent/*"),
      ).toMatchObject({ status: 0 });
      expect(clientGit(world, "show-ref")).toBe(beforeNoMatch);
      expect(
        clientResult(world, "fetch", "-q", "origin", "refs/absent/exact:refs/tmp/exact"),
      ).toMatchObject({ status: 128 });

      const duplicate = clientResult(
        world,
        "fetch",
        "-q",
        "origin",
        "refs/checkpoints/one:refs/tmp/collision",
        "refs/checkpoints/two:refs/tmp/collision",
      );
      expect(duplicate.status).not.toBe(0);
      expect(clientResult(world, "show-ref", "--verify", "refs/tmp/collision").status).not.toBe(0);

      clientGit(world, "update-ref", "refs/heads/nonff", world.next);
      expect(
        clientResult(world, "fetch", "-q", "origin", "refs/heads/old:refs/heads/nonff").status,
      ).not.toBe(0);
      expect(clientGit(world, "rev-parse", "refs/heads/nonff")).toBe(world.next);
      clientGit(world, "fetch", "-q", "origin", "+refs/heads/old:refs/heads/nonff");
      expect(clientGit(world, "rev-parse", "refs/heads/nonff")).toBe(world.base);

      clientGit(world, "update-ref", "refs/tags/local", world.next);
      expect(
        clientResult(world, "fetch", "-q", "origin", "refs/tags/replace:refs/tags/local").status,
      ).not.toBe(0);
      expect(clientGit(world, "rev-parse", "refs/tags/local")).toBe(world.next);
      clientGit(world, "fetch", "-q", "origin", "+refs/tags/replace:refs/tags/local");
      expect(clientGit(world, "rev-parse", "refs/tags/local")).toBe(world.base);

      clientGit(world, "update-ref", "refs/custom/local", world.next);
      clientGit(world, "fetch", "-q", "origin", "refs/custom/tree:refs/custom/local");
      expect(clientGit(world, "rev-parse", "refs/custom/local")).toBe(world.tree);

      clientGit(world, "branch", "locked", world.next);
      clientGit(world, "checkout", "-q", "locked");
      const locked = clientResult(
        world,
        "fetch",
        "-q",
        "origin",
        "+refs/heads/old:refs/heads/locked",
      );
      expect(locked.status).not.toBe(0);
      expect(output(locked)).toContain("checked out");
      expect(clientGit(world, "rev-parse", "refs/heads/locked")).toBe(world.next);

      clientGit(world, "branch", "linked", world.next);
      clientGit(world, "worktree", "add", "-q", "../linked", "linked");
      const linked = clientResult(
        world,
        "fetch",
        "-q",
        "origin",
        "+refs/heads/old:refs/heads/linked",
      );
      expect(linked.status).not.toBe(0);
      expect(output(linked)).toContain("checked out");
      expect(clientGit(world, "rev-parse", "refs/heads/linked")).toBe(world.next);

      const wrongType = clientResult(
        world,
        "fetch",
        "-q",
        "origin",
        "+refs/custom/blob:refs/heads/blob-target",
      );
      expect(wrongType.status).not.toBe(0);
      expect(clientResult(world, "show-ref", "--verify", "refs/heads/blob-target").status).not.toBe(
        0,
      );
    } finally {
      world.fixture.dispose();
    }
  });

  it("pins push namespace rules, oid sources, wildcard expansion, and deletion", () => {
    const world = refspecFixture();
    try {
      expect(
        world.fixture.gitResult("push", "-q", "origin", "refs/absent/*:refs/checkpoints/absent/*"),
      ).toMatchObject({ status: 0 });
      expect(remoteRef(world, "refs/checkpoints/absent/example")).toBeNull();
      expect(
        world.fixture.gitResult(
          "push",
          "-q",
          "origin",
          "refs/absent/*:refs/checkpoints/absent/*",
          `${world.next}:refs/checkpoints/mixed-match`,
        ),
      ).toMatchObject({ status: 0 });
      expect(remoteRef(world, "refs/checkpoints/mixed-match")).toBe(world.next);
      expect(
        world.fixture.gitResult(
          "push",
          "-q",
          "origin",
          "refs/heads/missing:refs/checkpoints/missing-source",
        ).status,
      ).not.toBe(0);
      const mixedMissing = world.fixture.gitResult(
        "push",
        "-q",
        "origin",
        "refs/heads/missing:refs/checkpoints/missing-source",
        `${world.next}:refs/checkpoints/missing-companion`,
      );
      expect(mixedMissing.status).not.toBe(0);
      expect(remoteRef(world, "refs/checkpoints/missing-companion")).toBeNull();
      const duplicate = world.fixture.gitResult(
        "push",
        "-q",
        "origin",
        `${world.next}:refs/checkpoints/collision`,
        `${world.divergent}:refs/checkpoints/collision`,
      );
      expect(duplicate.status).not.toBe(0);
      expect(remoteRef(world, "refs/checkpoints/collision")).toBeNull();

      updateRemote(world, "refs/heads/target", world.base);
      expect(
        world.fixture.gitResult("push", "-q", "origin", `${world.next}:refs/heads/target`),
      ).toMatchObject({ status: 0 });
      expect(remoteRef(world, "refs/heads/target")).toBe(world.next);
      expect(
        world.fixture.gitResult("push", "-q", "origin", `${world.divergent}:refs/heads/target`)
          .status,
      ).not.toBe(0);
      expect(remoteRef(world, "refs/heads/target")).toBe(world.next);
      expect(
        world.fixture.gitResult("push", "-q", "origin", `+${world.divergent}:refs/heads/target`),
      ).toMatchObject({ status: 0 });
      expect(remoteRef(world, "refs/heads/target")).toBe(world.divergent);

      expect(
        world.fixture.gitResult("push", "-q", "origin", `+${world.blob}:refs/heads/blob-target`)
          .status,
      ).not.toBe(0);
      expect(remoteRef(world, "refs/heads/blob-target")).toBeNull();

      updateRemote(world, "refs/tags/release", world.base);
      expect(
        world.fixture.gitResult("push", "-q", "origin", `${world.next}:refs/tags/release`).status,
      ).not.toBe(0);
      expect(remoteRef(world, "refs/tags/release")).toBe(world.base);
      world.fixture.git("push", "-q", "origin", `+${world.next}:refs/tags/release`);
      expect(remoteRef(world, "refs/tags/release")).toBe(world.next);

      updateRemote(world, "refs/custom/object", world.blob);
      expect(
        world.fixture.gitResult("push", "-q", "origin", `${world.tree}:refs/custom/object`).status,
      ).not.toBe(0);
      expect(remoteRef(world, "refs/custom/object")).toBe(world.blob);
      world.fixture.git("push", "-q", "origin", `+${world.tree}:refs/custom/object`);
      expect(remoteRef(world, "refs/custom/object")).toBe(world.tree);

      updateRemote(world, "refs/custom/commit", world.base);
      world.fixture.git("push", "-q", "origin", `${world.next}:refs/custom/commit`);
      expect(remoteRef(world, "refs/custom/commit")).toBe(world.next);
      expect(
        world.fixture.gitResult("push", "-q", "origin", `${world.divergent}:refs/custom/commit`)
          .status,
      ).not.toBe(0);
      world.fixture.git("push", "-q", "origin", `+${world.divergent}:refs/custom/commit`);
      expect(remoteRef(world, "refs/custom/commit")).toBe(world.divergent);

      updateRemote(world, "refs/custom/tagged-commit", world.base);
      world.fixture.git("push", "-q", "origin", `${world.annotatedTag}:refs/custom/tagged-commit`);
      expect(remoteRef(world, "refs/custom/tagged-commit")).toBe(world.annotatedTag);

      world.fixture.git("push", "-q", "origin", `${world.blob}:refs/checkpoints/blob`);
      expect(remoteRef(world, "refs/checkpoints/blob")).toBe(world.blob);
      world.fixture.git("push", "-q", "origin", "refs/checkpoints/local/*:refs/checkpoints/wild/*");
      expect(remoteRef(world, "refs/checkpoints/wild/one")).toBe(world.next);
      expect(remoteRef(world, "refs/checkpoints/wild/two")).toBe(world.divergent);

      world.fixture.git("push", "-q", "origin", ":refs/checkpoints/wild/one");
      expect(remoteRef(world, "refs/checkpoints/wild/one")).toBeNull();
      expect(
        world.fixture.gitResult("push", "-q", "origin", ":refs/checkpoints/missing"),
      ).toMatchObject({ status: 0 });
      expect(remoteRef(world, "refs/checkpoints/missing")).toBeNull();
    } finally {
      world.fixture.dispose();
    }
  });

  it("pins non-atomic partial status, atomic rejection, and push options", () => {
    const world = refspecFixture();
    try {
      world.fixture.writeExecutable(
        "origin.git/hooks/update",
        '#!/bin/sh\ncase "$1" in\n  refs/checkpoints/reject|refs/checkpoints/atomic-reject) exit 1 ;;\nesac\nexit 0\n',
      );
      world.fixture.writeExecutable(
        "origin.git/hooks/pre-receive",
        '#!/bin/sh\n{\n  printf "%s\\n" "$GIT_PUSH_OPTION_COUNT"\n  printf "%s\\n" "$GIT_PUSH_OPTION_0"\n  printf "%s\\n" "$GIT_PUSH_OPTION_1"\n} > push-options.log\ncat >/dev/null\n',
      );

      const partial = world.fixture.gitResult(
        "push",
        "--porcelain",
        "origin",
        `${world.next}:refs/checkpoints/accepted`,
        `${world.next}:refs/checkpoints/reject`,
      );
      expect(partial.status).not.toBe(0);
      expect(output(partial)).toContain("refs/checkpoints/accepted");
      expect(output(partial)).toContain("refs/checkpoints/reject");
      expect(remoteRef(world, "refs/checkpoints/accepted")).toBe(world.next);
      expect(remoteRef(world, "refs/checkpoints/reject")).toBeNull();

      const atomic = world.fixture.gitResult(
        "push",
        "--porcelain",
        "--atomic",
        "origin",
        `${world.next}:refs/checkpoints/atomic-accepted`,
        `${world.next}:refs/checkpoints/atomic-reject`,
      );
      expect(atomic.status).not.toBe(0);
      expect(output(atomic)).toContain("refs/checkpoints/atomic-accepted");
      expect(output(atomic)).toContain("refs/checkpoints/atomic-reject");
      expect(remoteRef(world, "refs/checkpoints/atomic-accepted")).toBeNull();
      expect(remoteRef(world, "refs/checkpoints/atomic-reject")).toBeNull();

      expect(
        world.fixture.gitResult(
          "push",
          "-q",
          "-o",
          "alpha",
          "-o",
          "beta=value",
          "origin",
          `${world.next}:refs/checkpoints/options`,
        ),
      ).toMatchObject({ status: 0 });
      expect(readFileSync(join(world.origin, "push-options.log"), "utf8")).toBe(
        "2\nalpha\nbeta=value\n",
      );
    } finally {
      world.fixture.dispose();
    }
  });

  it("pins a post-receive hook changing a successfully reported target", () => {
    const world = refspecFixture();
    try {
      world.fixture.writeExecutable(
        "origin.git/hooks/post-receive",
        '#!/bin/sh\nwhile read old new ref\ndo\n  if test "$ref" = "refs/heads/hooked"\n  then\n    git update-ref "$ref" "' +
          world.divergent +
          '"\n  fi\ndone\n',
      );
      const result = world.fixture.gitResult(
        "push",
        "--porcelain",
        "origin",
        `${world.next}:refs/heads/hooked`,
      );
      expect(result.status).toBe(0);
      expect(output(result)).toContain("refs/heads/hooked");
      expect(remoteRef(world, "refs/heads/hooked")).toBe(world.divergent);
    } finally {
      world.fixture.dispose();
    }
  });
});
