---
id: 66
title: Retire modeled retained-byte charges
blocked-by: []
---

# 66 — Retire modeled retained-byte charges

**Summary.** Five operations still charge a hand-computed estimate of a
JavaScript object's footprint against a byte ceiling, on top of a structural
count cap that already bounds the same structure. Remove the charge, keep the
cap.

## Problem

[ADR-0005](../decisions/0005-bound-real-failures-and-measure-cost.md) admits a
byte budget only when it charges bytes the operation actually holds. These five
charge modeled sizes instead:

| Site | Modeled constants | Structural cap already present |
|---|---|---|
| `packages/git/src/ops/push/push-plan-types.ts` | `COMMIT_ENTRY_BYTES = 512`, `MAP_ENTRY_BYTES = 128`, `SET_ENTRY_BYTES = 96`, `pushPlanStringBytes = 48 + len*2`, plus a `PushRetainedTracker` with named parts, `transfer`, and `keepOnly` | `MAX_PUSH_COMMITS = 512`, `MAX_PUSH_OBJECTS = 100_000`, `MAX_PUSH_BRANCH_TARGETS = 1_024` |
| `packages/git/src/ops/status/status-full.ts`, `status-clean.ts` | `SET_ENTRY_BYTES = 48` | **none** — `STATUS_RETAINED_BYTES` is the only bound on the tracked-path set |
| `packages/git/src/ops/status/rename-detection.ts` | `RENAME_CANDIDATE_FIXED_BYTES = 256`, `RENAME_CONFIG_BYTES = 16` | `MAX_EXACT_RENAME_CANDIDATES = 10_000` |
| `packages/git/src/ops/rebase/rebase-plan.ts` | `PENDING_REBASE_STEP_BYTES = 336` | `maxSteps`; the byte limit defaults to `Number.MAX_SAFE_INTEGER`, so it bounds nothing unless a caller sets it |
| `packages/git/src/ops/staging/staging-selected-validation.ts` | eight `*_FIXED_BYTES` / `*_SLOT_BYTES` constants | `ADD_SELECTED_PATHS = 1_000` |

`push` is the largest: 100,000 objects at its own 160-byte estimate is roughly
16 MB against a 64 MiB ceiling, so the ledger cannot fire before the count cap
does. The numbers are also unverifiable — no test asserts that any constant
matches a real allocation — and they were already scheduled for deletion in
[`specs/trusted-domain-architecture.md`](../specs/trusted-domain-architecture.md)
("hand-computed JS-size constants | delete"), which the restructure sprint did
not finish.

## Approach / acceptance

For push, rename detection, rebase, and selected staging, delete the byte
accounting and keep the count cap that already bounds the structure.

**Status is not that shape.** `STATUS_RETAINED_BYTES` is the only thing bounding
its tracked-path set, so deleting the charge there would remove a real bound.
That site needs a structural cap first — a path count naming the failure it
prevents — and the byte charge is removed only once the cap is in place and
witnessed.

Public options that accepted a byte ceiling need a decision per site: drop the
option, or reinterpret it as a count.

Acceptance: no `_BYTES` constant under `packages/git/src/ops/` stands for a JavaScript
object rather than real payload; the existing memory benchmark scenarios stay
under the sub-100 MiB target with the charges removed; push, status, rename,
rebase, and staging keep their current refusal behaviour at the structural caps,
witnessed by their existing suites.

## Touch points

`packages/git/src/ops/push/push-plan-*.ts`, `packages/git/src/ops/status/status-full.ts`,
`packages/git/src/ops/status/rename-detection.ts`, `packages/git/src/ops/rebase/rebase-plan.ts`,
`packages/git/src/ops/staging/staging-selected*.ts`, their tests, and
`docs/reference/architecture.md`.

<!-- Origin: the 2026-09-04 ADR rewrite, which found the ledger removal in ADR-0005 was only partial. -->
