---
id: 58
title: Add metadata-only bulk timestamp updates
blocked-by: []
---

# 58 — Add metadata-only bulk timestamp updates

**Summary.** Correctness and cost gap. Shell `touch` rewrites complete file
contents to change one timestamp, clears content identity, and cannot touch a
directory.

## Problem

For every existing operand, shell `touch` calls `stat()`, reads the complete
file, and passes its bytes back through `writeFiles()`
(`src/shell/commands/files.ts:198-212`). Omitting the original `contentId`
changes it to `NULL`, so the next Git status cannot reuse the authoritative
identity even though the bytes did not change. Large files are copied through
the isolate for a metadata-only operation.

An existing directory reaches `readFile()` and throws `EISDIR` out of
`shell.run()` instead of updating its timestamp. Final-symlink behavior is also
an accident of composing `stat()` with a content write rather than an explicit
timestamp contract.

## Approach / acceptance

- Add a bulk filesystem timestamp operation that resolves the input set once.
  One mutating call bumps the revision once and changes no content rows.
- Preserve inode, type, mode, size, link count, bytes, and `contentId` for every
  existing entry.
- Match ordinary `touch` behavior for files, directories, and a final symlink;
  unsupported options such as `-h` remain rejected unless separately justified.
- Keep the current missing-file behavior: create an empty regular file with the
  default mode. Preflight all operands so a failure does not leave a partially
  updated set.
- Wire shell `touch` and the applicable Node compatibility timestamp methods to
  the primitive.
- Add filesystem conformance and real-`touch` differential cases, plus a cost
  witness proving that a multi-megabyte file moves no content BLOB through the
  isolate and that path count is handled in bounded metadata batches.

## Touch points

`src/fs/types.ts`, `src/fs/filesystem.ts`, `src/fs/ops.ts`,
`src/fs/store/ops.ts`, `src/fs/compat/node.ts`,
`src/shell/exec/context.ts`, `src/shell/commands/files.ts`, `tests/fs/`,
`tests/shell/`

<!-- Origin: shell implementation audit, 2026-08-26. -->
