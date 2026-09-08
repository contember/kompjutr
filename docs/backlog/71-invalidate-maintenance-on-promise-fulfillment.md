---
id: 71
title: Invalidate maintenance marks when promised blobs become physical
blocked-by: []
---

# 71 — Invalidate maintenance marks when promised blobs become physical

**Summary.** High-priority lifecycle fix: maintenance must not collect a
referenced blob fulfilled after its tree was marked.

## Problem and evidence

Missing promised blobs are omitted from the maintenance mark table. Loose and
packed publication remove the fulfilled promise without advancing the root
epoch. The unfinished generation therefore retains an obsolete reachability view.

The review reproduced both storage variants:

1. A referenced tree names promised, missing blob B.
2. Maintenance expands the tree while B is absent.
3. Publish B, then classify it in the same generation without changing refs.
4. Leave that generation unfinished at sweep for more than 14 days.
5. Resume: B is deleted, HEAD is unchanged, and B has no promise left.

The fixture used supported store writers, public `hashObject()` for loose
fulfillment, pack ingest for packed fulfillment, and cold public maintenance
calls. No arbitrary SQL corruption was involved. The complete HTTP partial
clone → `catFile()` hydration journey was not reproduced; its use of the same
publication path is established by code tracing. Fresh marking in a new
generation would prevent this specific failure.

The impact is loss of local bytes and automatic promise-based recovery, not a
claim that an upstream copy becomes unrecoverable.

## Approach / acceptance

- Atomically invalidate the old reachability generation when physical publication
  fulfills promises, covering both loose and packed writes. Do not make all
  promises maintenance roots.
- Add a deterministic public partial-clone/hydration/maintenance witness for the
  schedule above, including cold reopening and an injected clock.
- Retain the focused loose and packed publication twins and normal grace-period
  collection of genuinely unreachable objects.
- Confirm that the next destructive action restarts or otherwise incorporates
  newly physical reachable leaves before deleting anything.

## Touch points

- `packages/git/src/store/pack/packs.ts` — complete publication.
- `packages/git/src/store/schema/schema-object-statements.ts` — loose publication.
- `packages/git/src/store/maintenance/reachability/reachability-publish.ts`.
- `packages/git/src/store/maintenance/sweep/`.
- `packages/git/src/ops/network/network-promisor.ts`.
- `tests/maintenance-sweep.test.ts`, `tests/promisor-store.test.ts`.
