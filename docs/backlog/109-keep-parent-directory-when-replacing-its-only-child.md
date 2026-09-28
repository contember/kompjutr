---
id: 109
title: Keep a directory whose only child changes type
blocked-by: []
---

# 109 — Keep a directory whose only child changes type

**Summary.** When the only entry of `d` changes from a directory to a file, checkout
deletes `d` and creates it again, so a custom mode on `d` resets to 755. Git keeps
`d`. Tier S (silent divergence), but narrow: only directory metadata changes.

## Problem

Found by the independent review of WU6 P3 in the 2026-09-28 memory and cost sprint.
It happens on both checkout paths and predates that sprint.

- **Sparse fast path:** `prepareSparseCheckout` puts the ancestors of structural roots
  into the prune set (`ops/checkout/sparse-checkout-apply.ts`, `removalRoots`).
- **Full path:** `CheckoutRemovalStream` prunes the same parents
  (`ops/checkout/checkout-removals.ts`).

Repro: `d` holds only the tracked directory `d/y`. Run `chmod 700 d`, then check out a
tree where `d/y` is a file. `d` comes back with mode 755.

## Approach / acceptance

Leave the ancestors of a structural root out of the prune set, because their subtree
gets a new entry.

Witness: a local-adapter parity case against the real `git` binary. The mode of `d`
must survive on both checkout paths.

## Touch points

`packages/git/src/ops/checkout/sparse-checkout-apply.ts`,
`packages/git/src/ops/checkout/checkout-removals.ts`, `tests/local/git-parity.test.ts`.

<!-- Origin: sprint-2026-09-28 memory and cost, WU6 P3 review. -->
