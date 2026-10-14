---
id: 123
title: Qualify large Git server production capacity
blocked-by: []
---

# 123 — Qualify large Git server production capacity

**Summary.** The bare Smart HTTP server passes local native Git qualification,
but its large-repository production memory envelope is unqualified. Attribute
transient and retained memory before making a production capacity claim.

## Problem

The [server measurements](../reference/benchmark-server.md) use a complete
640-commit, 113,920-object fixture. Local workerd has no production isolate
memory limiter. GC samples exceed 128 MiB even after exact SQL range reads
remove the multi-gigabyte allocation amplification. Whole-process RSS is not
isolate memory, and post-GC reclamation does not erase transient peaks.

The initial-push trace shows a reclaimable component: its largest sample
combines 44.3 MiB pre-major-GC heap with 92.76 MiB external memory; post-GC heap
is 8.9 MiB. Full clone also crosses the threshold after a minor GC, which does
not establish the retained live set. The current evidence proves neither
production fit nor an unavoidable production-memory failure.

The example configures 300,000 ms CPU per request. Yield checkpoints do not
reset that budget. Host process CPU includes instrumentation and background
work; production request CPU is a separate measurement.

## Approach / acceptance

1. Add attribution markers for receive indexing, final publication, upload
   planning and pack emission. Preserve the uninstrumented baseline.
2. Measure transient pressure and retained live data separately under enforced
   CPU leases. Record GC sampling gaps, cgroup limits, fixture and revision;
   do not substitute a live-set number for the original peak.
3. If a concrete owner exceeds the intended envelope, reduce its allocation or
   retention in that owner. Evaluate compressed-entry reuse or bounded deltas
   only if outbound packing is the cause. Keep full history and atomic ref
   publication; do not add projected-cost admission refusals.
4. Decide whether an actual Cloudflare probe is needed. Any deployment requires
   explicit authorization and the repository's CI path. A supported production
   envelope needs evidence for memory, request CPU and native Git correctness.

The local four-run matrix and native cancellation/closure witnesses must remain
green. Until this evidence exists, describe large production capacity as
**unqualified**.

## Touch points

`bench/server/`, `packages/git/src/store/pack/`,
`packages/git/src/store/transfer/`, `examples/git-server/`, and
`docs/reference/benchmark-server.md`.

Origin: [Smart HTTP server sprint](../archive/sprint-2026-10-13-git-smart-http-server.md).
