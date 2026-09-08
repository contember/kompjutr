---
id: 77
title: Remove repeated local traversal and recovery work
blocked-by: []
---

# 77 — Remove repeated local traversal and recovery work

**Summary.** Make valid large local operations scale with visited paths and live
state instead of repeatedly processing completed prefixes and touch history.

## Problem and evidence

| Site | Verified work shape |
|---|---|
| Hash-window refresh | `refreshOrderedPaths()` starts another disk stream per window and filters `after` after enumeration/stat. For N files in windows B, prefix visits grow as B + 2B + … + N, or Θ(N²/B). Public status, add, and API worktree diff use this; the default exact-path CLI diff is an exception. |
| Ignore discovery | Each page starts traversal again. The 1,024-ignore-file / 128-handle limits bound this to at most eight pages; do not describe it as unbounded quadratic growth in all repository files. |
| Recovery path membership | Each first touch scans accumulated touches, and settlement checks touches for each temporary. Distinct sibling writes in one transaction can produce Θ(N²) comparisons despite bounded mutation batches. |
| External merge runs | Each spill record opens a run, reads its header and payload, then closes it. Depth-based spilling also affects small directories. The syscall shape is proven; its share of end-to-end latency is not measured. |

All mechanisms are established by static call-chain inspection under valid API
use. This issue does not claim measured latency regressions or OOM. Conservative
local rehashing with `contentId: null` is intentional and must remain correct.

## Approach / acceptance

- Reuse a correctly scoped ordered refresh iterator or exact metadata refresh.
  Preserve fresh observations, exclusions, and iterator cleanup.
- Share a traversal across discovery pages or prune cursor prefixes before their
  enumeration. Keep DO indexed discovery intact.
- Retain the ordered undo array, but accelerate membership using canonical path
  sets and ancestor walks. Preserve ancestor/descendant rollback ordering.
- Buffer spill readers within an explicit descriptor/live-frontier bound; do not
  keep every suspended deep traversal descriptor open.
- Add visited-entry and membership-work witnesses at N and 2N, plus early-exit and
  failure cleanup. Confirm public status/add and mutation parity before leased
  performance measurements on wide, deep, and flat trees.

## Touch points

- `packages/git/src/ops/worktree/worktree-io-hash.ts`.
- `packages/git/src/ignore/source.ts`.
- `packages/local/src/drive/disk-drive.ts`, `external-sort.ts`.
- `packages/local/src/recovery/coordinator.ts`, `settlement.ts`.
- `tests/local/`, `bench/local.ts`.
