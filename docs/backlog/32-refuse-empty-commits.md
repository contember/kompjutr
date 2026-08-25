---
id: 32
title: Refuse an empty commit unless it is explicitly allowed
blocked-by: []
---

# 32 — Refuse an empty commit unless it is explicitly allowed

**Summary.** Tier S (silent divergence). `commit()` always succeeds, where Git
exits non-zero with "nothing to commit".

## Problem

`commit()` in `src/core/ops/commit.ts` validates the message, rejects unmerged
paths, then publishes unconditionally. There is no comparison between the index
tree and HEAD's tree, so a commit with no staged change creates a real commit.
`tests/commit.test.ts:189` pins this against Git's `--allow-empty`, confirming
the divergence is from Git's default, not from Git entirely.

Callers use Git's refusal as a no-op signal. Under kompjutr an automation loop
that commits on every pass silently grows the history instead of stopping.

## Approach / acceptance

- Compare the projected tree with the parent's tree inside the existing
  transaction and throw a stable error when they are equal.
- Add `allowEmpty` for the callers that want Git's `--allow-empty`.
- Refuse an empty root commit too; allow a non-empty root normally. Preserve the
  actual exceptions: `--amend` that only rewrites metadata and finalising a
  pending merge, which commits by definition.
- Real Git parity tests for no-op commit, staged no-op (content restaged
  identical), amend-message-only, empty merge continuation, and `allowEmpty`.

## Touch points

`src/core/ops/commit.ts`, `src/git/client.ts`, `src/compat/computer/client.ts`,
`tests/commit.test.ts`, `docs/reference/git-support.md`
