import { afterAll, describe, expect, it, vi } from "vitest";

import {
  classifyExactRenames,
  type ExactRenameCandidate,
  type ExactRenameClassification,
  exactRenameCandidateRetainedBytes,
  MAX_EXACT_RENAME_CANDIDATES,
  renameDetectionEnabled,
} from "../src/git/ops/status/rename-detection.js";
import { GitFixture } from "./helpers/git.js";
import { makeRepo } from "./helpers/workspace.js";

const SAME_OID = "11".repeat(20);
const OTHER_OID = "22".repeat(20);
const THIRD_OID = "33".repeat(20);

const fixtures: GitFixture[] = [];
afterAll(() => {
  for (const fixture of fixtures) fixture.dispose();
});

function candidate(path: string, oid = SAME_OID, mode = "100644"): ExactRenameCandidate {
  return { path, oid, mode };
}

function renameLines(classification: ExactRenameClassification): string {
  return classification.renames
    .map((rename) => `R100\t${rename.source.path}\t${rename.destination.path}`)
    .join("\n");
}

describe("bounded exact rename classification", () => {
  it("matches Git's basename-first pairing for duplicate object ids", () => {
    const fixture = new GitFixture().init();
    fixtures.push(fixture);
    fixture.write("old/a.txt", "same\n");
    fixture.write("old/b.txt", "same\n");
    fixture.commit("base");
    const oid = fixture.git("rev-parse", "HEAD:old/a.txt");
    fixture.remove("old");
    fixture.write("new/b.txt", "same\n");
    fixture.write("new/a.txt", "same\n");
    fixture.git("add", "-A");

    const classification = classifyExactRenames(
      [candidate("old/b.txt", oid), candidate("old/a.txt", oid)],
      [candidate("new/b.txt", oid), candidate("new/a.txt", oid)],
    );

    expect(renameLines(classification)).toBe(
      fixture.git("diff", "--cached", "--name-status", "-M100%"),
    );
  });

  it("matches Git's destination and source path order when basenames differ", () => {
    const classification = classifyExactRenames(
      [candidate("old/b.txt"), candidate("old/a.txt")],
      [candidate("new/d.txt"), candidate("new/c.txt")],
    );

    expect(renameLines(classification)).toBe(
      "R100\told/a.txt\tnew/c.txt\nR100\told/b.txt\tnew/d.txt",
    );
  });

  it("matches Git for distinct-identity swaps and new directories", () => {
    const classification = classifyExactRenames(
      [candidate("old/a", SAME_OID), candidate("old/b", OTHER_OID)],
      [candidate("new/a", OTHER_OID), candidate("new/deeper/b", SAME_OID)],
    );

    expect(renameLines(classification)).toBe("R100\told/b\tnew/a\nR100\told/a\tnew/deeper/b");
  });

  it("allows regular mode changes but never pairs regular files with symlinks", () => {
    const fixture = new GitFixture().init();
    fixtures.push(fixture);
    fixture.write("old/plain", "same\n");
    fixture.write("old/a-regular", "target");
    fixture.symlink("target", "old/z-link");
    fixture.commit("base");
    const plainOid = fixture.git("rev-parse", "HEAD:old/plain");
    const targetOid = fixture.git("rev-parse", "HEAD:old/a-regular");
    expect(fixture.git("rev-parse", "HEAD:old/z-link")).toBe(targetOid);
    fixture.remove("old");
    fixture.writeExecutable("new/executable", "same\n");
    fixture.symlink("target", "new/a-link");
    fixture.write("new/z-regular", "target");
    fixture.git("add", "-A");

    const classification = classifyExactRenames(
      [
        candidate("old/plain", plainOid),
        candidate("old/a-regular", targetOid),
        candidate("old/z-link", targetOid, "120000"),
      ],
      [
        candidate("new/executable", plainOid, "100755"),
        candidate("new/a-link", targetOid, "120000"),
        candidate("new/z-regular", targetOid),
      ],
    );

    expect(renameLines(classification)).toBe(
      fixture.git("diff", "--cached", "--name-status", "-M100%"),
    );
  });

  it("orders non-BMP paths by Git's UTF-8 byte order", () => {
    const privateUse = "\uE000";
    const nonBmp = "😀";
    const classification = classifyExactRenames(
      [candidate(`old/${nonBmp}`), candidate(`old/${privateUse}`)],
      [candidate(`new/${nonBmp}`), candidate(`new/${privateUse}`)],
    );

    expect(classification.renames.map((rename) => rename.destination.path)).toEqual([
      `new/${privateUse}`,
      `new/${nonBmp}`,
    ]);
  });

  it("classifies a rename path above the former component ceiling", () => {
    const basename = "x".repeat(2_201 - "old/".length);
    const source = candidate(`old/${basename}`);
    const destination = candidate(`new/${basename}`);

    expect(classifyExactRenames([source], [destination])).toMatchObject({
      kind: "classified",
      renames: [{ source, destination, similarity: 100 }],
    });
  });

  it("cannot form a rename after either filtered endpoint is removed", () => {
    expect(classifyExactRenames([candidate("old/a")], []).renames).toEqual([]);
    expect(classifyExactRenames([], [candidate("new/a")]).renames).toEqual([]);
  });

  it("classifies at exact count and byte limits and falls back all at once above them", () => {
    const source = candidate("old/a");
    const destination = candidate("new/a");
    const retainedBytes =
      exactRenameCandidateRetainedBytes(source) + exactRenameCandidateRetainedBytes(destination);

    expect(
      classifyExactRenames([source], [destination], {
        maxCandidates: 2,
        maxRetainedBytes: retainedBytes,
      }),
    ).toMatchObject({ kind: "classified", candidateCount: 2 });
    expect(
      classifyExactRenames([source], [destination, candidate("new/b")], {
        maxCandidates: 2,
      }),
    ).toMatchObject({ kind: "fallback", renames: [], candidateCount: 3 });
    expect(
      classifyExactRenames([source], [destination], {
        maxRetainedBytes: retainedBytes - 1,
      }),
    ).toMatchObject({ kind: "fallback", renames: [], candidateCount: 2 });
  });

  it("scans path grammar and UTF-8 length before the aggregate byte boundary", () => {
    const source = candidate(`old/${"é".repeat(128 * 1024)}`);
    const destination = candidate(`new/${"😀".repeat(64 * 1024)}`);
    const encode = vi.spyOn(TextEncoder.prototype, "encode");
    try {
      const retainedBytes =
        exactRenameCandidateRetainedBytes(source) + exactRenameCandidateRetainedBytes(destination);
      expect(
        classifyExactRenames([source], [destination], { maxRetainedBytes: retainedBytes }),
      ).toMatchObject({ kind: "classified", candidateCount: 2 });
      expect(
        classifyExactRenames([source], [destination], { maxRetainedBytes: retainedBytes - 1 }),
      ).toMatchObject({ kind: "fallback", candidateCount: 2 });
      expect(encode).not.toHaveBeenCalled();
    } finally {
      encode.mockRestore();
    }
  });

  it("rejects corrupt identities and attempts to raise hard limits", () => {
    expect(() => classifyExactRenames([candidate("old/a", "bad")], [])).toThrowError(
      expect.objectContaining({ code: "ECORRUPT" }),
    );
    expect(() => classifyExactRenames([candidate("old/a", SAME_OID, "160000")], [])).toThrowError(
      expect.objectContaining({ code: "ECORRUPT" }),
    );
    expect(() =>
      classifyExactRenames([], [], { maxCandidates: MAX_EXACT_RENAME_CANDIDATES + 1 }),
    ).toThrow(RangeError);
  });
});

describe("rename option resolution", () => {
  it("uses explicit option, then command config, then the enabled default", () => {
    const workspace = makeRepo("/");
    expect(renameDetectionEnabled(workspace.repo, "status", undefined)).toBe(true);
    expect(renameDetectionEnabled(workspace.repo, "diff", undefined)).toBe(true);

    workspace.repo.store.configSet("status.renames", "false");
    workspace.repo.store.configSet("diff.renames", "copies");
    expect(renameDetectionEnabled(workspace.repo, "status", undefined)).toBe(false);
    expect(renameDetectionEnabled(workspace.repo, "diff", undefined)).toBe(true);
    expect(renameDetectionEnabled(workspace.repo, "status", true)).toBe(true);
    expect(renameDetectionEnabled(workspace.repo, "diff", false)).toBe(false);
  });

  it("fails closed on invalid or oversized config unless an explicit option overrides it", () => {
    const workspace = makeRepo("/");
    workspace.repo.store.configSet("status.renames", "invalid");
    expect(() => renameDetectionEnabled(workspace.repo, "status", undefined)).toThrowError(
      expect.objectContaining({ code: "EINVAL" }),
    );
    expect(renameDetectionEnabled(workspace.repo, "status", false)).toBe(false);

    workspace.repo.store.configSet("diff.renames", THIRD_OID);
    expect(() => renameDetectionEnabled(workspace.repo, "diff", undefined)).toThrowError(
      expect.objectContaining({ code: "E2BIG" }),
    );
    expect(renameDetectionEnabled(workspace.repo, "diff", true)).toBe(true);
  });
});
