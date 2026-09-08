---
id: 73
title: Validate fetched object connectivity and final publication
blocked-by: []
---

# 73 — Validate fetched object connectivity and final publication

**Summary.** Reject incomplete remote object graphs before publishing refs, and
qualify object lifetime across the final asynchronous publication seam.

## Problem and evidence

### Invalid remote graph accepted by a correctly used client

The review reproduced public `clone()` succeeding after a server sent valid
commit C and its empty tree but omitted parent P. HEAD became C, P was missing,
and the shallow set was empty. Root type/hash checks and pack membership do not
establish commit/tree/blob connectivity.

This is a high-priority network-boundary defect. It requires an incomplete remote
response; it is not evidence that cloning from a healthy Git server normally
loses history. No direct local database mutation was used.

### Existing objects can disappear after validation

A statically verified legacy-fetch schedule reuses a complete but unreferenced,
aged pack without receiving a new transfer. After root validation, an `await`
allows already-eligible maintenance to delete the pack. Publication compares
ref/namespace/shallow snapshots, not physical availability. This public
interleaving has not been reproduced. A normal mapped transfer supplying a fresh
fallback pack is not the same witness.

### Upload-pack framing

The upload-pack parser treats EOF like flush and ignores some empty, control, or
unknown-band frames that native Git rejects. This is another malformed-remote
input condition, established by parser tracing and native-source comparison.
Pack checksum validation still applies. Trailing bytes after flush are not an
independently established defect and are not an acceptance requirement here.

## Approach / acceptance

- Add public clone/fetch witnesses for missing parents, trees, and non-promised
  blobs, including unmaterialized fetched branches. Reject before ref publication.
- Explicitly allow declared shallow boundaries, absent gitlinks, and durable
  `blob:none` promises. Avoid rehashing trusted local objects during connectivity
  traversal; use bounded metadata walks and batches.
- Reproduce the legacy fetch/maintenance schedule first. Establish target lifetime
  across validation and publication by ownership or an effective final check.
  Do not silently broaden the guarantee to untested transfer variants.
- Differentially test empty sideband packets, unknown bands, and EOF without
  required termination. Preserve streaming and valid large transfers.
- Preserve previous refs and usable checkout state on every rejected response.

## Touch points

- `packages/git/src/ops/network/network-tags.ts`, `network-fetch-legacy.ts`,
  `network-fetch-mapped.ts`, `network-checkpoint.ts`.
- `packages/git/src/store/fetch/fetch-publication-preflight.ts`.
- `packages/git/src/protocol/upload-pack.ts`.
- `tests/clone.test.ts`, `tests/fetch-refspec.test.ts`,
  `tests/concurrency-fetch.test.ts`, `tests/protocol.test.ts`.
