---
id: 11
title: Add a production Durable Object regression probe
blocked-by: [./05-ci-and-release-gates.md]
---

# 11 — Add a production Durable Object regression probe

**Summary.** Validate release candidates against actual Durable Object SQLite,
memory, restart, and wall-time behaviour instead of extrapolating from Node.

## Problem

The local benchmark transfers SQL statement counts but explicitly does not prove
production isolate memory or latency. Clone has production evidence from a pinned
revision, while the current release head and Smart HTTP push do not have a
repeatable release regression lane.

## Approach / acceptance

- Package a deterministic probe for clone, fetch, local mutation, commit, push,
  reopen, and physical repository audit on a release candidate.
- Record operation SQL counts, external wall time, platform analytics, response
  correctness, and state correctness after a fresh Durable Object instance.
- Separate application failures, storage resets, and isolate resets. Never infer
  platform memory from Node process RSS.
- Keep deployment and credentials in an explicitly authorized CI or operator
  workflow; no local publish or deploy path.
- Document the fixture revision and retained raw evidence so results can be
  compared across releases.

## Touch points

`.github/workflows/`, production probe harness, `bench/`, `docs/reference/`
