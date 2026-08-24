---
id: 12
title: Add reflogs and ref recovery
blocked-by: []
---

# 12 — Add reflogs and ref recovery

**Summary.** Record bounded ref movement history so destructive operations remain
recoverable and garbage collection has explicit retention roots.

## Problem

Refs currently store only their latest target. Reset, amend, rebase, checkout,
pull, and force push can make commits unreachable without leaving a recovery
record. Garbage collection cannot safely approximate Git's retention semantics
until reflog roots and expiry are defined.

## Approach / acceptance

- Append a validated reflog row whenever HEAD or a direct ref moves, including
  old and new OIDs, identity, timestamp, and a bounded reason.
- Update refs and their reflog rows in the same synchronous transaction.
- Expose bounded listing and explicit recovery through typed APIs; support the
  useful `HEAD@{n}` resolution form only if it remains cheap and unambiguous.
- Define time- and count-based retention. Expired entries stop protecting objects
  from garbage collection, while active operation state remains authoritative.
- Add parity tests for commit, amend, checkout, reset, pull, merge, rebase, and
  forced updates, plus expiry, corruption, migration, and statement budgets.

## Touch points

`src/sqlite/schema.ts`, `src/sqlite/store.ts`, `src/core/ops/`,
`src/core/repository.ts`, `src/git/client.ts`, migrations, `tests/`
