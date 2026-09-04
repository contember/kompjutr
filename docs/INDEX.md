# kompjutr docs — index

The map of everything under `docs/`. Read [`CLAUDE.md`](CLAUDE.md) for the rules.
When sources disagree, precedence is: invariants/hard-rules → active sprint →
decisions → reference → archive.

## Folders

- [`reference/`](reference/README.md) — how the system works now.
- [`ideas/`](ideas/README.md) — proposals, no commitment.
- [`decisions/`](decisions/README.md) — living ADRs (the *why*).
- [`backlog/`](backlog/README.md) — decided work, not yet scheduled.
- [`sprints/`](sprints/README.md) — active thematic work-plans.
- [`specs/`](specs/README.md) — accepted pre-build and frozen specs.
- [`archive/`](archive/README.md) — shipped sprints + reference-worthy records.

## Active sprints

None.

## Specs

- [`specs/trusted-domain-architecture.md`](specs/trusted-domain-architecture.md)
  — the authoritative target architecture adopted by the completed restructure.
- [`specs/budget-targets-evidence-ledger.md`](specs/budget-targets-evidence-ledger.md)
  — accepted statement-barrier and byte-limit evidence incorporated by the
  archived budget-targets sprint.

## What's hot

<!-- hand-maintained, keep short: the few things actually in motion + what's next.
     If everything is "hot", nothing is. -->
- The trusted-store restructure and its clone follow-up are complete. Clone is
  back under the statement target at 906 SQL / 78,558 rows; the attribution and
  current median-of-three snapshot are in
  [`benchmark-current`](reference/benchmark-current.md#clone-statement-profile).
- Native `blob:none` clone/fetch, durable promises, bounded lazy blob hydration,
  promise-aware maintenance, and pre-push hydration are complete (ADR-0015).
- Three tranches from the 2026-09-02 Git-in-SQLite architecture review are
  complete: storage/publication safety, Git result and scale correctness, then
  transaction-owned local mutations with trusted ordinary reads. Remaining
  verified work is in
  [`backlog/65`](backlog/65-git-sqlite-architecture-review.md) and
  [`backlog/63`](backlog/63-bound-packed-dependency-graph-traversal.md); unverified
  claims remain in [`ideas`](ideas/git-sqlite-architecture-review-triage.md).
- The completed everyday Git shell sprint made command execution asynchronous,
  added staged diff and history reads, exposed exact local/network operations,
  and composed pull with the restart-safe rebase lifecycle.
- The completed POSIX shell sprint admitted bounded `printf`, `exit`, `1>&2`,
  and named parameter expansion with Bash parity as the standing gate
  (ADR-0019).
- Next is the external consumer integration gate outside this public repository;
  its provider still lacks the bulk worktree scan needed for an efficient
  implementation without crossing private storage boundaries. Phase 2 is
  re-planned from that real workflow rather than package-local assumptions.

## Key reference

- [`reference/architecture.md`](reference/architecture.md) — domains, shared database kernel, trust model, structural bounds, and concurrency seams.
- [`reference/benchmark-current.md`](reference/benchmark-current.md) — current native benchmark snapshot.
- [`reference/concurrency.md`](reference/concurrency.md) — async owners, durable seams, and restart outcomes.
- [`reference/git-support.md`](reference/git-support.md) — what of Git is supported, command by command.
- [`reference/oid-encoding-measurement.md`](reference/oid-encoding-measurement.md) — measured TEXT-versus-BLOB OID evidence.
- [`reference/production-probe.md`](reference/production-probe.md) — production Durable Object probe runbook and current witness.
- [`reference/release.md`](reference/release.md) — CI gates and the tag-driven release process.
- [`reference/shell.md`](reference/shell.md) — current shell surface and deliberate limits.

## Decisions

- [0001 — Own the standalone SQLite runtime](decisions/0001-own-the-standalone-sqlite-runtime.md)
- [0002 — Organize source by domain with bottom-up layers](decisions/0002-organize-source-by-domain-with-bottom-up-layers.md)
- [0003 — Split the shared Git store from checkouts](decisions/0003-split-the-shared-git-store-from-checkouts.md)
- [0004 — Trust stored rows and validate at the boundary](decisions/0004-trust-stored-rows-validate-at-the-boundary.md)
- [0005 — Bound real failures and measure cost](decisions/0005-bound-real-failures-and-measure-cost.md)
- [0006 — Own local Git mutations with SQLite transactions](decisions/0006-own-local-git-mutations-with-sqlite-transactions.md)
- [0007 — Require well-formed UTF-8 paths](decisions/0007-require-well-formed-utf8-paths.md)
- [0008 — Enforce SQLite foreign keys at the store boundary](decisions/0008-enforce-sqlite-foreign-keys-at-the-store-boundary.md)
- [0009 — Choose the persisted Git storage formats](decisions/0009-persisted-git-storage-formats.md)
- [0010 — Port xdiff for text merge](decisions/0010-port-xdiff-for-text-merge.md)
- [0011 — Retain bounded deleted-ref history](decisions/0011-retain-bounded-deleted-ref-history.md)
- [0012 — Run maintenance as resumable generations](decisions/0012-run-maintenance-as-resumable-generations.md)
- [0013 — Publish clones through provisional ownership](decisions/0013-publish-clones-through-provisional-ownership.md)
- [0014 — Make an optionless clone complete](decisions/0014-make-an-optionless-clone-complete.md)
- [0015 — Model partial-clone blobs as durable promises](decisions/0015-model-partial-clone-blobs-as-durable-promises.md)
- [0016 — Route Git argv through one asynchronous runner](decisions/0016-route-git-argv-through-one-asynchronous-runner.md)
- [0017 — Preflight mutating CLI output inside the transaction](decisions/0017-preflight-mutating-cli-output-inside-the-transaction.md)
- [0018 — Compile shell commands to bounded queries](decisions/0018-compile-shell-commands-to-bounded-queries.md)
- [0019 — Admit a bounded POSIX shell surface](decisions/0019-admit-a-bounded-posix-shell-surface.md)

The set was renumbered on 2026-09-04; [`decisions/README.md`](decisions/README.md#renumbered-on-2026-09-04)
decodes an old number found in `archive/` or `specs/`.

## Historical records

- [`archive/sprint-2026-09-02-trusted-reads-and-linear-journal.md`](archive/sprint-2026-09-02-trusted-reads-and-linear-journal.md)
  — transaction-owned local Git mutations, linear durable operation
  transitions, and trusted plain projections over explicit write premises.
- [`archive/sprint-2026-09-02-git-correctness-and-scale.md`](archive/sprint-2026-09-02-git-correctness-and-scale.md)
  - ordered untracked selection, streamed staging and hashing, live cache
  correctness, bounded reflog headers, and removal of the total tree-object cap.
- [`archive/sprint-2026-08-31-everyday-git-shell.md`](archive/sprint-2026-08-31-everyday-git-shell.md)
  — asynchronous bounded shell execution and exact everyday Git reads,
  mutations, history, network commands, and pull-rebase.
- [`archive/sprint-2026-08-31-shell-posix-surface.md`](archive/sprint-2026-08-31-shell-posix-surface.md)
  — bounded `printf`, `exit`, ordered `1>&2`, and named parameter expansion with
  byte-exact Bash parity.
- [`archive/sprint-2026-08-31-deepening-and-network-safety.md`](archive/sprint-2026-08-31-deepening-and-network-safety.md)
  — relative deepening and unshallow, per-destination push leases, and abortable
  clone, fetch, and push with explicit local and remote certainty boundaries.
- [`archive/sprint-2026-08-30-trusted-store-and-domain-restructure.md`](archive/sprint-2026-08-30-trusted-store-and-domain-restructure.md)
  — trusted stored rows, the deleted memory ledger, the fs/shell/git domain
  restructure over a shared storage kernel, and the finished store split.
- [`archive/sprint-2026-08-29-budget-targets-and-store-split.md`](archive/sprint-2026-08-29-budget-targets-and-store-split.md)
  — measured statement targets, the byte-limit evidence ledger, operation-owned
  memory ceilings, and the store-split start superseded by the restructure
  sprint.
- [`archive/sprint-2026-08-29-shell-run-inputs.md`](archive/sprint-2026-08-29-shell-run-inputs.md)
  — bounded caller stdin, frozen injected-command env and Git identity
  forwarding through one run-owned input lifetime.
- [`archive/sprint-2026-08-28-agent-git-and-file-selection.md`](archive/sprint-2026-08-28-agent-git-and-file-selection.md)
  — a strict synchronous Git argv runner, injectable shell command, and bounded
  tracked plus non-ignored untracked file selection.
- [`archive/sprint-2026-08-28-first-contact-defaults.md`](archive/sprint-2026-08-28-first-contact-defaults.md)
  — complete clone defaults, atomic branch rename, typed remote URLs, and
  bounded tracked `lsFiles()` globs.
- [`archive/sprint-2026-08-28-refspec-transport.md`](archive/sprint-2026-08-28-refspec-transport.md)
  — bounded remote discovery, wildcard mapped fetch, exact atomic publication,
  and structured atomic multi-ref push with tracking reconciliation.
- [`archive/sprint-2026-08-28-snapshot-replay-and-guarded-refs.md`](archive/sprint-2026-08-28-snapshot-replay-and-guarded-refs.md)
  — bounded checkpoint replay, guarded ref publication, revision resolution,
  merge-base, and recursive tree reads.
- [`archive/sprint-2026-08-28-index-and-object-write-plumbing.md`](archive/sprint-2026-08-28-index-and-object-write-plumbing.md)
  — scoped scratch indexes, bounded tree and commit construction, and a public
  snapshot facade that preserves checkout state.
- [`archive/sprint-2026-08-27-concurrency-and-restart-conformance.md`](archive/sprint-2026-08-27-concurrency-and-restart-conformance.md)
  — deterministic async-owner schedules, cold restart qualification, and
  bounded ownership and publication fences.
- [`archive/sprint-2026-08-27-repack-and-garbage-collection.md`](archive/sprint-2026-08-27-repack-and-garbage-collection.md)
  — resumable root marking, bounded loose-object repacking, grace-period
  collection, and crash/concurrency/cost qualification.
- [`archive/sprint-2026-08-27-production-do-probe.md`](archive/sprint-2026-08-27-production-do-probe.md)
  — authenticated production Git lifecycle with isolate and storage resets,
  physical audit, wall time, and platform analytics.
- [`archive/sprint-2026-08-27-worktree-performance-and-budget.md`](archive/sprint-2026-08-27-worktree-performance-and-budget.md)
  — bounded selected-path add, subtree-reusing commit, sparse status and
  checkout acceleration, truthful checkout measurement, and a repeated local
  release-candidate baseline.
- [`archive/sprint-2026-08-26-git-boundary-correctness.md`](archive/sprint-2026-08-26-git-boundary-correctness.md)
  — safe branch deletion, framing-safe and sparse-truthful status,
  file/symlink conflict materialisation, and Git-compatible network defaults.
- [`archive/sprint-2026-08-26-shell-correctness-and-bounds.md`](archive/sprint-2026-08-26-shell-correctness-and-bounds.md)
  — truthful shell lists and commands, set-based filesystem mutations, paged
  discovery, atomic redirects, and one measured retained-memory boundary.
- [`archive/sprint-2026-08-26-multi-checkout-consumer-foundation.md`](archive/sprint-2026-08-26-multi-checkout-consumer-foundation.md)
  — one shared Git store, isolated linked checkouts, bounded consumer reads, and
  one development-only schema baseline.
- [`archive/sprint-2026-08-26-reflogs-and-ref-recovery.md`](archive/sprint-2026-08-26-reflogs-and-ref-recovery.md)
  — transactional bounded ref history, public CAS recovery, fixed retention
  roots, and one development-only Git schema baseline.
- [`archive/sprint-2026-08-26-e2e-journeys.md`](archive/sprint-2026-08-26-e2e-journeys.md)
  — a differential journey harness and six workflow files, plus the six
  divergences from Git they pinned.
- [`archive/sprint-2026-08-26-storage-contracts.md`](archive/sprint-2026-08-26-storage-contracts.md)
  — bounded opaque content identities, source-surrogate tree projections,
  authoritative migration, and derived-row write guards.
- [`archive/sprint-2026-08-25-status-and-rename-correctness.md`](archive/sprint-2026-08-25-status-and-rename-correctness.md)
  — unmerged status truth, native status reports, and bounded exact renames.
- [`archive/sprint-2026-08-25-release-correctness-baseline.md`](archive/sprint-2026-08-25-release-correctness-baseline.md)
  — verified CI and package release gates, explicit SQLite enforcement, measured
  OID storage, and Git-safe mutation defaults.
- [`archive/sprint-2026-08-25-bounded-rebase-sequencer.md`](archive/sprint-2026-08-25-bounded-rebase-sequencer.md)
  — bounded linear rebase with authenticated restart-safe sequencing.
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
