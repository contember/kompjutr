# Decomposition — the standalone runtime

The unit breakdown for [`standalone-runtime.md`](standalone-runtime.md). That
document decides *what* is built; this one decides *who builds which file* and
in what order.

A unit is **territory + contract + done-check**. Territories are strictly
disjoint, tests included. Anything several units would touch belongs to a
leader-owned wave and is never delegated.

> **Revision note.** The first draft of this breakdown was reviewed
> adversarially by a different model family and failed on eleven counts. The
> fatal one: it froze *executable* integration files — `filesystem.ts`, the
> barrels, `core/worktree.ts` — with throwing stubs before any implementation
> existed, so no later unit had the territory to wire them up and the tree
> could not be green at the end of a wave. The structure below is the revision.
> Findings are cited inline as **[Rn]** where they changed something.

---

## Two rules that apply to every unit

**Territory.** Write only inside it — not even a one-line fix elsewhere. You
may read anything. Anything you want changed outside your territory, you
report; you do not do it. Blocked beats creative.

**Done-checks come in threes.** Originally two; wave C proved a third is
needed.

1. **A statement ceiling** — the Durable Object metric.
2. **An output-parity assertion** — same paths, same bytes, same modes, same
   order as what it replaces. A ceiling alone is beaten by an implementation
   that does nothing: an empty diff, a no-op `add` and a skipped checkout all
   come in well under budget. **[R11]**
3. **A scaling assertion.** F4's first `removeFiles` was constant in statements
   *and* correct in output, and took **2.7 s for 5,000 paths** — a correlated
   `EXISTS` over `json_each` re-runs the virtual table per candidate row. The
   fix, `IN (SELECT value FROM json_each(?))`, is built once and
   binary-searched: **55 ms**. The count was 6 either way and the output was
   identical either way, so neither of the first two checks could see it.
   Measure at two sizes an order of magnitude apart and assert the shape of the
   curve, not just the endpoint.

A gate that cannot observe the bug class is not evidence.

---

## Gate commands

Run by the leader, never by an implementer, cheapest first:

```bash
npx tsc -p tsconfig.json --noEmit          # typecheck (includes tests and bench)
npx biome check .                          # lint + format
npx vitest run                             # the existing 5,518-line suite
cpu-lease run -n 2 -- npm run bench:macro  # statement counts against §7
```

An implementer runs **only** its own narrow gate, named per unit.

---

## Wave A — evidence. 2 agents. Not a deliverable.

Two probes whose job is to **invalidate the plan** before anything is built on
it. Neither writes to `src/`.

| unit | territory | done-check |
|---|---|---|
| **E1 — rename cost** | `tmp/rename-probe.ts` | `mv` of a 5,000-file subtree: statements, rows written, wall. R1 in §10.2 says this is the one cost the path key makes structurally worse. |
| **E2 — conformance port survey** | `tmp/port-survey/` | Mechanically port the 19 portable dofs test files against a stub store. Report the pass rate; classify every failure as *schema-shaped* or *signature-shaped*. |

**Stop conditions, agreed before running.** E1: a 5,000-file directory rename
above ~50 ms or above 2 statements re-opens D2 and possibly the path key
itself. E2: a mechanical pass rate below ~95% retires the rewrite and the fork
becomes the plan (§2.1).

E2's output is not thrown away — `tmp/port-survey/classification.tsv` carries
411 rows, one per test case with its bucket and `file:line` reason, and is the
porting worklist for wave D.

### Outcome

**E1 passed.** A 5,000-file directory rename is 2 statements and 5,250 rows,
17.6 ms in memory and 24.8 ms file-backed, linear at ~3.5 µs/row. R1 does not
fire; the path key and the two-table split stand. Recorded in §3.7 of the
design, along with three gaps the probe found in that section — `?oldLen` is
code points not bytes, `?oldRootSuccessor` was never defined, and the second
statement was counted but never shown.

**E2 fired its stop condition.** The inherited suite is 55.9% API-shaped
strictly, 85.6% granting mechanical helper substitution, against a ~95%
threshold. The plan's three headline figures were all correct; the inference
from them was not, because coupling concentrates in helpers rather than in line
mentions. The bulk primitives — the point of the exercise — have **zero**
inherited coverage.

**Decision: proceed with the rewrite anyway, with the claim corrected.** The
fork does not win on this evidence: it inherits the same 247 out-of-scope cases
plus a v5 schema with four migrations, and it keeps inode+dirents, which means
no bulk writes and therefore no reachable `checkout` or `clone` — the reason
the dependency is being cut at all. The threshold measured a secondary
argument and should not have been decisive; that was an error in setting it,
recorded rather than quietly reinterpreted. §2.3 of the design now carries the
real numbers and the real budget.

---

## Wave B — types and schema. Leader-owned. Purely additive.

Everything here is either a new file with no consumers or an additive schema
change. **Nothing that already compiles changes shape, so the tree stays green
throughout.** **[R1]**

| file | what it fixes |
|---|---|
| `src/fs/types.ts` | §4.1 verbatim: `EntryType`, `RealPath`, `Stat`, `Dirent`, `ScanEntry`, `ScanOptions`, `ReadBatch`, `WriteEntry`, `WriteOptions`, `RemoveOptions`, `FilesystemOptions`, `Filesystem`, `subtreeSuccessor`. Three additions the seam must carry before it freezes: **`WriteEntry.mtime`**, or the importer cannot preserve timestamps **[R7]**; **`Stat.rev`**, which six inherited cases assert on and whose column already exists; and **an injected clock** on `FilesystemOptions`, without which every inherited `mtime` assertion has nowhere to pin time. |
| `src/fs/schema.ts` | The `fs_meta` / `fs_nodes` / `fs_paths` / `fs_chunks` DDL from §3.3, the version row, the migration runner. |
| `src/fs/path.ts` | Normalisation, join, parent, basename, `subtreeSuccessor`. Pure functions, no SQL. |
| `src/fs/store/meta.ts` | `rev()`, `fs_meta` accessors, the explicit inode allocator. **Implemented, not stubbed** — a new file with no consumers cannot redden anything. |
| `src/fs/store/resolve.ts` | `realpath()` — the sole producer of `RealPath` and the choke point §3.6 hangs the design on. Implemented for the same reason. |
| `src/sqlite/schema.ts` | **`git_blob_ids`, `git_objects.stored` and `git_commits` do not exist in the tree.** All three land here with their migration and migration tests, before any unit depends on them. **[R4]** |
| `tests/fs/conformance/harness.ts` | **A dofs-shaped conformance adapter**, not just a fixture: it maps dofs' free-function calls (`stat(db, path)`, `readdir(db, path, options)`, `resolveInode`, `readBack`) onto `Filesystem`, so the inherited tests port nearly mechanically and no production code carries dofs' shape. This is what converts four of E2's nine porting blockers from interface decisions into thirty lines of test harness. **[R8]** |
| `package.json` | **Deferred to the integration wave, deliberately.** An export map has to point at files that exist; `./fs`, `./git`, `./compat/computer` and `./testing` are barrels the integration wave creates. Adding the entries now would ship a package whose exports resolve to nothing. |

**Deliberately not touched here:** `src/fs/filesystem.ts`, `src/fs/index.ts`,
`src/core/worktree.ts`, `src/index.ts`, `tests/helpers/*`. Those are the
integration wave's territory, and freezing them before their implementations
exist is exactly what broke the first draft.

### Landed

`2846279`. Gates: typecheck green, biome green, **279/279 tests**, including
six new ones covering the v1→v2 migration, root seeding, idempotence, and the
BINARY ordering the whole design rests on.

`tests/store.test.ts` asserts the exact table inventory and failed on the two
new tables. Updated rather than relaxed — the assertion exists to catch tables
nobody meant to create, and these are intended and documented, so its force is
unchanged.

**Known pre-existing flake, so no later unit mistakes it for its own doing:**
the suite intermittently reports one unhandled `EPIPE` from
`tests/helpers/http-backend.ts:151`, where a truncated-response test writes to
a `git http-backend` child that has already exited. A negative control at HEAD
in a scratch worktree reproduced it in **2 of 3** full-suite runs, with none of
this wave's changes present. It is not in any unit's territory; if it becomes
load-bearing, it belongs to G5 with the rest of the clone path.

One seam call recorded so it is not re-litigated: **`Filesystem.withReadScope`
ships declared but as a pass-through.** Its purpose — memoising resolutions and
stat rows — is what dofs' scope serves, and §12 D4 establishes that purpose
largely evaporates over a path-keyed table. It stays in the interface because
removing it later is a breaking change and adding memoisation later is not. The
"mutation inside a scope throws" invariant waits for a benchmark that asks for
it. Note that `Filesystem.withReadScope(fn)` (ours, sync) and the
`./compat/computer` export `withReadScope(db, work)` (async no-op shim, §12 D4)
are different functions in different modules.

---

## Wave C — the store. 5 agents, parallel.

Five disjoint files. F1–F4 are a fresh directory with no existing consumers;
G6 touches the git object store, which nothing in waves B or C reads.

**Every test in F1–F4 is new.** dofs has no bulk API, so E2 found zero
inherited coverage for `scan`, `readFiles`, `writeFiles`, `removeFiles` or
`glob`. These four units carry no inheritance and their gates are the only
thing standing behind the primitives the whole design rests on. Budget them
accordingly.

| unit | territory | contract | done-check |
|---|---|---|---|
| **F1 — scan** | `src/fs/store/scan.ts`, `tests/fs/scan.test.ts` | `scan(root, options)`, `glob(root, pattern, options)`. P1 from §7.0. | Paged scan equals one-shot scan; order equals `comparePaths` (`src/core/streams.ts:29`); 12,675 rows in 13 statements at a 1,000 page. |
| **F2 — bulk read** | `src/fs/store/read.ts`, `tests/fs/read.test.ts` | `readFiles(paths, {budget})`, `readFile`, `readRange`. P2 from §7.0, paged by `(inode, idx)`. | 24 MB across 9,329 files in ≤ 24 statements; `remaining` set, never a partial file; **an instrumented assertion on maximum result-set size** — "never materialises a 50 MB file whole" is otherwise unobservable. **[R11]** |
| **F3 — bulk write** | `src/fs/store/write.ts`, `tests/fs/write.test.ts` | `writeFiles(entries, options)`, `makeDirectories(paths)`. P3 from §7.0. | 2,000 files in constant statements plus one per payload budget; round-trip byte-identical; **a non-ASCII path fixture** — §7.0's TEXT/BLOB `substr` trap corrupts silently and only non-ASCII reveals it. |
| **F4 — remove and rename** | `src/fs/store/remove.ts`, `tests/fs/remove.test.ts` | `removeFiles(paths, options)`, `rename(old, new)`. The range-key rewrite from §3.7. | 5,000-file tree removed in five statements; directory rename in two, `fs_nodes`/`fs_chunks` untouched, **and every descendant path correct afterwards**. |
| **G6 — git store primitives** | `src/sqlite/store.ts`, `tests/store.test.ts`, `tests/store-stream.test.ts` | A batch write API on `RepoStore` — open, accumulate, flush — plus an existence probe covering loose **and** packed in one query. **Callers are not changed here.** **[R2]** | No statement exceeds 100 bound parameters; a 3,293-object batch flushes in ≤ 15 statements; existing store tests green. |

G6 is deliberately primitives-only. `buildTree` calls `store.write()` once per
directory close (`src/core/ops/tree-build.ts:59`) and `RepoStore.write()`
inserts immediately, so collapsing 3,293 writes needs a caller-visible
lifecycle. That caller change is G8, in wave F. **[R2]**

### Landed

**All five landed. Gates after integration: typecheck 0, biome 0, 382/382
tests**, up from 273 at baseline. The one reported error is the known
pre-existing `EPIPE` flake.

| unit | result | commit |
|---|---|---|
| F1 — scan | 12,675 rows / **13 statements** | `35b00bf` |
| F2 — bulk read | 23.9 MB across 9,329 files / **24 statements** | `3aecf75` |
| F3 — bulk write | 2,000 files / **9**; 9,329 × 2.7 KB / **33** | `3ebfcdb` |
| F4 — remove, rename | rename **2**; remove **6** at any size | `4b62281` |
| G6 — object batch | 3,293 objects / **4** (from 16,465) | `273cd6b` |

Every unit ran negative controls against its own gate — deliberately breaking
its implementation to confirm the check fires. F3 went furthest and temporarily
implemented the byte-offset trap to prove its non-ASCII fixture was not
decorative: 9 of 25 tests fired, reproducing both documented failure modes.

**F1 — `35b00bf`.** 12,675 rows in **13 statements**, query plan pinned, order
asserted on the adversarial cases. It also found a real bug in the plan's own
P1 SQL: the range predicate started at `root` rather than `root + "/"`, so
scanning `/repo/src` returned `/repo/src-extra` and `/repo/src.txt`. Fixed in
`63c55d0`. The gate was checked against four deliberate mutations of the
implementation and fires on all four.

**G6 — `273cd6b`.** 3,293 objects in **4 statements**, down from 16,465, with
a widest binding of 3 parameters. `write()` and `writeStream()` byte-for-byte
unchanged.

Two things G6 reported rather than did, both correctly:

- **`packs.ts` moved to G5.** `#indexPack` reads `git_pack_objects` back
  mid-scan through `offsetToOid`, and `#readForBase`/`#drainPending` resolve
  delta bases from rows just inserted, so deferring those inserts changes
  ingest semantics. G5 owns the clone path and can batch it together with the
  base-resolution changes it already needs.
- **`git_objects.stored` still has no `'raw'` half.** G6 writes the literal
  `'zlib'` and carries it through the `DO UPDATE` so the column cannot
  describe bytes it no longer matches, but no compression *choice* exists and
  `#readLoose` still inflates unconditionally. §7.3's deflate tax is therefore
  **not** removed, and the work needs an owner — it is in `store.ts`, which
  G6 has now closed. Assign it before wave F rather than letting G4 discover
  it mid-flight.

---

## Wave D — surface, compatibility, migration. 3 agents, parallel.

| unit | territory | contract | done-check |
|---|---|---|---|
| **F5 — single-path ops** | `src/fs/ops.ts`, `tests/fs/conformance/{stat,readdir,readFile,writeFile,mkdir,rm,rename,symlink,chmod,link}.test.ts` | Every single-path method in §4.1 as a thin wrapper over F1–F4. No new SQL. | **Its share of the inherited suite green**, ported through wave B's adapter, worklist in `tmp/port-survey/classification.tsv`. Roughly 120 in-scope cases. Not "expressible as a bulk call" — symlink following, POSIX error mapping and mode bits are exactly what a shape-only check misses. Cases E2 marked unportable are discarded with a recorded reason, never silently skipped. **[R8]** |
| **F6 — compatibility surfaces** | `src/fs/compat/`, `tests/fs/conformance/{fd,errors,provider}.test.ts` | `NodeFsCompat` (node:fs names, the fd table) and the Computer façade (`withReadScope` no-op, `shellQuote`, the provider shape). | Behavioural, not type-level: the fd trio round-trips, `existsSync` swallows errors per §4.3, and the inherited fd and error-mapping tests are green. **`provider.fd.test.ts` is the highest-yield inherited file in the whole suite — 28 of 29 cases API-shaped, 376 lines — and it lands here.** Compiling is not passing. **[R11]** |
| **F7 — importer and migration** | `src/fs/import.ts`, `src/fs/testing.ts`, `tests/fs/import.test.ts` | `importFromComputer(db)` per §8.2, the divergence latch, and the shadow-read wrapper §8.3 ships from `./testing`. | Round-trips a real Prettier-sized `vfs_*` database: same paths, bytes, modes, symlink targets **and mtimes**; the latch trips on a database Computer wrote to after import. |

The latch is *validated* on every open, which is the filesystem's opening path
and therefore the integration wave's territory, not F7's. F7 owns writing the
latch and the check function; the leader wires the call. **[R7]**

---

## Wave INT — integration. Leader-owned. The tree goes red and comes back.

This is the wave the first draft did not have, and its absence was the fatal
defect. Every file here is imported by three or more units or changes a shape
existing code depends on. **[R1] [R3]**

| file | what happens |
|---|---|
| `src/fs/filesystem.ts` | Composes the wave-C and wave-D modules into `Filesystem`. |
| `src/fs/index.ts`, `src/index.ts` | Barrels and entry points. |
| `src/core/worktree.ts` | `Worktree` becomes a slice of `Filesystem`. This is a breaking shape change: today it uses `"directory"` and positional `writeFile(path, data, mode)` (`src/core/worktree.ts:5`, `:27`); `Filesystem` uses `"dir"` and an options object. |
| `src/computer/worktree.ts` | `ComputerWorktree` migrated to the new shape, or deleted early if nothing needs it before wave G. |
| `tests/helpers/workspace.ts`, `tests/helpers/worktree.ts` | Migrated. Five wave-F units import these; `CountingWorktree` implements the old interface (`tests/helpers/worktree.ts:6`). Left alone, every wave-F unit would either need to write them, report `blocked`, or run its gate against the old filesystem and observe nothing. **[R3]** |
| the latch call site | Wired into the filesystem's opening path. |

Full gates must pass before wave E starts. **These files are frozen only from
this point on** — an implementer that needs one changed reports `blocked` and
the leader decides.

---

## Wave E — the git read paths. 3 agents, parallel.

All three are consumed by wave F, and all three are disjoint.

| unit | territory | contract | done-check |
|---|---|---|---|
| **G0 — batched object and tree reads** | `src/core/ops/tree-stream.ts`, `src/core/repository.ts`, `tests/reads.test.ts` | Tree objects read per generation instead of one at a time, across loose **and** packed storage. | ≤ 25 statements for a 3,346-tree HEAD read, plus parity: the same tree entries in the same order as `walkTree` today. |
| **G1 — worktree-io** | `src/core/ops/worktree-io.ts`, `tests/worktree.test.ts` | The walk becomes `fs.scan`; hashing becomes `fs.readFiles` plus batched SHA-1; `dirtyPaths` consumes `contentId` before reading anything. | A 9,329-file walk in ≤ 15 statements and zero content reads when nothing changed, with the emitted path list identical to today's. |
| **G7 — ignore** | `src/core/ignore/`, `tests/ignore.test.ts` | `.gitignore` discovery and contents bulk-read through `glob` + `readFiles`, evaluated in JS, with the caller steering `scan` past ignored subtrees. | One statement for discovery, one for contents, regardless of depth; existing ignore semantics unchanged. |

G0 exists because the design's statement counts assume batched tree reads
(§7.1) while `treeStream` delegates to a recursive `walkTree`
(`src/core/ops/tree-stream.ts:22`, `src/core/repository.ts:275`) that does a
scalar read per directory. Without it, status, diff, staging and checkout miss
their ceilings even with perfect files of their own. **[R5]**

G7 moved out of wave F because `status.ts:187` and `staging.ts:64` construct
the ignore matcher during their walk — G2 and G4 need it finished, not racing
them. **[R10]**

---

## The integration wave's worklist, as wave C wrote it

Every item was reported by a unit rather than acted on, which is the contract
working. None is a defect in what landed; all are seams that only become
decidable once the pieces sit together.

| # | what | found by |
|---|---|---|
| 1 | **`Filesystem.scan(root: string)` cannot meet 13 statements as declared.** `realpath` costs a statement, so calling it per page doubles the count and blows §7.1's 15-statement budget for `status`. The wrapper must resolve once and hold the `RealPath` across pages. | F1 |
| 2 | **No bulk primitive resolves symlinks.** Per-path `realpath` breaks the constant-statement contract outright, so all four take already-real paths. The composing layer must route through `realpath` / `realpathNoFollow`, and it is the only thing standing between a lexical path and §3.6's invariant. | F1–F4 |
| 3 | **`WriteOptions` has no `now`.** `FilesystemOptions.now` exists so a test can pin `mtime`, but the free-function signature gives it nowhere to go, so F3 defaults to one `Date.now()` per call. Either `WriteOptions` grows a clock or `Filesystem` closes over one. | F3 |
| 4 | **`rev` is bumped asymmetrically.** `removeFiles` bumps; `rename` does not, because 2 statements leaves no room. If `Filesystem.removeFiles` bumps as well, the counter advances twice per call. | F4 |
| 5 | **No shared error helper.** F3 and F4 both inlined `Object.assign(new Error(…), { code })` from `resolve.ts:77`. Collapse into `src/fs/errors.ts`. | F3, F4 |
| 6 | **`bumpRev` costs two statements** — update, then read back. A one-statement variant in `meta.ts` would stop callers inlining their own. | F4 |
| 7 | **`readFiles`' path lookup is one unpaged result set** proportional to the input list — 9,329 rows at full-repository scale. It carries no BLOBs, but the byte budget does not bound it. | F2 |
| 8 | **24 statements for a full-repository read is 1 + 23 with zero slack.** Past ~24 MB, or if `readFiles` ever has to resolve symlinks, the ceiling moves rather than the implementation. | F2 |
| 9 | **`git_objects.stored` has no `'raw'` half**, so §7.3's deflate tax is not removed. The work is in `store.ts`, which G6 has closed. Needs an owner before wave F. | G6 |

**One measurement caveat that affects every number in this document.**
`TestDatabase.transactionSync` (`tests/helpers/db.ts`) issues its `BEGIN` and
`COMMIT` through `storage.db.exec` rather than `sql.exec`, so transactions do
**not** appear in `statementCount`. Every count reported here is statements
*inside* the transaction. That is the right comparison between our own layers,
and it is not what a Durable Object would bill.

---

## Wave F — git operations. 5 agents, parallel.

| unit | territory | contract | done-check |
|---|---|---|---|
| **G2 — status** | `src/core/ops/status.ts`, `tests/status.test.ts` | Consumes the bulk walk. Also removes the double `git_index` scan (`status.ts:93` and `:208`). | ≤ 170 statements at 9,329 files **and identical status output** to the current implementation across the existing suite. |
| **G3 — diff** | `src/core/ops/diff.ts`, `tests/diff.test.ts` | Content for changed paths only, through `readFiles`. | ≤ 180 statements **and byte-identical diff output**. |
| **G4 — staging** | `src/core/ops/staging.ts`, `tests/staging.test.ts` | `add` consumes the bulk walk and the `contentId` → `git_blob_ids` join. | ≤ 230 statements for `add --all` **and an index identical to today's**, entry for entry. |
| **G5 — checkout and clone** | `src/core/ops/checkout.ts`, `src/core/ops/network.ts`, `src/core/ops/refs.ts`, `tests/clone.test.ts`, `tests/refs.test.ts` | Checkout consumes `writeFiles` and records the blob oid as `contentId`. | ≤ 200 statements for a 9,329-file checkout, ≤ 240 for clone, **and a worktree byte-identical to the target tree**. |
| **G8 — commit batching** | `src/core/ops/tree-build.ts`, `src/core/ops/commit.ts`, `tests/commit.test.ts` | Drives G6's batch lifecycle across the whole tree build instead of one write per directory close. | `commit` of 3,293 objects in ≤ 15 statements **and an identical tree and commit oid**. |

G5 owns `refs.ts` because public checkout runs its overwrite guard there
(`src/core/ops/refs.ts:125`, walking target tree, HEAD tree and index at
`:233`) before calling `checkoutTree`, which walks target tree and index again
(`src/core/ops/checkout.ts:49`). Clone calls `checkoutTree` directly
(`src/core/ops/network.ts:256`), so a clone-only gate would pass while ordinary
checkout stayed double-scanned. **[R6]**

---

## Wave G — cut over and close. Leader-owned.

| step | territory |
|---|---|
| Retire the adapter | `src/computer/` deleted, `src/index.ts` rewired |
| Migrate the last Computer consumers | `tests/client.test.ts`, `tests/factory.test.ts`, `bench/harness.ts` — all three still import `@cloudflare/computer` and all three are inside `tsconfig.json`'s `include`. **[R9]** |
| `package.json` | `@cloudflare/computer` **stays as an optional peer** through the compatibility milestone, per §1.1 and §5.3. Removing it is a later, separate decision. **[R9]** |
| Declare the exec seam | `src/runtime/` — `Workspace`, `AsyncFilesystem`, `ProcessHost`, `RpcHost`: typed, unimplemented (§6) |
| Re-measure and rewrite | `docs/benchmark-macro.md`, `docs/benchmark-reference.md`, `README.md` |

---

## Agent count

| wave | agents | mode |
|---|---:|---|
| A — evidence | 2 | parallel, writes only to `tmp/` |
| B — types and schema | 0 | leader, additive, tree stays green |
| C — the store | 5 | parallel |
| D — surface and migration | 3 | parallel |
| INT — integration | 0 | leader, tree red then green |
| E — git read paths | 3 | parallel |
| F — git operations | 5 | parallel |
| G — cut over | 0 | leader |
| **total implementers** | **18** | |

Above the usual "keep it under 15" guideline, and deliberately: the review
showed the first draft was too coarse in three places, not too fine. Reviews
run as one wide pass per wave over frozen diffs, not per unit sequentially.

Isolation is **single tree** throughout. Territories are disjoint files,
`src/fs/` is a fresh directory, and explicit-path commits let a green unit land
while its neighbours are still being written.

---

## Out of scope

- **Exec.** Declared as a seam in wave G, not implemented. The shell layer
  (`just-bash` over a Worker Loader binding, with an RPC surface back into the
  filesystem) is a separate body of work.
- **Containers and their sync protocol.** All of dofs' `sync/` — 1,266 lines.
- **Mounts**, assets, artifacts, AI tools, file watching, garbage collection,
  content-addressed dedup.
- **Async SHA-1.** §12 D3 declines it. It is what would move the write-heavy
  wall times, and it is its own estimate.
- **Renaming the package.** §12 D1 keeps `kompjutr`.
- **Dropping the `@cloudflare/computer` optional peer.** Kept through the
  compatibility milestone.
- **Publishing.** Nothing here ships to npm.

## Dropped to fit

Nothing was dropped for budget. If wave A's stop conditions fire, the plan
changes rather than the unit list shrinking.
