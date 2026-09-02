---
id: 0022
title: Own local Git mutations with SQLite transactions
status: accepted
date: 2026-09-02
---

# 0022 — Own local Git mutations with SQLite transactions

## Context

A local Git operation reads durable state, decides a transition, and changes
repository, index, and worktree rows in the same SQLite database. Durable Object
`transactionSync()` is blocking and rejects asynchronous callbacks, so no other
request can interleave while that transaction is open. Nested calls on the same
stack join the outer SQLite transaction, however, and injected worktree or index
callbacks can re-enter a supported public Git mutation unless the Git domain
rejects that re-entry explicitly.

The former operation journal bound its complete state to a detached integrity
hash. Rebase advancement reread and authenticated the complete plan and replaced
all journal rows. This duplicated the database transaction's ownership and made
an N-step replay quadratic. The trusted-store contract in
[ADR-0018](0018-trust-stored-rows-validate-at-the-boundary.md) instead makes the
validated write and schema constraints authoritative.

Some Git methods cross network, pack-streaming, or cooperative `await`
boundaries. A synchronous SQLite transaction cannot and must not span those
boundaries, so local transaction ownership and durable asynchronous coordination
have different scopes.

## Decision

A same-database Git read-decide-write state machine is owned by one outer
`transactionSync()`. Each supported synchronous Git mutation boundary acquires
an uncommitted `mutation_guard` row in `git_meta` before its first store or
worktree mutation. A conflicting same-stack acquisition fails with `EREENTRANT`.
Only the successful outer acquirer deletes the row before commit; rollback also
removes it. The row is transaction-local serialization, not a durable lock or a
cross-process claim.

The owning transaction contains the authoritative reread, the worktree and index
mutation, the conditional SQL transition, and the maintenance-root epoch bump.
Legal journal transitions use expected phase, cursor, and pending-outcome
predicates with `RETURNING`; changing no row fails with `EOPMISMATCH`.

An operation's replay plan and anchors are validated completely when the journal
is created and are immutable afterwards. A transition may change only `phase`,
`empty_reason`, the `current_step` cursor, `current_parent_oid`,
`replayed_count` and `skipped_count`, `committer_name` and `committer_email`,
the current step's `outcome` and `result_oid`, and the bounded conflict
snapshot. A new result object is validated when introduced. Ordinary journal
reads use plain projections and shared row decoders; maintenance consumes
bounded operation-root pages.

No guarded repository, index, or worktree publication phase holds the local
guard across `await`. If an asynchronous flow later enters another guarded
publication phase, it reacquires the guard and repeats the durable checks that
authorize that phase. Fetch generations and namespaces, pack-stream
checkpoints, and similar asynchronous ownership use their own transactions,
epochs, CAS, or leases; they do not acquire the local mutation guard merely
because they mutate rows. This decision makes no distributed or cross-process
serialization guarantee. One live database graph represents one Durable Object
isolate as described in
[the concurrency reference](../reference/concurrency.md).

## Consequences

- Local mutations have one serialization owner, and injected public mutation
  re-entry fails before changing durable or worktree state.
- Rebase journal statement and returned-row growth is linear in the number of
  steps; each advancement changes constant journal state plus a bounded conflict
  snapshot.
- A successful call, a thrown callback, and a transaction rollback leave no
  committed guard row. Cold reopen needs no guard recovery protocol.
- Internal owned seams must compose inside the outer transaction without
  reacquiring the public guard.
- Async code must make every guarded repository, index, or worktree publication
  phase explicit. After an `await`, that phase cannot rely on pre-await reads
  and must reacquire and revalidate; other async checkpoints retain their own
  coordination.
- Out-of-band raw SQL mutation remains undefined behavior under ADR-0018.

The direct behavior witnesses are
[`concurrency-operations.test.ts`](../../tests/concurrency-operations.test.ts),
[`operation-state.test.ts`](../../tests/operation-state.test.ts), the
maintenance repack release/reacquisition witness in
[`maintenance-repack.test.ts`](../../tests/maintenance-repack.test.ts), and the
public boundary inventory in
[`public-exports.test.ts`](../../tests/public-exports.test.ts).

## Alternatives considered

- **Detached revisions, rolling hashes, or per-row versions.** These duplicate
  SQLite's local transaction ownership, add read/write work to every transition,
  and preserve a second consistency protocol without protecting an additional
  concurrency boundary.
- **The complete-journal integrity hash.** Recomputing and comparing the hash
  re-authenticated trusted rows and made replay advancement proportional to the
  whole plan; replacing all rows made the complete replay quadratic.
- **A durable lease.** Expiry, renewal, fencing, and clock semantics are useful
  across asynchronous checkpoints, but are unnecessary and weaker than one
  blocking local transaction.
- **An in-memory mutex.** It is isolate-local, disappears on eviction, is not
  shared by separate facades over the same database, and does not express the
  atomic relationship with SQLite writes.
