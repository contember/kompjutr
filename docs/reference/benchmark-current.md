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
