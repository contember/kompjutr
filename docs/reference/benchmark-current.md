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
