---
id: 0026
title: Gate the workerd clone on a V8 regression limit
status: accepted
date: 2026-09-28
---

# 0026 — Gate the workerd clone on a V8 regression limit

## Context

`npm run bench:workerd:nextjs` clones the Next.js fixture (24,252 files, a
42 MiB pack) inside a SQLite Durable Object on local workerd. Its gate failed
when the clone added more than 100 MiB of process RSS. The gate failed in every
run: in the five WU4 runs below, the clone added 367.6–468.0 MiB of RSS.

Process RSS on local workerd does not measure the production 128 MB isolate
limit. Local workerd has no isolate memory limiter. RSS also holds SQLite,
allocator and runtime memory, which the isolate limit does not count.

The isolate limit counts V8 heap and V8 external memory. External memory holds
ArrayBuffer backing stores, so every `Uint8Array` that kompjutr allocates counts
against the isolate.

WU3 of sprint-2026-09-28-memory-and-cost split the clone's memory with V8's
`--trace-gc --trace-gc-verbose` output. Forced GCs bracket the clone. Each V8 value
is a sample at a GC event, so each V8 peak is a lower bound. Three leased runs
(`cpu-lease run -n 2`) of the harness that landed as `2b2002c`, with cgroup
`memory.max` = `max` (no limit) and `workerd` 1.20260820.1, gave the numbers
below. The clone then ran 1,012 statements. A reviewer's run of the same harness
is shown apart.

| Measure | Three runs, MiB | Review run, MiB |
| --- | --- | ---: |
| Peak V8 used | 44.1–52.0 | 58.8 |
| Peak V8 external | 187.5–227.2 | 325.0 |
| Peak V8 used + external | 219.1–279.2 | 355.9 |
| Added process RSS | 354.1–405.9 | 493.7 |
| Non-V8 residue added after a forced GC | 191.1–243.7 | 245.7 |

External memory is material. It is 4.5–7.7× the pack and several times V8 used.
The sprint had planned a gate of V8 used + external below 100 MiB. No gate at
the production limit can pass today. The local numbers suggest that the clone
does not fit the production isolate, but nobody has measured how the production
limiter counts and when it checks.

The sprint plan required a stop and a re-gate with the user if the sum did not fit.
At that escalation the user chose a V8 measurement with a regression limit at
today's level, and a backlog item for the external memory.

## Decision

We gate the workerd clone on a **regression limit**, not on a production claim.

- **The gated measure** is `clone.v8.peakUsedPlusExternalBytes`: the highest V8
  heap used before a GC plus the external counter after that GC, over every GC
  of the clone isolate between the two forced GCs. A GC can only lower the
  external counter, so the sum is a lower bound on the true peak.
- **The limit** is `V8_USED_PLUS_EXTERNAL_LIMIT_BYTES` in `bench/workerd/run.ts`:
  450 MiB. It is today's level with a margin. Five leased runs at `555ee0d`
  (898 statements, 145,777 rows, `memory.max` = `max`) measured 238.4, 241.2,
  277.8, 363.3 and 225.6 MiB. The limit is the maximum × 1.2, rounded up to
  25 MiB.
- **Process RSS is report-only.** The harness still prints baseline, peak and
  added RSS, the sampled anonymous and file peaks, and the non-V8 residue.
- **Correctness stays hard.** A clone result with invalid counts, or a checkout
  that fails the oracle (HEAD, 24,252 tracked and worktree files, no invalid
  file), fails the run.

The limit catches a regression. It does not say that the clone fits the
production isolate. [Backlog 106](../backlog/106-reduce-the-workerd-clone-external-memory.md)
owns that question and the external memory.

## Consequences

- The workerd benchmark can pass, so a large regression in V8 memory now fails it.
- A drop in external memory must lower the limit in the same change. Otherwise
  the limit drifts away from today's level.
- The measure is a lower bound from GC samples. A short spike between two GCs
  is invisible.
- The run-to-run spread is wide. Four of the five runs measured 226–278 MiB and
  one measured 363 MiB, like the WU3 review run. A limit above the high runs
  lets a typical run grow by almost 2× before it fails, so the limit catches
  large regressions only.
- A draft of the WU3 harness measured 399.9 MiB at `06de5e5`, 89% of the limit.
  A failure near 450 MiB may be spread, not a regression; rerun before blaming
  the change.
- The production 128 MB question stays open until backlog 106 attributes and
  reduces the external memory, or a production probe answers it.

## Alternatives considered

- **Keep the 100 MiB RSS gate.** It measured memory that the isolate does not
  count and failed in every run, so it gated nothing.
- **Gate V8 used + external below 100 MiB, the planned gate.** Today's clone is
  more than twice that. The gate would only fail until the external memory is
  reduced, which is backlog work, not a gate.
- **Gate V8 used only, or run under `--max-old-space-size`.** Both ignore
  external memory, the largest part of what the isolate counts. The plan's
  `--max-semi-space-size=8` pin belonged to that old-space gate, so the harness
  passes only the GC trace flags. Nobody measured whether the pin narrows the
  run-to-run spread.
- **Report only, with no limit.** Nothing would catch a regression while
  backlog 106 is open.
