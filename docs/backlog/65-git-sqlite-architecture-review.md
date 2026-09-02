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

## High-severity work

| IDs | Problem | Acceptance | Touch points |
|---|---|---|---|
| ARCH-8 | Three-way integration refuses more than 1,000 changed paths even though deleting the cap alone would leave retained plan state unbounded. | A 1,001-path integration succeeds under a real retained-state bound or a restart-safe streaming plan. | `src/git/ops/integration.ts`, `src/git/ops/integration-structure.ts` |

## Store and maintenance work

| IDs | Problem | Acceptance | Touch points |
|---|---|---|---|
| ARCH-9 | Pack ingest temporarily publishes a pending pack as complete to insert commit projections. | Ingest can publish projections for its own pending pack without exposing complete-pack visibility, including after interruption. | `src/git/store/pack-ingest-index.ts`, `src/git/store/commits.ts`, `src/git/store/pack/` |
| ARCH-13 / ARCH-23 | Repack finalization inflates and hashes the same batch twice in one transaction. | A finalized batch is authenticated at most once, and loose deletion follows a metadata-level proof of complete packed availability. | `src/git/store/maintenance/repack.ts` |
| ARCH-14 | Candidate selection fragments repack output at every OID-order transition between shadowed and unshadowed objects. | Candidates are partitioned by kind and ordered by OID within each partition, filling bounded batches. | `src/git/store/maintenance/repack.ts` |
| ARCH-16 | Loose classification and sweep do not persist keyset cursors and repeatedly scan settled or young rows. | Both phases resume from durable OID cursors, root drift clears them, and visited rows grow linearly with candidates. | `src/git/store/maintenance/sweep.ts`, `src/git/store/maintenance/state.ts`, `src/git/store/maintenance/roots.ts` |
| ARCH-17 / CORR-11 / CORR-12 | Modeled-byte currencies remain in integration, tree walking, checkout, status, diff, rename detection, initial checkout, and rebase planning. Sparse native projections no longer use mutable reserve/release/peak accounting. | Every surviving cap names a real failure; repository-scale sets stream or use a structural page where possible. | `src/git/ops/{integration,integration-structure,checkout,status,diff,rename-detection,rebase-plan}.ts`, `src/git/store/tree-walk.ts`, `src/fs/store/initial-write.ts` |
| ARCH-18 / CORR-18 | A single-ref mutation materializes the whole ref table, and fetch publication repeats related full scans. | Mutations read only changed, expected, and bounded symbolic-chain refs; cost does not depend on unrelated refs. | `src/git/store/refs.ts`, `src/git/store/fetch-publication.ts` |
| ARCH-19 | `activeRefLogOids` duplicates maintenance's reflog-root stream and carries a stale 9,727-row refusal. | One paged reflog-root implementation remains; dead facades, caps, and duplicate tests are removed or redirected. | `src/git/store/reflog.ts`, `src/git/store/maintenance/roots.ts`, store facades |
| ARCH-20 | Recursive sparse selection prevents an indexed path-range seek, so `git add <dir>` scans the whole index. | Exact and recursive branches use indexable text ranges; a query-plan witness shows work proportional to the selected range. | `src/git/store/sparse/selection.ts`, `src/git/store/sparse/workspace.ts`, `src/git/ops/staging.ts` |
| ARCH-21 | `git_maintenance_shallow` duplicates `git_maintenance_objects.shallow_boundary`; its functional lookup is always false. | The duplicate table and cross-check are removed without changing shallow traversal or restart behavior. | `src/git/store/schema.ts`, `src/git/store/maintenance/` |
| ARCH-22 | `git_pack_objects` duplicates every payload column from `git_pack_entries`. | One physical entry table plus a narrow canonical OID-to-location projection preserves reads, shadowing, and deletion. | `src/git/store/schema.ts`, `src/git/store/pack-ingest-index.ts`, `src/git/store/pack/` |

## Layering and operation work

| IDs | Problem | Acceptance | Touch points |
|---|---|---|---|
| ARCH-24 / ARCH-25 | Most `*Owned` wrappers, identical twins, and WeakMap dispatch survive from the removed ownership system. | Every remaining owner abstraction has a concrete layering or behavior role; no pure forwarding twin remains. | `src/git/ops/repository.ts`, `src/git/store/` |
| ARCH-26 | `CheckoutStore` forwards shared-repository operations already available through its guarded shared store. | Checkout exposes checkout-owned behavior only; shared calls preserve active-store guards through `store.shared`. | `src/git/store/checkout.ts`, `src/git/store/shared.ts` |
| ARCH-27 | Path, UTF-8, basename/depth, and OID helpers are duplicated across ops and already disagree on lone surrogates. | Shared path and byte kits become the single implementation while callers retain their error taxonomy. | `src/git/common/paths.ts`, `src/git/common/bytes.ts`, `src/git/ops/` |
| ARCH-29 | Status scans every tracked path for each ignored directory although tracked directory prefixes are already available. | Directory pruning uses constant-time tracked path/prefix lookup, including paths retained during the stream. | `src/git/ops/status.ts` |
| ARCH-30 | `git clean` removes paths one by one although the filesystem supports bounded bulk recursive deletion. | Flat paths are batched and directory roots use recursive bulk removal while preserving ignored and registered-root protection. | `src/git/ops/status.ts`, `src/git/ops/checkout.ts`, `src/fs/store/remove.ts` |

## Lower-severity cleanup

| IDs | Problem | Acceptance | Touch points |
|---|---|---|---|
| ARCH-33 / ARCH-39 | Checkout-backed `indexApply` lacks the scratch branch's thenable guard, sink revocation, and guaranteed disposal. | Both branches reject asynchronous callbacks, revoke escaped sinks, and dispose buffers in `finally`. | `src/git/store/index-table.ts` |
| ARCH-34 | `store/operations.ts` duplicates existing ref and path validators. | The reviewed equivalent implementations collapse to shared validators with no behavior change. | `src/git/store/operations.ts`, `src/git/store/ref-validation.ts`, `src/git/common/` |
| ARCH-36 | Direct-ref and checkout-HEAD reflog writers duplicate append and retention logic. | Shared infrastructure preserves separate ownership and FKs, including valid endpoint-equal HEAD entries. | `src/git/store/reflog.ts`, `src/git/store/checkout.ts`, `src/git/store/refs.ts` |
| ARCH-37 | The documented maintenance terminal-result contract disagrees with immediate rollover when `nextEligibleAt` is null. | Code, tests, and reference docs define one behavior for null and non-null future boundaries. | `src/git/ops/maintenance.ts`, `docs/reference/git-support.md` |
| ARCH-38 | `maintenance()` discards repack advancer status and can report discarded work as progress after root drift. | The detecting call exposes or performs the restart and does not report discarded work as forward progress. | `src/git/ops/maintenance.ts`, `src/git/store/maintenance/repack.ts` |
| ARCH-40 | Ref expansion and one ref probe issue raw `git_refs` SQL from ops. | Ref queries live behind the store ref seam; ops does not name store tables. | `src/git/ops/repository.ts`, `src/git/ops/refs.ts`, `src/git/store/refs.ts` |

## Cross-cutting acceptance

- Preserve ADR-0017's rule that cost is bounded structurally rather than through
  projected-work currencies.
- Preserve ADR-0018's boundary-validation and trusted-read model. The optional
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
