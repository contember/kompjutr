# archive

Shipped sprints (each carrying its `OUTCOME` header — that's the record) and the
rare backlog/spec item with standalone reference value. Items arrive here by
`git mv`; they are **not** edited afterward.

**Default is delete, not archive.** The archive is not a graveyard for everything
that ships — only what genuinely helps a future reader. The git log holds the rest.

<!-- optional: group by date or theme as it grows; one line per entry -->

- [Concurrency and restart conformance](sprint-2026-08-27-concurrency-and-restart-conformance.md)
  — deterministic async-owner schedules, cold restart qualification, and
  bounded ownership and publication fences.
- [Repack and garbage collection](sprint-2026-08-27-repack-and-garbage-collection.md)
  — resumable root marking, bounded loose-object repacking, grace-period
  collection, and crash/concurrency/cost qualification.
- [Production Durable Object probe](sprint-2026-08-27-production-do-probe.md)
  — retained authenticated Worker, bounded Git lifecycle, real isolate and
  storage resets, physical audit, external wall time, and platform analytics.
- [Worktree performance and budget closure](sprint-2026-08-27-worktree-performance-and-budget.md)
  — bounded selected-path add, subtree-reusing commit, sparse status and
  checkout acceleration, truthful checkout measurement, and a repeated local
  release-candidate baseline.
- [Git boundary correctness](sprint-2026-08-26-git-boundary-correctness.md)
  — safe branch deletion, framing-safe and sparse-truthful status,
  file/symlink conflict materialisation, and Git-compatible network defaults.
- [Shell correctness and bounds](sprint-2026-08-26-shell-correctness-and-bounds.md)
  — truthful shell lists and commands, set-based filesystem mutations, paged
  discovery, atomic redirects, and one measured retained-memory boundary.
- [Multi-checkout consumer foundation](sprint-2026-08-26-multi-checkout-consumer-foundation.md)
  — one shared Git store, isolated linked checkouts, bounded consumer reads, and
  one undeployed schema baseline.
- [Bounded reflogs and ref recovery](sprint-2026-08-26-reflogs-and-ref-recovery.md)
  — transactional ref history, CAS recovery, fixed retention roots, and one
  undeployed Git schema baseline.
- [End-to-end journeys](sprint-2026-08-26-e2e-journeys.md)
  — a differential journey harness and six workflow files, plus the six
  divergences from Git they pinned.
- [Storage contracts and derived-table hardening](sprint-2026-08-26-storage-contracts.md)
  — bounded opaque content identities, narrow source-surrogate tree storage,
  guarded derived writes, and authoritative schema-v12 reconstruction.
- [Status and rename correctness](sprint-2026-08-25-status-and-rename-correctness.md)
  — truthful unmerged status, native status options and branch metadata, and
  bounded exact rename detection.
- [Release correctness baseline](sprint-2026-08-25-release-correctness-baseline.md)
  — verified CI and exact-package gates with explicit storage and safe Git
  mutation contracts.
- [Bounded rebase sequencer](sprint-2026-08-25-bounded-rebase-sequencer.md)
  — authenticated bounded linear replay with restart-safe recovery and one
  final branch publication.
- [Cherry-pick and revert lifecycle](sprint-2026-08-24-cherry-pick-and-revert.md)
  — bounded one-commit replay and inversion with restart-safe recovery.
- [Complete pull](sprint-2026-08-24-complete-pull.md) — bounded configured-
  upstream fetch with native recovery and atomic compatibility integration.
- [Merge operation lifecycle](sprint-2026-08-24-merge-operation-lifecycle.md)
  — bounded local merge with restart-safe continue and path-scoped abort.
- [Three-way integration engine](sprint-2026-08-24-three-way-integration-engine.md)
  — bounded pure integration plan with Git-compatible content conflicts.
- [`plans/`](plans/README.md) — completed and superseded design and delivery plans.
- [`benchmarks/`](benchmarks/README.md) — pre-standalone benchmark evidence.
