---
id: 20
title: Settle the role of git_blob_ids and bound its growth
blocked-by: []
---

# 20 — Settle the role of `git_blob_ids` and bound its growth

**Summary.** `git_blob_ids` is documented as an opaque filesystem-chosen identity,
is in practice mostly an identity map of the blob OID, and is never pruned.
Decide whether the indirection earns its table; if it stays, give it a lifecycle.

## Problem

`git_blob_ids (repo_id, content_id BLOB, oid)` maps `fs_nodes.content_id` to a
blob OID so `status` and `add` can skip reading unchanged files
(`src/sqlite/schema.ts`, the `git_blob_ids` comment; readers in
`src/core/ops/status-rows.ts`, `status-sparse.ts`, `staging.ts`, `checkout.ts`).

- The filesystem never mints a content id. `fs_nodes.content_id` is either
  supplied by a writer through the `writeFile` option (`src/fs/types.ts`,
  `contentId?: Uint8Array`) or cleared to `NULL` on any plain write
  (`src/fs/store/ops.ts`). The in-repo writers are checkout, which passes
  `fromHex(entry.oid)` (`src/core/ops/checkout.ts`) — so the row is the identity
  `oid-bytes → oid-hex` — and the import path, which passes a manifest hash
  (`src/fs/import.ts`).
- The table only ever grows: `upsertBlobIds` (`src/sqlite/store.ts`) and
  `destroy()`. Rows whose `content_id` no longer exists in `fs_nodes` are never
  removed, and nothing in backlog 04 (repack and GC) mentions them.
- The schema comment ("the id is whatever the filesystem chose to record")
  describes a boundary the code does not have. The next reader will design
  against the comment.

## Approach / acceptance

Decide one of:

1. **Content id is the blob OID.** Document it, have every in-repo writer pass
   the OID bytes, and let `status`/`add` compare `fs_nodes.content_id` to
   `git_index.oid` directly. Drop `git_blob_ids` in a migration. The import path
   must then either compute blob OIDs or leave `content_id` NULL.
2. **Keep the opaque indirection** for foreign identities (import manifests,
   external writers). Then: fix the schema comment to say who mints ids; add
   pruning of rows whose `content_id` has no `fs_nodes` row, either as part of
   backlog 04 maintenance or as a bounded sweep after checkout/commit; and cap
   the table per repository so the budget invariant (bound before allocating)
   holds.

Acceptance:

- A short decision records the choice and the reason.
- Under option 1: `git_blob_ids` is gone, `status` on an unchanged checkout still
  reads zero file bodies (existing statement-count tests hold), and import
  behaviour is covered by a test.
- Under option 2: a test writes, overwrites, and deletes files, runs the sweep,
  and shows the table holds only ids present in `fs_nodes`; the sweep stays under
  the per-operation statement budget on a repo with more files than one page.

## Touch points

`src/sqlite/schema.ts`, `src/sqlite/store.ts` (`lookupBlobIds`, `upsertBlobIds`),
`src/core/ops/status-rows.ts`, `src/core/ops/status-sparse.ts`,
`src/core/ops/staging.ts`, `src/core/ops/checkout.ts`, `src/core/ops/diff.ts`,
`src/fs/import.ts`, `tests/`

<!-- Origin: git schema architecture review, 2026-08-24. Related: ./04-repack-and-garbage-collection.md -->
