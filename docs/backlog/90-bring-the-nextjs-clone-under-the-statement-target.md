---
id: 90
title: Bring the Next.js clone under the statement target
blocked-by: []
---

# 90 — Bring the Next.js clone under the statement target

**Summary.** One public 24,252-file clone costs 1,012 SQL statements over
145,777 rows at `62ffbf0`, 12 over the repository's 1,000-statement target. It
was 996 at the 2026-09-10 sprint's starting commit.

## Problem

Measured on the real Next.js fixture with `bench:nextjs`, `bench:workerd:nextjs`
and `bench:clone-storage`; all three report 1,012 statements and 145,777 rows.
The network benchmark's clone, which passes `depth: 0` and `noTags: true`
instead of `ref` and `depth: 1`, reports 1,006.

| commit | statements | rows read |
|---|---:|---:|
| `acf7289` 2026-09-10 sprint start | 996 | 145,778 |
| `491189b` canonical pack dependency validation | 1,833 | 214,375 |
| 2026-09-10 sprint closure | 1,031 | 164,287 |
| `4c333ce` 2026-09-23 histogram | 1,029 | 164,285 |
| simplification WU12, self-contained packs, admission deleted | 1,004 | 145,778 |
| simplification WU14 review, tree index flushes objects first | 1,014 | — |
| `62ffbf0` | 1,012 | 145,777 |

The 2026-09-10 excursion was ADR-0023 pack graph admission, which the
simplification sprint deleted with self-contained packs. The miss that remains
is not in one subsystem. The clone's 1,012 statements at `62ffbf0` split as:

| Family | Statements |
|---|---:|
| Worktree materialization (`fs_chunks`, `fs_nodes`, `fs_paths`, DOFS index mutations) | 437 |
| Blob reads for checkout (promise checks, loose/pack location, read graph, pack data) | 215 |
| Pack ingest (pack data, entries, objects, pending deltas) | 187 |
| Tree projection (`git_tree_sources`, `git_tree_entries`) | 62 |
| Refs and reflogs, including 5 full ref listings | 23 |
| Config (4 keys, each a read plus DELETE+INSERT) | 13 |
| Git index and blob ids | 12 |
| Mutation guard (`git_meta` insert/delete pairs) | 10 |
| Repository, checkout, fetch-namespace, shallow, ingest-control and maintenance bookkeeping | 53 |

The 1,000-statement figure is an [ADR-0005](../decisions/0005-bound-real-failures-and-measure-cost.md)
target, not a runtime bound, and `--check` reports the miss without failing.
Nothing refuses work because of it.

## Approach / acceptance

The batch-sized families (materialization, blob reads, ingest, projection)
scale with the fixture and are already structurally bounded. The candidates
are the fixed per-mutation costs: the five mutation-guard pairs (10), config
keys written as DELETE+INSERT (8 of 13), five full ref listings, the reflog
retention prunes run on every ref-mutation transaction, and the maintenance
epoch bumped four times. Several of these together reach the target with
margin.

Do not reach the target by raising a page or batch size alone; that trades
rows or retained bytes for statements, which the row gate and the memory
benchmarks would catch.

Witness: `nextjs:git.clone` reports `pass` against the 1,000-statement target
with rows read no higher than 145,777 × 1.10, the clone's native oracles
unchanged, and the workerd clone reporting the same count.

## Touch points

`packages/git/src/ops/network/`, `packages/git/src/store/pack/ingest/`,
`packages/git/src/store/refs/`, `packages/git/src/store/repository/`,
`bench/statements.ts`.

<!-- Origin: sprint-2026-09-10 closure, 2026-09-22 clone attribution; remeasured at the 2026-09-23 simplification closure. -->
