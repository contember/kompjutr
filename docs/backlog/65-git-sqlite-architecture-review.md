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

ARCH-10 shipped with the 2026-09-10 sprint. ARCH-19 (the duplicate reflog-root
scan) and the rebase no-op admission cap went with the 2026-09-23 simplification
sprint. ARCH-47 is the [outbound delta compression idea](../ideas/outbound-delta-compression.md).
ARCH-17 is owned by [66](66-retire-modeled-retained-byte-charges.md).

The 2026-09-24 backlog review dropped findings that would add machinery without
a measured cost or a reproduced defect: ARCH-16 (durable sweep cursors), ARCH-18
(ref-table scans at 100,000 refs), ARCH-20 (sparse range seeks), ARCH-22
(normalizing `git_pack_objects`), ARCH-30 (bulk `clean`) and ARCH-33/39 (guards
against misuse of a synchronous callback). Reopen one only with a measurement.
Unverified and disputed claims remain in
[`../ideas/git-sqlite-architecture-review-triage.md`](../ideas/git-sqlite-architecture-review-triage.md).

## 2026-09-08 follow-up and evidence boundaries

The follow-up reviewed the working tree containing the scoped-package extraction,
not a commit-only diff. Existing findings stay owned here.

Re-check current source before implementation. Review probes were temporary and
were removed; their reported output is evidence, not a committed regression
suite. Preserve these distinctions when planning acceptance:

| Existing finding | Qualified evidence and required witness |
|---|---|
| ARCH-27 | Public `updateRef` accepted a trailing unpaired high surrogate; stored text changed and original-name lookup failed. Runtime-reproduced caller-input validation defect, not failure with valid ref names. Fix the shared text boundary and test symbolic targets/config/reflog siblings as applicable. |

## Store and maintenance work

| IDs | Problem | Acceptance | Touch points |
|---|---|---|---|
| ARCH-21 | `git_maintenance_shallow` duplicates `git_maintenance_objects.shallow_boundary`; its functional lookup is always false. | The duplicate table and cross-check are removed without changing shallow traversal or restart behavior. | `packages/git/src/store/schema/schema.ts`, `packages/git/src/store/maintenance/` |

## Layering and operation work

| IDs | Problem | Acceptance | Touch points |
|---|---|---|---|
| ARCH-24 / ARCH-25 | Most `*Owned` wrappers, identical twins, and WeakMap dispatch survive from the removed ownership system. | Every remaining owner abstraction has a concrete layering or behavior role; no pure forwarding twin remains. | `packages/git/src/ops/repository/repository.ts`, `packages/git/src/store/` |
| ARCH-26 | `CheckoutStore` duplicates some synchronous shared-repository reads, while other wrappers enforce delayed lifetime and mutation behavior. | Simplify only redundant reads first; preserve checks at iterator start/batch flush and authorized internal mutation composition. | `packages/git/src/store/checkout/checkout.ts`, `packages/git/src/store/repository/shared.ts` |
| ARCH-27 | Path, UTF-8, basename/depth, and OID helpers are duplicated across ops and already disagree on lone surrogates. | Shared path and byte kits become the single implementation while callers retain their error taxonomy. | `packages/git/src/common/paths.ts`, `packages/git/src/common/bytes.ts`, `packages/git/src/ops/` |
| ARCH-29 | Status scans every tracked path for each ignored directory although tracked directory prefixes are already available. | Directory pruning uses constant-time tracked path/prefix lookup, including paths retained during the stream. | `packages/git/src/ops/status/status.ts` |

## Lower-severity cleanup

| IDs | Problem | Acceptance | Touch points |
|---|---|---|---|
| ARCH-34 | `store/operations/operations.ts` duplicates existing ref and path validators. | The reviewed equivalent implementations collapse to shared validators with no behavior change. | `packages/git/src/store/operations/operations.ts`, `packages/git/src/store/refs/ref-validation.ts`, `packages/git/src/common/` |
| ARCH-36 | Direct-ref and checkout-HEAD reflog writers duplicate append and retention logic. | Shared infrastructure preserves separate ownership and FKs, including valid endpoint-equal HEAD entries. | `packages/git/src/store/refs/reflog.ts`, `packages/git/src/store/checkout/checkout.ts`, `packages/git/src/store/refs/refs.ts` |
| ARCH-40 | Ref expansion and one ref probe issue raw `git_refs` SQL from ops. | Ref queries live behind the store ref seam; ops does not name store tables. | `packages/git/src/ops/repository/repository.ts`, `packages/git/src/ops/refs/refs.ts`, `packages/git/src/store/refs/refs.ts` |
| Unused membership digests | Pack ingest computes and stores digest arrays that publication never consumes; the arrays alone reach 5 MiB at the admitted entry count. | Remove unused hashing/storage and reconcile the documented membership guarantee, or explicitly establish a needed comparison without ordinary read-time reauthentication. This is dead work/documentation drift, not protection against out-of-band writes. | `packages/git/src/store/pack/shared.ts`, `packages/git/src/store/pack/lifecycle/lifecycle-ingest.ts`, store and concurrency docs |

## Cross-cutting acceptance

- Preserve ADR-0005's rule that cost is bounded structurally rather than through
  projected-work currencies.
- Preserve ADR-0004's boundary-validation and trusted-read model; no finding
  here is a reason to re-authenticate ordinary reads.
- Update [`benchmark-current`](../reference/benchmark-current.md) only from
  measurements run under `bench/CLAUDE.md` rules.
- Update living reference documentation in the same change as each behavior or
  limit change.

<!-- Origin: external Git-in-SQLite architecture review, 2026-09-02. -->
