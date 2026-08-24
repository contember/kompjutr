---
id: 17
title: Add repository integrity audit and snapshots
blocked-by: []
---

# 17 — Add repository integrity audit and snapshots

**Summary.** Provide a bounded way to diagnose repository corruption and export
or restore a reproducible Durable Object state.

## Problem

Reads validate untrusted rows and fail closed, but callers have no public command
that explains the full damage, distinguishes authoritative from rebuildable data,
or captures a portable state for incident analysis and migration.

## Approach / acceptance

- Audit schema and migration state, refs, HEAD, index stages, shallow boundaries,
  loose objects, packs, object checksums, and derived commit/tree projections.
- Page the audit under explicit statement, byte, and finding limits. Report
  stable structured findings instead of stopping at the first unrelated defect.
- Classify repairs as safe derived-data rebuilds or destructive authoritative
  changes; never perform the latter implicitly.
- Define a versioned streaming snapshot format with checksums and bounded import.
  Import must validate fully before making restored repositories visible.
- Add corruption fixtures, interrupted export/import tests, round trips, forward
  compatibility rejection, and large-repository resource gates.

## Touch points

`src/sqlite/schema.ts`, `src/sqlite/store.ts`, `src/sqlite/packs.ts`,
`src/core/repository.ts`, new audit/snapshot API, `tests/`
