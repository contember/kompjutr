---
id: 0017
title: Measure cost in benchmarks and bound only real failures
status: accepted
date: 2026-08-29
---

# 0017 — Measure cost in benchmarks and bound only real failures

## Context

The runtime originally adopted two invented currencies to stay clear of
platform limits: a 1,000-SQL-statement operation ceiling and a hand-maintained
retained-byte ledger (`MemoryCoordinator` reservations, scope trees, ownership
checks, `TransportOperationBudget`). Both inverted their intent. Statement
projections refused calls the platform would have served — a valid clone
already uses a median of 1,586 statements. The byte ledger modeled JavaScript
object sizes with hand-computed constants, threaded reservation parameters
through most signatures, and repeatedly failed its own reviews
(allocation-before-admission gaps), while the actual protection against
Durable Object OOM came from streaming discipline and fixed caps, not from the
ledger.

## Decision

We will measure cost and bound only real failures.

- **No invented runtime currency.** Production code does not project, reserve,
  charge, or refuse work from a statement count or a byte ledger, whatever the
  currency is called (statements, pages, reads, rows, retained bytes). The
  dynamic memory-accounting system is removed.
- **Memory safety is structural.** Peak memory stays bounded because every
  seam is bounded by construction: streaming cursors, fixed batch sizes, fixed
  cache capacities, bounded queues, single-value caps that name a real limit
  (SQL binding size, wire format, algorithmic budget), and structural result
  caps (`E2BIG`) on enumerations whose output is inherently caller-unbounded.
  A cap survives only if it names the real failure it prevents.
- **Benchmarks own the evidence.** Representative operations have
  deterministic statement/row rows, and memory scenarios run under a leased
  cgroup that measures the real composed peak. A target miss (≤1,000
  statements, sub-100 MiB peak) is optimization evidence, never a runtime
  refusal. Vitest keeps coarse `<1,000` alarms and exact zero/one assertions
  only where they prove a named semantic query shape.

## Consequences

- Calls the platform can execute are never rejected by an invented currency,
  and signatures stop carrying reservation plumbing.
- A bug that accidentally materializes unbounded state now OOMs the isolate
  instead of failing with a ledger error. The compensating controls are the
  structural caps at the few genuinely unbounded seams, the leased cgroup
  benchmark scenarios, and the layer rules that keep traversals on streaming
  cursors.
- Cost regressions surface as benchmark rows and coarse suite alarms, not as
  unit-test diffs of exact counts.
- Every surviving cap must name its owner and the real failure it prevents;
  an unexplained threshold is deleted on sight.

## Alternatives considered

- **Keep the statement ceiling.** Rejected: projections are conservative, the
  platform limit is different, and real workloads already exceed the number
  while completing.
- **Keep the byte ledger.** Rejected: it is precision theater — hand-computed
  constants standing in for real allocation — with a high plumbing and review
  cost, and it never was the thing actually preventing OOM.
- **Remove every limit.** Rejected: structural caps on binding sizes, wire
  formats, queues, caches, and unbounded enumerations prevent real failures
  and cost nothing to keep.
