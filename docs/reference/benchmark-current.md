# Current benchmark snapshot

Measured in three clean runs on 2026-08-27 at commit
`d03aa708af926d3590fc4903bc6946b38698be7e` with Node v24.4.0, SQLite 3.50.2,
git 2.54.0, Linux 6.17.0-41-generic x64, and an AMD Ryzen 7 PRO 8840HS:

```bash
cpu-lease run -n 2 --no-smt -- npm run bench:nextjs
```

The harness held two vCPUs with SMT siblings excluded. The fixture is
`vercel/next.js` at `v15.5.2`, rebuilt as one shallow-cloneable commit with
24,252 tracked files. SQLite uses a temporary file. The local Smart HTTP origin
is prepared outside measurement. Each phase resets SQLite counters and the
process RSS high-water mark. Wall values below are the median of three runs;
statement and returned-row counts were identical in all three.

This is `node:sqlite`, not Durable Object SQL. Statement counts transfer to the
platform cost model. Local wall time and process RSS are regression signals, not
proof of a production isolate limit.

## Results

| Operation | Median wall | SQL | Rows |
| --- | ---: | ---: | ---: |
| `git.clone` | 11,628.592 ms | 824 | 78,537 |
| `git.status` — clean clone | 2.461 ms | 9 | 7 |
| `git.branch` | 4.050 ms | 23 | 13 |
| `fs.writeFiles` — 100 | 23.206 ms | 6 | 288 |
| `git.status` — 100 modified | 1,234.155 ms | 59 | 49,538 |
| `git.diffSummary` — 100 | 74.973 ms | 28 | 1,574 |
| `git.diff` — 100 | 65.242 ms | 27 | 1,572 |
| `git.add` — 100 | 75.338 ms | 15 | 1,752 |
| `git.status` — 100 staged | 1,176.031 ms | 58 | 49,192 |
| `git.commit` — 100 | 55.527 ms | 38 | 717 |
| `git.push` — 100 | 414.325 ms | 29 | 738 |
| `git.status` — clean commit | 29.487 ms | 23 | 683 |
| `git.checkout main` | 87.534 ms | 59 | 819 |
| `git.checkout main --force` | 70.305 ms | 60 | 919 |
| `git.status` — clean main | 0.723 ms | 10 | 7 |
| `git.checkout bench-work` | 71.178 ms | 59 | 1,018 |
| `git.checkout bench-work --force` | 78.531 ms | 59 | 1,018 |
| `git.status` — clean work | 0.791 ms | 9 | 7 |

Every phase stayed below the 1,000-statement operation ceiling in all three
runs, and every operation and status assertion passed. Every one of the three
runs for each required row was below 100 ms: maxima were 76.957 ms for add,
58.832 ms for commit, 29.558 ms for clean post-commit status, 89.446 ms for
checkout to main, and 79.682 ms for checkout to bench-work. Both real force
transitions were also below 100 ms in all three runs, with maxima of 72.793 and
98.198 ms. The modified and staged status rows remain full-repository paths and
do not meet that wall target.

The harness writes detailed generated output to `bench/results/`, which is
gitignored. Update this curated snapshot only from a CPU-leased run. Historical
pre-standalone comparisons remain in
[`../archive/benchmarks/`](../archive/benchmarks/README.md).

## Tree-schema storage

Measured 2026-08-26 at benchmark commit `6890f53` with Node v24.4.0 and
SQLite 3.50.2 on Linux 6.17.0-41-generic x64 and an AMD Ryzen 7 PRO 8840HS:

```bash
npm run bench:tree-schema
```

The harness re-executes measurement through `cpu-lease run -n 2 --no-smt` and
verified `Cpus_allowed_list=10`, one logical CPU. A correctness-only run uses
`npm run bench:tree-schema -- --check` without a lease. Both layouts contain the
same parsed data from Next.js v15.5.2 at revision
`381a9c8089ed7a244dcfa374fbb27d37032e208a`: 24,252 tracked paths, 11,070 tree
sources, 34,996 immediate entries, and 11,070 effective sources.

| Structure | v11 pages | v11 bytes | v12 pages | v12 bytes |
| --- | ---: | ---: | ---: | ---: |
| Sources | 163 | 667,648 | 173 | 708,608 |
| Entries | 1,536 | 6,291,456 | 1,001 | 4,100,096 |
| Name index | 585 | 2,396,160 | 195 | 798,720 |
| Effective sources | 144 | 589,824 | 135 | 552,960 |
| Automatic source indexes | 0 | 0 | 296 | 1,212,416 |
| **Combined** | **2,428** | **9,945,088** | **1,800** | **7,372,800** |

The source-surrogate layout saves 628 pages and 2,572,288 bytes, or 25.8649%.
Combined storage falls from 284.17785 to 210.67551 bytes per immediate entry, a
73.50234-byte reduction. The total includes the two v12 source-key indexes, so
the result does not hide the surrogate's added indexing cost.

Logical validation produced the same row counts and layout checksum
`86c7c1c52823ea97e6b1163abaa06c2f16402e2c796fa2b729c9acf1c6c349b5`.
Both layouts completed the traversal profile in 11,070 statements over 34,996
rows with checksum
`86cafc000db99382db9972c47129ee5827266564f8bdb1633197cd13f947f309`.
The exact-name profile found all 2,048 sampled entries in 2,048 statements with
checksum `312271501c79dd9cb5d888ea75be8b4c9fc13b3b2f2f756bf11f9a1c2b886619`.

This measurement isolates SQLite layout size and logical query profiles. It is
`node:sqlite`, not Durable Object SQL, and makes no wall-time or production
runtime claim.


## Clone storage

Measured in three clean runs on 2026-08-27 at commit
`d03aa708af926d3590fc4903bc6946b38698be7e` with Node v24.4.0, SQLite 3.50.2,
git 2.54.0, Linux 6.17.0-41-generic x64, and an AMD Ryzen 7 PRO 8840HS:

```bash
npm run bench:clone-storage
```

The harness re-executes measurement through `cpu-lease run -n 4 --no-smt` and
verified `Cpus_allowed_list=8,10`, two logical CPUs — one for the client, one
for the Smart HTTP origin that runs in the same process. A correctness-only run
uses `npm run bench:clone-storage -- --check` without a lease. Sizes are
`page_count * page_size`, the quantity `SqlStorage.databaseSize` reports on the
platform; the baseline is a real `git clone --depth 1` from the same origin,
counted as apparent bytes per entry. Every run proves its own end state: HEAD,
index entries and worktree files must match the fixture before a size is
reported.

| Fixture | Files | SQLite | git total | SQLite / git | `git.clone` median | Checkout median | Clone SQL |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| `express` | 218 | 1.46 MiB | 917.2 KiB | 1.63× | 167.272 ms | 30.614 ms | 85 |
| `tailwind` | 541 | 7.47 MiB | 6.41 MiB | 1.16× | 253.542 ms | 104.934 ms | 97 |
| `vue` | 1,075 | 14.18 MiB | 12.25 MiB | 1.16× | 509.732 ms | 250.671 ms | 114 |
| `eslint` | 2,358 | 32.73 MiB | 29.08 MiB | 1.13× | 1,503.573 ms | 583.589 ms | 161 |
| `prettier` | 9,329 | 43.95 MiB | 30.92 MiB | 1.42× | 3,286.099 ms | 1,417.923 ms | 273 |
| `nextjs` | 24,252 | 218.07 MiB | 179.89 MiB | 1.21× | 9,151.759 ms | 5,339.358 ms | 824 |

All three runs passed provenance, end-state, storage, and SQL assertions. Sizes,
facts, and statement counts were identical. Wall time is a regression signal,
not a constant.

Next.js is the row that carries. Its 218.07 MiB is 1.21× what git writes for the
same shallow clone, and the shape of that overhead is the whole story:

| Group | Allocated | Payload | Share |
| --- | ---: | ---: | ---: |
| Working tree (`fs_*`) | 153.55 MiB | 146.79 MiB | 70.4% |
| Pack (`git_pack_*`) | 45.85 MiB | 45.19 MiB | 21.0% |
| Tree projection (`git_tree_*`) | 11.45 MiB | 6.50 MiB | 5.3% |
| Index (`git_index`, `git_blob_ids`) | 7.01 MiB | 6.14 MiB | 3.2% |
| Loose objects | 20.0 KiB | 170 B | <0.1% |
| Repository | 100.0 KiB | 1.4 KiB | <0.1% |
| Schema | 96.0 KiB | 76.7 KiB | <0.1% |
| **Total** | **218.07 MiB** | **204.70 MiB** | **100.0%** |

The working tree holds the checkout uncompressed, so `fs_chunks` carries
134.25 MiB of payload against the 134.08 MiB git writes to disk — a filesystem
is a filesystem either way. The live received pack remains authoritative next
to it; maintenance removes only wholly unreachable packs and does not compact
mixed packs. Derived rows — tree projections, the index and the blob-id cache —
cost 18.46 MiB, 8.5% of the database, and are the only part a plain `.git` does
not have an equivalent for. B-tree overhead over the whole database is 6.1%;
`VACUUM` would reclaim a further 2.9%, and Durable Object SQL exposes no
`VACUUM`, so treat that as a diagnostic rather than a plan.

Decomposing the same work — `init`, `fetch`, `updateRef`, `checkout`, each into
its own database — attributes bytes and statements to the two halves:

| Phase | Median wall | SQL | Rows | DB after |
| --- | ---: | ---: | ---: | ---: |
| `git.init` + `remoteAdd` | 3.907 ms | 16 | 6 | 336.0 KiB |
| `git.fetch` | 4,100.493 ms | 208 | 1,202 | 57.57 MiB |
| `git.updateRef` | 2.278 ms | 23 | 8 | 57.57 MiB |
| `git.checkout` | 5,339.358 ms | 608 | 77,340 | 218.07 MiB |

This is a decomposition, not the clone path. Both paths use the shared
create-only initial materializer, but the standalone sequence also performs the
separate initialization, fetch, and ref publication phases. Clone uses 824
statements; the standalone checkout itself uses 608. Both materialize exactly
24,252 index entries and worktree leaves at the expected HEAD. Each final state
has the same 228,667,392-byte allocated database size. Both stay below the
1,000-statement operation budget.

Generated output goes to `bench/results/clone-storage.{json,md}`, which is
gitignored. Update this curated snapshot only from a CPU-leased run.
