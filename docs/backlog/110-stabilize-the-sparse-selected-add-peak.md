---
id: 110
title: Stabilize the sparse selected add peak under its gate
blocked-by: []
---

# 110 — Stabilize the sparse selected add peak under its gate

**Summary.** `core.sparse-selected-add` fails its <100 MiB process gate in about
one run in two. The peak is bimodal: about 78 MB or about 110 MB. Effort: M.

## Problem

The 2026-09-28 memory and cost sprint reported three passing runs after WU2. The
closure review reran the row at `b7a5118` six times and at `9fa0a7b` (the end of
WU2) three times, interleaved:

```bash
npm run bench:memory -- --scenarios=core.sparse-selected-add
```

| Commit | Runs | Failed | Failing peaks, B | Passing peaks, B |
| --- | ---: | ---: | --- | --- |
| `b7a5118` | 6 | 3 | 109,158,400; 112,398,336; 114,962,432 | 77,459,456; 78,245,888; 79,765,504 |
| `9fa0a7b` | 3 | 1 | 110,071,808 | 78,057,472; 79,630,336 |

Every failure is in the uncapped calibration stage. The capped stage
(`memory.max` 536870912) passed every time it ran. The runner leases its own CPU.
Both commits show the same two modes, so this is not a regression after WU2.

The WU2 probe attributed the peak to transient copies of the 8 MiB path set, not
to retention. The second mode is most likely a GC that runs one window later. A
peak that depends on GC timing does not meet the gate.

## Approach / acceptance

1. Attribute the high mode first. Compare a heap sampling profile of a run in each
   mode, and name the allocation that survives until the late GC.
2. Remove the remaining path copies in the add window that the attribution names.
   Do not change the harness or the gate to make the row pass.

Witness: ten consecutive `bench:memory -- --scenarios=core.sparse-selected-add`
runs pass both stages. Record `memory.max` and the commit hash with every peak.
The `staging.add-selected` and `status.sparse-*` statement rows do not rise.

## Touch points

`packages/git/src/do-fs/sparse/`, `packages/git/src/ops/staging/staging-add.ts`,
`packages/do/src/fs/store/`.

<!-- Origin: closure review of sprint-2026-09-28 memory and cost. -->
