---
id: 107
title: Bound the shared integration step's full-tree passes
blocked-by: []
---

# 107 — Bound the shared integration step's full-tree passes

**Summary.** One integration step reads the whole index, tree and worktree several
times, even when the step touches 100 paths. Rebase, merge, cherry-pick and revert
all share this code.

## Problem

The 2026-09-28 memory and cost sprint removed the rebase-owned passes (backlog 95,
part a). The step passes in the shared integration code remain. A per-call-site
probe of one 100-file pick over 10,000 tracked files attributed them. The Next.js
row savings are estimates at about 24,000 rows per full pass.

| Call site | Passes | Needs only |
|---|---|---|
| `classifyIntegrationStructureOwned` (`ops/integration/integration-structure-owned.ts`) | 3 tree walks with no subtree pruning | the subtrees where base, current and incoming differ (~72k rows) |
| `requireSafeIntegrationWorktreeOwned` → `checkoutBlockers` (`integration-worktree.ts`) | 2 T + 1 I + 1 F, then filters the plan paths in JS | seeks over the plan's paths (~100k rows) |
| `snapshotDrafts` (`integration-apply-owned.ts`) | 1 I + 1 F | the touched ranges (~55k rows) |
| `requireResultTree` → `prospectiveIntegrationIndexEntriesOwned` | 1 I | the affected directories (~24k rows) |
| `writeUnpublishedCommit` → `buildTreeInBatch` (`commit.ts`) | 1 I | the sparse tree plan through `context.commitTrees` (~24k rows) |

Two deferred parts of backlog 95 belong to the same work:

- **Limit the rebase baseline preflight object checks to the diff blobs** (P4 of
  backlog 95). `preflightBaselineTree` still checks every object in the tree. This is
  semantics-sensitive: gitlinks, promisor trees, and a local disk that is not
  transactional.
- **Share the exclusion normalizer** between checkout (`ops/checkout/checkout-support.ts`)
  and `rebaseExclusions` (`ops/rebase/rebase-lifecycle-baseline.ts`). Both now keep
  only the 64-root cap.

## Approach / acceptance

Bound each pass by the step's plan paths or by the three-way diff. Keep every pass
streamed and batched. Keep Git's per-pick rule: a touched path must be clean
before the step writes it.

Witness:
- The `rebase.large-*` and merge gate rows in `bench/statements.ts` read fewer rows,
  and no statement count rises.
- The rebase, merge, cherry-pick, revert and integration suites pass unchanged.
- Three leased `bench:nextjs` runs show fewer rebase-phase rows.

The [integration worktree reads idea](../ideas/read-integration-worktree-inputs-once.md)
edits the same files; do not run the two at once.

## Touch points

`packages/git/src/ops/integration/`, `packages/git/src/ops/commit/commit.ts`,
`bench/statements.ts`.

<!-- Origin: sprint-2026-09-28 memory and cost, grounding of backlog 95 (part b). -->
