# Sprint — Trusted store and domain restructure (2026-08-30)

**Goal.** Adopt the trusted-store contract (ADR-0018), remove the dynamic
memory ledger (ADR-0017), reorganize `src/` into `fs` / `shell` / `git`
domains with bottom-up layers (ADR-0019), and finish the store split the
budget sprint started — with green tests as the only gate.

**Theme.** The archived budget sprint removed invented statement barriers;
this sprint removes the read-time distrust machinery, the byte-accounting
ledger, the scattered validators and path helpers they bred, and the layout
that hid the growth. Cleanup comes first so the restructure moves less code.
The design is fixed in
[`../specs/trusted-domain-architecture.md`](../specs/trusted-domain-architecture.md);
by user direction (2026-08-30) there are no architecture reviews this phase and
the named test commands are the only gates.

## Refs re-verified at HEAD (2026-08-30)

Grounding at `4e4f1e0`; the archived sprint's WU7 facade split landed during
planning as `e6b9287` + `59d8438`.

- ✔ `src/sqlite/store.ts` is now a re-export facade (79 lines) over
  `src/sqlite/store/{contracts,database,shared,checkout}.ts` (landed
  `e6b9287`); the pre-split line references below cite `4e4f1e0`.
- ✔ Confirmed regression at HEAD (runtime witness, 2026-08-30): `worktreeAdd`
  then `worktreeRemove`, then `git.add`/`commit` in the primary checkout throws
  `EWORKTREENOTFOUND` ("checkout is no longer active"). Cause: repo-scoped
  owned seams rebind last-wins in the `CheckoutStore` constructor
  (`store.ts:6314-6319` at HEAD), `openCheckout` caches (`store.ts:5808`), and
  `#evictCheckout` revokes without rebinding (`store.ts:5918-5922`).
- ✔ Read-time distrust machinery is pervasive: SQL `typeof` witnesses +
  `CAST(... AS BLOB)` canonical reads + two-phase preflights (draft
  `store/checkout.ts:5588-5640` as one instance of the pattern), pack
  publication re-read audit (`packs.ts:3875-3901`), deletion re-hash audits,
  five hand-rolled maintenance run-row readers
  (`maintenance/{state,roots,reachability,repack,sweep}.ts`).
- ✔ The dynamic memory ledger threads through most Git-side signatures:
  `src/memory.ts` (`MemoryCoordinator`/`MemoryReservation`, scopes, transfer,
  `ownsMemoryReservation` checks), `TransportOperationBudget`
  (`src/core/ops/transport-budget.ts`), and hand-computed size constants
  (e.g. the `PACK_PAGER_*` set, `packs.ts:108-117`). Leased cgroup memory
  scenarios exist in `bench/` since WU6g of the archived sprint.
- ✔ `store.ts:32-51` imports journal codecs from `core/ops/merge-state.js` and
  `core/ops/operation-state.js` — the store↔ops value cycle the layer rules
  must break.
- ✔ Files over the 2,000-line ceiling at HEAD: `store.ts` (12,971, superseded
  by the draft), `packs.ts` (5,583), `sparse-workspace.ts` (3,537),
  `core/ops/staging.ts` (2,481); the draft `store/checkout.ts` also exceeds it.
- ✔ Inline `unknown` option decoding and local path helpers are scattered
  through ops (`lsFilesExcludeRoots`, `staging.ts:2159`, and path-ish helpers
  in ~14 ops files).

## Policy contract

1. **No architecture review this phase** (user direction 2026-08-30). The spec
   and ADRs are authoritative as written; every gate below is a test command.
2. **Public exports are byte-stable** (`tests/public-exports.test.ts`), with
   one deliberate exception: types that exist only to carry the deleted memory
   ledger disappear with it — every removal is listed in the OUTCOME.
   Everything internal may change, including SQL text, schema shape, and
   transaction internals. This supersedes the archived sprint's frozen
   pure-move contract.
3. **ADR-0018 governs checks.** No new read-time re-authentication; remaining
   checks go through the shared guard/decoder kit; a new multi-operand
   `typeof` chain or SQL `typeof` witness is rejected on sight.
4. **ADR-0017 governs cost.** No invented runtime currency — statements or
   bytes. Structural caps survive only when they name a real failure.
5. **ADR-0019 governs structure.** Layer order and the 2,000-line ceiling
   become suite witnesses inside this sprint and stay green afterward.
6. **Unchanged models:** concurrency seams (epochs, leases, CAS, provisional
   states), row ownership (ADR-0009).

## Work units

### WU1 — Verify the landed facade baseline (effort S)

- **Problem.** The facade split landed at the end of the archived sprint
  (`e6b9287`) without its closure gates; the successor builds on it and must
  know the base is sound.
- **Verify first.** `git log` confirms the split commits; skim the module
  boundaries against the spec's store layout.
- **Scope.** Run the gates; repair forward only if one fails. No new behavior.
- **Acceptance / witness.** `tests/public-exports.test.ts` unchanged from
  `4e4f1e0`; `npm run typecheck`, `npm run check`, `npm test` green.
- **Touch points.** none expected; `src/sqlite/store/*` only on a failure.

### WU2 — Fix the owned-seam eviction regression (effort S)

- **Problem.** The confirmed `worktreeRemove` regression above; a live
  user-visible defect that also blocks trusting the seam during later moves.
- **Verify first.** Reproduce with the witness scenario (worktreeAdd →
  worktreeRemove → add/commit in the primary).
- **Scope.** Bind repo-scoped owned dispatch to one fixed owner (shared store /
  primary), remove the last-wins rebinding; add the regression test.
- **Acceptance / witness.** New regression test green; worktree, commit, and
  merge suites green; `npm test` green.
- **Touch points.** `src/sqlite/store/{shared,checkout}.ts`, new test in
  `tests/worktrees.test.ts`.

### WU3 — Shared guards, decoders, and path kit (effort M)

- **Problem.** Row decoding, `unknown` option handling, and path helpers are
  hand-rolled per site (five-operand `if` chains, `Reflect.get` loops, local
  path functions in ~14 ops files).
- **Verify first.** Inventory the recurring shapes (text/int/blob row fields,
  string-array options, root/ancestor path logic) before writing the kit.
- **Scope.** Add the guard/decoder kit and consolidate Git-side path utilities
  per the spec ("Design style" + "Shared kits") — fundamental structures as
  classes where behavior belongs with the data (path, ref name, decoded row),
  not free functions over `unknown`. Convert a representative first slice
  (`staging.ts` options, one store family) to prove the shapes; full
  conversion happens inside WU5–WU7 as those files are touched.
- **Acceptance / witness.** Kit unit tests green; converted slice suites
  green; `npm run typecheck`; `npm test`.
- **Touch points.** `src/core/` (kit location pre-move), `src/core/ops/staging.ts`,
  one store family, new focused tests.

### WU4 — Remove the dynamic memory ledger (effort L)

- **Problem.** Reservation plumbing threads through most Git-side signatures
  while the real OOM protection is structural (streaming cursors, fixed batch
  and cache sizes); the ledger is hand-computed precision theater with a high
  review cost (ADR-0017).
- **Verify first.** Inventory every `MemoryReservation`/`MemoryCoordinator`
  parameter, `ownsMemoryReservation` check, and size-model constant; classify
  the caps they carry — structural (stays, moved next to its seam) versus
  ledger-only (goes).
- **Scope.** Delete `src/memory.ts`, `TransportOperationBudget`, reservation
  parameters, ownership checks, and size-model constants. Keep structural
  caps in place with named owners. Update tests: ledger-accounting assertions
  are deleted; structural-cap boundary tests stay.
- **Acceptance / witness.** `npm run typecheck` and `npm test` green; the
  leased cgroup memory scenarios in `bench/` still pass under the 512 MiB
  cgroup with peaks recorded in the run log; removed public types listed for
  the OUTCOME.
- **Touch points.** `src/memory.ts` (deleted), `src/core/ops/transport-budget.ts`
  (deleted), signatures across `src/core/` and `src/sqlite/`, `tests/memory.test.ts`,
  `bench/`.

### WU5 — Trust the store: row reads (effort L)

- **Problem.** Refs, reflogs, config, shallow, tracking, checkouts, blob-ids,
  and index reads re-prove storage classes and canonical bytes on every read.
- **Verify first.** List every `typeof(` / `CAST(... AS BLOB)` / two-phase
  read site in the store families.
- **Scope.** Single-read row access through the shared decoders; delete the
  SQL witnesses, canonical-text dance, and two-phase preflights; delete or
  convert the corruption-injection tests for these paths per ADR-0018.
- **Acceptance / witness.** Store, reflog, config, fetch-publication, and
  concurrency suites green; `npm test` green.
- **Touch points.** `src/sqlite/store/*.ts`, `src/sqlite/{ref-validation,reflog-schema}.ts`,
  matching tests.

### WU6 — Trust the store: projections and traversal (effort L)

- **Problem.** Tree and commit projections re-authenticate against
  authoritative objects at read time; SQL stream order is re-validated in JS.
- **Verify first.** Pin which guards are termination/cycle protection (keep)
  versus re-authentication (delete) in `tree-walk.ts`, `tree-index.ts`,
  `commits.ts`.
- **Scope.** Trust projection rows; keep source-surrogate keying, shadowing,
  and cycle/termination guards; drop order re-validation and cross-field
  witnesses (ADR-0007 as rewritten).
- **Acceptance / witness.** Tree, commit-cache, log, status, and diff suites
  green; `npm test` green.
- **Touch points.** `src/sqlite/{tree-index,tree-walk,commits}.ts`, matching
  tests.

### WU7 — Trust the store: packs and maintenance (effort L)

- **Problem.** Pack publication re-reads and re-inflates the whole pack inside
  its transaction; deletion re-hashes promoted objects; maintenance validates
  the same run row five different ways and re-audits whole sets per call.
- **Verify first.** Pin the parse-time digest path so publication can rely on
  it; pin the structural delta-closure check that stays.
- **Scope.** Publish from parse-time digests; reduce deletion to the
  structural closure check; one shared run-row reader and chunk predicate;
  drop whole-set re-validation in sweep/classify. Leases, epochs, grace, and
  provisional gating unchanged.
- **Acceptance / witness.** Pack, ingest, maintenance, and concurrency suites
  green; `npm test` green; one informative leased `bench:nextjs` clone row
  recorded in the run log.
- **Touch points.** `src/sqlite/packs.ts`, `src/sqlite/maintenance/*.ts`,
  matching tests.

### WU8 — Domain restructure (effort M)

- **Problem.** `core/` and `sqlite/` sit beside real domains; the store↔ops
  value cycle contradicts any layer story.
- **Verify first.** Snapshot public exports; script the import rewrite before
  moving.
- **Scope.** `git mv` per the spec mapping; journal codecs and contracts move
  into `store/`; add the import-graph witness; move module `CLAUDE.md` files
  with their directories (content rewrite lands in WU11).
- **Acceptance / witness.** Import-graph witness green;
  `tests/public-exports.test.ts` unchanged; `npm run typecheck`, `npm run check`,
  `npm test` green.
- **Touch points.** `src/` tree-wide moves, `tsconfig*`, `bench/` imports,
  test imports.

### WU9 — File ceiling (effort M)

- **Problem.** `packs.ts`, `sparse-workspace.ts`, `staging.ts`, and the drafted
  checkout family exceed 2,000 lines.
- **Verify first.** Line-count inventory after WU4–WU8 deletions and moves —
  split only what still exceeds the ceiling.
- **Scope.** Split remaining offenders along the seams named in the spec; add
  the file-ceiling witness test.
- **Acceptance / witness.** Ceiling witness green over `src/`; the split
  files' focused suites green; `npm test` green.
- **Touch points.** `src/git/store/pack/*`, `src/git/ops/*`, new witness test.

### WU10 — Finish the family extraction (effort L)

- **Problem.** The archived sprint's WU8–WU10 goals — objects, refs/reflogs,
  config, index, checkout state, operation journals as separate store modules —
  remain undone; the checkout family still implements most of the store.
- **Verify first.** Family-by-family method inventory of the drafted
  `store/checkout.ts`.
- **Scope.** Extract the families behind the unchanged public facade,
  repo-scoped ownership on the shared side per the spec. Simpler than the
  original plan because WU4–WU7 already deleted the validation and ledger mass.
- **Acceptance / witness.** Family-focused suites green in bounded groups;
  public exports unchanged (modulo the WU4 removals); ceiling and import-graph
  witnesses green; `npm test` green.
- **Touch points.** `src/git/store/*.ts`, matching tests.

### WU11 — Docs and closure (effort S)

- **Problem.** Reference and module docs describe the superseded trust model,
  memory ledger, and layout.
- **Verify first.** Grep reference and `CLAUDE.md` files for the deleted
  checks, old paths, and stale numbers (e.g. the 64 KiB pack-chunk claim —
  code stores 1 MiB rows).
- **Scope.** Rewrite `docs/reference/architecture.md`, root and module
  `CLAUDE.md` files, `docs/INDEX.md`; stamp OUTCOME and archive this sprint.
- **Acceptance / witness.** Closure gate below green; docs lint clean;
  INDEX/README indexes current.
- **Touch points.** `docs/`, root `CLAUDE.md`, `src/**/CLAUDE.md`.

## Review strategy

By user direction (2026-08-30) this sprint runs without architecture or
independent code review. The gate for every WU is its named test commands; the
integration gate is the closure run below. A WU that cannot make its witness
green stops and records the blocker in the run log instead of weakening the
witness.

| Scope | Gate |
|---|---|
| Sprint integration | `npm run typecheck` · `npm run check` · `npm run build` · `npm test` · `npm run test:full` · Git parity (`tests/git-upstream-parity.test.ts`) · fs conformance (`tests/fs/conformance`) · `npm run package:smoke` |
| Each WU | The acceptance witnesses named in the WU + `npm test` |

## Test cadence

- **Per WU.** Exact named witnesses, split to stay under 30 s per command;
  `npm test` after each landed WU.
- **Benchmarks.** Informative only this sprint. The leased cgroup memory
  scenarios after WU4; one leased clone row after WU7 (expected to improve);
  a final leased `bench:nextjs` comparison at closure, recorded without gating.
- **Sprint closure.** The integration gate above, `test:full` once under a
  two-vCPU lease.
- **Failure loop.** Reproduce with the exact file/domain slice; rerun the full
  suite only after the focused witness is stable.

## Out of scope (explicit)

- The opt-in integrity audit
  ([backlog 17](../backlog/17-integrity-audit-and-snapshots.md)) — ADR-0018
  names it as the corruption-detection home; implementing it is its own item.
- Partial clone and Phase 2 items — unchanged sequencing after this cleanup.
- Extreme packed-graph scaling
  ([backlog 63](../backlog/63-bound-packed-dependency-graph-traversal.md)).
- The compat adapter surface and semantics.
- Any schema migration machinery — schema edits stay in-place (no production
  users).

## Decisions

- [ADR-0018](../decisions/0018-trust-stored-rows-validate-at-the-boundary.md) —
  trust stored rows, validate at the boundary; opt-in audit.
- [ADR-0017](../decisions/0017-measure-query-cost-and-bound-real-failures.md)
  (rewritten 2026-08-30) — no invented runtime currency; structural caps +
  benchmark evidence replace the byte ledger.
- [ADR-0019](../decisions/0019-organize-source-by-domain-with-bottom-up-layers.md) —
  domain layout, bottom-up layers, 2,000-line ceiling, witness enforcement.
- Backlog 60 deleted: its statement-budget half shipped with the archived
  sprint; its store-split half is WU10 here. Backlog 64 deleted: its hardening
  direction is rejected by ADR-0018.
- The archived sprint's WU7 draft is salvaged (WU1), not discarded.

## Sequencing

WU1 → WU2 → WU3 → WU4 → (WU5 ‖ WU6 ‖ WU7, disjoint files) → WU8 → WU9 →
WU10 → WU11. Cleanup (WU4–WU7) deliberately precedes the move (WU8) so the
restructure moves less code; splits (WU9–WU10) follow the move so they happen
at final paths.

## Plan review

Waived by user direction (2026-08-30): no architecture reviews this phase; the
spec and this plan are authoritative; tests are the only gate.

- **Reviewer:** waived
- **Verdict:** authoritative by user direction
- **Material findings:** —

## Run log

<!-- Append as you work: discoveries, deviations, blockers. Graduate each entry:
     changed the *why* → ../decisions/NNNN ; new future work → ../backlog/NN ;
     transient → leave it (dies with the sprint on archive). -->
