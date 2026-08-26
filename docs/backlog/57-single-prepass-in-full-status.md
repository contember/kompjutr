---
id: 57
title: Stream HEAD and the index once in the full status prepass
blocked-by: []
---

# 57 — Stream HEAD and the index once in the full status prepass

**Summary.** Effort M. With rename detection on, a full status streams the index
three times and the HEAD tree twice. Fold the two prepasses into one.

## Problem

Three passes run ahead of and inside one full status:

1. `classifyStatusRenames` (`src/core/ops/status.ts:293`) joins
   `treeStream × statusIndexGroups(indexScan())` to pair staged deletions with
   staged additions.
2. `snapshotStatusIndex` (`status.ts:520`) scans the index again for
   `trackedDirs` and `trackedPaths`.
3. The main `joinSorted3` (`status.ts:373`) streams both a final time.

On the 24,252-file fixture each index scan is about 25 paged statements
(`DEFAULT_INDEX_PAGE = 1000`, `src/sqlite/store.ts:143`). The statement budget
survives; wall time does not need to.

It is this way for a reason. `statusStream` is a lazy public export
(`src/index.ts`), and a rename destination cannot be emitted before every
source has been seen — a source may sort after its destination. The prepass is
what keeps the stream lazy; `tests/status-sparse.test.ts:501` ("keeps the
exported lazy status stream side-effect free when abandoned") pins that
contract.

## Approach / acceptance

- Merge passes 1 and 2 into one `treeStream × index` prepass that collects
  `trackedDirs`, `trackedPaths`, and the rename classifier together: two index
  passes and one HEAD pass instead of three and two.
- Skip the HEAD side of the prepass when `renameDetectionEnabled` is false, so
  `renames: false` keeps today's cost.
- Keep the lazy contract of `statusStream` unchanged.
- Coordinate with [55](55-sparse-status-across-untracked-files.md), which may
  remove `trackedPaths` retention from the same prepass.
- **Witness.** `tests/status.test.ts` parity output is unchanged; a recorded
  statement test asserts the full path scans the index twice with renames on
  and off.

## Touch points

`src/core/ops/status.ts`, `tests/status.test.ts`.

<!-- Origin: status code review, 2026-08-26; contributor to 10. -->
