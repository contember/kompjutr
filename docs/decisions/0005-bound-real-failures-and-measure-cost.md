---
id: 0005
title: Bound real failures and measure cost
status: accepted
date: 2026-08-29
---

# 0005 — Bound real failures and measure cost

## Context

The runtime originally adopted two invented currencies to stay clear of platform
limits: a 1,000-SQL-statement operation ceiling, and a hand-maintained
retained-byte ledger with scoped reservations, ownership checks, and a separate
transport budget.

Both inverted their intent. Statement projections refused calls the platform
would have served, while representative valid operations exceed the performance
target and still complete. The byte ledger modeled JavaScript object sizes with
hand-computed constants, threaded accounting parameters through most signatures,
and repeatedly failed its own reviews with allocation-before-admission gaps. The
actual protection against Durable Object OOM came from streaming discipline and
fixed caps, not from the ledger.

The statement ceiling was removed completely. The ledger was not: the
cross-cutting coordinator and its reservation scopes went, but several
operations kept a private budget, and five of those still charge hand-computed
JavaScript object sizes. This decision therefore has to draw the line the
original removal did not.

## Decision

We bound real failures, measure cost in benchmarks, and count only bytes we
actually hold.

**No admission currency.** Production code does not project, reserve, or refuse
work from a statement count, a page count, a row count, or a global byte ledger
threaded through signatures. There is no projected-count refusal anywhere,
including in the argv runner.

**Memory safety is structural.** Peak memory stays bounded because every seam is
bounded by construction: streaming `db.iterate()` cursors, fixed batch sizes,
fixed cache capacities, bounded queues, single-value caps that name a real limit
(SQL binding size, wire format, algorithmic budget), and structural result caps
(`E2BIG`) on enumerations whose output is inherently caller-unbounded. A cap
survives only if it names the real failure it prevents, and it never truncates
silently.

**Count bytes you hold; never bytes you model.** A byte budget is legitimate
when it charges the length of a buffer the operation actually retains, or a
ceiling the caller declared for its own output. It is not legitimate when it
charges a hand-computed estimate of a JavaScript object's footprint — that
number cannot be verified, drifts with every engine and every field added, and
usually duplicates a structural count cap that already bounds the same
structure.

Two budgets satisfy the rule and are part of the contract:

- `src/shell/exec/context.ts` — `RetainedBudget` charges the real byte length of
  intermediate pipeline buffers and releases each reservation when the buffer
  leaves scope. It is a documented shell limit
  ([ADR-0018](0018-compile-shell-commands-to-bounded-queries.md),
  [ADR-0019](0019-admit-a-bounded-posix-shell-surface.md)).
- `src/git/ops/integration/integration-limits.ts` — `maxPlanBytes` is supplied by
  the caller and converted into remaining text-merge output capacity. Absent a
  caller value, the text-merge output ceiling still bounds the result.

Five charge modeled object sizes and are debt, not contract:
`src/git/ops/push/push-plan-types.ts` (`COMMIT_ENTRY_BYTES`, `MAP_ENTRY_BYTES`,
and a `PushRetainedTracker` with reservation transfer and ownership),
`src/git/ops/status/status-full.ts`, `src/git/ops/status/rename-detection.ts`,
`src/git/ops/rebase/rebase-plan.ts`, and
`src/git/ops/staging/staging-selected-validation.ts`.

Four of the five sit on top of a structural count cap that already bounds the
same structure — 512 commits and 100,000 objects for push, 10,000 candidates for
rename detection, a step ceiling for rebase, 1,000 paths for selected staging —
so the estimate cannot fire first. The rebase byte limit additionally defaults to
`Number.MAX_SAFE_INTEGER`, bounding nothing unless a caller sets it. Status is
the exception: `STATUS_RETAINED_BYTES` is currently the only bound on its
tracked-path set, so retiring that charge means introducing a real cap rather
than deleting one.

Removing them is
[backlog 66](../backlog/66-retire-modeled-retained-byte-charges.md); until then
they are known exceptions, and no new one may be added.

**Benchmarks own the evidence.** Representative operations have deterministic
statement and row rows, and memory scenarios run under a leased cgroup that
measures the real composed peak. At most 1,000 SQL statements and under 100 MiB
of process-transient memory per representative operation are *targets*. A target
miss is optimization evidence, never a runtime refusal. Vitest keeps coarse
`<1,000` alarms and exact zero/one assertions only where they prove a named
semantic query shape.

## Consequences

- Calls the platform can execute are never rejected by an invented currency, and
  signatures do not carry reservation plumbing.
- A bug that accidentally materializes unbounded state OOMs the isolate instead
  of failing with a ledger error. The compensating controls are the structural
  caps at the genuinely unbounded seams, the leased cgroup benchmark scenarios,
  and the layer rules that keep traversals on streaming cursors.
- Cost regressions surface as benchmark rows and coarse suite alarms, not as
  unit-test diffs of exact counts.
- Every surviving cap must name its owner and the real failure it prevents. An
  unexplained threshold is deleted on sight.
- The rule is now checkable by reading one constant: a `_BYTES` constant that
  stands for a JavaScript object rather than for real payload is a violation.

## Alternatives considered

- **Keep the statement ceiling.** Rejected: projections are conservative, the
  platform limit is different, and real workloads already exceed the number
  while completing.
- **Keep the byte ledger everywhere.** Rejected: it is precision theater —
  hand-computed constants standing in for real allocation — with a high plumbing
  and review cost, and it never was the thing preventing OOM.
- **Declare the five survivors compliant.** Rejected: that would bless a charge
  nobody can verify, layered on a count cap that already bounds the same
  structure. Recording them as debt keeps the rule sharp and the record honest.
- **Remove every limit.** Rejected: structural caps on binding sizes, wire
  formats, queues, caches, and unbounded enumerations prevent real failures and
  cost nothing to keep.
