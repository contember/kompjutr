# src/sqlite — the store

Every table the Git side owns, plus the adapter under all of them. `src/fs/`
keeps its own schema and shares only `Database`. `src/core/` reaches this layer
through `SharedRepoStore`; the two direct `git_refs` existence checks in
`core/repository.ts` and `core/ops/refs.ts` are the exception, not a pattern.

```
db.ts             Database — the DurableObjectStorageLike adapter, cursor refinement
schema.ts         every CREATE TABLE, the version, and the shared row limits
store.ts          repository registry: objects, refs, config, index, reflog
packs.ts          pack-native object storage (derived from dgit — keep the header)
tree-index.ts     parsed tree edges · tree-walk.ts walks them · commits.ts caches commits
index-tracker.ts  index dirty state · sparse-workspace.ts · pack-ingest-index.ts
maintenance/      one durable GC run: roots → reachability → repack → sweep
```

`docs/reference/architecture.md` carries the full table ownership map and the
maintenance lifecycle. Read it before changing either.

## Row ownership

`repo_id` marks a shared row; `checkout_id` marks a row private to one working
tree. Checkout views of one store share objects, packs, refs, config, shallow,
fetch and cache state, and keep worktrees, indexes, tracker state and operation
journals apart. Two rows do not follow the rule: `git_tree_entries` is owned
through its source surrogate, and `git_scratch_index*` rows are
transaction-local — they never survive the callback, so they are neither
checkout state nor a maintenance root.

## Rules

- **A bad stored row is `CorruptError`; bad caller input is `GitError`.**
  `ref-validation.ts` carries the distinction as `RefValueSource`. Collapsing
  the two turns a caller's typo into a corruption report, and hides real
  corruption behind an argument error.
- **`SCHEMA_VERSION` is 1 and there are no migrations.** Edit `schema.ts` in
  place; do not add a migration step.
- **A pack is stored verbatim, still compressed, in fixed 64 KiB chunk rows.** A
  read pulls only the chunks the object spans, so nothing inflates a whole
  repository. A new read path that widens that span is the regression to avoid.
- **Every allocating path takes a `MemoryReservation`** from `src/memory.ts` and
  disposes it when ownership ends. A query that retains rows without one is
  invisible to the operation's memory budget.
- **One `maintenance()` call advances one bounded durable action.** A
  root-changing transaction bumps the repository epoch; drift restarts at the
  root seam instead of continuing on a stale mark. Sweep eligibility is fixed at
  14 days (`GC_GRACE_MS`) after classification.
- `packs.ts` is derived from dgit (MIT), as are seven files in `src/core/`. Keep
  the attribution header when you edit it.
