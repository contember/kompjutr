# Guard the index shape and settle the drive's default `force`

Two contract gaps noted while re-checking the differential tester's residual
divergences (2026-11-17). Neither is a reproduced defect, so neither is backlog
work yet.

- **Index writer accepts a file and a path below it.** `indexApply()` in
  `packages/git/src/store/indexes/index-table-store.ts` takes a put of `a` while
  `a/b` is indexed, and `buildTreeInBatch()` in
  `packages/git/src/ops/tree/tree-build-full.ts` then writes a tree with a blob
  and a tree both named `a`. `git fsck` rejects such a tree
  (`duplicateEntries`, checked with a hand-made tree). No current path produces
  it; a checkout bug of this shape was fixed in review before it shipped. A
  write-path check (ADR-0004) would turn such a bug into a stable error instead
  of a published tree. Graduates when a path reproduces it, or when a review
  finds another bug of this shape.
- **Drive `removeFiles` default `force`.** `removeFiles(["/missing"])` without
  options returns on the DO filesystem (`options.force ?? true` in
  `packages/do/src/fs/store/remove.ts`) and throws `ENOENT` on the local
  `DiskDrive` (`options.force === true` in
  `packages/local/src/drive/disk-drive.ts`). `RemoveOptions` in
  `packages/drive/src/index.ts` names no default. The Git callers that omit
  `force` (`apply-prune.ts`, `checkout-structure.ts`, `sparse-checkout-apply.ts`)
  appear to filter missing paths first: a checkout that removes `d/a` after `d`
  is gone agrees with Git. Graduates with a caller that reaches a missing path.
