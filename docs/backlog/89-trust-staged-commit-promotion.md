---
id: 89
title: Trust staged commit promotion instead of counting it
blocked-by: []
---

# 89 — Trust staged commit promotion instead of counting it

**Summary.** `promoteCommitCaches` brackets its insert with two `count(*)`
probes to confirm the insert covered every staged key — a read-time
re-authentication of rows the store wrote in the same transaction.

## Problem

`packages/git/src/store/trees/commits-staging.ts:53-76` runs
`INSERT ... SELECT ... ON CONFLICT DO NOTHING` between two `count(*)` queries
and compares them to prove the promotion was complete.

Critical invariant 4 says to validate at the boundary and trust the store:
rows the store wrote are trusted at read, with no two-phase preflights and no
SQL witnesses. This is exactly such a witness, over rows written moments
earlier inside the same transaction.

It costs only two statements, so the reason to look at it is the contract, not
the cost. Removing it is a judgement about what the promotion guarantees, which
is why the keyset fix deliberately left it alone.

## Approach / acceptance

Establish what the count comparison actually protects against — a staged key
with no corresponding row is either impossible under the write path and the
`CHECK` constraints, or it is a real gap that belongs in the write path rather
than a read-time check. Decide accordingly, and record it in
[ADR-0004](../decisions/0004-trust-stored-rows-validate-at-the-boundary.md) if
the answer refines the trust rule.

Witness: WU1's publication witnesses stay green, including the cleanup-fault
rollback and the second-handle reads in
`tests/pack-projection-publication.test.ts`.

## Touch points

`packages/git/src/store/trees/commits-staging.ts`,
`tests/pack-projection-publication.test.ts`.

<!-- Origin: 2026-09-22 baseline triage. -->
