---
id: 08
title: Extend push refspec support
blocked-by: []
---

# 08 — Extend push refspec support

**Summary.** Expand Smart HTTP push from one branch update to bounded tag and
multi-ref transactions with explicit refspecs.

## Problem

The current push operation intentionally handles one branch update or deletion.
It does not push tags, multiple refs, wildcard refspecs, or push options, so it
cannot model common release and mirror workflows.

## Approach / acceptance

- Introduce typed refspec input for branches, tags, creations, updates, and
  deletions while preserving the simple single-branch API.
- Validate all local and remote ref names and enforce a bounded number of
  commands before building a request.
- Negotiate atomic and push-option capabilities explicitly; reject requested
  semantics when the server does not advertise them.
- Parse and return per-ref receive-pack results without hiding partial failure.
- Add protocol fixtures and real-server integration tests for tags, multiple
  refs, deletion, force, atomic rejection, and push options.

## Touch points

`src/core/ops/push.ts`, `src/core/protocol/`, `src/git/client.ts`,
`src/compat/computer/client.ts`, `tests/push*.test.ts`, `tests/protocol.test.ts`
