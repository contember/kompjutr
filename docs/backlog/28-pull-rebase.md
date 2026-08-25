---
id: 28
title: Compose pull with native rebase
blocked-by: []
---

# 28 — Compose pull with native rebase

**Summary.** Route `pull --rebase` and supported `pull.rebase` configuration
through the native restart-safe rebase lifecycle after fetch.

## Problem

Pull recognises rebase configuration but rejects every enabled value. The native
rebase lifecycle now exists, but pull must define the observable boundary
between a completed fetch and a local replay that completes, conflicts, or is
resumed later.

## Approach / acceptance

- Add an explicit native pull-rebase option and support the non-interactive
  `pull.rebase=true` configuration without changing merge-default behaviour.
- Resolve and capture the fetched remote-tracking target, then start native
  rebase only after fetch publication. A later local failure must not hide or
  roll back a successful fetch.
- Preserve stale-HEAD and stale-upstream checks across the HTTP await and the
  final branch compare-and-set publication.
- Return a typed conflict/recovery result on the native surface. Keep the
  Computer compatibility behaviour explicit unless its installed contract can
  represent the lifecycle.
- Add real Git and transport parity tests for explicit/configured rebase,
  fast-forward, clean replay, conflict and reopen, abort, fetch-only persistence,
  invalid config, and concurrent ref movement.

## Touch points

`src/core/ops/pull.ts`, `src/core/ops/rebase-lifecycle.ts`, `src/git/client.ts`,
`src/compat/computer/client.ts`, `tests/pull.test.ts`, `tests/client.test.ts`,
transport fixtures and reference docs

<!-- Origin: ../archive/sprint-2026-08-25-bounded-rebase-sequencer.md -->
