---
id: 49
title: Copy a set of paths as one operation
blocked-by: []
---

# 49 — Copy a set of paths as one operation

**Summary.** Every other bulk verb has a set-based form; copy has none, so a
recursive copy is the per-file loop the runtime exists to avoid.

## Problem

`Filesystem` (`src/fs/types.ts`) is bulk-first everywhere except copying.
`scan()` is one indexed range scan, `readFiles()` and `writeFiles()` take sets
under a byte budget, and `removeFiles()` turns a recursive delete into a range
delete — "removing a 5,000-file tree costs what removing one file costs". There
is no `copyFiles()`, no recursive `cp`, and `NodeFsCompat.copyFileSync()` throws
`ENOSYS` (`src/fs/compat/node.ts:359`).

A caller needing `cp -r` therefore walks the tree, reads each file and writes it
back — a statement per file in each direction, plus its own paging against a read
budget it cannot see. It is also the one place where a caller must re-derive
semantics the filesystem already owns: a symlink copied as a link rather than
followed, modes preserved, and `contentId` carried over so the copy is not
re-hashed on its first `status`.

Copying a directory is not exotic. It is how a workspace is seeded from a
template and how a session is branched from another.

## Approach / acceptance

- Add a set-based copy over the existing bulk primitives: source paths resolved
  once, entries applied in path order, parents created as `writeFiles()` does.
- Preserve type, mode and `contentId` per entry. Copy a symlink as a symlink.
- Bound it like every other bulk verb — a byte budget with a deferred remainder,
  so a caller pages instead of meeting the ceiling as a failure.
- Give `NodeFsCompat.copyFile` a real implementation on top of it.
- Conformance against `node:fs` for a single file, a directory tree, a symlink to
  a file and to a directory, a hard-linked source, an existing destination, and a
  destination inside the source.
- An operation-count witness: copying a 5,000-file tree must not scale by file.

## Touch points

`src/fs/types.ts`, `src/fs/filesystem.ts`, `src/fs/store/write.ts`,
`src/fs/store/read.ts`, `src/fs/compat/node.ts`, `tests/fs/`

<!-- Origin: migration assessment of roj's platform adapter onto kompjutr, 2026-08-26. -->
