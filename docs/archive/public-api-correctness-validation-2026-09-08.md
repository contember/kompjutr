> **OUTCOME — validated 2026-09-08.** The public API correctness sprint and its
> savepoint follow-up have passed the final full-suite gate on
> `d624d19c70300ce5327f6c6ce45e8da32c7c2dbc`: 3,511 tests passed across all 17
> slices, exit 0, no unhandled errors. Five existing opt-in timing tests were
> skipped. Wall time was 643.0 seconds with two lanes and four leased vCPUs.
> The documentation-only closure commit does not change the tested runtime or
> tests. Backlog 81 remains deferred; the original missing plan review remains a
> recorded historical process exception.

# Public API correctness — follow-up validation (2026-09-08)

Companion record to the [original sprint](sprint-2026-09-08-public-api-correctness.md).
The original OUTCOME describes the implementation at `3fd93bd`; current nested
transaction behavior is specified by
[ADR-0021](../decisions/0021-recover-local-worktree-mutations-with-an-undo-journal.md)
and the [concurrency reference](../reference/concurrency.md).

## Follow-up commits

| Commit | Change |
|---|---|
| `b74288d` | Replace local SQL-effect inference with nested savepoints, scope-owned cursor invalidation, and regression tests. Preserve outer abort-only for disk effects. |
| `da5de2a` | Exercise reused transport Buffers at the pack-ingest boundary. |
| `d624d19` | Correct the memory estimate and links invalidated by sprint closure. |

## Final-tree verification

The worktree was clean before and after this run, with HEAD unchanged at the full
SHA above. Runtime: Node v24.4.0, Git 2.54.0, Linux 6.17.0-41-generic.

```bash
cpu-lease run -n 4 -- env GIT_EDITOR=true GIT_SEQUENCE_EDITOR=true TEST_FULL_LANES=2 npm run test:full
```

The standard runner completed all slices without retries or configuration changes:

| Slice | Passed tests | Wall seconds |
|---|---:|---:|
| root 1/8 | 441 | 233.3 |
| root 2/8 | 187 | 75.9 |
| root 3/8 | 317 | 174.7 |
| root 4/8 | 491 | 158.9 |
| root 5/8 | 274 | 83.7 |
| root 6/8 | 186 | 60.3 |
| root 7/8 | 221 | 99.4 |
| root 8/8 | 224 | 147.1 |
| filesystem | 467 | 26.6 |
| pack 1/5 | 9 | 4.9 |
| pack 2/5 | 24 | 21.5 |
| pack 3/5 | 17 | 23.4 |
| pack 4/5 | 24 | 22.3 |
| pack 5/5 | 29 | 5.4 |
| shell | 452 | 14.0 |
| end-to-end | 96 | 127.9 |
| protocol | 52 | 4.1 |

Runner summary: **643.0 s wall, 1,283.4 s summed slice time, two lanes**. Per-slice
durations above are rounded independently. The five skipped tests are the
existing `TIMING_GATE` cases in `tests/ignore.test.ts`; ordinary full-suite runs
do not enable that opt-in gate. Pack slices report other slices' tests as skipped,
but their passed counts cover all 103 pack tests exactly once.

Root 8/8 includes the entire 12-test crash-recovery file and all 14 savepoint
tests. Both passed in the standard threads pool without the earlier RPC timeout.
Vitest aliases and the crash workers' source loader resolve the implementation
directly to `packages/*/src`, not to a previous build.

## Review and focused verification

Four independent reviews covered transactions/recovery, object-byte ownership,
disk mutations/discovery, and sprint evidence/documentation. Independent
verification reproduced the remaining SQL-effect leaks through public adapter
calls and confirmed the transport-buffer witness gap. The user approved SQL
savepoints and immediate SQL rollback, retaining whole-transaction disk recovery.

An independent review of the savepoint follow-up found no further runtime defect.
Its probes exercised failed savepoint release, cursor constraint errors, and
failed outer commit with a pending writer. Those cases were then retained in
`tests/local/sqlite-savepoints.test.ts`. The test suite also covers TEMP DDL,
transactional metadata, signed schema cookies, dormant cursors, nested ownership,
and successful read cursors surviving commit. The public CLI failure witness now
reopens the workspace and completes another public mutation.

Focused checks passed: 159 smoke tests; 30 local SQLite/savepoint tests; three
reused-Buffer ingest cases; two import-graph tests; typecheck and Biome check.
Temporarily restoring `.slice()` at the pack trailer retention boundary made all
three new ingest cases fail with checksum mismatch; restoring the fix made them
pass again.

The default forks-pool local/rebase run completed 118 passing tests but failed
with Vitest's `onTaskUpdate` RPC timeout. The isolated crash file reproduced that
runner failure after all 12 tests passed. The same 12 tests passed cleanly in two
non-overlapping invocations. The standard full-suite runner already selects the
threads pool for root shards to avoid this known runner issue; no runner change
was made in this follow-up.

## Remaining work and historical limits

- [Backlog 81](../backlog/81-copy-object-bytes-only-when-retained.md) retains the
  measurement-first ownership-copy optimization. Two 48 MiB buffers are a static
  allocation estimate, not a measured process peak.
- The original sprint's required pre-implementation plan review did not happen.
  This follow-up review does not retroactively satisfy that historical gate.
- The original 449.9-second run and reverse-verification claims remain historical
  assertions in the original record; this follow-up has its own final-tree run.
- The [lifecycle/network sprint](../sprints/sprint-2026-09-08-lifecycle-and-network-integrity.md)
  remains active and its work units are not consumed here.
