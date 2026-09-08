---
id: 65
title: Resolve verified Git SQLite architecture review findings
blocked-by: []
---

# 65 - Resolve verified Git SQLite architecture review findings

**Summary.** Resolve the verified open findings from the 2026-09-02
Git-in-SQLite architecture review, ordered by correctness risk and cost-model
impact.

## Scope

The review verified each finding below with a second adversarial pass. Treat each
row as a candidate work unit and re-check its premise at HEAD before scheduling
it. Split a selected cluster into a sprint with focused witnesses; do not attempt
this entire item as one undifferentiated change.

Completed findings are removed when their response ships. The tables below
contain only open work.

ARCH-10 is tracked in
[`63 - Bound packed dependency graph traversal`](63-bound-packed-dependency-graph-traversal.md),
which now includes the review's unbounded packed-read memo finding. ARCH-47 is
already represented by
[`09 - Add outbound delta compression`](09-outbound-delta-compression.md).
Unverified and disputed claims remain in
[`../ideas/git-sqlite-architecture-review-triage.md`](../ideas/git-sqlite-architecture-review-triage.md).

## 2026-09-08 follow-up and evidence boundaries

The follow-up reviewed the working tree containing the scoped-package extraction,
not a commit-only diff. New issues are indexed in the
[backlog review intake](README.md#2026-09-08-review-intake). Existing findings stay
owned here or in [63](63-bound-packed-dependency-graph-traversal.md).

Re-check current source before implementation. Review probes were temporary and
were removed; their reported output is evidence, not a committed regression
suite. Preserve these distinctions when planning acceptance:

| Existing finding | Qualified evidence and required witness |
|---|---|
| ARCH-8 | Valid public merges can retain aggregate output content despite the 1,000-entry limit: 150 distinct binary conflicts with 1 MiB current contents retain at least 150 MiB of payload. This is a static live-payload calculation, not measured OOM. Store results as references through bounded operation-owned storage before widening the entry cap. |
| ARCH-9 | Runtime-observed through ingest and repository reads: interrupt a 3,073-commit pack after projection staging; physical availability is false while cached `readCommit` and graph reads succeed. No arbitrary SQL corruption. This establishes pending projection visibility, not that an ordinary completed clone publishes an invalid HEAD. Add a public fetch interruption/read witness and cold cleanup coverage. |
| ARCH-16 | Static verification also found cursorless packed classification and young-prefix sweep. Bound visited-row growth for loose and packed phases; not every all-eligible sweep is quadratic. |
| ARCH-18 / CORR-18 | A supported writer can cross from 100,000 to 100,001 refs because the preimage alone is checked. Every later mutation, including corrective deletion, fails in the full-ref scan. Statically verified; add a public threshold-crossing/deletion witness. |
| ARCH-20 | Current combined recursive/exact predicates still produced checkout-only seeks in review query plans. Independent verification checked SQL shape, not a second plan run. Record target-runtime plans before rewriting. Related index and journal cursor work is [78](78-make-sql-cursors-seek-and-deliver-incrementally.md). |
| ARCH-22 | Payload metadata duplication is confirmed, but normalization adds joins and its net benefit is unmeasured. Keep separate physical membership and canonical ownership; qualify any narrower mapping with storage and read/write measurements. This is design debt, not demonstrated corruption. |
| ARCH-24 / ARCH-25 / ARCH-26 | Read-only forwarding registries and synchronous aliases can be redundant. Deferred iterator checks, batch-flush lifetime checks, and public versus authorized internal mutation guards have real behavior; blanket wrapper removal is not justified. |
| ARCH-27 | Public `updateRef` accepted a trailing unpaired high surrogate; stored text changed and original-name lookup failed. Runtime-reproduced caller-input validation defect, not failure with valid ref names. Fix the shared text boundary and test symbolic targets/config/reflog siblings as applicable. |
| ARCH-33 / ARCH-39 | Runtime-reproduced late writes from an escaped checkout sink after an async callback was rejected with `EINVAL`. This is robustness against misuse of a synchronous callback API, not ordinary supported async execution. Retain the scratch branch's revocation/disposal contract. |
| ARCH-38 | The detecting repack call can report its unchanged durable phase, with restart on the next call. Current docs define the durable phase, so this is a low-priority progress/observability decision, not demonstrated unsafe publication. The old ARCH-37 null-boundary contradiction is not present in the current reference contract. |

## High-severity work

| IDs | Problem | Acceptance | Touch points |
|---|---|---|---|
| ARCH-8 | Three-way integration retains aggregate resolved contents and refuses more than 1,000 changed paths; deleting the cap alone would leave retained plan state unbounded. | Bound live input and result payloads across batches; a 1,001-path integration succeeds under a real retained-state bound or a restart-safe streaming plan. | `packages/git/src/ops/integration/integration-plan.ts`, `packages/git/src/ops/integration/integration-content.ts`, `packages/git/src/ops/integration/integration-structure.ts` |

## Store and maintenance work

| IDs | Problem | Acceptance | Touch points |
|---|---|---|---|
| ARCH-9 | Pack ingest stages ordinary commit projections that remain readable after the pack returns to pending. | Pending projections remain invisible to commit and graph reads, including after interruption/reopen; atomic final publication makes them available. | `packages/git/src/store/pack/pack-ingest-index.ts`, `packages/git/src/store/trees/commits-cache.ts`, `packages/git/src/store/trees/commits-graph.ts` |
| ARCH-13 / ARCH-23 | Repack finalization inflates and hashes the same batch twice in one transaction. | A finalized batch is authenticated at most once, and loose deletion follows a metadata-level proof of complete packed availability. | `packages/git/src/store/maintenance/repack.ts` |
| ARCH-14 | Candidate selection fragments repack output at every OID-order transition between shadowed and unshadowed objects. | Candidates are partitioned by kind and ordered by OID within each partition, filling bounded batches. | `packages/git/src/store/maintenance/repack.ts` |
| ARCH-16 | Loose and packed classification/sweep lack durable keyset positions and repeatedly scan settled or young rows. | Phases resume from durable source-appropriate cursors, root drift clears them, and visited rows grow linearly with candidates. | `packages/git/src/store/maintenance/sweep/`, `packages/git/src/store/maintenance/state.ts`, `packages/git/src/store/maintenance/roots.ts` |
| ARCH-17 / CORR-11 / CORR-12 | Modeled-byte currencies remain in integration, tree walking, checkout, status, diff, rename detection, initial checkout, and rebase planning. Sparse native projections no longer use mutable reserve/release/peak accounting. | Every surviving cap names a real failure; repository-scale sets stream or use a structural page where possible. | `packages/git/src/ops/{integration,checkout,status,diff,rebase}/`, `packages/git/src/ops/tree/`, `packages/git/src/store/trees/tree-walk.ts`, `packages/do/src/fs/store/initial-write.ts` |
| ARCH-18 / CORR-18 | A single-ref mutation materializes the whole ref table, and fetch publication repeats related full scans. | Mutations read only changed, expected, and bounded symbolic-chain refs; cost does not depend on unrelated refs. | `packages/git/src/store/refs/refs.ts`, `packages/git/src/store/fetch/fetch-publication.ts` |
| ARCH-19 | `activeRefLogOids` duplicates maintenance's reflog-root stream and carries a stale 9,727-row refusal. | One paged reflog-root implementation remains; dead facades, caps, and duplicate tests are removed or redirected. | `packages/git/src/store/refs/reflog.ts`, `packages/git/src/store/maintenance/roots.ts`, store facades |
| ARCH-20 | Recursive sparse selection prevents an indexed path-range seek, so `git add <dir>` scans the whole index. | Exact and recursive branches use indexable text ranges; a query-plan witness shows work proportional to the selected range. | `packages/git/src/do-fs/sparse/selection.ts`, `packages/git/src/do-fs/sparse/workspace.ts`, `packages/git/src/ops/staging/staging.ts` |
| ARCH-21 | `git_maintenance_shallow` duplicates `git_maintenance_objects.shallow_boundary`; its functional lookup is always false. | The duplicate table and cross-check are removed without changing shallow traversal or restart behavior. | `packages/git/src/store/schema/schema.ts`, `packages/git/src/store/maintenance/` |
| ARCH-22 | `git_pack_objects` duplicates every payload column from `git_pack_entries`. | Measure a narrow canonical OID-to-location prototype before choosing normalization; preserve reads, shadowing, physical occurrences, and deletion with an acceptable join cost. | `packages/git/src/store/schema/schema.ts`, `packages/git/src/store/pack/pack-ingest-index.ts`, `packages/git/src/store/pack/` |

## Layering and operation work

| IDs | Problem | Acceptance | Touch points |
|---|---|---|---|
| ARCH-24 / ARCH-25 | Most `*Owned` wrappers, identical twins, and WeakMap dispatch survive from the removed ownership system. | Every remaining owner abstraction has a concrete layering or behavior role; no pure forwarding twin remains. | `packages/git/src/ops/repository/repository.ts`, `packages/git/src/store/` |
| ARCH-26 | `CheckoutStore` duplicates some synchronous shared-repository reads, while other wrappers enforce delayed lifetime and mutation behavior. | Simplify only redundant reads first; preserve checks at iterator start/batch flush and authorized internal mutation composition. | `packages/git/src/store/checkout/checkout.ts`, `packages/git/src/store/repository/shared.ts` |
| ARCH-27 | Path, UTF-8, basename/depth, and OID helpers are duplicated across ops and already disagree on lone surrogates. | Shared path and byte kits become the single implementation while callers retain their error taxonomy. | `packages/git/src/common/paths.ts`, `packages/git/src/common/bytes.ts`, `packages/git/src/ops/` |
| ARCH-29 | Status scans every tracked path for each ignored directory although tracked directory prefixes are already available. | Directory pruning uses constant-time tracked path/prefix lookup, including paths retained during the stream. | `packages/git/src/ops/status/status.ts` |
| ARCH-30 | `git clean` removes paths one by one although the filesystem supports bounded bulk recursive deletion. | Flat paths are batched and directory roots use recursive bulk removal while preserving ignored and registered-root protection. | `packages/git/src/ops/status/status.ts`, `packages/git/src/ops/checkout/checkout.ts`, `packages/do/src/fs/store/remove.ts` |

## Lower-severity cleanup

| IDs | Problem | Acceptance | Touch points |
|---|---|---|---|
| ARCH-33 / ARCH-39 | Checkout-backed `indexApply` lacks the scratch branch's thenable guard, sink revocation, and guaranteed disposal. | Both branches reject asynchronous callbacks, revoke escaped sinks, and dispose buffers in `finally`. | `packages/git/src/store/indexes/index-table.ts` |
| ARCH-34 | `store/operations/operations.ts` duplicates existing ref and path validators. | The reviewed equivalent implementations collapse to shared validators with no behavior change. | `packages/git/src/store/operations/operations.ts`, `packages/git/src/store/refs/ref-validation.ts`, `packages/git/src/common/` |
| ARCH-36 | Direct-ref and checkout-HEAD reflog writers duplicate append and retention logic. | Shared infrastructure preserves separate ownership and FKs, including valid endpoint-equal HEAD entries. | `packages/git/src/store/refs/reflog.ts`, `packages/git/src/store/checkout/checkout.ts`, `packages/git/src/store/refs/refs.ts` |
| ARCH-38 | `maintenance()` discards the repack advancer's root-change result and exposes the unchanged durable phase until a later call restarts. | Decide whether immediate restart reporting improves the public progress contract; keep result fields truthful to durable state and add the corresponding concurrency witness. | `packages/git/src/ops/repository/maintenance.ts`, `packages/git/src/store/maintenance/repack.ts` |
| ARCH-40 | Ref expansion and one ref probe issue raw `git_refs` SQL from ops. | Ref queries live behind the store ref seam; ops does not name store tables. | `packages/git/src/ops/repository/repository.ts`, `packages/git/src/ops/refs/refs.ts`, `packages/git/src/store/refs/refs.ts` |
| Rebase no-op admission | Baseline's real 4,096-leaf materialization cap is checked before the up-to-date result, so a clean 4,097-file no-op is rejected unnecessarily. | Recognize no-op eligibility before unnecessary baseline allocation; preserve the existing real bound for operations that materialize the baseline. The earlier claim about a 10,000-row dirty guard causing this failure was refuted. | `packages/git/src/ops/rebase/rebase-lifecycle.ts`, `packages/git/src/ops/rebase/rebase-lifecycle-baseline.ts` |
| Unused membership digests | Pack ingest computes and stores digest arrays that publication never consumes; the arrays alone reach 5 MiB at the admitted entry count. | Remove unused hashing/storage and reconcile the documented membership guarantee, or explicitly establish a needed comparison without ordinary read-time reauthentication. This is dead work/documentation drift, not protection against out-of-band writes. | `packages/git/src/store/pack/shared.ts`, `packages/git/src/store/pack/lifecycle/lifecycle-ingest.ts`, store and concurrency docs |

## Cross-cutting acceptance

- Preserve ADR-0005's rule that cost is bounded structurally rather than through
  projected-work currencies.
- Preserve ADR-0004's boundary-validation and trusted-read model. The optional
  integrity audit remains
  [`17 - Add repository integrity audit and snapshots`](17-integrity-audit-and-snapshots.md),
  not a reason to re-authenticate ordinary reads.
- Add scale witnesses for reflog retention, large worktree hash windows, public
  maintenance traversal, and deep packed delta chains. Update
  [`benchmark-current`](../reference/benchmark-current.md) only from measurements
  run under `bench/CLAUDE.md` rules.
- Update living reference documentation in the same change as each behavior or
  limit change.

<!-- Origin: external Git-in-SQLite architecture review, 2026-09-02. -->
