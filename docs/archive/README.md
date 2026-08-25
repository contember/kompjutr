# archive

Shipped sprints (each carrying its `OUTCOME` header — that's the record) and the
rare backlog/spec item with standalone reference value. Items arrive here by
`git mv`; they are **not** edited afterward.

**Default is delete, not archive.** The archive is not a graveyard for everything
that ships — only what genuinely helps a future reader. The git log holds the rest.

<!-- optional: group by date or theme as it grows; one line per entry -->

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
