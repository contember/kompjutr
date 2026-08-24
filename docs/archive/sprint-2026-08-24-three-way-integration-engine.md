> **OUTCOME — shipped 2026-08-24.** Delivered a mutation-free, bounded
> three-tree integration engine with byte-exact xdiff text merge, structural and
> binary conflict stages, batched loose/packed blob reads, and fail-closed SQL,
> memory, trust, and output gates. Commit map: WU1 → `c4746f0`; WU2 → `cb5e596`
> with trust fix `9951095`; WU3 → `705431c`; WU4 → `aa33001` and `a16a0cd`.
> Verification: `npm run check`; `npm run typecheck`; leased full suite — 75
> files, 1,422 passed, 5 skipped; leased production build. Backlog closed: 02.
> Deferred: public merge lifecycle and physical file/directory conflict
> relocation remain in backlog 19. The 134-statement static ceiling has cold
> loose/packed coverage, but no synthetic 16-batch external-delta-base witness.

# Sprint — Three-way integration engine (2026-08-24)

**Goal.** Deliver a bounded, Git-compatible engine that turns base, current, and
incoming trees into a deterministic integration plan without mutating repository
state.

**Theme.** Merge, stash application, rebase, cherry-pick, and revert all need the
same text and structural conflict semantics. This sprint builds that shared pure
layer once. Success means callers can inspect clean results, conflicts, and index
stages under explicit SQL and memory bounds; command orchestration remains a
separate concern.

Consumed backlog item 02, deleted on ship, and implements
[ADR 0003](../decisions/0003-port-xdiff-text-merge.md).

## Refs re-verified at HEAD (2026-08-24, `5546a94`)

- ✔ The xdiff boundary is already isolated under LGPL-2.1-or-later, but it only
  exposes two-input line diff and unified output today — `src/core/diff/index.ts:1`,
  `src/core/diff/index.ts:8`, `src/core/diff/index.ts:28`.
- ⚠ The current repository diff path decodes blobs as UTF-8 before calling xdiff.
  Three-way merge must not reuse that lossy boundary because Git merges non-NUL
  byte sequences without Unicode replacement — `src/core/ops/diff.ts:109`,
  `src/core/bytes.ts:2`.
- ✔ `joinSorted3` already merges three UTF-8/Git-ordered streams with one item of
  lookahead per side — `src/core/streams.ts:183`, `src/core/streams.ts:193`.
- ✔ `treeStream` exposes non-tree leaves from the authoritative validated tree
  traversal, and each traversal is one lazy SQLite cursor —
  `src/core/ops/tree-stream.ts:8`, `src/core/ops/tree-stream.ts:15`,
  `src/sqlite/tree-walk.ts:660`, `src/sqlite/tree-walk.ts:666`.
- ⚠ Because tree entries are not emitted, file/directory conflicts must be
  recognized from adjacent path prefixes without materializing a directory tree —
  `src/core/ops/tree-stream.ts:8`, `src/sqlite/tree-walk.ts:645`.
- ✔ The SQLite index model already represents stages 1, 2, and 3, scans in
  `(path, stage)` order, and can detect unresolved stages — `src/sqlite/store.ts:117`,
  `src/sqlite/store.ts:2338`, `src/sqlite/store.ts:2414`.
- ✔ Repository blob reads accept an explicit byte budget and return a bounded
  prefix instead of forcing scalar reads per path — `src/core/repository.ts:191`,
  `src/sqlite/store.ts:1187`.
- ✔ The shared operation memory coordinator fails with `E2BIG` above 64 MiB —
  `src/sqlite/memory.ts:3`, `src/sqlite/memory.ts:25`, `src/sqlite/memory.ts:65`.
- ✔ Real-Git fixtures already pin identity and time and expose text and binary
  command output, so differential merge witnesses can use the installed Git
  binary — `tests/helpers/git.ts:18`, `tests/helpers/git.ts:37`,
  `tests/helpers/git.ts:41`.
- ✔ `Git.merge()` is still an explicit unsupported-operation stub. No public
  lifecycle needs backward compatibility in this sprint — `src/git/client.ts:160`,
  `src/git/client.ts:330`.

## Work units

### WU1 — Bounded xdiff text merge (effort L)

- **Problem.** The xdiff module can compare two decoded strings, but it cannot
  combine three byte sequences or emit Git-compatible conflict markers —
  `src/core/diff/index.ts:20`, `src/core/diff/index.ts:28`.
- **Verify first.** Pin the exact upstream Git revision used for `xdiff/xmerge.c`
  and record it in the port header. Before porting, capture a small
  `git merge-file` matrix for clean overlap, refined conflict, each supported
  marker style, CRLF, missing final newline, non-UTF-8 text, and binary input.
- **Scope.** Port `xdiff/xmerge.c` into the existing LGPL directory. Expose a
  byte-oriented API with a discriminated `clean`, `conflict`, or `binary` result.
  Support `merge`, `diff3`, and `zdiff3` markers, configurable labels, conflict
  refinement, CRLF, and missing final newlines. Keep byte records lossless; do
  not decode blob content as UTF-8. Bound each input, line table, change list,
  retained conflict region, label, and output before allocating it. Reject
  structurally unsafe labels and capacity excess with stable codes.
- **Acceptance / witness.** A dedicated differential suite matches
  `git merge-file` byte-for-byte for the controlled matrix. Boundary tests accept
  the exact configured limits and reject the next byte, line, conflict, output,
  or label before allocation. Binary and arbitrary non-UTF-8 fixtures prove that
  the API does not silently replace bytes.
- **Touch points.** `src/core/diff/`, `tests/xmerge.test.ts`,
  `tests/helpers/git.ts`, `src/core/diff/LICENSE`, `LICENSE`.

### WU2 — Pure three-tree structural classifier (effort L)

- **Problem.** The repository has three-stream merge primitives and validated
  tree cursors, but no layer classifies base/current/incoming identities or
  structural conflicts — `src/core/streams.ts:183`,
  `src/core/ops/tree-stream.ts:15`.
- **Verify first.** Build minimal real-Git fixtures and capture final tree/index
  results for unchanged, one-sided, identical, add/add, modify/delete,
  file/directory, executable-bit, symlink, binary, and gitlink cases. Confirm
  that three existing tree cursors preserve ordering, laziness, corruption
  checks, and the statement budget before considering a new SQLite traversal.
- **Scope.** Add a repository-aware but mutation-free classifier in
  `src/core/ops/`. Merge three `treeStream` cursors through `joinSorted3`.
  Represent output as a bounded delta relative to the current tree, not a copy of
  the complete result tree. Use prefix-aware state for file/directory conflicts.
  Resolve identity-only cases without reading blobs. Report renames as delete/add
  and preserve Git path order for every plan entry.
- **Acceptance / witness.** Table-driven fixtures cover every structural case and
  compare the planned clean entries and stages with real Git. File/directory
  fixtures compare logical stage identities but defer Git's label-dependent
  conflict-path relocation. Tests prove Unicode path order, lazy consumption,
  equal-tree pruning at the classifier boundary, prefix-conflict handling,
  deterministic output, and fail-closed corrupt tree rows. The accepted path
  uses at most the three authoritative tree cursors.
- **Touch points.** `src/core/ops/integration.ts`,
  `src/core/ops/tree-stream.ts`, `src/core/streams.ts`,
  `tests/integration-structure.test.ts`, `tests/helpers/git.ts`.

### WU3 — Content resolution and bounded integration plan (effort L)

- **Problem.** Structural identity alone cannot resolve independent text edits,
  and later lifecycle operations need one deterministic result that includes
  clean writes, conflicts, and index stages without performing those writes.
- **Verify first.** Define and test the plan contract using hand-built trees
  before connecting blob reads. Model the conservative peak for three inputs,
  xdiff state, output bytes, paths, entries, stages, and the caller-retained plan
  against the shared 64 MiB coordinator. Prove that blob reads can be batched
  without scalar SQL inside the path loop.
- **Scope.** Batch ordinary-file blob reads under one operation reservation and
  invoke WU1 only for valid three-way text candidates. Reuse existing OIDs for
  identity resolutions; retain bounded merged bytes only when new content is
  required. Emit stages 1/2/3 for unresolved paths, including binary, mode,
  symlink, gitlink, and file/directory conflicts. Account for every retained
  entry and byte. Fail closed on missing objects, wrong object types, corrupt
  rows, reordered batches, oversized expansion, plan cardinality, or SQL-budget
  exhaustion. Do not write objects, refs, index rows, or worktree files.
- **Acceptance / witness.** End-to-end tree fixtures match real Git for clean and
  conflicted multi-file integrations from loose, packed, and mixed sources.
  Tests assert exact stage identities, merged bytes, plan order, statement count,
  memory high-water, and `E2BIG` at the first rejected boundary. A mutation guard
  proves refs, object rows, index rows, and worktree state are unchanged after
  success and every failure class.
- **Touch points.** `src/core/ops/integration.ts`, `src/core/repository.ts`,
  `src/sqlite/store.ts`, `src/sqlite/memory.ts`,
  `tests/integration.test.ts`, `tests/memory.test.ts`, `tests/store.test.ts`.

### WU4 — Adversarial conformance and documentation (effort M)

- **Problem.** The shared engine becomes a trust boundary used by several
  mutating operations. Happy-path parity alone would not prove its corruption,
  allocation, or cost behavior.
- **Verify first.** Inventory every new row field, retained collection, numeric
  counter, byte conversion, and error exit introduced by WU1–WU3. Map each one to
  either an existing validation or a new explicit boundary witness.
- **Scope.** Add adversarial cases for large single lines, repeated regions,
  conflict/output expansion, unsafe labels, Unicode paths, deep prefixes,
  corrupt source projections, missing blobs, invalid modes/OIDs, mixed loose and
  packed provenance, and plan-size exhaustion. Update the xdiff attribution and
  current architecture reference. Keep the public API and README status unchanged
  because `Git.merge()` remains unsupported.
- **Acceptance / witness.** Every accepted edge case matches Git; every rejected
  boundary fails with a stable error before exposing untrusted data or exceeding
  the modeled allocation. `npm run check`, `npm run typecheck`, the full leased
  test suite, and a leased production build pass. The sprint closes only after
  the architecture reference describes the shipped engine and backlog item 02
  is removed.
- **Touch points.** `tests/xmerge.test.ts`, `tests/integration*.test.ts`,
  `tests/reads.test.ts`, `tests/memory.test.ts`, `src/core/diff/LICENSE`,
  `LICENSE`, `docs/reference/architecture.md`, docs indexes.

## Out of scope (explicit)

- Public merge orchestration, merge-base traversal, fast-forward selection,
  merge commits, and continue/abort state shipped in the later
  [merge lifecycle sprint](./sprint-2026-08-24-merge-operation-lifecycle.md).
  This sprint accepts tree OIDs and returns a plan only.
- Fast-forward and divergent pull shipped in the later
  [complete pull sprint](./sprint-2026-08-24-complete-pull.md).
- Stash and rebase remain consumers in
  [backlog item 06](../backlog/06-stash-operations.md) and
  [backlog item 07](../backlog/07-rebase.md). Cherry-pick and revert shipped in
  the later [replay lifecycle sprint](./sprint-2026-08-24-cherry-pick-and-revert.md).
- Rename detection, attributes, custom merge drivers, and submodule checkout are
  follow-on behavior. The initial classifier reports renames as delete/add and
  gitlinks as identities or conflicts only.
- No schema migration, operation-state table, ref update, index mutation,
  worktree mutation, network call, benchmark claim, or public client method ships
  in this sprint.

## Decisions

- Follow [ADR 0003](../decisions/0003-port-xdiff-text-merge.md): port only the
  low-level xdiff text merge; do not port `merge-ort` or add a runtime merge
  dependency.
- Keep the public text-merge boundary byte-oriented. Existing string diff APIs
  remain compatible, but integration never decodes arbitrary blob bytes as UTF-8.
- Return a materialized but strictly bounded delta relative to the current tree.
  This gives the next lifecycle sprint an inspectable atomic input without
  retaining an unchanged repository-sized tree.
- Keep `src/core/diff/` repository-independent. Tree classification and bounded
  object reads belong in `src/core/ops/`.
- Start with three existing authoritative tree cursors joined in TypeScript. Do
  not add a three-tree SQL traversal unless WU2 first demonstrates a correctness
  or budget failure that the current cursors cannot solve; record that drift and
  re-plan before changing the storage architecture.
- Return file/directory conflicts at their logical paths. Git's `~HEAD`/`~branch`
  relocation needs branch labels and collision handling, so backlog item 19 owns
  that lifecycle-specific projection into index and worktree paths.
- Treat expected binary content conflicts as plan results, not exceptions.
  Invalid inputs, corruption, and exceeded structural limits fail with stable
  errors.

## Sequencing

| Order | Work | Dependency |
| --- | --- | --- |
| 1a | WU1 — text merge | Starts immediately. |
| 1b | WU2 — structural classifier | Independent of WU1 after shared result types are fixed. |
| 2 | WU3 — integrated plan | Requires WU1 and WU2. |
| 3 | WU4 — final conformance and docs | Runs throughout, closes after WU3. |

Use targeted tests after each work unit. Before close, run:

```bash
npm run check
npm run typecheck
cpu-lease run -n 2 -- npm test
cpu-lease run -n 2 -- npm run build
```

Do not run or publish a benchmark from this sprint; it changes no wall-time
claim.

## Run log

<!-- Append as you work: discoveries, deviations, blockers. Graduate each entry:
     changed the *why* → ../decisions/NNNN ; new future work → ../backlog/NN ;
     transient → leave it (dies with the sprint on archive). After graduating,
     trim to a one-line pointer ("→ ADR-0007"). -->

- 2026-08-24 — Started WU1 and WU2 in parallel with disjoint write territories;
  WU3 remains the integration seam after both result contracts settle. A third
  read-only pass is independently probing real-Git parity and resource risks.
- 2026-08-24 — ⚠ Real Git relocates the file side of file/directory conflicts to
  a label-derived unique path. The pure tree-OID engine will return logical
  conflict identities; lifecycle projection is now explicit in backlog item 19.
  Also corrected the expected three-tree read cost from three statements to up
  to six because each `treeStream` validates the root before opening its cursor.
- 2026-08-24 — Independent review found and closed three fail-closed gaps:
  reservation coverage before classification, authoritative equal-root source
  validation, and plan-output capacity checks before allocation.
