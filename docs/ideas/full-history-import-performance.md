# Full-history import and staging performance

Measured on 2026-10-06. This is a proposal, not an approved implementation plan.

## Recommendation

Optimize physical pack reads, projection writes, and graph queries before
replacing codecs. The profile attributes about 76% of sampled time to native SQL
execution/cursor advancement. Rust/Wasm cannot remove that work by replacing
SHA-1 or the delta decoder alone.

For staging, use the existing complete dirty tracker and preserve exact-path
access through hashing. Running the full metadata scan faster is the wrong first
step for a clean tree or one changed file.

## Measurement boundary

- Next.js v15.5.2, upstream HEAD
  `497ec6aa08a33f9e2d65a5c8461f550c2549d3e6`.
- Full reachable history, `blob:none`, then current checkout hydration:
  30,347 commits, 338,052 metadata objects, 24,252 checkout files, and
  19,585 unique checkout blobs. Historical blobs remain lazy.
- Local Smart HTTP origin backed by the previously downloaded native repository.
  These timings exclude downloading that origin from GitHub.
- Separate persisted profiling workspace; the interactive demo and its existing
  workspaces were preserved.
- `cpu-lease run -n 2 --no-smt`; host-monotonic timings; CDP sampling at 10 ms,
  started before the clone; organic V8 GC traces and host process samples.
- Cgroup `memory.max`: unlimited (`memoryMaxBytes: null`).
- One diagnostic clone, not a repeated production benchmark. Instrumentation and
  profiling affect timings and allocation. The earlier run without this detailed
  instrumentation took 361.8 s; this run took 444.5 s. Their difference is not a
  measured regression or a measured profiler overhead.
- The diagnostic clone checked the exact HEAD, 24,252 files, and a clean worktree.
  The earlier full-history verification checked all commits and native history
  and patch parity.

The clone hook counted all statements and returned rows. Its first version did
not account native counters on unconsumed DML cursors. Consequently, this report
does not claim complete clone-wide `rowsRead`/`rowsWritten` totals. The exhausted
connectivity SELECT counters are usable. The staging run used the corrected hook.

## Clone phase breakdown

| Phase | Host wall time | SQL statements | Rows returned to JS |
|---|---:|---:|---:|
| First metadata pack receive | 3.39 s | 60 | 0 |
| Initial metadata indexing | 27.47 s | 1,543 | 28,102 |
| Deferred deltas, including projection writes | 273.42 s | 8,244 | 439,617 |
| Physical membership audit | 2.83 s | 1 | 1 |
| Commit projection publication | 0.73 s | 2 | 0 |
| Promise registration | 39.11 s | 4 | 2 |
| Fetched graph connectivity | 55.81 s | 1,575 | 4,230,638 |
| Checkout materialization | 4.19 s | 530 | 76,527 |
| Checkout blob type checks, both batches | 0.44 s | 19,590 | 39,170 |
| Whole clone, including negotiation and hydration | **444.47 s** | **31,881** | **4,918,726** |

Rows do not sum to the total: smaller publication, tree-scan, negotiation, blob
receive/index, and final-state phases are omitted. The two type-check phases
include presence checks and surrounding bookkeeping; their scalar type lookups
account for 19,585 statements.

### CPU attribution

Inclusive stack times overlap; do not add them:

| Stack | Sampled inclusive time | Interpretation |
|---|---:|---|
| `readRangeBatch` | 151.1 s | Compressed range lookup and native cursor work |
| `indexPackTreeSources` | 98.2 s | Tree parsing, batching, and projection SQL |
| Tree batch `#flushEntries` | 62.3 s | Subset of projection time |
| Promise registration | 39.1 s | Native SQL dominates a very small statement count |
| Connectivity | 55.5 s | Graph SQL plus exported edge processing |

Self samples: native `exec` 175.1 s, native `next` 164.3 s, OID regexp 12.0 s,
SHA-1 `#compress` 9.18 s, GC 6.65 s. Native stack symbols are opaque: `exec` and
`next` include SQLite and runtime boundary work, not a measured SQL VM-only split.

The principal connectivity SELECT returned **3,356,291 rows** and reported
**35,058,105 native rows read**. Across the connectivity phase, exhausted SELECTs
reported **39,784,054 rows read**. Returned rows are not scanned/read rows.

## Prioritized changes

### 1. Batch pack reads by physical chunk, not object fragment

`packages/git/src/store/pack/read/read-data.ts:151` groups logical requests in SQL
but still joins the same 1 MiB `git_pack_data` row for each small requested slice.
The profile's range query ran 49 times and returned 191,327 fragments. Its query
plan uses the full `(repo_id, pack_id, seq)` key, so this is not a missing-index
explanation.

Hypothesis: repeated BLOB loading/materialization dominates these small slices.
Group admitted requests by physical chunk, read each needed chunk once into a
fixed-size window, and scatter its slices into bounded result buffers. Preserve
cross-chunk objects, returned-byte bounds, and ownership of output buffers. Reuse
the existing pack row-cache seam rather than building a second unbounded cache.

The bounded experiment compared 1,285 delta ranges with 1,048,141 output bytes
(below the existing 1 MiB batch ceiling) in the same workerd database. All output
digests matched. Two measurements per method, ordered original/grouped/grouped/
original, gave:

| Read strategy | Host time | Statements | Returned rows | Native rows read | Returned BLOB bytes |
|---|---:|---:|---:|---:|---:|
| Existing per-range SQL | 450–568 ms | 1 | 1,286 | 5,143 | 1,048,141 |
| Read each physical chunk once | 30–32 ms | 2 | 2 | 2 | 2,097,152 |

Times include common bounded request selection, output assembly, and hashing;
table counters cover the range-read portion. The first request also includes
runtime startup, so the final original measurement is the better warm comparison.
Both methods ran under `cpu-lease run -n 2 --no-smt`. The roughly 15× warm kernel
gain establishes the direction; it is not a 15× clone result or a measured memory
gain. Grouped reads cross the SQL boundary with more bytes but do far less repeated
row work. The prototype reads one chunk at a time and retains bounded output.

Local artifacts: `/tmp/opencode/kompjutr-range-probe.json` and the matching
`kompjutr-range-probe*.mjs` scripts. Test broader delta-page locality before
extrapolating this dense sample to the whole 151 s profile region.

### 2. Make projection batches cheaper, not merely larger

`packages/git/src/store/trees/tree-index-batch.ts:246` serializes repository/tree
identity into every entry, extracts JSON fields repeatedly, and resolves the
source key again for each entry. The entries already belong to an authenticated,
operation-owned source batch.

- Seed/select source keys once per bounded tree batch; carry the numeric source
  key into entry rows instead of resolving a 40-character tree OID per entry.
- Retain duplicate-tree projection skipping.
- Reuse the entry/marker arenas across batches.
- Parse resolved trees while their bytes are live. Avoid target chunks → flat
  raw-tree copy → delayed parser → another entry arena.
- Measure SQL binding/serialization and actual insert/index maintenance
  separately before choosing JSON, packed fields, or another batch encoding.

The 98.2 s inclusive region is an opportunity envelope, not a promised saving.
Required parsing and projection writes remain.

### 3. Deduplicate promises before probes and conflict handling

`packages/git/src/store/fetch/promisor.ts:122` inserts promises from historical
tree edges. The same blob can occur in many trees. Current SQL performs physical
availability probes and conflict handling for those repeated edges.

Materialize/deduplicate the candidate OID relation before availability joins and
insertion. Verify the plan and native row counters; a `DISTINCT` placed after
expensive probes does not establish that the probes were avoided. Preserve remote
ownership and complete-pack visibility.

This phase takes 39.1 s despite just four statements. Increasing batch size is not
the central issue.

### 4. Keep connectivity checking in the store; return failures only

`packages/git/src/store/trees/connectivity.ts` and
`packages/git/src/ops/network/network-connectivity.ts` export successful edges,
validate OID strings, rebuild batches, and ask SQLite about them again.

- Traverse combined roots with identity deduplication.
- Deduplicate blob identities as well as tree identities.
- Join physical types and permitted promises inside SQLite.
- Return a bounded failure result rather than millions of successful rows.
- Avoid ordinary loose-chunk integrity aggregates when presence/type is the
  actual question.

Keep missing-parent/tree detection, shallow boundaries, wrong-type failures,
gitlink exclusion, publication freshness, and blob-only promises. Authentication
does not prove graph connectivity. A single SQL query still needs a sound plan
and measured recursive-state memory.

### 5. Fix scalar hydration checks for cost, not as a speed headline

`packages/git/src/ops/network/network-promisor.ts:107` first checks missing wants,
then calls `typeAndSize` once per blob. One bounded presence/type batch can replace
both passes. Approximately 61% of clone statements disappear, but this profile
places their entire enclosing phases at only 0.44 s.

### 6. Remove duplicate work and allocation churn

- `pack-ingest-index.ts` passes authenticated commits to a projection path that
  hashes them again. Split parsing from authentication and remove the second hash.
- `ingest-inflate.ts` already obtains delta header sizes on the first pass.
  Preserve that metadata instead of re-inflating a prefix during deferred work.
- `ingest-index.ts` releases and immediately disposes the chunk pool after small
  immediate deltas. Keep a fixed retained free-list or reuse an exact-size small
  target path; never retain the largest-ever working set without a bound.
- Avoid fetching compressed pending entries whose bases were not admitted.
- `initial-checkout.ts` repeatedly plans the remaining suffix of a blob window.
  Plan once, then consume bounded byte groups.
- The current large packed-blob “stream” can contain one fully materialized
  object. Implement real non-delta streaming, then address delta-base lifetime.
- The DO initial writer copies chunks and later assembles another SQL payload.
  A writer-owned bounded arena can preserve caller ownership with fewer copies.

Checkout is only 4.19 s here. Its streaming improvements matter more to memory
than to the first order-of-magnitude latency reduction.

## Staging results

Same full checkout, restarted Worker, separate profiling workspace. Command time
is host request latency; counters include the shell command path.

| Operation | Time | Statements | Returned | Native rows read |
|---|---:|---:|---:|---:|
| First clean `git add .` after clone | 2,293 ms | 188 | 80,712 | 1,994,769 |
| Second clean `git add .` | 467 ms | 67 | 60,193 | 396,143 |
| One changed `readme.md`, `git add .` | 496 ms | 86 | 68,205 | 416,958 |
| Selected changed `.alexignore` | 22 ms | 25 | 1,024 | 51,335 |
| Selected changed `vercel.json` | 156 ms | 49 | 24,276 | 144,731 |
| Changed `vercel.json`, `git add .` | 629 ms | 103 | 84,455 | 468,075 |

Three distinct causes:

1. Initial checkout writes null stat-cache fields. The first add repairs index
   metadata across a clean checkout; it reported 72,807 native rows written.
   Content-ID mappings can avoid file hashing without avoiding those writes.
2. Full add does not consume the complete dirty tracker used by sparse status.
   It scans index and filesystem metadata even for a proven-clean tree.
3. Candidate hashing can refresh by scanning from the root to the selected path.
   The early/late selected-file difference demonstrates the unwanted traversal.

There is also an exact-selection SQL plan problem: one selected-index query
returned one row while reading 48,505. A read-only native SQLite plan inspection
shows lookup by `checkout_id` alone. A `CROSS JOIN` diagnostic selects the full
`(checkout_id, path)` key. Verify this candidate in workerd before landing it.

Use tracker candidates and exact hydrated facts for same-database staging, with
the existing complete scan as fallback. Preserve deletions, conflicts, partially
staged files, `rm --cached` followed by add, ignored untracked paths, forced add,
directory replacements, and dirty paths outside a selection. Never reseal all
tracker state from a partial selection.

Target: clean or one-small-file warm add below 100–200 ms, with row work
proportional to candidates. This is not a bound for invalid trackers, large dirty
files, or thousands of edits.

## Memory

| Metric | Detailed clone profile |
|---|---:|
| Peak workerd process RSS | 965 MiB |
| GC-sampled peak V8 used + external | 759.3 MiB |
| Peak V8 used | 100 MiB |
| Peak external | 667.9 MiB |
| Peak ArrayBuffer counter | 504.5 MiB |

All numbers are under an unlimited cgroup memory cap. RSS is not isolate memory;
GC-sampled used + external is a lower bound. Individual peaks need not coincide
and must not be summed. The earlier run reached about 1.46 GiB used + external;
the difference does not prove a memory improvement.

The initial metadata indexing phase already reaches the 759.3 MiB sampled peak,
before deferred resolution begins. Thus blaming connectivity or only deferred
delta caches would be incorrect. External memory dominates, but this profile does
not establish an allocation-site breakdown or prove a leak.

Reduce allocation rate and concurrent buffer ownership: reusable bounded pools
and arenas, physical chunk reuse, parse-before-release, real large-object streams,
and fewer SQL/JS row conversions. Measure again under a fixed memory cap and with
the existing V8 trace gate. Neither a small live cache nor Wasm linear memory
alone proves compliance with the production 128 MB isolate limit.

## Rust/Wasm and alternatives

| Approach | Best when | Main limitation |
|---|---|---|
| Physical batching and set-oriented SQL; retain eager projections | Current measured SQL/row costs dominate | Still writes all historical projections |
| Fused Wasm inflate → delta → hash → packed projection output | A subsequent profile is dominated by JS codecs/parser or their allocations | Does not remove SQLite work; per-entry boundary crossings can erase gains |
| Lazy historical projections or clone-owned provisional output staging | Fast initial readiness justifies changed storage/read contracts | Architectural change, deferred latency, and more failure/publication design |

Git SHA-1 is handwritten TypeScript. Buffered zlib is already native
`node:zlib`; streaming zlib uses pako 2.2.0. First compare supported synchronous
`node:crypto.createHash("sha1")` with the current hasher. A separate leased workerd
probe verified equal digests and measured the following host request times:

| Input × repetitions | TypeScript | Native SHA-1 |
|---|---:|---:|
| 256 B × 50,000 | 178–183 ms | 167–233 ms |
| 4 KiB × 10,000 | 206–214 ms | 49–53 ms |
| 1 MiB × 100 | 468–476 ms | 87–89 ms |

The probe alternated implementations, with two measurements each and a warmup
request. It establishes availability and a useful larger-input kernel gain, not
an end-to-end improvement or a reliable tiny-object win. The measured SHA-1
compression self time is only about 2% of this clone, so even eliminating it
cannot produce a tenfold clone improvement.

If Wasm becomes justified, use coarse bounded inputs and packed outputs. Preserve
compressed-byte consumption, malformed-stream/delta checks, cancellation seams,
and output ownership. Do not call Wasm once per path comparison or SQL row.

## Decision and verification gates

Recommended order: physical range-read experiment → projection batching →
promise deduplication and failures-only connectivity → repeat full profile →
codec/native/Wasm decision. Staging tracker/exact-path work is independently useful.

A 30–45 s clone is a stretch target, not a measured forecast. It requires several
large regions to shrink together; the 151 s and 98 s stack regions overlap other
phase totals. Eliminating all range-read time alone would still leave roughly
293 s of this diagnostic run. Hydration transport and origin pack generation also
remain. Claim a tenfold improvement only after comparable end-to-end runs.

Each implementation step needs byte/state parity and full-history measurement:
cross-chunk/delta-base pack reads; duplicate and malformed tree/commit inputs;
missing/wrong-type connectivity and shallow cases; cold reopen; exact HEAD,
file and commit counts; clean worktree; native historical patches; and staging
semantics above. Re-profile after each major region changes before expanding scope.

Local evidence is under `/tmp/opencode/kompjutr-profile-run1/` and
`/tmp/opencode/kompjutr-profile-add/`: `summary.json`, `phases.json`, `cpu.json`,
`sql.json`, `gc.json`, `memory.json`, and `analysis.json`. These are temporary
diagnostic artifacts, not portable benchmark fixtures. The attempted native Git
baseline failed on unadvertised-object hydration and supplies no valid comparison.
