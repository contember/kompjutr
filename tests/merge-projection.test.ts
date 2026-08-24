import { describe, expect, it } from "vitest";

import type { IntegrationPlan } from "../src/core/ops/integration.js";
import type { IntegrationIdentity } from "../src/core/ops/integration-structure.js";
import { projectMergePlan } from "../src/core/ops/merge-projection.js";

function identity(digit: string, mode = "100644"): IntegrationIdentity {
  return { mode, oid: digit.repeat(40) };
}

describe("merge file/directory projection", () => {
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
      blobReadCalls: 1,
      retainedBytes: 0,
      memoryHighWaterBytes: 0,
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
      blobReadCalls: 0,
      retainedBytes: 0,
      memoryHighWaterBytes: 0,
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
      blobReadCalls: 0,
      retainedBytes: 0,
      memoryHighWaterBytes: 0,
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
      blobReadCalls: 0,
      retainedBytes: 0,
      memoryHighWaterBytes: 0,
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
      blobReadCalls: 0,
      retainedBytes: 0,
      memoryHighWaterBytes: 0,
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
      blobReadCalls: 0,
      retainedBytes: 0,
      memoryHighWaterBytes: 0,
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
      blobReadCalls: 0,
      retainedBytes: 0,
      memoryHighWaterBytes: 0,
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
      blobReadCalls: 0,
      retainedBytes: 0,
      memoryHighWaterBytes: 0,
    };

    expect(() =>
      projectMergePlan(plan, { currentLabel: "HEAD", incomingLabel: "z".repeat(2_200) }),
    ).toThrow(expect.objectContaining({ code: "E2BIG" }));
  });
});
