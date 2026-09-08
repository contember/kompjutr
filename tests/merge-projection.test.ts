import { describe, expect, it } from "vitest";

import type {
  IntegrationConflictKind,
  IntegrationPlan,
} from "../packages/git/src/ops/integration/integration.js";
import type { IntegrationIdentity } from "../packages/git/src/ops/integration/integration-structure.js";
import { projectMergePlan } from "../packages/git/src/ops/merge/merge-projection.js";

function identity(digit: string, mode = "100644"): IntegrationIdentity {
  return { mode, oid: digit.repeat(40) };
}

function conflictPlan(
  base: IntegrationIdentity | null,
  current: IntegrationIdentity,
  incoming: IntegrationIdentity,
  conflict: IntegrationConflictKind,
): IntegrationPlan {
  return {
    entries: [
      {
        kind: "conflict",
        path: "x",
        conflict,
        stages: { base, current, incoming },
        content: null,
      },
    ],
    sourceRows: 1,
  };
}

describe("merge projection", () => {
  it("projects conflict content with its independently resolved mode", () => {
    const base = identity("1");
    const current = identity("2");
    const incoming = identity("3", "100755");
    const content = new TextEncoder().encode("conflict markers\n");
    const plan: IntegrationPlan = {
      entries: [
        {
          kind: "conflict",
          path: "x",
          conflict: "content",
          stages: { base, current, incoming },
          resultMode: "100755",
          content,
        },
      ],
      sourceRows: 1,
    };

    expect(projectMergePlan(plan, { currentLabel: "HEAD", incomingLabel: "topic" })).toEqual([
      {
        path: "x",
        logicalPath: "x",
        purpose: "primary",
        stageZero: null,
        stages: { base, current, incoming },
        worktree: { mode: "100755", oid: current.oid },
        content,
      },
    ]);
  });

  it("keeps an incoming symlink primary and relocates the current regular file", () => {
    const current = identity("2");
    const incoming = identity("3", "120000");

    expect(
      projectMergePlan(conflictPlan(null, current, incoming, "add/add"), {
        currentLabel: "HEAD",
        incomingLabel: "topic",
      }),
    ).toEqual([
      {
        path: "x",
        logicalPath: "x",
        purpose: "primary",
        stageZero: null,
        stages: { base: null, current: null, incoming },
        worktree: incoming,
        content: null,
      },
      {
        path: "x~HEAD",
        logicalPath: "x",
        purpose: "current-relocation",
        stageZero: null,
        stages: { base: null, current, incoming: null },
        worktree: current,
        content: null,
      },
    ]);
  });

  it("keeps a current symlink primary and relocates the incoming regular file", () => {
    const current = identity("2", "120000");
    const incoming = identity("3", "100755");

    expect(
      projectMergePlan(conflictPlan(null, current, incoming, "add/add"), {
        currentLabel: "HEAD",
        incomingLabel: "topic",
      }),
    ).toEqual([
      {
        path: "x",
        logicalPath: "x",
        purpose: "primary",
        stageZero: null,
        stages: { base: null, current, incoming: null },
        worktree: current,
        content: null,
      },
      {
        path: "x~topic",
        logicalPath: "x",
        purpose: "incoming-relocation",
        stageZero: null,
        stages: { base: null, current: null, incoming },
        worktree: incoming,
        content: null,
      },
    ]);
  });

  it("moves a regular merge base to the regular relocation", () => {
    const base = identity("1");
    const current = identity("2", "100755");
    const incoming = identity("3", "120000");

    expect(
      projectMergePlan(conflictPlan(base, current, incoming, "symlink"), {
        currentLabel: "HEAD",
        incomingLabel: "topic",
      }),
    ).toEqual([
      {
        path: "x",
        logicalPath: "x",
        purpose: "primary",
        stageZero: null,
        stages: { base: null, current: null, incoming },
        worktree: incoming,
        content: null,
      },
      {
        path: "x~HEAD",
        logicalPath: "x",
        purpose: "current-relocation",
        stageZero: null,
        stages: { base, current, incoming: null },
        worktree: current,
        content: null,
      },
    ]);
  });

  it("keeps a symlink merge base with the primary symlink", () => {
    const base = identity("1", "120000");
    const current = identity("2");
    const incoming = identity("3", "120000");

    expect(
      projectMergePlan(conflictPlan(base, current, incoming, "symlink"), {
        currentLabel: "HEAD",
        incomingLabel: "topic",
      }),
    ).toEqual([
      {
        path: "x",
        logicalPath: "x",
        purpose: "primary",
        stageZero: null,
        stages: { base, current: null, incoming },
        worktree: incoming,
        content: null,
      },
      {
        path: "x~HEAD",
        logicalPath: "x",
        purpose: "current-relocation",
        stageZero: null,
        stages: { base: null, current, incoming: null },
        worktree: current,
        content: null,
      },
    ]);
  });

  it("does not split two regular modes", () => {
    const current = identity("2");
    const incoming = identity("3", "100755");

    expect(
      projectMergePlan(conflictPlan(null, current, incoming, "add/add"), {
        currentLabel: "HEAD",
        incomingLabel: "topic",
      }),
    ).toEqual([
      {
        path: "x",
        logicalPath: "x",
        purpose: "primary",
        stageZero: null,
        stages: { base: null, current, incoming },
        worktree: current,
        content: null,
      },
    ]);
  });

  it("reuses collision suffixes and bounds distinct-type relocation paths", () => {
    const current = identity("2");
    const incoming = identity("3", "120000");
    const plan = conflictPlan(null, current, incoming, "add/add");

    expect(
      projectMergePlan(plan, {
        currentLabel: "HEAD",
        incomingLabel: "topic",
        trackedCollisions: new Set(["x~HEAD", "x~HEAD_0"]),
      })[1]?.path,
    ).toBe("x~HEAD_1");
    expect(() =>
      projectMergePlan(plan, {
        currentLabel: "HEAD",
        incomingLabel: "topic",
        untrackedCollisions: new Set(["x~HEAD"]),
      }),
    ).toThrow(expect.objectContaining({ code: "ECHECKOUTFAIL" }));
    expect(() =>
      projectMergePlan(plan, {
        currentLabel: "z".repeat(2_200),
        incomingLabel: "topic",
      }),
    ).toThrow(expect.objectContaining({ code: "E2BIG" }));
  });

  it("relocates the current file and makes an added incoming descendant stage zero", () => {
    const current = identity("1");
    const incoming = identity("2");
    const plan: IntegrationPlan = {
      entries: [
        {
          kind: "conflict",
          path: "x",
          conflict: "file/directory",
          stages: { base: null, current, incoming: null },
          content: null,
        },
        {
          kind: "conflict",
          path: "x/y",
          conflict: "file/directory",
          stages: { base: null, current: null, incoming },
          content: null,
        },
      ],
      sourceRows: 2,
    };

    expect(projectMergePlan(plan, { currentLabel: "HEAD", incomingLabel: "topic" })).toEqual([
      {
        path: "x/y",
        logicalPath: "x/y",
        purpose: "primary",
        stageZero: incoming,
        stages: null,
        worktree: incoming,
        content: null,
      },
      {
        path: "x~HEAD",
        logicalPath: "x",
        purpose: "current-relocation",
        stageZero: null,
        stages: { base: null, current, incoming: null },
        worktree: current,
        content: null,
      },
    ]);
  });

  it("moves base/current stages with a modified current file", () => {
    const base = identity("1");
    const current = identity("2", "100755");
    const incoming = identity("3");
    const plan: IntegrationPlan = {
      entries: [
        {
          kind: "conflict",
          path: "x",
          conflict: "file/directory",
          stages: { base, current, incoming: null },
          content: null,
        },
        {
          kind: "conflict",
          path: "x/y",
          conflict: "file/directory",
          stages: { base: null, current: null, incoming },
          content: null,
        },
      ],
      sourceRows: 2,
    };

    expect(projectMergePlan(plan, { currentLabel: "HEAD", incomingLabel: "topic" })[1]).toEqual({
      path: "x~HEAD",
      logicalPath: "x",
      purpose: "current-relocation",
      stageZero: null,
      stages: { base, current, incoming: null },
      worktree: current,
      content: null,
    });
  });

  it("relocates the incoming file and keeps a modify/delete descendant conflicted", () => {
    const base = identity("1");
    const current = identity("2");
    const incoming = identity("3", "100755");
    const plan: IntegrationPlan = {
      entries: [
        {
          kind: "conflict",
          path: "x",
          conflict: "file/directory",
          stages: { base: null, current: null, incoming },
          content: null,
        },
        {
          kind: "conflict",
          path: "x/y",
          conflict: "file/directory",
          stages: { base, current, incoming: null },
          content: null,
        },
      ],
      sourceRows: 2,
    };

    expect(projectMergePlan(plan, { currentLabel: "HEAD", incomingLabel: "topic" })).toEqual([
      {
        path: "x/y",
        logicalPath: "x/y",
        purpose: "primary",
        stageZero: null,
        stages: { base, current, incoming: null },
        worktree: current,
        content: null,
      },
      {
        path: "x~topic",
        logicalPath: "x",
        purpose: "incoming-relocation",
        stageZero: null,
        stages: { base: null, current: null, incoming },
        worktree: incoming,
        content: null,
      },
    ]);
  });

  it("sanitizes branch slashes and follows tracked suffixes", () => {
    const incoming = identity("3");
    const plan: IntegrationPlan = {
      entries: [
        {
          kind: "conflict",
          path: "x",
          conflict: "file/directory",
          stages: { base: null, current: null, incoming },
          content: null,
        },
      ],
      sourceRows: 1,
    };

    expect(
      projectMergePlan(plan, {
        currentLabel: "HEAD",
        incomingLabel: "feature/side",
        trackedCollisions: new Set(["x~feature_side", "x~feature_side_0"]),
      })[0]?.path,
    ).toBe("x~feature_side_1");
  });

  it("refuses an untracked collision at the selected path", () => {
    const incoming = identity("3");
    const plan: IntegrationPlan = {
      entries: [
        {
          kind: "conflict",
          path: "x",
          conflict: "file/directory",
          stages: { base: null, current: null, incoming },
          content: null,
        },
      ],
      sourceRows: 1,
    };

    expect(() =>
      projectMergePlan(plan, {
        currentLabel: "HEAD",
        incomingLabel: "topic",
        untrackedCollisions: new Set(["x~topic"]),
      }),
    ).toThrow(expect.objectContaining({ code: "ECHECKOUTFAIL" }));
  });

  it("reserves a relocation before projecting the next conflict", () => {
    const current = identity("2");
    const incoming = identity("3");
    const plan: IntegrationPlan = {
      entries: [
        {
          kind: "conflict",
          path: "x",
          conflict: "file/directory",
          stages: { base: null, current: null, incoming },
          content: null,
        },
        {
          kind: "conflict",
          path: "x~topic",
          conflict: "file/directory",
          stages: { base: null, current, incoming: null },
          content: null,
        },
      ],
      sourceRows: 2,
    };

    expect(
      projectMergePlan(plan, { currentLabel: "HEAD", incomingLabel: "topic~HEAD" }).map(
        (entry) => entry.path,
      ),
    ).toEqual(["x~topic~HEAD", "x~topic~HEAD_0"]);
  });

  it("bounds generated relocation paths in UTF-8 bytes", () => {
    const incoming = identity("3");
    const plan: IntegrationPlan = {
      entries: [
        {
          kind: "conflict",
          path: "x",
          conflict: "file/directory",
          stages: { base: null, current: null, incoming },
          content: null,
        },
      ],
      sourceRows: 1,
    };

    expect(() =>
      projectMergePlan(plan, { currentLabel: "HEAD", incomingLabel: "z".repeat(2_200) }),
    ).toThrow(expect.objectContaining({ code: "E2BIG" }));
  });
});
