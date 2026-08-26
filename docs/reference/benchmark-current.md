# Current benchmark snapshot

Measured 2026-08-24 at commit `a531efa` on Linux 6.17 and Node 24.4.0:

```bash
cpu-lease run -n 2 --no-smt -- npm run bench:nextjs
```

The fixture is `vercel/next.js` at `v15.5.2`, rebuilt as one shallow-cloneable
commit with 24,252 tracked files. SQLite uses a temporary file. The local Smart
HTTP origin is prepared outside measurement. Each phase resets SQLite counters
and the process RSS high-water mark.

This is `node:sqlite`, not Durable Object SQL. Statement counts transfer to the
platform cost model. Local wall time and process RSS are regression signals, not
proof of a production isolate limit.

## Results

| Operation | Wall | SQL | Rows | Peak RSS added |
| --- | ---: | ---: | ---: | ---: |
| `git.clone` | 11,669.9 ms | 791 | 78,526 | 245.6 MiB |
| `git.status` — clean clone | 1.9 ms | 8 | 7 | 0.0 MiB |
| `git.branch` | 1.5 ms | 8 | 5 | 0.0 MiB |
| `fs.writeFiles` — 100 | 21.7 ms | 6 | 288 | 1.3 MiB |
| `git.status` — 100 modified | 79.4 ms | 27 | 1,402 | 3.0 MiB |
| `git.diffSummary` — 100 | 96.7 ms | 27 | 1,947 | 0.2 MiB |
| `git.diff` — 100 | 67.1 ms | 26 | 1,945 | 0.4 MiB |
| `git.add` — 100 | 656.4 ms | 245 | 31,380 | 3.4 MiB |
| `git.status` — 100 staged | 43.8 ms | 24 | 1,056 | 0.3 MiB |
| `git.commit` — 100 | 496.2 ms | 31 | 24,301 | 5.6 MiB |
| `git.push` — 100 | 871.5 ms | 17 | 730 | 4.9 MiB |
| `git.status` — clean commit | 502.2 ms | 23 | 1,156 | 0.0 MiB |
| `git.checkout main` | 519.8 ms | 51 | 1,551 | 0.0 MiB |
| `git.checkout main --force` | 7.1 ms | 31 | 16 | 0.0 MiB |
| `git.status` — clean main | 0.7 ms | 9 | 7 | 0.0 MiB |
| `git.checkout bench-work` | 526.5 ms | 51 | 1,750 | 0.0 MiB |
| `git.checkout bench-work --force` | 6.7 ms | 27 | 16 | 0.0 MiB |
| `git.status` — clean work | 0.7 ms | 8 | 7 | 0.0 MiB |

Every phase stays below the 1,000-statement operation ceiling. Push uses 17
statements and adds 4.9 MiB of process RSS for the 100-file change. Clone remains
the local memory hotspot: its 245.6 MiB RSS delta does not establish production
isolate usage, while its 791 statements stay within the SQL ceiling.

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

Measured 2026-08-26 at commit `4f64cf9` with a clean `src` tree, Node v24.4.0
and SQLite 3.50.2 on Linux 6.17.0-41-generic x64 and an AMD Ryzen 7 PRO 8840HS:

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

| Fixture | Files | SQLite | `.git` | Worktree | git total | SQLite / git | `git.clone` | `git clone` | SQL |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| `express` | 218 | 1.42 MiB | 229.1 KiB | 688.1 KiB | 917.2 KiB | 1.59× | 175 ms | 86 ms | 74 |
| `tailwind` | 541 | 7.44 MiB | 1.12 MiB | 5.30 MiB | 6.41 MiB | 1.16× | 260 ms | 146 ms | 86 |
| `vue` | 1,075 | 14.15 MiB | 2.51 MiB | 9.75 MiB | 12.25 MiB | 1.15× | 484 ms | 244 ms | 103 |
| `eslint` | 2,358 | 32.70 MiB | 6.61 MiB | 22.47 MiB | 29.08 MiB | 1.12× | 1,130 ms | 506 ms | 150 |
| `prettier` | 9,329 | 43.91 MiB | 7.99 MiB | 22.93 MiB | 30.92 MiB | 1.42× | 2,554 ms | 912 ms | 262 |
| `nextjs` | 24,252 | 218.04 MiB | 45.81 MiB | 134.08 MiB | 179.89 MiB | 1.21× | 10,998 ms | 2,906 ms | 813 |

Sizes and statement counts are byte-identical across repeated runs. Wall time is
not: three leased runs of the same ladder put `nextjs` at 9,715, 10,745 and
10,998 ms and `eslint` at 1,117, 1,876 and 1,130 ms while every size stayed the
same. Read the times as a regression signal, not a constant — and never read a
sub-second improvement out of this column.

Next.js is the row that carries. Its 218.04 MiB is 1.21× what git writes for the
same shallow clone, and the shape of that overhead is the whole story:

| Group | Allocated | Payload | Overhead | Share |
| --- | ---: | ---: | ---: | ---: |
| Working tree (`fs_*`) | 153.55 MiB | 146.79 MiB | 4.4% | 70.4% |
| Pack (`git_pack_*`) | 45.85 MiB | 45.19 MiB | 1.4% | 21.0% |
| Tree projection (`git_tree_*`) | 11.45 MiB | 6.50 MiB | 43.2% | 5.3% |
| Index (`git_index`, `git_blob_ids`) | 7.01 MiB | 6.14 MiB | 12.4% | 3.2% |
| Repository and schema | 160.0 KiB | 70.5 KiB | 55.9% | 0.1% |
| **Total** | **218.04 MiB** | **204.69 MiB** | **6.1%** | 100.0% |

The working tree holds the checkout uncompressed, so `fs_chunks` carries
134.25 MiB of payload against the 134.08 MiB git writes to disk — a filesystem
is a filesystem either way. The pack is retained verbatim next to it, which is
why the total is above git's: nothing yet drops the pack after checkout, and
[repack and garbage collection](../backlog/04-repack-and-garbage-collection.md)
is where that would change. Derived rows — tree projections, the index and the
blob-id cache — cost 18.46 MiB, 8.5% of the database, and are the only part a
plain `.git` does not have an equivalent for. B-tree overhead over the whole
database is 6.1%; `VACUUM` would reclaim a further 2.9%, and Durable Object SQL
exposes no `VACUUM`, so treat that as a diagnostic rather than a plan.

Decomposing the same work — `init`, `fetch`, `updateRef`, `checkout`, each into
its own database — attributes bytes and statements to the two halves:

| Phase | SQL | Rows | DB after | Added |
| --- | ---: | ---: | ---: | ---: |
| `git.init` + `remoteAdd` | 11 | 3 | 300.0 KiB | 300.0 KiB |
| `git.fetch` | 206 | 1,201 | 57.54 MiB | 57.24 MiB |
| `git.updateRef` | 19 | 7 | 57.54 MiB | 0.0 KiB |
| `git.checkout` | 1,117 | 155,446 | 218.07 MiB | 160.53 MiB |

This is a decomposition, not the clone path: `clone` takes an initial-checkout
fast path only a fresh repository can take, which is why it needs 813 statements
where the decomposed sequence needs 1,353. The decomposed total lands within
28 KiB of the clone's, so the attribution holds. **A standalone `git.checkout`
that materialises 24,252 files uses 1,117 statements and exceeds the
1,000-statement operation budget.** `clone` does not hit it and neither does a
branch switch in an already-materialised tree — the nextjs workflow's
`git.checkout main` costs 51 — but a checkout into an empty worktree does.

Generated output goes to `bench/results/clone-storage.{json,md}`, which is
gitignored. Update this curated snapshot only from a CPU-leased run.
