---
id: 59
title: Make long and recursive shell listings set-based
blocked-by: []
---

# 59 — Make long and recursive shell listings set-based

**Summary.** Query-shape gap. Bare `ls` is one `readdir`, but `ls -l` costs one
extra metadata query per entry and `ls -R` one directory query per directory.

## Problem

`listDirectory()` calls `stat()` for every visible child when `-l` is present,
then recursively calls itself and issues another `readdir()` for every directory
under `-R` (`src/shell/commands/list.ts:58-79`). Wide and deep trees therefore
turn one shell command back into the per-path/per-directory loop the bulk
filesystem API exists to remove.

The current cost suite measures only bare `ls`, so its constant result does not
witness the two expensive supported forms. The file header and archived design
both describe recursive listing as a bulk scan, which is not the current query
shape.

## Approach / acceptance

- Provide or reuse a paged metadata-bearing directory/subtree primitive so
  `ls -l` does not call single-path `stat()` for each row.
- Render `ls -R` from bounded scan pages in path byte order without one
  `readdir()` per directory or a complete-tree materialization.
- Preserve supported visibility, symlink, multi-target, heading, mode, size, and
  timestamp output semantics. Do not implement currently ignored sort/format
  flags as part of this cost fix.
- Add correctness witnesses for empty, wide, deep, hidden, symlinked, and
  multi-target trees.
- Add operation and SQL-statement measurements at two tree sizes. Cost may scale
  with bounded pages and output bytes, never with one call per listed path or
  directory. A trailing `head` must stop further pages where output order allows.

## Touch points

`src/fs/types.ts`, `src/fs/filesystem.ts`, `src/fs/store/scan.ts`,
`src/shell/exec/context.ts`, `src/shell/commands/list.ts`, `tests/fs/scan.test.ts`,
`tests/shell/shell.test.ts`, `tests/shell/cost.test.ts`

<!-- Origin: shell implementation audit, 2026-08-26. -->
