---
id: 90
title: Bring the Next.js clone under the statement target
blocked-by: []
---

# 90 — Bring the Next.js clone under the statement target

**Summary.** One public 24,252-file clone costs 1,031 SQL statements, over the
repository's 1,000-statement target. It was 996 at the 2026-09-10 sprint's
starting commit, so the miss was introduced by that sprint and is 31 statements
wide.

## Problem

Measured at HEAD on the real Next.js fixture, per-commit against each direct
parent:

| commit | statements | rows read |
|---|---:|---:|
| `acf7289` sprint start | 996 | 145,778 |
| `491189b` canonical pack dependency validation | 1,833 | 214,375 |
| `e7d31b0` admission page 256 -> 4,096 | 1,067 | 214,485 |
| `924fb06` source generation | 1,068 | 214,486 |
| HEAD with the narrowed admission seed | 1,031 | 164,287 |
| 2026-09-23 self-contained packs, admission deleted | 1,004 | 145,778 |

The whole excursion was ADR-0023 admission, since deleted with self-contained
packs; the clone is still 4 statements over the target. `491189b` added 827
statements, `e7d31b0` returned 766 of them by matching the production page to
the read graph's, and narrowing the seed to delta participants returned a
further 36 along with 50,198 rows. What is left
is the residue of a validation the clone did not previously perform, plus one
statement per batch flush from ADR-0025's source generation.

The 1,000-statement figure is an [ADR-0005](../decisions/0005-bound-real-failures-and-measure-cost.md)
target, not a runtime bound, and `--check` reports the miss without failing.
Nothing refuses work because of it.

## Approach / acceptance

A clone histogram at `4c333ce` (1,029 statements, 2026-09-23) shows the
residue is not in admission: pack graph admission is ~25 statements in total.
The candidates are small per-mutation costs — five mutation-guard pairs (10),
four config keys written as DELETE+INSERT each (8), user identity read twice per
reflog writer (4), two ref-mutation transactions each listing all refs, pruning
reflogs and bumping epochs (~10), and five full ref listings. Several of these
together reach the target; admission changes alone do not.

The original plan, kept for reference:
The admission walk is now seeded at 5,233 of 30,613 objects, so the question is
no longer how many objects it visits but how many statements one bounded page
costs — six query shapes per page plus the scratch lifecycle. Check whether the
reverse and forward passes can share a page, and whether the scratch table
create/delete pair can be hoisted out of the per-clone path.

Do not reach the target by raising `GRAPH_PAGE` again: 4,096 already matches
`MAX_PACK_BLOB_GRAPH_ENTRIES`, and raising it trades rows for statements in a
way the row gate would catch.

Witness: `nextjs:git.clone` reports `pass` against the 1,000-statement target
with rows read no higher than 164,287, the clone's native oracles unchanged,
and every admission rejection witness still green.

## Touch points

`packages/git/src/store/pack/graph/`, `packages/git/src/store/pack/ingest.ts`,
`packages/git/src/store/schema/schema-pack-graph-statements.ts`,
`bench/statements.ts`.

<!-- Origin: sprint-2026-09-10 closure, 2026-09-22 clone attribution. -->
