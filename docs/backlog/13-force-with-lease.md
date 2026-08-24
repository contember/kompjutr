---
id: 13
title: Add force-with-lease push
blocked-by: []
---

# 13 — Add force-with-lease push

**Summary.** Let callers force-update a branch only when its remote tip still
matches the value they previously observed.

## Problem

Push includes the freshly advertised remote OID in its receive-pack command, so
a concurrent update during one request is rejected. `force: true` can still
overwrite a commit that appeared since the caller's last fetch because discovery
accepts that new tip as the command's expected old OID.

## Approach / acceptance

- Add a typed lease option that accepts an explicit expected remote OID or derives
  it from the configured remote-tracking ref.
- Compare the lease with discovery before building or sending a pack, then retain
  the advertised OID in the receive-pack command for request-time races.
- Return a distinct stable error for a stale lease and never weaken ordinary
  non-fast-forward checks unless force was explicitly requested.
- Cover implicit and explicit leases, missing tracking refs, new branches,
  deletions, stale remotes, and a race after discovery with real-server tests.

## Touch points

`src/core/ops/push.ts`, `src/git/client.ts`, `src/compat/computer/client.ts`,
`tests/push.test.ts`, `tests/client.test.ts`
