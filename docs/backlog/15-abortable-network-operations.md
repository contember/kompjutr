---
id: 15
title: Make network operations abortable
blocked-by: []
---

# 15 — Make network operations abortable

**Summary.** Allow callers to cancel clone, fetch, and push while preserving
repository validity and reclaimable storage.

## Problem

The public network options do not accept an `AbortSignal`, and the default HTTP
transport does not pass one to `fetch`. A caller whose request or deadline ends
cannot promptly stop negotiation, streaming pack ingestion, compression, or an
outbound POST.

## Approach / acceptance

- Accept `AbortSignal` in clone, fetch, push, and transport request options and
  propagate it through every awaited and streaming boundary.
- Check cancellation before costly synchronous phases and at existing cooperative
  yield points without adding timing-dependent partial mutations.
- Close request and response streams, release memory reservations, and leave an
  interrupted incoming pack invisible and reclaimable.
- Distinguish confirmed cancellation before receive-pack from an uncertain remote
  result after a POST may have completed.
- Add abort-at-boundary tests for discovery, authentication retry, pack ingest,
  checkout, push planning, upload, response parsing, and retry after cancellation.

## Touch points

`src/core/ops/network.ts`, `src/core/ops/push.ts`, `src/core/protocol/`,
`src/sqlite/packs.ts`, `src/git/client.ts`, `tests/`
