---
id: 0003
title: Port xdiff for text merge
status: accepted
date: 2026-08-24
---

# 0003 — Port xdiff for text merge

## Context

Merge, cherry-pick, revert, rebase, and stash application need the same
three-way content merge. Conflict placement is user-visible Git behaviour with a
large edge-case surface. A new algorithm or a generic diff3 package would be
smaller, but its results could differ from Git and its memory model would not
automatically satisfy Durable Object limits.

Git's complete `merge-ort` strategy is not a suitable unit to port. It is coupled
to Git's object database, index, attributes, rename detection, refs, and working
tree. The low-level `xdiff/xmerge.c` component is a separable LibXDiff algorithm
under LGPL-2.1-or-later. The repository already isolates a TypeScript port of
Git's xdiff line differ under the same licence in `src/core/diff/`.

## Decision

We will port `xdiff/xmerge.c` into the existing LGPL xdiff module and adapt it to
the current line-diff representation. The port will own only byte-oriented text
merge, conflict refinement, marker formatting, and related bounds.

We will implement merge-base traversal, streamed tree integration, structural
conflicts, index stages, worktree plans, operation state, and Git command
orchestration natively against kompjutr's repository and SQLite abstractions. We
will not port `merge-ort` or add a runtime merge dependency.

## Consequences

- Text conflict behaviour can be tested directly against `git merge-file` and
  share the existing upstream attribution and LGPL boundary.
- The xdiff module and its compiled output remain LGPL-2.1-or-later; the rest of
  the package remains MIT.
- Resource limits must be added explicitly around the port. Upstream allocation
  assumptions are not accepted unchanged.
- Tree merging remains tailored to streamed SQLite rows and the operation budget.
- Initial merge support may omit rename detection, attributes, custom merge
  drivers, and submodule checkout, but these omissions must be explicit.
- Upstream xdiff changes require deliberate review and differential tests rather
  than automatic dependency updates.

## Alternatives considered

- Write the text merge from scratch. This maximizes control but creates an
  unnecessary Git-parity risk in the hardest user-visible algorithm.
- Depend on or vendor the MIT `diff3` package used by isomorphic-git. Its compact
  implementation is attractive, but it has different conflict behaviour and no
  repository-specific memory contract.
- Port Git's complete `merge-ort` strategy. Its coupling, size, licensing, and
  assumptions about Git's native repository make it a poor fit for this runtime.
- Defer merge indefinitely. This leaves divergent pull and the shared conflict
  foundation for rebase, cherry-pick, revert, and stash unavailable.
