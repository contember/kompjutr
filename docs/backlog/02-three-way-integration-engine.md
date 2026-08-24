---
id: 02
title: Build the shared three-way integration engine
blocked-by: []
---

# 02 — Build the shared three-way integration engine

**Summary.** Build the bounded tree, content, and conflict engine shared by
merge, cherry-pick, revert, rebase, and stash application.

## Problem

The SQLite index can store conflict stages 1, 2, and 3, but no operation can
combine base, current, and incoming trees. Reimplementing text conflict semantics
independently would likely drift from Git, while a whole `merge-ort` port would
import Git-specific object, index, attribute, rename, and repository machinery
that does not fit kompjutr's SQLite-native cost model.

## Approach / acceptance

- Port Git's LGPL-2.1-or-later `xdiff/xmerge.c` into the existing isolated xdiff
  module and adapt it to the current line-diff representation. Preserve upstream
  attribution and extend the module's licence notice.
- Expose a byte-oriented, size-bounded text merge that supports clean results,
  Git-compatible conflict refinement, merge/diff3/zdiff3 markers, CRLF, missing
  final newlines, configurable labels, and explicit binary rejection.
- Implement the three-tree structural join natively over authoritative streamed
  tree rows. Resolve unchanged, one-sided, identical, add/add, modify/delete,
  file/directory, mode, symlink, binary, and gitlink cases.
- Return a deterministic integration plan containing clean entries, conflict
  entries, and index stages. Do not mutate refs, index, or worktree in this layer.
- Bound every input, retained region, conflict, output, tree row, and SQL page
  before allocation. Fail closed instead of truncating or falling back to an
  unbounded algorithm.
- Differential-test text results against `git merge-file` and structural results
  against real Git. Add adversarial tests for large lines, repeated regions,
  malicious labels, output expansion, Unicode paths, and corrupt tree data.
- Treat rename detection, attributes, custom merge drivers, and submodule checkout
  as explicit follow-on scope. The initial engine reports renames as delete/add.

## Touch points

`src/core/diff/`, `src/core/ops/`, `src/core/repository.ts`, `src/sqlite/tree-walk.ts`,
`src/sqlite/store.ts`, `tests/`, `LICENSE`, `LICENSES/`

See [ADR 0003](../decisions/0003-port-xdiff-text-merge.md).
