# kompjutr docs — index

The map of everything under `docs/`. Read [`CLAUDE.md`](CLAUDE.md) for the rules.
When sources disagree, precedence is: invariants/hard-rules → active sprint →
decisions → reference → archive.

## Folders

- [`reference/`](reference/README.md) — how the system works now.
- [`ideas/`](ideas/README.md) — proposals, no commitment.
- [`decisions/`](decisions/README.md) — ADRs (the *why*), immutable.
- [`backlog/`](backlog/README.md) — decided work, not yet scheduled.
- [`sprints/`](sprints/README.md) — active thematic work-plans.
- [`archive/`](archive/README.md) — shipped sprints + reference-worthy records.

## Active sprints

<!-- list the sprint files currently in sprints/ ; empty between sprints -->
- [`sprints/sprint-2026-08-25-bounded-rebase-sequencer.md`](sprints/sprint-2026-08-25-bounded-rebase-sequencer.md)
  — authenticated bounded rebase for one checked-out linear branch.

## What's hot

<!-- hand-maintained, keep short: the few things actually in motion + what's next.
     If everything is "hot", nothing is. -->
- The bounded rebase sequencer is active; its first unit adds an authenticated
  operation-step journal before replay execution.
- CI and release gates remain the next release-readiness priority.

## Key reference

- [`reference/architecture.md`](reference/architecture.md) — current runtime architecture and limits.
- [`reference/benchmark-current.md`](reference/benchmark-current.md) — current native benchmark snapshot.
- [`reference/shell.md`](reference/shell.md) — current shell surface and deliberate limits.

## Decisions

- [`decisions/0001-own-the-standalone-sqlite-runtime.md`](decisions/0001-own-the-standalone-sqlite-runtime.md)
- [`decisions/0002-compile-shell-commands-to-bounded-queries.md`](decisions/0002-compile-shell-commands-to-bounded-queries.md)
- [`decisions/0003-port-xdiff-text-merge.md`](decisions/0003-port-xdiff-text-merge.md)

## Historical records

- [`archive/sprint-2026-08-24-cherry-pick-and-revert.md`](archive/sprint-2026-08-24-cherry-pick-and-revert.md)
  — bounded one-commit replay and inversion with restart-safe recovery.
- [`archive/sprint-2026-08-24-complete-pull.md`](archive/sprint-2026-08-24-complete-pull.md)
  — configured-upstream fetch plus safe native and compatibility integration.
- [`archive/sprint-2026-08-24-merge-operation-lifecycle.md`](archive/sprint-2026-08-24-merge-operation-lifecycle.md)
  — complete bounded two-head merge lifecycle for the checked-out branch.
- [`archive/sprint-2026-08-24-three-way-integration-engine.md`](archive/sprint-2026-08-24-three-way-integration-engine.md)
  — bounded pure three-tree integration engine.
- [`archive/plans/`](archive/plans/README.md) — completed and superseded implementation plans.
- [`archive/benchmarks/`](archive/benchmarks/README.md) — pre-standalone benchmark evidence.
