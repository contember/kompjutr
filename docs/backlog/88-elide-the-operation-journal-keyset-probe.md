---
id: 88
title: Elide the operation journal keyset probe
blocked-by: []
---

# 88 — Elide the operation journal keyset probe

**Summary.** `iterateOperationTouched` pays the same always-one-extra-query
tax that was removed from the integration workspace in `e355936`, on the
durable journal instead of the scratch workspace.

## Problem

`iterateOperationTouched`
(`packages/git/src/store/operations/operation-journal-read.ts:146-188`) is the
identical keyset loop: `ordinal` keyset, `LIMIT INTEGRATION_PAGE_ROWS`, a byte
cap, and `if (page.length === 0) return`. It therefore issues one query that
returns no rows at the end of every traversal.

The same analysis applies: a page that drained its cursor to exhaustion was not
truncated by the `LIMIT`, so the next query provably returns nothing; a page
stopped early by the byte cap says nothing about what remains. The naive
"fewer rows means done" form loses rows, which is why the shared predicate
`isFinalKeysetPage(scanned, byteCapped)` exists in
`packages/git/src/store/operations/integration-workspace/storage.ts`.

Found while fixing the two integration-workspace sites; left alone then
because it was outside that unit's territory.

## Approach / acceptance

Apply the same three-line change and import the shared predicate rather than
re-deriving it. Confirm no journal consumer appends past the cursor during a
traversal, as was done for the integration sites.

Witness: the two boundary cases the integration fix uses — a traversal ending
exactly on a page boundary, and a page truncated by the byte cap with fewer
than a full page of rows — both against the journal, each failing on a naive
implementation.

## Touch points

`packages/git/src/store/operations/operation-journal-read.ts`,
`tests/operation-state.test.ts`.

<!-- Origin: 2026-09-22 baseline triage and the e355936 keyset fix. -->
