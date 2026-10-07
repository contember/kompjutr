# Fast fresh clone

Proposal, no commitment. Measured on 2026-10-07 at `8bd064f`.

## Target

The Next.js v15.5.2 full-history `blob:none` clone takes 197.0 s; native Git
takes 17.2–18.9 s on the same origin and lease (6.5–8.0 s metadata, about
11 s checkout with blob hydration). A Durable Object request also has a CPU
limit (30 s by default), so today's clone cannot run as one production request.

Proposed targets:

- **≤ 60 s** for the whole clone after the three storage changes below.
- **≤ 30 s** as the stretch goal, which also needs the CPU work in
  [Beyond the storage changes](#beyond-the-storage-changes).
- Every request stays within the platform CPU limit, which needs a resumable,
  sliced clone regardless of speed.

## Where the time goes

One instrumented run: `cpu-lease run -n 2 --no-smt`, fresh persistence, CDP CPU
profile at 1 ms, per-statement native counters. It reproduced the reference
6,414 statements and 537,990 returned rows. The isolate was busy 204.2 s, of
which **138.1 s (68 %) is native SQL execution**. Wall times from this day are
noisy (load average ~17; clean runs 235 s and 265 s), so use shares, not
absolute seconds.

| Region | Isolate s | Native rows read / written |
|---|---:|---:|
| Tree projection writes (`TreeIndexBatch.flush`, seeds, markers) | 43.6 | 35.4 M / 14.3 M |
| Tree parsing and buffering for projections | 22.5 | — |
| Connectivity failures query (one statement) | 50.2 | 25.1 M / 0 |
| Deferred deltas, JS (pako 5.4, SHA-1 2.9, header probe 3.6) | 17.8 | 1.6 M / 0.2 M |
| Pack object rows (`git_pack_entries`, `git_pack_objects`) | 16.7 | 1.4 M / 1.7 M |
| Promise registration + publication-time promise DELETE | 15.3 | 14.9 M / 0.2 M |
| First pass (inflate, hash) | 8.3 | — |
| GC | 7.4 | — |
| Commit projection | 4.2 | 0.3 M / 0.1 M |
| Hydration, blob ingest, checkout, the rest | ~18 | — |

All codec, hash and text-decode work together is 23.0 s: the most that native
SHA-1 or Wasm can touch before the storage changes. SHA-1 alone is 5.85 s.

HEAD's checkout reaches 11,027 unique trees with 34,746 entries: **0.52 %** of
the 6,689,426 projected entry rows.

## Proposal

The three changes remove work native Git never does. They are coupled:
connectivity and promise registration read the historical projections, so
dropping (1) forces (2) and (3).

1. **Lazy historical tree projections.** At clone, project only the trees the
   HEAD checkout reaches. Project any other tree on first read from its pack
   bytes, inside the reading operation's transaction. Removes about 43–66 s.
2. **Implicit promises.** A blob referenced by a tree in a promisor pack is
   promised without a `git_promised_blobs` row, as in Git's promisor-pack
   rule. Explicit rows remain for promises without such a pack. Removes about
   15 s.
3. **Pack-local connectivity for a fresh clone.** When the repository had no
   objects before the fetch, verify during ingest that every reference from
   the pack's commits and trees resolves inside the pack, to a shallow
   boundary, to a gitlink, or to a promised blob. This is Git's
   `--check-self-contained-and-connected`. Incremental fetches keep the
   current SQL check. Removes about 52 s.

Expected result: about 70 s of isolate time remains. With hydration transfer
on top, the clone lands near 60–80 s.

### Beyond the storage changes

- **Pack object rows (16.7 s).** Two `INSERT OR IGNORE` statements per object
  batch, 338k objects. Check whether one table can carry both roles at ingest.
- **Codec and hash kernel (≤ 23 s).** First native `node:crypto` SHA-1 (at
  most 4–5 s). Then remove the second pako inflater per delta (header probe
  plus apply, ~2 s). A fused Wasm inflate → delta → SHA-1 kernel is the last
  step and is worth measuring only after the items above.
- **Resumable, sliced clone.** Persist ingest progress so each request does a
  bounded slice under the CPU limit; continue through alarms.

## Decisions this needs

- Changes (1) and (2) change the stored-row model and its trust premise
  ([ADR-0003](../decisions/0003-split-the-shared-git-store-from-checkouts.md) row ownership,
  [ADR-0004](../decisions/0004-trust-stored-rows-validate-at-the-boundary.md)
  trusted reads): a reader would project an authenticated pack tree on demand,
  and promise status would derive from pack membership.
- Change (3) needs a precise definition of "fresh" (no objects, no refs, no
  promisor packs) and must keep every rejection the current check makes.
- Maintenance must treat lazily projected trees and implicit promises as it
  treats today's rows.

## Measurement evidence

Scratch artifacts, not portable fixtures:
a scratch directory (`profile118/`: `out-instr/analysis.md`,
`cpu.cpuprofile`, `sql.json`) and `reprofile/` (the harness used
for the 428.8 s → 197.0 s comparison and `native.sh`).
