# Sprint — Snapshot replay and guarded refs (2026-08-28)

**Goal.** Complete the local checkpoint restore cycle with bounded revision
resolution, guarded ref publication, recursive tree inspection, and an
index-only replay of one snapshot commit onto a new tip.

**Theme.** The snapshot is already a normal one-parent commit. Reuse the
authenticated replay planner and the transaction-scoped scratch index instead
of implementing textual patch transport. Read-only plumbing establishes the
inputs; one guarded ref mutation publishes the result only when the observed
ref has not moved.

## Refs re-verified at HEAD (2026-08-28)

Planning was grounded at `3bdb14d`. `✔` = confirmed live · `⚠` = drift or
missing contract found during planning.

- ✔ `Repository.revParse()` bounds the whole expression and 32 parent
  traversals, but its suffix parser accepts only numeric `^`/`~` forms and has
  no path or quiet result — `src/core/repository.ts:334`.
- ✔ `lsTree()` resolves one optional path and materialises only one tree level;
  `Repository.walkTree()` already supplies a bounded recursive cursor used by
  `lsFilesAtRef()` — `src/core/ops/reads.ts:78`, `src/core/ops/reads.ts:115`.
- ✔ `selectMergeBases()` already authenticates two commit roots, walks the
  bounded indexed graph, reports unrelated/shallow histories, and returns all
  best bases deterministically — `src/core/ops/merge-base.ts:323`.
- ✔ `updateRef()` still exposes create/force only, while the store mutation seam
  already supports one expected direct target and deletion with reflog metadata
  — `src/core/ops/plumbing.ts:422`, `src/sqlite/store.ts:5601`.
- ✔ A snapshot commit is exactly the existing replay planner's cherry-pick
  input: its selected parent is the base tree, the snapshot tree is incoming,
  and the new tip is current — `src/core/ops/replay.ts:433`.
- ⚠ Merge application writes only through `repo.checkout`; the shared
  `IndexStore` contract can mutate a scratch index, but there is no index-only
  applicator for projected content blobs and stage-zero entries —
  `src/core/ops/merge-apply.ts:840`, `src/sqlite/store.ts:1917`.
- ✔ The public scratch handle is synchronous, transaction-owned, and currently
  exposes only `readTree`, `add`, `writeTree`, and `commitTree`; extending that
  handle preserves the existing no-escape boundary — `src/git/client.ts:236`.

## Work units

### WU0 — Pin checkpoint plumbing against real Git (effort M)

- **Problem.** The backlog names Git spellings but leaves several API-shaping
  boundaries open: typed peel failures, path modes, quiet absence, guarded
  deletion, multiple merge bases, recursive tree output, and conflict results.
- **Verify first.** Build disposable real-Git histories and record stdout,
  object ids, index stages, ref outcomes, and exit status for each boundary.
- **Scope.** Add one focused contract test that fixes: `^{}`, typed peel and
  chained suffix semantics; `<rev>:<path>` for blobs and directories;
  verify/quiet absence; `update-ref` create, guarded replace, guarded delete,
  stale and missing cases; `merge-base --all`; `ls-tree -r` including gitlinks;
  and clean/conflicted snapshot replay through real `read-tree` plus
  `apply --3way --cached`. Include Git's zero-oid command spelling only as
  translation evidence; the public API uses `null` for an expected-absent ref.
  Record the proposed API cases as test-local inputs and expected results; each
  implementation WU pins its own public types when that surface exists. WU0
  contains external Git probes only, not speculative product types.
- **Acceptance / witness.** The Git probe passes deterministically across two
  runs without importing production implementations that do not exist yet.
- **Touch points.** `tests/checkpoint-contract.test.ts`, `tests/helpers/git.ts`.

### WU1 — Resolve typed revisions, paths, and quiet absence (effort L)

- **Problem.** The current parser treats `^{tree}` as a parent suffix followed
  by junk, and only `catFile()` understands `:<path>` after the caller has
  chosen a materialising read.
- **Verify first.** Run the WU0 peel/path matrix against the current parser and
  classify semantic absence separately from corrupt or missing referenced
  objects.
- **Scope.** Refactor one bounded revision parser to produce a structured
  resolution carrying the oid and optional tree-entry mode. Add `^{}`,
  `^{commit}`, `^{tree}`, `^{blob}`, `^{tag}`, and one trailing `:<path>` while
  retaining the 1,024-unit and 32-traversal caps. Keep `revParse()` returning
  the oid. Add `tryRevParse()` with the same string result and `undefined` only
  for semantic absence. Semantic absence is an unknown input ref/name or
  abbreviated oid, an absent object when a directly supplied full oid must be
  read, or a missing `:<path>` entry including a non-tree intermediate
  component. Match Git by returning a bare, syntactically valid full oid
  unchanged even when no object exists; typed peel, parent, or path syntax then
  requires the object. Malformed syntax, typed-peel mismatch, and every
  structural-limit failure still throw. A dangling ref, missing tag target,
  missing traversed parent or commit tree, missing final tree-entry object, or
  malformed authoritative/derived object data also throws because stored state
  promised that object. Authenticate the final path object against its mode
  before returning. Route the native facade through the same resolver; keep
  Computer's existing `revParse()` return contract.
- **Acceptance / witness.** Real-Git oid parity covers annotated and lightweight
  tags, commits, trees, blobs, directories, chained suffixes, mismatches,
  absent paths, exact bounds, and corrupt object sources. Quiet lookup changes
  only absence into `undefined`.
- **Touch points.** `src/core/repository.ts`, `src/core/ops/reads.ts`,
  `src/git/client.ts`, `src/git/index.ts`, `src/index.ts`,
  `tests/reads.test.ts`, `tests/client.test.ts`,
  `tests/checkpoint-contract.test.ts`, `tests/public-exports.test.ts`.

### WU2 — Publish and delete refs with an expected old value (effort M)

- **Problem.** Public `updateRef()` cannot express the checkpoint publisher's
  compare-and-set or guarded rollback even though `RefMutation.expected`
  already makes both atomic in storage.
- **Verify first.** Compare the WU0 ref matrix with current create/force
  behavior and with the low-level expected mutation seam, including reflogs and
  linked checkouts.
- **Scope.** Make `UpdateRefOptions` a validated legacy-write versus
  direct-update/direct-delete union. Unguarded legacy writes retain current
  `HEAD`, symbolic, `force`, and direct-ref behavior. Delete accepts only a full
  `refs/...` name. A guarded update/delete also accepts only a full `refs/...`
  name, rejects `HEAD`, `symbolic`, and `force`, requires a direct new oid for
  update, and uses `expected: string | null`, where `null` means the raw ref row
  must be absent. The guard compares the raw direct `git_refs` target without
  dereferencing; an existing symbolic target cannot match an oid guard and
  fails with `ESTALEHEAD`. Never expose Git's zero oid as the absence sentinel
  and do not emulate batch stdin. Apply the mutation once through
  `Repository.mutateRefs()` so target, expectation, deletion, and reflog are
  atomic. Thread the compatible subset through both facades.
- **Acceptance / witness.** Git parity covers successful and stale guarded
  update/delete, absent deletion, symbolic and detached HEAD boundaries, cold
  reopen, reflog endpoints, rollback, and no partial mutation. Existing
  create/force callers remain green.
- **Touch points.** `src/core/ops/plumbing.ts`, `src/git/client.ts`,
  `src/compat/computer/client.ts`, `tests/refs.test.ts`, `tests/compat.test.ts`,
  `tests/reflog-operations.test.ts`, `tests/client.test.ts`,
  `tests/checkpoint-contract.test.ts`, `tests/public-exports.test.ts`.

### WU3 — Expose bounded merge bases and recursive tree entries (effort M)

- **Problem.** The facade hides the existing merge-base selector, and
  `lsTree()` cannot return recursive mode/oid entries needed to reject gitlinks
  before replay.
- **Verify first.** Confirm the WU0 output for multiple best bases, unrelated
  and shallow histories, subdirectory recursion, and gitlinks.
- **Scope.** Add `mergeBase({ current, incoming })` returning every best base;
  return the existing `{ kind, bases }` distinction so empty shallow and
  unrelated results remain distinguishable without weakening the existing
  graph limits. Extend `lsTree()` with an explicit recursive option that
  streams the existing validated tree cursor into `TreeEntryView` rows in Git
  path order. Bound the materialised result to 10,000 rows and 16 MiB retained,
  charging `256 + path.length * 2` bytes before each append; the exact boundary
  succeeds and the first excess throws `E2BIG` without truncation. Keep the
  default one-level behavior unchanged. Export and expose both through the
  native facade; pass the compatible `lsTree` option through the Computer
  adapter.
- **Acceptance / witness.** Real-Git parity covers criss-cross best bases,
  diverged/unrelated/shallow histories, nested path prefixes, modes, non-BMP
  ordering, gitlinks, row/byte limits, malformed derived rows, and cold reopen.
  Instrumentation proves the recursive tree cursor uses one SQL statement.
- **Touch points.** `src/core/ops/merge-base.ts`, `src/core/ops/reads.ts`,
  `src/git/client.ts`, `src/compat/computer/client.ts`, `src/git/index.ts`,
  `src/index.ts`, `tests/divergence.test.ts`, `tests/merge-base.test.ts`,
  `tests/reads.test.ts`, `tests/client.test.ts`, `tests/compat.test.ts`,
  `tests/public-exports.test.ts`.

### WU4 — Replay one snapshot into a scratch index (effort L)

- **Problem.** The replay planner can compute the exact three-way delta, but
  its applicator is coupled to checkout worktree and operation-journal state.
- **Verify first.** Prove that the WU0 snapshot commit produces the same
  `planReplay(kind: "cherry-pick")` base/current/incoming trees as real Git's
  patch round-trip.
- **Scope.** Add one index-only applicator over `IndexStore`. It validates the
  snapshot as exactly one-parent and validates the full replay plan and gitlink
  prohibition before writing; root and merge snapshots are rejected with
  `EINVAL`. A conflict returns ordered path/kind/stage data and leaves the
  selected index and object store unchanged. A clean plan atomically seeds the
  selected scratch index from the new tip, writes authenticated merged blobs,
  applies only stage-zero entries, writes the bounded result tree, and returns
  its oid. Expose this as
  `scratch.replaySnapshot({ snapshot, onto })`; never touch the worktree,
  checkout index, HEAD, refs, reflogs, tracker, or operation journal.
- **Acceptance / witness.** The result tree equals real Git for clean text,
  binary, mode, rename-shaped add/delete, add, and delete cases. Conflicts match
  Git stages and write nothing. Gitlinks, corrupt objects, stale derived rows,
  oversized plans, SQL/memory boundaries, callback failure, and cold reopen all
  fail closed or preserve state exactly as declared.
- **Touch points.** `src/core/ops/replay.ts`,
  `src/core/ops/integration-worktree.ts`, `src/core/ops/merge-apply.ts`,
  `src/core/ops/plumbing.ts`, `src/git/client.ts`, `src/git/index.ts`,
  `src/index.ts`, `tests/snapshot-replay.test.ts`, `tests/replay.test.ts`,
  `tests/integration.test.ts`, `tests/merge-apply.test.ts`,
  `tests/plumbing-write.test.ts`, `tests/client.test.ts`,
  `tests/public-exports.test.ts`.

### WU5 — Compose the checkpoint restore contract (effort M)

- **Problem.** Individual methods do not prove that the consumer can inspect,
  replay, apply, and conditionally publish a checkpoint without leaking scratch
  or control state.
- **Verify first.** Re-read the public call sequence and every state component
  preserved by the shipped snapshot facade.
- **Scope.** Through the public client: resolve and quiet-probe the snapshot,
  recursively reject gitlinks, find the merge base, replay through one scratch
  callback, apply a clean tree with top-level `readTree({ updateWorktree: true })`,
  and publish with expected-old `updateRef()`. Cover the conflict return without
  checkout mutation and a ref race after replay. The public calls are not one
  transaction: if the ref changes after the tree is applied, `updateRef()`
  throws `ESTALEHEAD`; the checkout index, worktree, and tracker retain the
  replayed tree, HEAD retains its raw target, the ref retains the rival oid,
  the failed publisher adds no reflog row, replay-created objects remain, the
  scratch rows are cleaned up, and operation-journal state is unchanged. The
  caller must resynchronise or retry from that explicit dirty state. Refresh
  public exports and the current Git-support/architecture reference with this
  non-atomic composition contract.
- **Acceptance / witness.** One consumer-shaped test matches real Git's final
  tree and ref, proves a stale publisher loses without overwriting, and proves
  clean, conflict, throw, and cold-reopen outcomes for scratch rows, objects,
  checkout index, worktree, HEAD, refs, reflogs, tracker, and journal.
- **Touch points.** `src/git/client.ts`, `src/git/index.ts`, `src/index.ts`,
  `tests/client.test.ts`, `tests/snapshot-replay.test.ts`,
  `tests/public-exports.test.ts`, `docs/reference/git-support.md`,
  `docs/reference/architecture.md`.

## Review strategy

The sprint combines read-only plumbing with two state-sensitive seams. Review
depth follows the actual mutation risk; a tier label is only a summary.

| Scope | Tier and rationale | Required gate and review | Escalate when |
|---|---|---|---|
| Sprint integration | T3 — scratch object writes, checkout application, and guarded ref publication compose one checkpoint cycle | After WU5, one independent review receives the complete WU1-WU5 diff and returns separate replay, facade, and integration verdicts. Settled internals are not reopened unless their public contracts fail in the composed state or atomicity proof. Fix material findings and repeat only the affected portion until clean, then run closure gates. | Any result can mutate a ref, checkout/worktree, durable object, or journal outside its declared success state. |
| WU0 | T1 — external Git probes only | Run the exact Git witness twice; no independent implementation review. | A probe forces a product-semantic choice not settled by Git or the workload. |
| WU1 | T2 — bounded read-only parser and facade | Run the exact witness and root-inspect grammar, typed peeling, absence classification, and bounds; no independent review. | Parsing bypasses authoritative reads, widens a structural bound, or changes existing expressions. |
| WU2 | T3 — durable conditional ref mutation and reflog | Run the exact witness, then independently review validation, stale guards, HEAD/symbolic behavior, atomicity, and reflogs. Fix and re-review until clean. | More than one ref, a remote ref, or checkout ownership enters the mutation. |
| WU3 | T2 — facade over existing bounded read cursors | Run the exact witness and root-inspect ordering, limits, and export shape; no independent review. | A new graph/tree algorithm, materialised unbounded result, or stored-data trust change appears. |
| WU4 | T3 — new object-writing path over transient index state | Run the exact witness, then independently review no-write conflicts, object trust, selected-index isolation, rollback, and SQL/memory bounds. Fix and re-review until clean. | Conflict state persists, worktree/control state changes, or an existing merge/replay seam changes behavior. |
| WU5 | T2 — public composition over reviewed seams | Run the exact witness. The sprint integration review covers the facade and references once; repeat only if a fix changes the public contract. | The composition adds another mutation seam or weakens WU2/WU4 guarantees. |

Exact focused witnesses:

```bash
# WU0
npx vitest run tests/checkpoint-contract.test.ts

# WU1
npx vitest run tests/checkpoint-contract.test.ts tests/reads.test.ts tests/client.test.ts tests/public-exports.test.ts

# WU2
npx vitest run tests/checkpoint-contract.test.ts tests/refs.test.ts tests/reflog-operations.test.ts tests/client.test.ts tests/compat.test.ts tests/public-exports.test.ts

# WU3
npx vitest run tests/checkpoint-contract.test.ts tests/reads.test.ts tests/divergence.test.ts tests/merge-base.test.ts tests/client.test.ts tests/compat.test.ts tests/public-exports.test.ts

# WU4
npx vitest run tests/snapshot-replay.test.ts tests/replay.test.ts tests/integration.test.ts tests/merge-apply.test.ts tests/plumbing-write.test.ts tests/client.test.ts tests/public-exports.test.ts

# WU5
npx vitest run tests/checkpoint-contract.test.ts tests/snapshot-replay.test.ts tests/client.test.ts tests/public-exports.test.ts
```

## Test cadence

- **Per WU.** Run only the exact focused witness above while iterating.
- **Routine integration.** Run `npm test` after WU5; keep the smoke gate below
  30 seconds.
- **Sprint closure.** Run `npm run test:full` once after final review and
  focused fixes have settled.
- **Failure loop.** Reproduce a full-suite failure with its exact file. Rerun
  the exhaustive suite only after the focused witness is stable.

## Out of scope (explicit)

- Textual patch output/parsing and general `apply`; backlog 44 retains that
  deferred half until a patch must cross a process boundary.
- `catFile` type/size probes, tree/blob filters, `forEachRef`, and `revList` from
  the no-caller remainder of backlog 39.
- Revision ranges, arbitrary reflog selectors, `@{upstream}`, date selectors,
  and search syntax.
- Persistent scratch conflicts or a generic alternate-index handle outside the
  synchronous callback.
- Multi-ref/atomic push, wildcard fetch, and remote ref discovery; backlog 08
  and 42 own transport.

## Decisions

- Snapshot replay is an index-only cherry-pick of the snapshot commit, not a
  patch format implementation.
- Conflicted replay is observational: return ordered conflict stages and write
  nothing because scratch state cannot outlive its callback.
- Existing `revParse()` keeps its string return. One structured internal
  resolver carries path mode; `tryRevParse()` adds non-throwing absence without
  weakening corrupt-object failures.
- Public merge-base returns every best base so deterministic callers never
  depend on Git's unspecified single-base choice.
- Guarded ref mutation remains a single-ref local transaction. Transport batch
  semantics stay in backlog 08.
- Guarded ref absence is `null`, not a Git zero oid. Guards never dereference a
  symbolic target and never operate on `HEAD`.
- Recursive `lsTree()` materialises at most 10,000 rows and 16 MiB of charged
  result state; its underlying traversal remains one SQL cursor.
- Applying the replayed tree and publishing a guarded ref are deliberately two
  public transactions. A stale publisher leaves the declared dirty checkout
  state for caller-directed resynchronisation; it never rolls back a rival ref.

## Sequencing

| Wave | Units | Contract |
|---|---|---|
| 0 | WU0 | Serial external-behavior gate. |
| 1 | WU1 + WU2 | Behaviorally independent; integrate serially because both touch the client facade. |
| 2 | WU3 | Read-surface exports after revision shape settles. |
| 3 | WU4 | Index-only replay over the settled scratch and replay seams. |
| 4 | WU5 | Consumer-shaped composition, references, integration review, and closure gates. |

Each WU receives an atomic semantic commit. Any unbounded traversal, swallowed
corruption, persisted conflict scratch state, checkout mutation during replay,
or unguarded ref overwrite is a stop condition.

## Plan review

An independent reviewer checks the complete proposal against HEAD, including
grounding, WU boundaries, acceptance witnesses, test cadence, and whether each
review gate is proportionate to scope and blast radius. Blocking findings are
resolved before implementation.

- **Reviewer:** Singer (independent)
- **Verdict:** approved after one revision round
- **Material findings:** The first review blocked on ambiguous guarded-ref and
  quiet-resolution contracts, missing recursive result bounds, undefined stale
  publication state, incomplete integration-review scope, witness gaps, and
  unsupported snapshot parent shapes. The revised plan resolves each item with
  an exact contract and no material findings remain.

## Run log

<!-- Append discoveries, deviations, and blockers. Graduate durable entries to
     decisions or backlog; leave transient evidence here for the archive. -->

- WU0 found that `git rev-parse --verify --quiet <full-oid>` succeeds without
  object membership; object existence is required only by a suffix/path that
  reads it. The WU1 quiet matrix now preserves that external contract; Singer
  independently approved the plan correction before WU1.
- WU1 shipped one structured resolver for typed peeling, paths, and quiet
  absence. Its focused witness passed 85 tests in 17.98 s; typecheck passed. An
  initial bare-ref BLOB read regressed the indexed log cost witness, so bare
  refs now verify bounded object metadata only and payload reads remain
  suffix/path-driven.
- WU2 shipped raw guarded update/delete with `null` absence and preserved the
  legacy Computer surface. All 101 focused tests passed; the slowest slice was
  `refs.test.ts` at 35.56 s. Typecheck and Biome passed, and Singer's independent
  T3 review found no material issues.
- WU3 exposed revision-based merge-base selection and bounded recursive tree
  rows through the native facade. Its focused witness passed 113 tests in
  18.92 s, including Git parity for non-BMP paths and gitlinks, exact result
  limits, one recursive SQL cursor, cold reopen, Computer passthrough, and
  public exports. The T2 root inspection found no remaining material issue.
- WU4 added atomic index-only snapshot replay through the transaction-scoped
  scratch handle. Its focused witness passed 105 tests in 19.05 s, including
  real-Git clean-tree and structural-conflict parity, no-write conflicts,
  rollback, cold reopen, corrupt rows, the 1,000-entry bound, and a retained
  clean plan above 16 MiB within the shared 64 MiB limit. Typecheck and Biome
  passed. Singer's first T3 review found three blockers in nested memory
  accounting, physical conflict projection, and parent-validation order; the
  fixes closed all three and the independent re-review approved WU4.
