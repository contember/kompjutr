import { describe, expect, it } from "vitest";

import { resolveBranchUpstream } from "../src/core/ops/branch-upstream.js";
import { makeRepo } from "./helpers/workspace.js";

const OID = "0123456789abcdef0123456789abcdef01234567";

describe("branch upstream resolver", () => {
  it("requires a bounded branch ref before reading config", () => {
    const { repo } = makeRepo("/");

    for (const ref of ["refs/tags/main", "refs/heads/bad..name"]) {
      expect(() => resolveBranchUpstream(repo, ref)).toThrowError(
        expect.objectContaining({ code: "EINVALIDREF" }),
      );
    }
    expect(() => resolveBranchUpstream(repo, `refs/heads/${"a".repeat(1_014)}`)).toThrowError(
      expect.objectContaining({ code: "E2BIG" }),
    );
  });

  it("returns undefined without complete config and null for a missing upstream ref", () => {
    const { repo } = makeRepo("/");
    expect(resolveBranchUpstream(repo, "refs/heads/main")).toBeUndefined();

    repo.store.configSet("branch.main.remote", ".");
    expect(resolveBranchUpstream(repo, "refs/heads/main")).toBeUndefined();
    repo.store.configSet("branch.main.merge", "refs/heads/missing");
    expect(resolveBranchUpstream(repo, "refs/heads/main")).toEqual({
      name: "missing",
      ref: "refs/heads/missing",
      oid: null,
    });
  });

  it("returns the local upstream ref, display name, and direct oid", () => {
    const { repo } = makeRepo("/");
    repo.store.configSet("branch.main.remote", ".");
    repo.store.configSet("branch.main.merge", "refs/heads/release");
    repo.store.setRef("refs/heads/release", OID);

    expect(resolveBranchUpstream(repo, "refs/heads/main")).toEqual({
      name: "release",
      ref: "refs/heads/release",
      oid: OID,
    });
  });

  it("returns the remote-tracking ref only for the supported direct fetch mapping", () => {
    const { repo } = makeRepo("/");
    repo.store.configSet("branch.main.remote", "origin");
    repo.store.configSet("branch.main.merge", "refs/heads/release");
    repo.store.configSet("remote.origin.fetch", "+refs/heads/*:refs/remotes/origin/*");
    repo.store.setRef("refs/remotes/origin/release", OID);

    expect(resolveBranchUpstream(repo, "refs/heads/main")).toEqual({
      name: "origin/release",
      ref: "refs/remotes/origin/release",
      oid: OID,
    });

    repo.store.configSet("remote.origin.fetch", "+refs/heads/release:refs/remotes/origin/release");
    expect(resolveBranchUpstream(repo, "refs/heads/main")).toBeUndefined();
  });

  it("rejects invalid and oversized upstream config", () => {
    const { repo } = makeRepo("/");
    repo.store.configSet("branch.main.remote", ".");
    repo.store.configSet("branch.main.merge", "refs/tags/release");
    expect(() => resolveBranchUpstream(repo, "refs/heads/main")).toThrowError(
      expect.objectContaining({ code: "EINVALIDREF" }),
    );

    repo.store.configSet("branch.main.merge", "a".repeat(1_025));
    expect(() => resolveBranchUpstream(repo, "refs/heads/main")).toThrowError(
      expect.objectContaining({ code: "E2BIG" }),
    );

    repo.store.configSet("branch.main.merge", "refs/heads/release");
    repo.store.configSet("branch.main.remote", "bad..remote");
    expect(() => resolveBranchUpstream(repo, "refs/heads/main")).toThrowError(
      expect.objectContaining({ code: "EINVAL" }),
    );
  });

  it("rejects a corrupt direct upstream ref", () => {
    const workspace = makeRepo("/");
    workspace.repo.store.configSet("branch.main.remote", ".");
    workspace.repo.store.configSet("branch.main.merge", "refs/heads/release");
    workspace.repo.store.setRef("refs/heads/release", OID);
    workspace.database.db.run(
      "UPDATE git_refs SET target = ? WHERE repo_id = ? AND name = ?",
      "malformed",
      workspace.repo.store.repoId,
      "refs/heads/release",
    );

    expect(() => resolveBranchUpstream(workspace.repo, "refs/heads/main")).toThrowError(
      expect.objectContaining({ code: "ECORRUPT" }),
    );
  });
});
