---
id: 69
title: Preserve local mutation semantics after first touch
blocked-by: []
---

# 69 — Preserve local mutation semantics after first touch

**Summary.** Fix two reproduced ordinary-use failures caused by relying on the
first-touch backup move to perform the requested filesystem operation.

## Problem and evidence

The recovery coordinator intentionally backs up a path only once per outer
transaction. Later writes, including paths covered by an ancestor intent, must
still perform their own replacement or removal.

- **Symlink replacement:** a second `writeFiles()` of the same symlink reaches
  `symlinkSync()` with an existing destination and fails with `EEXIST`. The review
  reproduced this through public rebase: commit a symlink change on a feature
  branch, advance main with an unrelated file, then rebase the feature. Baseline
  materialization and replay replace the symlink in one transaction.
- **Empty directory removal:** public `makeDirectories()` followed by `rmdir()`
  in the same transaction fails because non-recursive `rmSync()` refuses
  directories. Separate transactions succeed through the backup move.

Neither sequence requires external filesystem edits or direct SQL writes.

## Approach / acceptance

- Implement symlink replacement independently of backup creation, using a
  recovery-compatible temporary symlink and rename or an equivalent atomic path.
- Use empty-directory removal semantics for non-recursive directory deletion.
- Add the public rebase parity witness, repeated symlink writes, and same- versus
  separate-transaction mkdir/rmdir witnesses.
- Cover paths already owned by ancestor intents and rollback/reopen after later
  failure. Preserve the original first-touch backup and directory fsync rules.

## Touch points

- `packages/local/src/drive/write.ts` — `writeFiles()` and removal execution.
- `packages/local/src/drive/disk-drive.ts` — public mutation adapters.
- `packages/local/src/recovery/coordinator.ts` — first-touch ownership.
- `tests/local/`, `tests/rebase.test.ts`.
