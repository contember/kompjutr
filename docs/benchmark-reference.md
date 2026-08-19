# Benchmark reference

The comparison target and the measurement rules come from an earlier experiment
that optimised DOFS *underneath* Computer's isomorphic-git client
(`perf/nextjs-macro-benchmark`). Its report is the baseline this package has to
beat, and its methodology notes are the ones to inherit.

## What that experiment established

- **The binding limit is not DOFS.** `git.commit` — and anything needing a full
  `git.add` as setup — exhausts the Durable Object isolate memory between **535
  and 985 tracked files**, *identically on both revisions*. The cause is
  isomorphic-git's index handling: the whole `.git/index` is materialised in the
  isolate. Optimising the filesystem underneath does not move this ceiling.
- **`git.status` on `main` costs about 30 SQL statements per tracked file and
  grows linearly** — 293,013 statements for 9,329 files (Prettier 3.9.6, local).
  The optimised DOFS branch does the same walk in 49.
- **Checkout ceiling:** `main` cannot check out 7,418 files in one request
  (storage timeout); the optimised branch can. Both fail at 9,329.

This package attacks the ceiling the DOFS work could not: the index is rows, so
staging never materialises one binary blob, and the object database is read a
chunk at a time.

## Targets

| Workload | `main` (isomorphic-git) | Optimised DOFS | kompjutr target |
| --- | --- | --- | --- |
| `status` packed, 9,329 files | 293,013 stmt / 2.77 s | 49 stmt / 1.77 s | bounded by tracked-file count, not pack size |
| `add --all`, 9,329 files | 605,482 stmt / 33.3 s | 27,296 stmt / 11.3 s | no full-index materialisation |
| `commit`, 9,329 files | 59,489 stmt / 8.74 s | 901 stmt / 1.90 s | must not OOM at 985 files |
| `commit` ceiling | 535–985 files | 535–985 files | **the number to beat** |
| Checkout ceiling | 4,925–7,418 files | ≥ 7,418 files | ≥ 9,329 files |

## Measurement rules inherited

1. **Wall time reported from inside a Worker is not a duration.** Cloudflare only
   advances timers at an I/O boundary, so a Durable Object cannot time
   synchronous SQLite work. Statement counts and rows read are the primary
   metrics; wall time is only meaningful from local runs.
2. **Statement counts are deterministic; rows read are stable to about three
   significant figures.** Report both, never round rows up to a claim.
3. **Small fixtures mislead.** Batching and read-ahead have a fixed cost a tiny
   tree cannot amortise — the earlier run showed an apparent rows *regression* at
   79 and 535 files that disappears at 9,329. Never headline a small-fixture
   number.
4. **`paths` bounds the checkout, not the fetch.** A subtree clone still
   downloads every blob, so subtree fixtures measure the whole repository's pack.
5. **Compare like with like.** Legacy-vs-legacy for git operations; never across
   filesystem modes.
6. Local `vitest-pool-workers` runs need a `compatibility_date` the bundled
   `workerd` supports — `2026-05-26` in that repo. A date set to "today" makes the
   local benchmark unrunnable.

## Fixtures

Chosen through the GitHub tree API, no cloning. File count drives statement
counts; blob volume and file count together decide whether a run survives.

| Repo | Tag | Files | Total MB | Median file |
| --- | --- | ---: | ---: | ---: |
| prettier/prettier | 3.9.6 | 9,329 | 24.0 | 219 B |
| eslint/eslint | v10.8.1 | 2,358 | 23.6 | 1,810 B |
| vuejs/core | v3.6.0-rc.4 | 1,075 | 10.2 | 2,532 B |
| tailwindlabs/tailwindcss | v4.3.3 | 541 | 5.6 | 2,001 B |
| expressjs/express | v5.2.1 | 218 | 0.7 | 1,033 B |
| vercel/next.js | v15.5.2 | 24,252 | 140.6 | 343 B |

Prettier is `tests`-heavy (8,264 of 9,329 files), which gives a clean size sweep
by adding `tests/format` subtrees to a `src` base.

Source report: `/tmp/computer-benchmark-report/report.md` (raw data alongside it).
