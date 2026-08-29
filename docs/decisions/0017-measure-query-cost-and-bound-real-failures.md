---
id: 0017
title: Measure query cost and bound real failures
status: accepted
date: 2026-08-29
---

# 0017 — Measure query cost and bound real failures

## Context

The runtime adopted 1,000 SQL statements as an operation ceiling to stay clear
of platform limits. Several implementations then projected a future statement
count and rejected the call with `E2BIG` or `EFBIG` before SQLite ran it. Those
checks do not prevent a platform failure. They manufacture an earlier failure
for work that may complete successfully. The Next.js baseline also shows that a
valid clone already uses a median of 1,586 statements, so statement count cannot
serve as a truthful package-runtime admission rule.

Byte limits have a different problem. Some protect a wire format, SQL binding,
persisted schema, retained allocation, or structural algorithm. Others count
streamed or paged work that is never live at once. The names and values alone do
not distinguish those cases.

## Decision

We will measure SQL statement count instead of using it for runtime admission.
Production code will not project, reserve, charge, or refuse work from a
statement count, and it will not assert a statement ceiling at module load.
The same rule applies when the invented query currency is named pages, reads,
or rows instead of statements.

The benchmark harness will report a target status for every representative
operation. A known target miss is evidence for optimization, not a runtime-like
benchmark failure. The harness may fail for a missing row, an invalid end state,
or a regression against a frozen baseline. Focused stress witnesses may exceed
the target when they prove that runtime no longer manufactures an error.

Vitest may retain exact zero- or one-statement assertions only when they prove a
named semantic query shape. Operation-cost assertions use a coarse `<1,000`
alarm; representative cost ownership lives in benchmarks.

Runtime byte refusals will protect only a real platform or format bound, an
untrusted persisted-schema invariant, an aggregate retained-memory/OOM model,
or a structural or algorithmic limit. Batch sizes and fallback heuristics may
shape work without refusing the whole operation. Streamed and paged work
counters will not act as memory limits. Every retained byte refusal will name
its owner, protected failure, evidence, and aggregate equation or structural
invariant.

A documented support target is not automatically an exact runtime boundary.
When the platform does not define the first failing value, the package may use
the target for non-refusing batching but must let the platform report its real
failure and normalize that result.

## Consequences

- Calls that SQLite and the platform can execute are no longer rejected by an
  invented SQL currency.
- Query regressions remain visible as deterministic benchmark rows and coarse
  unit alarms.
- A benchmark target miss creates optimization evidence without changing
  package behavior. The existing 1,586-statement clone median is such a miss.
- Byte-limit changes require a complete inventory and evidence review. This is
  more work than changing isolated constants, but it prevents arbitrary
  removals from exposing a real OOM, corrupt-row, binding, or format failure.
- Internal batching and fallback thresholds remain available because they do
  not reject valid work.

## Alternatives considered

### Keep the 1,000-statement runtime ceiling

Rejected. The projection can be conservative, the platform limit is different,
and the existing clone baseline already exceeds the ceiling while completing.

### Remove statement counting entirely

Rejected. Statement count is a useful deterministic cost signal and should
remain in benchmarks and focused query-shape witnesses.

### Remove every byte limit together with statement limits

Rejected. Several byte limits protect real retained allocations, SQL bindings,
wire formats, persisted rows, and structural algorithms. They need evidence-led
classification, not blanket removal.
