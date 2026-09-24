# Current benchmark snapshot

Unless a section says otherwise, measurements ran on 2026-09-24 at commit
`62ffbf0fb491731365d9a563437fc6b1d5540d3a` with Node v24.4.0, SQLite 3.50.2,
git 2.54.0, Linux 6.17.0-41-generic x64, and an AMD Ryzen 7 PRO 8840HS. The
Next.js fixture is `vercel/next.js` v15.5.2 at
`381a9c8089ed7a244dcfa374fbb27d37032e208a`, rebuilt as one shallow-cloneable
commit with 24,252 tracked files. The local Smart HTTP origin is prepared
outside measurement. SQLite uses a temporary file. Each phase resets SQLite
counters and the process RSS high-water mark; "added peak RSS" is reset `VmHWM`
minus the same-phase baseline.

This is `node:sqlite` unless the section names workerd. Statement counts
transfer to the Durable Object cost model. Local wall time and process RSS are
regression signals, not proof of a production isolate limit.

## Next.js workflow — 2026-09-24

One run:

```bash
cpu-lease run -n 2 -- npm run bench:nextjs
```

The lease held two vCPUs; SMT siblings were not excluded. Wall values are one
sample each, not medians.

| Operation | Wall, ms | SQL | Rows | Added peak RSS, MiB |
| --- | ---: | ---: | ---: | ---: |
| `git.clone` | 10,211.9 | 1,012 | 145,777 | 237.2 |
| `git.status` — clean clone | 4.0 | 14 | 12 | 0.0 |
| `git.branch` | 4.3 | 30 | 19 | 0.0 |
| `fs.writeFiles` — 100 | 26.0 | 6 | 288 | 0.0 |
| `git.status` — 100 modified | 27.7 | 30 | 1,031 | 0.3 |
| `git.diffSummary` — 100 | 66.2 | 30 | 1,575 | 0.0 |
| `git.diff` — 100 | 37.3 | 29 | 1,573 | 0.4 |
| `git.add` — 100 | 160.4 | 22 | 1,754 | 0.2 |
| `git.status` — 100 staged | 17.5 | 27 | 685 | 0.1 |
| `git.commit` — 100 | 140.6 | 51 | 725 | 0.1 |
| `git.push` — 100 | 342.2 | 47 | 615 | 0.6 |
| `git.status` — clean commit | 10.1 | 25 | 685 | 0.0 |
| `git.checkout main` | 478.2 | 101 | 25,089 | 0.9 |
| `git.checkout main --force` | 462.4 | 102 | 25,189 | 0.9 |
| `git.status` — clean main | 1.0 | 11 | 8 | 0.0 |
| `git.checkout bench-work` | 492.8 | 94 | 25,188 | 9.8 |
| `git.checkout bench-work --force` | 457.4 | 94 | 25,188 | 5.4 |
| `git.status` — clean work | 0.7 | 10 | 8 | 0.0 |
| `git.rebase` — 100 onto `main` | 10,809.6 | 942 | 1,061,270 | 96.6 |
| `git.status` — clean rebase | 23.8 | 27 | 891 | 0.0 |

Every phase passed its verification. Rows are rows returned, not rows scanned.
Every phase except clone meets the at-most-1,000-statement target. Clone misses
it by 12 statements.
Target status is performance evidence, not a runtime admission rule.

Clone adds 237.2 MiB over a 207.3 MiB process baseline. The rebase step replays
one 100-file commit onto a new `main` commit and adds 96.6 MiB
([backlog 95](../backlog/95-reduce-the-nextjs-rebase-step-peak.md)).
`git.diffSummary` measured a peak 0.3 MiB below its baseline; the table
reports 0.0.

## Next.js clone on workerd — 2026-09-24

Three runs of the clone inside a real SQLite Durable Object:

```bash
cpu-lease run -n 2 -- npm run bench:workerd:nextjs
```

The runtime was `workerd` 1.20260820.1 with compatibility date 2026-08-15.

| Run | SQL | Rows | Database bytes | Baseline RSS, MiB | Added peak RSS, MiB |
| --- | ---: | ---: | ---: | ---: | ---: |
| 1 | 1,012 | 145,777 | 228,356,096 | 65.0 | 377.4 |
| 2 | 1,012 | 145,777 | 228,356,096 | 65.3 | 453.1 |
| 3 | 1,012 | 145,777 | 228,356,096 | 65.1 | 445.0 |

Every run verified HEAD, 24,252 index entries, and 24,252 worktree files with no
invalid file. Statements and rows match the `node:sqlite` clone exactly. The
harness's 100 MiB added-RSS gate fails in every run
([backlog 86](../backlog/86-bound-sparse-selected-add-and-workerd-clone-peaks.md)).
Runs 2 and 3 overlapped another leased benchmark on separate cores. Local
workerd has no isolate memory limiter, and its RSS includes the SQLite page
cache of a 218 MiB database. Wall time from inside a Worker is not a duration
and is not reported.

## Network clone and fetch — 2026-09-24

One run per mode:

```bash
BENCH_NETWORK_MODE=legacy cpu-lease run -n 2 -- npm run bench:nextjs
BENCH_NETWORK_MODE=mapped cpu-lease run -n 2 -- npm run bench:nextjs
```

Each run clones, fetches with nothing new, then fetches a one-file child commit
`7bb95e82c56785e1024728697c811557087b5f9c`. The `legacy` mode passes
`singleBranch: false, tags: false`; the `mapped` mode passes one forced
`refs/heads/main:refs/remotes/origin/main` refspec. Both go through the same
fetch engine, which lowers the legacy options to forced refspecs, so both
modes do the same SQL work. Default OFS_DELTA transport and cache settings are
preserved. No cgroup memory limit was applied.

| Operation | Wall, ms | SQL | Rows | Added peak RSS, MiB |
| --- | ---: | ---: | ---: | ---: |
| Clone, `legacy` run | 9,427.8 | 1,006 | 145,772 | 250.2 |
| Fetch, unchanged, `legacy` options | 696.1 | 47 | 67,231 | 7.6 |
| Fetch, one changed file, `legacy` options | 1,332.8 | 105 | 130,791 | 0.0 |
| Clone, `mapped` run | 11,390.4 | 1,006 | 145,772 | 235.9 |
| Fetch, unchanged, `mapped` refspec | 693.3 | 47 | 67,231 | 19.8 |
| Fetch, one changed file, `mapped` refspec | 1,336.9 | 105 | 130,791 | 0.5 |

All phases passed semantic verification: the published tracking ref, the
fetched commit count, and every fetched tree entry. Clone process baselines were
167.8 MiB and 170.1 MiB. This clone passes `depth: 0` and `noTags: true`; the
workflow clone passes `ref` and `depth: 1` and runs 1,012 statements. The clone misses
the 1,000-statement target by 6 statements and the former <160 MiB added-peak
gate by 76–90 MiB
([backlog 86](../backlog/86-bound-sparse-selected-add-and-workerd-clone-peaks.md)).
A phase whose peak stayed below its baseline is reported as 0.0.

## Local runtime qualification

The Unix `@kompjutr/local` harness is a correctness and regression fixture, not
a comparison with the Durable Object composition. One leased run on 2026-09-08
used 50 directories and 2,500 tracked files:

```bash
cpu-lease run -n 2 --no-smt -- npm run bench:local
```

| Operation | Wall | Adapter SQL | Rows | Files |
| --- | ---: | ---: | ---: | ---: |
| Ordered disk traversal | 23.387 ms | 0 | 0 | 2,500 |
| Clean status with conservative disk hashes | 380.331 ms | 18 | 10,009 | 2,500 |

The run validated exact traversal cardinality and a clean Git status. Peak RSS
was 211,226,624 bytes for the complete process, including fixture creation,
initial add, and commit; it is not an operation-memory measurement. Disk
`contentId` remains `null`, so the status row deliberately measures the correct
rehash path. These small-fixture numbers are not product throughput claims.

## Tree-schema storage

Measured 2026-09-24 on the working tree at commit `5b5e1a7` with Node v24.4.0
and SQLite 3.50.2 on Linux 6.17.0-41-generic x64 and an AMD Ryzen 7 PRO 8840HS:

```bash
npm run bench:tree-schema
```

The harness re-executes measurement through `cpu-lease run -n 2 --no-smt` and
verified `Cpus_allowed_list=10`, one logical CPU. A rerun at `62ffbf0` on
2026-09-24 (`Cpus_allowed_list=12`) reproduced every page count, byte count, row count,
and checksum below. A correctness-only run uses
`npm run bench:tree-schema -- --check` without a lease. Both layouts contain the
same parsed data from Next.js v15.5.2 at revision
`381a9c8089ed7a244dcfa374fbb27d37032e208a`: 24,252 tracked paths, 11,070 trees
and 34,996 immediate entries. v12 keeps one source row per physical copy and
selects one through `git_tree_effective`; v13 keeps one projection per tree OID.

| Structure | v12 pages | v12 bytes | v13 pages | v13 bytes |
| --- | ---: | ---: | ---: | ---: |
| Sources | 173 | 708,608 | 157 | 643,072 |
| Entries | 634 | 2,596,864 | 634 | 2,596,864 |
| Name index | 195 | 798,720 | 195 | 798,720 |
| Effective sources | 135 | 552,960 | 0 | 0 |
| Automatic source indexes | 296 | 1,212,416 | 135 | 552,960 |
| **Combined** | **1,433** | **5,869,568** | **1,121** | **4,591,616** |

The per-OID layout saves 312 pages and 1,277,952 bytes, or 21.7725%. Combined
storage falls from 167.72111 to 131.20402 bytes per immediate entry, a
36.51709-byte reduction. Entry pages are unchanged: both layouts key entries by
the source surrogate.

Logical validation produced the same row counts and layout checksum
`bd5ea2781937ddb7e9876d3850432193484b38984c49b14dc189f81b56ba1681`.
Both layouts completed the traversal profile in 11,070 statements over 34,996
rows with checksum
`18abf0028eac04726a96419e373417ae575c9e6aff0de6e26ac18e7fb0ade82b`.
The exact-name profile found all 2,048 sampled entries in 2,048 statements with
checksum `3620b285ee34c9e9b87428a8006335a4fe21260fd237623e5f3ad9925a08b0e5`.

This measurement isolates SQLite layout size and logical query profiles. It is
`node:sqlite`, not Durable Object SQL, and makes no wall-time or production
runtime claim.

## Clone storage

Measured in one clean run on 2026-09-24 at commit
`62ffbf0fb491731365d9a563437fc6b1d5540d3a`:

```bash
npm run bench:clone-storage
```

The harness re-executes measurement through `cpu-lease run -n 4 --no-smt` and
verified `Cpus_allowed_list=12,14`, two logical CPUs — one for the client, one
for the Smart HTTP origin that runs in the same process. A correctness-only run
uses `npm run bench:clone-storage -- --check` without a lease. Sizes are
`page_count * page_size`, the quantity `SqlStorage.databaseSize` reports on the
platform; the baseline is a real `git clone --depth 1` from the same origin,
counted as apparent bytes per entry. Every run proves its own end state: HEAD,
index entries and worktree files must match the fixture before a size is
reported.

| Fixture | Files | SQLite | git total | SQLite / git | `git.clone` | Checkout | Clone SQL | Clone rows |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| `express` | 218 | 1.62 MiB | 917.2 KiB | 1.81× | 199 ms | 34.2 ms | 137 | 1,276 |
| `tailwind` | 541 | 7.64 MiB | 6.41 MiB | 1.19× | 273 ms | 95.4 ms | 150 | 3,024 |
| `vue` | 1,075 | 14.36 MiB | 12.25 MiB | 1.17× | 465 ms | 224.2 ms | 170 | 6,323 |
| `eslint` | 2,358 | 32.91 MiB | 29.08 MiB | 1.13× | 1,912 ms | 995.5 ms | 222 | 13,960 |
| `prettier` | 9,329 | 44.00 MiB | 30.92 MiB | 1.42× | 2,533 ms | 1,206.9 ms | 365 | 50,716 |
| `nextjs` | 24,252 | 217.78 MiB | 179.89 MiB | 1.21× | 9,890 ms | 4,037.1 ms | 1,012 | 145,777 |

The run passed provenance, end-state, storage, and SQL assertions. Checkout is
the standalone checkout phase of the decomposition below. Wall times are single
samples and a regression signal, not a constant. Small fixtures carry a fixed
schema and repository cost of about 288 KiB, which dominates the `express`
ratio.

Next.js is the row that carries. Its 217.78 MiB is 1.21× what git writes for the
same shallow clone, and the shape of that overhead is the whole story:

| Group | Allocated | Payload | Share |
| --- | ---: | ---: | ---: |
| Working tree (`fs_*`) | 153.55 MiB | 146.79 MiB | 70.5% |
| Pack (`git_pack_*`) | 49.72 MiB | 48.42 MiB | 22.8% |
| Tree projection (`git_tree_*`) | 7.13 MiB | 4.00 MiB | 3.3% |
| Index (`git_index`, `git_blob_ids`) | 7.02 MiB | 6.14 MiB | 3.2% |
| Loose objects | 24.0 KiB | 0.2 KiB | <0.1% |
| Integration scratch | 24.0 KiB | 0 B | <0.1% |
| Maintenance | 24.0 KiB | 0 B | <0.1% |
| Repository | 116.0 KiB | 1.4 KiB | 0.1% |
| Schema | 172.0 KiB | 130.9 KiB | 0.1% |
| **Total** | **217.78 MiB** | **205.48 MiB** | **100.0%** |

The working tree holds the checkout uncompressed, so `fs_chunks` carries
134.25 MiB of payload against the 134.08 MiB git writes to disk — a filesystem
is a filesystem either way. The received pack remains authoritative next to it;
maintenance removes only wholly unreachable packs and does not compact mixed
packs. Derived rows — tree projections, the index and the blob-id cache — cost
14.15 MiB, 6.5% of the database, and are the only part a plain `.git` does not
have an equivalent for. B-tree overhead over the whole database is 5.6%;
`VACUUM` would reclaim a further 2.3%, and Durable Object SQL exposes no
`VACUUM`, so treat that as a diagnostic rather than a plan.

Decomposing the same work — `init`, `fetch`, `updateRef`, `checkout`, each into
its own database — attributes bytes and statements to the two halves:

| Phase | Wall | SQL | Rows | DB after |
| --- | ---: | ---: | ---: | ---: |
| `git.init` + `remoteAdd` | 3.7 ms | 25 | 13 | 500.0 KiB |
| `git.fetch` | 6,165.8 ms | 330 | 68,430 | 57.27 MiB |
| `git.updateRef` | 4.3 ms | 28 | 12 | 57.27 MiB |
| `git.checkout` | 4,037.1 ms | 690 | 101,608 | 217.78 MiB |

This is a decomposition, not the clone path. Both paths use the shared
create-only initial materializer, but the standalone sequence also performs the
separate initialization, fetch, and ref publication phases. Clone uses 1,012
statements; the standalone checkout itself uses 690. Both materialize exactly
24,252 index entries and worktree leaves at the expected HEAD and end at the
same 217.78 MiB database size. Each phase meets the at-most-1,000-statement
target; the clone misses it.
A miss is optimization evidence, not a runtime refusal.

Generated output goes to `bench/results/clone-storage.{json,md}`, which is
gitignored. Update this curated snapshot only from a CPU-leased run.
Superseded snapshots are in
[`../archive/benchmarks/`](../archive/benchmarks/README.md).
