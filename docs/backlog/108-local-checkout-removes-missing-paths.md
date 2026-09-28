---
id: 108
title: Let local checkout remove paths that are already gone
blocked-by: []
---

# 108 — Let local checkout remove paths that are already gone

**Summary.** On the local adapter, `reset --hard` fails with `ENOENT` when a
tracked path it must remove is already missing from disk. Real Git succeeds. Tier A:
it blocks a common workflow, loudly.

## Problem

Found by the independent review of WU5 in the 2026-09-28 memory and cost sprint. It
reproduces at `06de5e5`, before that sprint changed checkout.

- **Missing file.** Delete tracked file `gone`, then `reset --hard` to a tree
  without it. The local adapter throws `ENOENT '/gone'`.
  - The local drive's `removeFiles` defaults to `force: false`. DOFS defaults to
    `true`.
  - The drive contract (`packages/drive/src/index.ts:150`) documents neither default.
- **Missing directory.** The checkout prune treats every planned directory that the
  emptiness walk did not see as empty, including directories that do not exist:
  - A nested replaced leaf (leaf `a/b` over tracked `a/b/c` and `a/b/d/e`) fails with
    `ENOTDIR` on both adapters.
  - Local "index-only `x/a` → target `x/b` → `x/c`" fails with `ENOENT '/x'`.

## Approach / acceptance

- Define the `removeFiles` missing-path default in the drive contract. Or pass
  `force: true` from the checkout removal calls: the removal stream,
  `discardUnmergedPaths`, and the prune.
- Plan prune roots only from directories the walk saw as directories.

Witness: local-adapter parity cases against the real `git` binary for all three
shapes. `reset --hard` succeeds, and the resulting status matches Git's.

## Touch points

`packages/drive/src/index.ts`, `packages/local/src/`,
`packages/git/src/ops/checkout/checkout-removals.ts`,
`packages/git/src/ops/checkout/checkout-structure.ts`, `tests/local/`.

<!-- Origin: sprint-2026-09-28 memory and cost, WU5 second review. -->
