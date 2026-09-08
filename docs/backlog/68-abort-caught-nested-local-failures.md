---
id: 68
title: Abort local transactions after caught nested failures
blocked-by: []
---

# 68 — Abort local transactions after caught nested failures

**Summary.** High-priority correctness fix for supported synchronous API
composition: a caught nested failure must not commit partial Git state.

## Problem and evidence

The local adapter's nested `transactionSync()` branch directly invokes the
closure. An ordinary exception does not make the outer transaction abort-only.
The Git mutation guard deletes its row only after successful completion.

The review reproduced the following using exported synchronous `readTree()`
and the public local database, without arbitrary SQL writes:

1. Initialize a local repository and enter an outer `transactionSync()`.
2. Call `readTree()` with a missing revision and catch its error inside the outer
   callback.
3. Return normally. The outer transaction commits the mutation guard.
4. Subsequent mutations fail with `EREENTRANT`, including after close/reopen.

This is valid error handling in advanced public API composition, not a claim
that a standalone successful `git.commit()` corrupts state. Earlier SQL changes
inside another failed nested operation could also commit. The shared database
contract requires nested transactions to join and roll back together.

## Approach / acceptance

- Make nested failure semantics consistent with the shared rollback contract
  and the single local recovery journal. Marking the outer transaction abort-only
  is the initial approach; do not introduce independent disk savepoints casually.
- Reproduce the caught missing-revision sequence through public synchronous APIs.
  The outer transaction must fail and later operations must work after reopen.
- Add a failure after actual nested SQL/disk effects and verify rollback of both
  resources. Check a caught CLI mutation failure inside an outer transaction.
- Removing the guard in `finally` alone is insufficient: it does not undo partial
  effects. Retain separate handling of async-callback misuse.

## Touch points

- `packages/local/src/sqlite/database.ts` — nested transaction and abort state.
- `packages/git/src/store/core/mutation-guard.ts`.
- `packages/git/src/cli/write/write-runtime.ts`.
- `packages/sqlite/src/index.ts` — shared nested rollback contract.
- `tests/local/`, `tests/transactions.test.ts`.
