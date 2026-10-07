---
id: 119
title: Slice the clone under the Durable Object request CPU limit
blocked-by: []
---

# 119 — Slice the clone under the Durable Object request CPU limit

**Summary.** A full-history clone still needs about 74 s of CPU in one request.
A Durable Object request has a 30 s CPU limit by default. Effort: L.

## Problem

`clone()` ingests, publishes, hydrates and checks out in one call. The
reference full-history `blob:none` clone of Next.js v15.5.2 is busy for 73.8 s
at `1347704`:

| Phase | CPU |
|---|---:|
| Metadata first pass | 16.5 s |
| Deferred deltas | 26.3 s |
| Hydration | ~15 s |
| Checkout | 4.3 s |

Each phase alone fits under the limit; their sum does not. Pending-pack
ingest already survives interruption, but no caller resumes it. A restarted
clone renegotiates from scratch.

## Approach / acceptance

- Persist ingest progress so that a clone advances in bounded slices across
  requests or alarms: first pass, deferred deltas, publication, hydration
  batches, checkout.
- Bound each slice by work done, not by an invented budget (ADR-0005).
- Witness: the WU0 harness (`bench:workerd:nextjs -- --history=full`) drives
  the clone through repeated calls, with each call's CPU under 30 s. It ends
  with the same HEAD, 24,252 files and a clean worktree.

## Touch points

`ops/network/network-clone.ts`, `store/pack/ingest*`,
`store/database/database-provisional.ts` (ADR-0013 lease), the playground and
bench workers.

<!-- Origin: sprint-2026-10-07-fast-fresh-clone WU5. -->
