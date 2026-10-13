# Read integration worktree inputs once

**Summary.** Integration still has separate worktree safety and recovery
snapshot passes. Historical measurement found eight reads of the conflicted
inputs in one binary-merge fixture; the current read count and cost need to be
measured before choosing which passes to combine.

## Current grounding

At `f8a677a` (2026-10-13), `requireSafeIntegrationWorktreeOwned()` still reaches
`checkoutBlockers()` through `requireSafeIntegrationSelection()`.
`applyIntegrationOwned()` separately walks the index and worktree in
`snapshotDrafts()` and, when recovery state is needed, calls
`snapshotWorktreeObjects()` to hash and store the touched worktree contents.
These call sites establish separate passes, not eight content reads per file.

[Backlog 107](../backlog/107-bound-shared-integration-step-passes.md) covers
full-tree passes in the same shared integration step. Coordinate the work:
this idea concerns repeated content transfer for touched files, while 107
also covers traversal of unrelated index, tree, and worktree entries.

## Historical measurement

Remeasured at `62ffbf0` (2026-09-24), after the simplification sprint's
forwarding-layer removal (WU4) and large-rebase streaming (WU22). Neither
changed the pass count. The instrumented pass for the 150-file binary merge
attributed 1,200 MiB of worktree reads to conflicted inputs that totaled
150 MiB: one query shape,
`SELECT c.idx, substr(c.bytes, 1, ?) FROM fs_chunks c WHERE c.inode = ? …`,
ran 2,400 times and returned 2,400 rows of `CHUNK_SIZE` 512 KiB, one row live at
a time. It was the same 2,400 rows and 1,200 MiB at `fe4e4e2`.

That measurement showed a time cost, not a process-memory target failure.
The case added 92.4–96.2 MiB of process peak over three runs, under the
<100 MiB target, in 8,040 statements. The reads were the dominant term in its
7.8–10.3 s, and binary-150 reached the 512 MiB cgroup cap through page cache:
667–809 `memory.max` reclaim events per
run, no OOM.

Evidence and the per-table-family ledger: ignored
`bench/results/integration-after-2026-09-22/` (baseline) and a HEAD copy of that
harness at the time, rebuilt from the same frozen packs. No new measurement
was made in the 2026-10-13 review; these figures are not a current baseline.

## Approach / acceptance

Reproduce the fixture at current HEAD under `bench/CLAUDE.md` rules and
attribute statements and transferred bytes to each consumer before changing
anything. The old count came from a storage-double ledger per table family,
not from identifying eight call sites. Collapse passes that read the same
content for the same purpose, keeping one row live at a time and preserving
the bounded-prefix contract.

Witness: the attributed worktree-read volume for the 150-file binary case
drops with unchanged public results, unchanged native byte/mode/stage/HEAD
oracles, and no regression in added process peak. Re-run the frozen fixtures
in the artifact directory so the before and after are like for like.

## Touch points

`packages/git/src/ops/integration/` (including `apply/`),
`packages/git/src/ops/merge/`, `packages/git/src/ops/worktree/`, `bench/`
fixtures.

## Graduation

Graduates to the backlog when a consumer runs large conflicted binary merges,
or when the extra reads cause a memory or time failure in a real workflow.

<!-- Origin: sprint-2026-09-10 WU6 measurement, 2026-09-22 run-log entry; remeasured at the 2026-09-23 simplification closure. -->
