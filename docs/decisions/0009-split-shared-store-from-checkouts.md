---
id: 0009
title: Split the shared Git store from checkouts
status: accepted
date: 2026-08-26
---

# 0009 — Split the shared Git store from checkouts

## Context

One repository row currently owns both shared Git data and one working checkout.
That identity cannot represent two session roots that share objects and refs while
keeping their mutable worktree state isolated.

Git 2.54 controls confirm the ownership boundary:

| State | Git control | kompjutr owner |
|---|---|---|
| Objects and packs | shared | shared store |
| Ordinary refs and direct-ref reflogs | shared | shared store |
| Ordinary local config and shallow state | shared | shared store |
| Root and raw `HEAD` | per worktree | checkout |
| Index, tracker, and dirty state | per worktree | checkout |
| In-progress operation state | per worktree | checkout |
| `HEAD` reflog | per worktree | checkout |

Git also exposes behaviours that do not fit kompjutr's safety contract: forced
branch sharing, worktree-local config, a failed add that can leave a new branch,
and forced removal during a live operation. Git's worktree-private ref namespaces
are not modeled. Every accepted ordinary ref is shared, and no parity is claimed
for a private namespace.

## Decision

We will keep `repo_id` as the shared store key and introduce `checkout_id` as the
checkout key. A checkout id is a safe positive integer, immutable for its row's
lifetime, and never derived from its root. A `Repository` is a checkout-bound
view over one shared store.

| Owner | State |
|---|---|
| Shared store | objects, packs, refs, ordinary config, shallow state, derived commit/tree projections, direct-ref reflogs |
| Checkout | root, raw `HEAD`, index, index tracker, dirty set, operation journal, operation steps, touched rows, `HEAD` reflog |

Each root is a globally unique canonical absolute path. It is immutable for the
checkout's lifetime; relocation is outside this decision. Exactly one checkout
per store carries the primary marker. `worktreeRemove` rejects that checkout with
`EPRIMARYWORKTREE`; `worktreePrune` never considers it. Whole-store destruction
is a separate internal operation that cascades every checkout and all store-owned
state.

Each store may have at most 1,024 live checkouts; listing is bounded by that
cap and the root/`HEAD` size limits. Reflog root enumeration is capped
structurally (`MAX_REFLOG_ROOT_SCAN_ENTRIES`) and fails with `E2BIG` before
yielding partial roots; below the cap it streams. The first checkout creation
above the 1,024 limit fails with `EWORKTREELIMIT` before mutation.

A checkout owns a branch only when its raw `HEAD` is exactly
`ref: refs/heads/*`. Ownership includes an unborn or deleted target. Symbolic
chains through other namespaces do not claim branch ownership. Retargeting raw
`HEAD` releases the old branch and acquires the new branch atomically. A storage
uniqueness constraint rejects an attached target with `EBRANCHINUSE`; there is no
force bypass.

A shared mutation of an owned branch records the direct-ref entry and the owning
checkout's causal `HEAD` entry atomically. This deliberately differs from Git's
raw named `update-ref`, which can move a branch checked out elsewhere without
updating that worktree's `HEAD` log.

One store-wide monotonic allocator orders direct-ref entries and every checkout's
`HEAD` entries. Logical reads and retention apply per direct ref for shared
history and per checkout for `HEAD` history. `HEAD@{n}` selects only retained
active `HEAD` history for the checkout selected by the operation's directory.
`n` is its zero-based position newest-first, never the store-wide ordinal.

`worktreeAdd` accepts a missing root or an existing empty root. A registered or
nonempty root fails with `EWORKTREEEXISTS`. All SQLite filesystem and Git writes,
including optional branch creation, commit or roll back together. A rejected add
therefore leaves no branch, checkout, index, or worktree state, even though Git
may leave a branch after a later add failure.

`worktreeRemove` fails with `EWORKTREENOTFOUND` for an unknown checkout and
`EPRIMARYWORKTREE` for the primary checkout. A live operation always fails with
`EWORKTREEBUSY`; force never bypasses it. Dirty state fails with
`EWORKTREEDIRTY`, and the exact force option defined by WU4 may bypass only that
dirty check. Filesystem deletion and checkout-row deletion are one transaction.
A successful removal deletes all checkout-owned state and `HEAD` history while
shared branches, objects, and direct-ref history remain. A clean detached checkout
with unique commits may therefore lose its last recovery root, matching the
verified Git lifecycle; its object bytes remain until future garbage collection.

`worktreePrune` considers only non-primary checkouts whose exact root has no
filesystem node. Staged or indexed state may be discarded once that root is
absent. If any eligible absent checkout has a live operation, the whole call fails
with `EWORKTREEBUSY` and changes nothing. Otherwise every eligible removal commits
in one transaction. The primary checkout is skipped, and a repeated call returns
an empty result.

Lifecycle methods use stable codes:

| Code | Meaning |
|---|---|
| `EBRANCHINUSE` | branch already owned by another checkout |
| `EPRIMARYWORKTREE` | operation cannot target the primary checkout |
| `EWORKTREEEXISTS` | root is registered or nonempty |
| `EWORKTREENOTFOUND` | checkout is not registered |
| `EWORKTREELIMIT` | store already has 1,024 live checkouts |
| `EWORKTREEDIRTY` | removal requires the exact dirty-force option |
| `EWORKTREEBUSY` | checkout has a live operation |

Existing generic codes retain their meanings: `EINVAL` for invalid input,
`E2BIG` for another structural bound, and `ECORRUPT` for invalid persisted state.

The current Git schema version 1 has not been deployed. We will replace that
baseline directly, without a migration, compatibility path, frozen historical
schema, or intermediate upgrade artifact.

Worktree-local config through `extensions.worktreeConfig` and
`git config --worktree` is not supported. Git administrative layout, pointer
repair, and worktree locks are also outside this model.

## Consequences

- Checkouts share newly written objects, refs, ordinary config, and shallow state
  immediately while their worktree and restart state remain isolated.
- A suspended operation in one checkout does not block another checkout unless
  both contend for the same shared ref publication.
- Branch ownership and causal `HEAD` history stay deterministic even for a ref
  mutation initiated through another checkout.
- Checkout creation, listing, pruning, and root aggregation need WU4/WU5
  first-over-limit and retained-state witnesses for the fixed cap.
- Removing a checkout is destructive to its private `HEAD` recovery history.
- A primary checkout cannot be removed independently of its store.
- Existing local databases from the previous undeployed baseline are rejected
  rather than upgraded.

## Alternatives considered

- Duplicate one repository per checkout. This isolates worktrees but duplicates
  objects, refs, config, fetch state, and caches, so sessions do not share one
  repository.
- Model Git's filesystem administration and `.git` pointer layout. kompjutr has
  no external Git directory, so this adds emulation without a storage benefit.
- Duplicate refs or ordinary config per checkout. That breaks immediate shared
  publication and changes the repository model rather than only the checkout.
- Add an upgrade chain. No schema version has been deployed, so migration code
  would preserve development-only states and become permanent trust surface.
