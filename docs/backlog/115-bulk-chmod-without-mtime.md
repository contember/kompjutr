---
id: 115
title: Change modes in bulk without touching mtime
---

# 115 — Change modes in bulk without touching mtime

**Summary.** `chmod -R` costs one filesystem call per changed entry, and every
chmod rewrites `mtime`. Cost and tier S.

## Problem

- `BoundedFs.chmod` changes one path per call, so `chmod -R` over a changing
  tree costs one call per entry plus its scan pages.
- `fs/store/ops.ts` `chmodRaw` sets `mtime`; a real chmod changes only ctime,
  so a later `ls -l` or `find -newer` differs from a real system.

## Approach / acceptance

Add a bulk mode change to `Filesystem` and `BoundedFs` that leaves `mtime`
alone. Acceptance: `chmod -R` over 1,000 changed files costs O(pages), and
`find -newer` after `chmod` matches GNU.

## Touch points

`packages/do/src/fs/`, `exec/context.ts`, `commands/links/chmod.ts`.

<!-- Origin: sprint-2026-09-28-shell-surface-expansion run log (C3). -->
