---
id: 49
title: Copy a set of paths as one operation
blocked-by: []
---

# 49 — Copy a set of paths as one operation

**Summary.** Every other bulk verb has a set-based form; copy has none, so the
existing shell fallback retains a whole recursive copy and reimplements
filesystem semantics above the bulk API.

## Problem

`Filesystem` (`src/fs/types.ts`) is bulk-first everywhere except copying.
`scan()` is one indexed range scan, `readFiles()` and `writeFiles()` take sets
under a byte budget, and `removeFiles()` turns a recursive delete into a range
delete — "removing a 5,000-file tree costs what removing one file costs". There
is no `copyFiles()` filesystem primitive, and `NodeFsCompat.copyFileSync()`
throws `ENOSYS` (`src/fs/compat/node.ts:359`). `kompjutr/shell` does expose
`cp -r`, but it is a fallback over `scan()` + `readFiles()` + `writeFiles()`,
not a native copy. It retains every destination entry and every file body until
the entire source tree has been read, then writes the full set once
(`src/shell/commands/files.ts:39-62`). A paged read therefore does not bound the
operation's retained memory.

A consumer needing `cp -r` therefore has to reimplement the recursive copy. A
naive loop pays one read and write per file; the shell fallback batches those
calls but retains the complete result before writing it. Either version also
re-derives semantics the filesystem already owns: a symlink copied as a link
rather than followed, modes preserved, and `contentId` carried over so the copy
is not re-hashed on its first `status`.

The shell fallback demonstrates that drift already: it preserves `contentId`
for one directly named file, but drops it for every regular file collected from
a recursive scan (`src/shell/commands/files.ts:105-108`). It also accepts `-p`
without implementing metadata preservation.

Copying a directory is not exotic. It is how a workspace is seeded from a
template and how a session is branched from another.

## Approach / acceptance

- Add a set-based copy over the existing bulk primitives: source paths resolved
  once, entries applied in path order, parents created as `writeFiles()` does.
- Preserve type, mode and `contentId` per entry. Copy a symlink as a symlink.
- Bound it like every other bulk verb — a byte budget with a deferred remainder,
  so a caller pages instead of retaining the complete tree. The retained entry
  and content state must stay bounded at every page.
- Give `NodeFsCompat.copyFile` a real implementation on top of it.
- Replace the shell's `collectSubtree()` fallback with the new primitive and
  expose that primitive through `BoundedFs`, so the shell operation ceiling still
  covers every page.
- Either implement `cp -p` through an explicit metadata-preservation option,
  including `mtime`, or reject it. It must not remain an accepted no-op.
- Conformance against `node:fs` for a single file, a directory tree, a symlink to
  a file and to a directory, a hard-linked source, an existing destination, and a
  destination inside the source. Pin whether two hard-linked source names become
  independent destination files; do not leave inode behavior accidental.
- An operation-count witness at two tree sizes: copying a 5,000-file tree must
  scale with content pages, not with one metadata operation per path. A
  retained-memory witness must prove that the full tree and all file bodies are
  never live together.

## Touch points

`src/fs/types.ts`, `src/fs/filesystem.ts`, `src/fs/store/write.ts`,
`src/fs/store/read.ts`, `src/fs/compat/node.ts`,
`src/shell/exec/context.ts`, `src/shell/commands/files.ts`, `tests/fs/`,
`tests/shell/`

<!-- Origin: migration assessment of roj's platform adapter onto kompjutr, 2026-08-26. -->
