---
id: 09
title: Add outbound delta compression
blocked-by: []
---

# 09 — Add outbound delta compression

**Summary.** Reduce push bandwidth and memory pressure by emitting bounded delta
objects when the savings justify their construction.

## Problem

Received Git deltas are supported, but the push pack writer emits full objects.
Large updates therefore transfer more bytes than necessary and may spend memory
compressing repeated content independently.

## Approach / acceptance

- Select candidate bases from already reachable or earlier emitted objects
  without an unbounded all-pairs search.
- Build valid OFS_DELTA or REF_DELTA entries under explicit input, output, depth,
  and working-memory limits; fall back to a full object when a delta is unsafe or
  not beneficial.
- Preserve deterministic pack output for fixed input where practical.
- Add adversarial pack validation, real Git receive-pack compatibility, bandwidth,
  memory, and wall-time measurements.
- Keep this optimization independent of functional multi-ref push support.

## Touch points

`packages/git/src/store/pack/writer.ts`, `packages/git/src/ops/push/push.ts`, pack selection helpers,
`tests/pack.test.ts`, `tests/push*.test.ts`, `bench/`
