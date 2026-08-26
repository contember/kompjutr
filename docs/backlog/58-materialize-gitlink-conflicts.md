---
id: 58
title: Materialize gitlink distinct-type conflicts
blocked-by: []
---

# 58 — Materialize gitlink distinct-type conflicts

**Summary.** Design and implement Git-compatible worktree materialisation for
gitlink conflicts instead of rejecting them. Effort L.

## Problem

The current checkout deliberately skips submodules and merge application rejects
any gitlink stage. Real Git materialises regular-file/gitlink conflicts with an
empty directory for the gitlink and relocates the file. Symlink/gitlink conflicts
relocate both sides and leave no primary path. The existing one-primary,
one-relocation projection cannot express those shapes.

## Approach / acceptance

- Define directory materialisation, status, dirty-check, resolution, abort, and
  replay semantics for a gitlink with no checked-out submodule runtime.
- Extend conflict projection to the two-relocation symlink/gitlink shape without
  weakening collision or operation bounds.
- Prove merge, cherry-pick, revert, rebase, abort, and continue against real Git.

## Touch points

Checkout and worktree modelling, merge projection/application, status, replay,
rebase, and differential conflict journeys.

<!-- Origin: sprint-2026-08-26-git-boundary-correctness scope decision. -->

