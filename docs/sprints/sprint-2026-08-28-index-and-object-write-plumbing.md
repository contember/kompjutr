# Sprint — Index and object write plumbing (2026-08-28)

**Goal.** Add bounded tree and commit construction, including an isolated
scratch-index session that can snapshot uncommitted work without changing the
checkout index.

**Theme.** Reuse the existing paged index, tree builder, object batch, and
identity machinery. The public surface gains Git-shaped `readTree`, `writeTree`,
and `commitTree` operations plus one scoped scratch-index session; no operation
materializes a whole index or exposes a filesystem-backed index file.

## Refs re-verified at HEAD (2026-08-28)

Planning was grounded at `12d5268`. `✔` = confirmed live · `⚠` = drift or
missing contract found during planning.

- ✔ The public plumbing surface stops at blob hashing, object reads, raw ref
  reads, and ref writes. `Git` has no tree/index/commit plumbing methods —
  `src/core/ops/plumbing.ts:18`, `src/git/client.ts:224`.
- ⚠ Backlog 43 describes one repository index keyed by `repo_id`; the live
  schema is already multi-checkout and keys `git_index` by `checkout_id`. A
  scratch index therefore belongs to the shared repository and must not borrow
  a checkout identity — `src/sqlite/schema.ts:247`.
- ✔ The checkout index already has bounded keyset scans, buffered mutation
  sinks, and paged replacement. Core staging still calls those methods directly
  through `repo.checkout` — `src/sqlite/store.ts:7795`,
  `src/core/ops/staging.ts:108`.
- ✔ `indexFromTree()` streams stage-zero rows from the parsed tree edge index,
  while `checkoutTree()` can update the worktree but is hard-wired to the
  checkout index — `src/core/ops/checkout.ts:69`,
  `src/core/ops/checkout.ts:647`.
- ✔ The bottom-up tree builder consumes an ordered `Iterable<IndexEntry>` and
  writes through a caller-owned bounded object batch. Its explicit preflight
  validates order, stages, modes, path bytes, object counts, and serialized
  bytes — `src/core/ops/tree-build.ts:521`, `src/core/ops/tree-build.ts:656`.
- ✔ Commit construction already has one unpublished-object seam and one
  identity resolver. They are internal and assume callers supplied valid tree
  and parent objects — `src/core/ops/commit.ts:153`,
  `src/core/ops/commit.ts:278`.
- ✔ Maintenance currently treats only checkout indexes as roots. Any scratch
  rows that can survive a public call would need another durable root source —
  `src/sqlite/maintenance/roots.ts:26`,
  `src/sqlite/maintenance/roots.ts:580`.
- ✔ Schema v1 is the editable development baseline. No compatibility migration
  is required for the new scratch-index tables.

## Work units

### WU0 — Pin the public and Git parity contract (effort M)

- **Problem.** Git's command names hide important edge behavior: missing
  alternate indexes, `read-tree --empty`, `read-tree -u`, unmerged stages,
  parent validation, identity precedence, and exact commit bytes.
- **Verify first.** Ask the installed Git binary for each boundary using pinned
  identities and timestamps. Record only behavior that affects the API or a
  stable error.
- **Scope.** Define top-level `readTree`, `writeTree`, and `commitTree` options.
  Define `withScratchIndex` as a synchronous scoped callback whose handle
  provides `readTree`, `add`, `writeTree`, and `commitTree`. Reject an async
  callback before it can escape the owning transaction. The ordinary methods
  target the checkout index; the scoped methods target only the named scratch
  rows.
- **Acceptance / witness.** Compile-time public-export tests pin every option
  and return type. Real-Git probes pin empty, nested, symlink, gitlink, unmerged,
  and zero/one/two-parent behavior before production code changes.
- **Touch points.** `tests/git-upstream-parity.test.ts`, new plumbing tests,
  `src/git/client.ts`, `src/git/index.ts`, `src/index.ts`.

### WU1 — Add bounded transaction-scoped scratch indexes (effort L)

- **Problem.** Checkout-owned rows cannot represent a throwaway index without
  changing status, commit, and tracker state.
- **Verify first.** Prove that nested `db.transactionSync()` calls join the
  outer transaction and that a thrown or thenable callback leaves no scratch
  rows or objects visible.
- **Scope.** Add repository-scoped scratch-index headers and entries directly to
  schema v1, with bounded UTF-8 names and a fixed simultaneous-session cap. Add
  a shared ordered index interface implemented by both checkout and scratch
  stores. A scratch session creates, uses, and drops its rows inside one
  synchronous outer transaction; rows never become a maintenance root because
  no scratch row commits at the operation boundary.
- **Acceptance / witness.** Same names in different repositories are isolated;
  duplicate/nested sessions respect the cap; throw, thenable return, and SQL
  injection roll back exactly; a cold reopen sees no scratch rows. Maximal scans,
  replacement, and mutation batches remain below 1,000 statements and 64 MiB.
- **Touch points.** `src/sqlite/schema.ts`, `src/sqlite/store.ts`,
  `tests/schema.test.ts`, `tests/store.test.ts`, new plumbing tests.

### WU2 — Make staging and checkout index-selectable (effort L)

- **Problem.** `add()` and `checkoutTree()` call `repo.checkout.index*`
  directly, so the existing bounded algorithms cannot operate on scratch rows.
- **Verify first.** Run the same 513-row interrupted-page and 24,252-row scale
  shapes through the shared index interface.
- **Scope.** Pass an explicit index store through the add and checkout engines;
  keep the checkout store as the default. Scratch staging skips checkout-only
  sparse index accelerators but retains bounded full-scan behavior. `readTree`
  replaces the selected index from a tree or the empty tree. Its update-worktree
  mode uses the selected index for conflict and dirty-state decisions without
  changing the checkout index or resealing the tracker; filesystem triggers
  keep the existing tracker baseline and journal accurate worktree dirtiness.
- **Acceptance / witness.** A scratch `readTree` + `add --all` cycle matches
  Git's alternate-index entries and leaves checkout index bytes, worktree (when
  update is false), tracker, HEAD, refs, and reflogs unchanged. Update-worktree
  parity covers file/symlink transitions, removals, and structural blockers.
- **Touch points.** `src/core/ops/staging.ts`, `src/core/ops/checkout.ts`,
  `src/core/ops/plumbing.ts`, `tests/staging.test.ts`, new plumbing tests.

### WU3 — Expose bounded `writeTree` (effort M)

- **Problem.** Only `commit()` can turn index rows into authoritative tree
  objects, and it also moves HEAD.
- **Verify first.** Compare existing tree-builder output with `git write-tree`
  for checkout and scratch indexes, including an empty tree.
- **Scope.** Preflight a fresh ordered scan, reopen it for bounded object
  materialization, and return only the root OID. Reject every unmerged stage
  before writing an object. Share the existing tree-build limits and object
  batch; add no second encoder.
- **Acceptance / witness.** Exact OID parity for nested files, executable files,
  symlinks, gitlinks, non-BMP names, and empty trees. Corrupt order/mode/OID rows
  and every first-over-limit boundary fail closed with no partial objects.
- **Touch points.** `src/core/ops/plumbing.ts`,
  `src/core/ops/tree-build.ts`, `tests/tree-build-preflight.test.ts`, new
  plumbing tests.

### WU4 — Expose authenticated `commitTree` (effort M)

- **Problem.** The unpublished commit writer is internal and trusts its tree and
  parent inputs because current callers already authenticated them.
- **Verify first.** Pin real Git's missing/wrong-type tree and parent failures,
  duplicate parents, message cleanup, and identity/date precedence.
- **Scope.** Resolve and authenticate one tree and a bounded ordered parent list,
  reuse `resolveIdentity()` and the existing commit serializer, write one commit
  object, and move no ref. Keep exact commit messages where Git plumbing keeps
  them; bound message, identity, parent count, input bytes, and SQL before
  allocation or mutation.
- **Acceptance / witness.** Exact Git OID parity for zero, one, and two parents;
  a merge commit preserves parent order. Missing, corrupt, wrong-type, or
  over-limit inputs write nothing. HEAD, refs, reflogs, all indexes, and the
  worktree remain unchanged after success and failure.
- **Touch points.** `src/core/ops/plumbing.ts`, `src/core/ops/commit.ts`,
  `src/core/objects.ts`, new plumbing tests.

### WU5 — Compose the snapshot workload and close the surface (effort M)

- **Problem.** Isolated operations do not prove the reference workload can
  capture uncommitted work without disturbing the user's staged state.
- **Verify first.** Reproduce the documented sequence against real Git with
  `GIT_INDEX_FILE`, then run the same public kompjutr sequence.
- **Scope.** Add one end-to-end scoped scratch session: read HEAD, stage all
  current work, write the tree, commit it, and return the commit OID while
  transactionally dropping the scratch rows. Export all public types and update
  the support matrix and architecture reference.
- **Acceptance / witness.** The snapshot commit and full reachable tree match
  Git byte for byte. The pre-existing checkout index, worktree, HEAD, refs,
  reflogs, tracker, journals, and maintenance state match their exact pre-call
  snapshots after success, callback failure, and cold reopen. The maximal
  admitted workload stays below 1,000 statements and 64 MiB; full repository
  gates pass.
- **Touch points.** `src/git/client.ts`, `src/git/index.ts`, `src/index.ts`,
  `tests/client.test.ts`, `tests/public-exports.test.ts`, new plumbing tests,
  `docs/reference/git-support.md`, `docs/reference/architecture.md`.

## Out of scope (explicit)

- Patch production and application remain
  [`44`](../backlog/44-patch-interchange.md).
- Extended revision syntax remains
  [`46`](../backlog/46-rev-parse-revision-syntax.md); these operations accept
  only revisions already supported by `Repository.revParse()`.
- General branch/ref plumbing remains
  [`39`](../backlog/39-plumbing-read-surface.md). `commitTree` never updates a
  ref; callers use the existing guarded ref API separately.
- A persistent alternate index, cross-request scratch lease, public binary Git
  index import/export, and a `GIT_INDEX_FILE` path are excluded. The scratch
  index is deliberately scoped to one synchronous database transaction.
- No schema compatibility migration, deploy, release, push, or production probe
  is part of this sprint.

## Decisions

- The checkout index remains the default for top-level `readTree` and
  `writeTree`. Scratch work is explicit through `withScratchIndex`; it cannot be
  selected accidentally by a string option on ordinary commands.
- A scratch callback is synchronous and transaction-scoped. This prevents
  leaked alternate indexes, removes a new maintenance-root class, and makes
  callback failure atomic. Returning a thenable is a stable usage error.
- Checkout and scratch storage share one narrow ordered-index interface. Core
  algorithms receive that interface; `shell` and `fs` gain no dependency on
  Git plumbing.
- `commitTree` writes an authenticated loose commit object and does not publish
  refs or reflogs. This matches Git's plumbing boundary and composes with the
  existing guarded `updateRef` operation.
- Schema changes edit the development-only v1 baseline directly.

## Sequencing

| Wave | Units | Contract |
|---|---|---|
| 0 | WU0 | Serial parity/API gate; settles behavior before storage work. |
| 1 | WU1 | Serial shared index seam and rollback contract. |
| 2 | WU2 | Serial core generalization over the settled index interface. |
| 3 | WU3 + WU4 | Parallel in behavior, integrated serially because both touch plumbing exports. |
| 4 | WU5 | Composed workload, reference refresh, review, and full gates. |

Each work unit receives an atomic semantic commit. Any persistent scratch row,
unbounded index materialization, second tree/commit encoder, or worktree/index
mutation outside the selected index is a stop condition.

## Gates

```bash
GIT_EDITOR=true GIT_SEQUENCE_EDITOR=true cpu-lease run -n 4 -- npm test
cpu-lease run -n 2 -- npm run typecheck
npm run check
cpu-lease run -n 2 -- npm run build
git diff --check
```

## Run log

- 2026-08-28: Planning replaced the backlog's outdated repository-index model
  with the live multi-checkout boundary. Scratch rows are repository-scoped but
  transaction-local; the checkout index and tracker remain separate.
- 2026-08-28: A synchronous scoped callback avoids a persistent alternate-index
  lifecycle and a new maintenance root source. The verify-first Git probes must
  confirm the remaining command semantics before WU1 changes production code.
- 2026-08-28: WU0 pinned real Git behavior for missing and populated alternate
  indexes, empty and mixed-mode trees, unmerged stages, reset-with-update, exact
  commit messages, parent order and deduplication, and wrong-type objects.
- 2026-08-28: WU1 added repository-scoped scratch headers and entries with a
  16-session cap, synchronous scoped handles, bounded 2,048-row scans, shared
  stored-row validation, and rollback-aware object-cache invalidation. A
  24,252-row replace/mutate/scan cycle stayed below 1,000 statements and 1 MiB
  per bound payload while leaving no scratch root or checkout-index mutation.
- 2026-08-28: Independent WU1 review found that a caught nested callback error
  could otherwise commit through the owning outer transaction. A per-database
  poison coordinator now forces the outer rollback across repositories for both
  throws and thenables; the new regression and all 149 focused store/schema
  tests plus 37 commit tests pass.
- 2026-08-28: WU2 made add and checkout operate on either checkout or scratch
  index rows, then added tree-ish and empty `readTree` with transactional
  reset-with-update behavior. Real Git parity covers alternate-index staging,
  annotated tags, file/symlink and file/directory transitions, and exact control
  state isolation. Row, retained-memory, hash, checkout-write, and SQL binding
  limits fail closed before mutation; directory pruning uses bounded scans and
  preflighted bulk removals. Independent review is clean, typecheck and Biome
  pass, and all 119 focused plumbing, staging, worktree, and sparse-checkout
  tests pass.
