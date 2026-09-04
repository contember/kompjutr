---
id: 0003
title: Split the shared Git store from checkouts
status: accepted
date: 2026-08-26
---

# 0003 — Split the shared Git store from checkouts

## Context

One repository row originally owned both the shared Git data and a single
working checkout. That identity cannot represent two session roots that share
objects and refs while keeping their mutable worktree state isolated, which is
the shape a hosted multi-session consumer needs.

Git 2.54 controls confirmed where the real boundary lies: objects, packs,
ordinary refs, direct-ref reflogs, ordinary config, and shallow state are
shared, while the root, raw `HEAD`, index, dirty state, in-progress operation
state, and the `HEAD` reflog are per worktree.

Git also exposes behaviours that do not fit this project's safety contract:
forced branch sharing between worktrees, worktree-local config, a failed add
that can leave a new branch behind, and forced removal during a live operation.

## Decision

`repo_id` is the shared store key and `checkout_id` is the checkout key. A
checkout id is a safe positive integer, immutable for its row's lifetime, and
never derived from its root. A `Repository` is a checkout-bound view over one
shared store. The current owner-by-owner table is in
[the architecture reference](../reference/architecture.md#git-storage-and-ownership).

Each root is a globally unique canonical absolute path, immutable for the
checkout's lifetime. Exactly one checkout per store carries the primary marker,
and whole-store destruction is a separate internal operation that cascades every
checkout.

A checkout owns a branch only when its raw `HEAD` is exactly
`ref: refs/heads/*`, including an unborn or deleted target. Symbolic chains
through other namespaces do not claim ownership. Retargeting raw `HEAD` releases
the old branch and acquires the new one atomically, and a storage uniqueness
constraint rejects an already-attached target with `EBRANCHINUSE`. There is no
force bypass.

A shared mutation of an owned branch records the direct-ref entry and the owning
checkout's causal `HEAD` entry in one transaction. One store-wide monotonic
allocator orders both. `HEAD@{n}` selects only retained active `HEAD` history for
the checkout the operation's directory selects; `n` is its zero-based position
newest-first, never the store-wide ordinal.

We deliberately diverge from Git in four places, each because Git's behaviour
would leave state this runtime cannot justify:

- A branch attached elsewhere cannot be moved by a raw named ref update without
  also updating that worktree's `HEAD` log.
- A rejected `worktreeAdd` leaves no branch, checkout, index, or worktree state;
  all of its SQLite writes commit or roll back together.
- A live operation always blocks removal. Force bypasses dirtiness only.
- Worktree-private ref namespaces are not modeled. Every accepted ordinary ref
  is shared, and no parity is claimed for a private namespace.

Structural caps: at most 1,024 live checkouts per store, with the first creation
over the limit failing before any mutation; reflog root enumeration capped by
`MAX_REFLOG_ROOT_SCAN_ENTRIES` and failing before it yields a partial root set.
The per-method behaviour and its stable error codes are documented in
[the Git support reference](../reference/git-support.md#git-worktree--worktreeadd-worktreelist-worktreeremove-worktreeprune).

Worktree-local config through `extensions.worktreeConfig`, Git's administrative
`.git/worktrees` layout, pointer repair, root relocation, and worktree locks are
outside this model.

## Consequences

- Checkouts share newly written objects, refs, ordinary config, and shallow
  state immediately, while their worktree and restart state stay isolated.
- A suspended operation in one checkout does not block another checkout unless
  both contend for the same shared ref publication.
- Branch ownership and causal `HEAD` history stay deterministic even when the
  ref mutation is initiated through a different checkout.
- Removing a checkout destroys its private `HEAD` recovery history. A clean
  detached checkout with unique commits can therefore lose its last recovery
  root, matching the verified Git lifecycle; its object bytes survive until
  garbage collection.
- A primary checkout cannot be removed independently of its store.

## Alternatives considered

- **One repository per checkout.** Isolates worktrees but duplicates objects,
  refs, config, fetch state, and caches, so sessions no longer share one
  repository.
- **Model Git's `.git` pointer layout.** There is no external Git directory
  here, so this adds emulation with no storage benefit.
- **Duplicate refs or ordinary config per checkout.** Breaks immediate shared
  publication and changes the repository model rather than only the checkout.
- **Add a schema upgrade chain.** No schema version has been deployed, so
  migration code would preserve development-only states and become permanent
  trust surface.
