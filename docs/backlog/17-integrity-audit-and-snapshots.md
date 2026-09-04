---
id: 17
title: Add repository integrity audit and snapshots
blocked-by: []
---

# 17 — Add repository integrity audit and snapshots

**Summary.** Provide an explicit, bounded diagnostic boundary for repository
integrity and a streaming way to export or restore reproducible Durable Object
state without burdening ordinary reads.

## Problem

Ordinary reads trust rows admitted by validated schemas and supported writers
([ADR-0004](../decisions/0004-trust-stored-rows-validate-at-the-boundary.md)).
Out-of-band mutation is undefined behavior, and callers have no public,
opt-in command that surveys the damage, distinguishes authoritative from
rebuildable data, or captures portable incident and migration state.

## Approach / acceptance

- Audit exact filesystem and Git schema shape, refs, checkout HEADs, index
  stages, operation plans and mutable transition state, shallow boundaries,
  loose objects, packs, object checksums, and derived commit/tree projections.
- Stream the audit through fixed keyset pages and bounded work queues. Apply
  explicit finding and output caps that name retained-result limits; do not
  invent projected-statement or modeled-byte admission currencies
  ([ADR-0005](../decisions/0005-bound-real-failures-and-measure-cost.md)).
  Report stable structured findings instead of stopping at the first unrelated
  defect.
- Classify repairs as safe derived-data rebuilds or destructive authoritative
  changes; never perform the latter implicitly.
- Define a versioned streaming snapshot format with checksums and structurally
  bounded import. Import is a new ingest boundary and must validate completely
  before making restored repositories visible.
- Add corruption fixtures, interrupted export/import tests, round trips,
  forward-compatibility rejection, and large-repository resource witnesses.

## Touch points

`src/fs/schema.ts`, `src/git/store/schema/schema.ts`,
`src/git/store/schema/operation-schema.ts`, `src/git/store/database/database.ts`,
`src/git/store/objects/`, `src/git/store/pack/`, `src/git/store/refs/`,
`src/git/store/indexes/index-table.ts`,
`src/git/store/maintenance/`, the new audit/snapshot API, and focused `tests/`
