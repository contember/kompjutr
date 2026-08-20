# Benchmark results

Measured 2026-08-20 on Linux 6.17, node 24.4, every run under `cpu-lease -n 4`.
Files are 4,096 bytes. "flat" puts every file in one directory; "deep" fans out
twenty per directory. Reproduce with `npm run bench`.

**This is `node:sqlite`, not Durable Object SQL.** The curves and the statement
counts transfer. An absolute Durable Object ceiling does not, and nothing below
claims one.

## The metric, and the one that had to be abandoned

Peak resident memory was the obvious measure and it does not work. `VmHWM` is a
high-water mark that moves with when the collector happened to run, not only
with what the code allocated: repeated medians of three runs of the same cell
landed 40 MB apart. Reported peaks below are still shown, but they are not what
any conclusion rests on.

The figure that carries the conclusions is **the smallest V8 old-space the
workload completes in**, found by bisection with `--max-semi-space-size=1`.
Under a heap cap V8 collects harder rather than growing, so what survives is
what the object graph actually needs. It is stable to about 1 MB.

It bounds the JavaScript side only. `Uint8Array` backing stores, the object and
pack caches, and `node:sqlite`'s own pages all live outside old space — which is
also why lowering the 16 MiB object cache changes neither figure, and why a
whole-isolate limit needs the cgroup pass (`--budget=128`) instead.

## kompjutr against `createGitClient()`

Smallest old-space the operation completes in:

| Scenario | Shape | N | `createGitClient()` | `createSqliteGitClient()` |
| --- | --- | --- | --- | --- |
| add + commit | flat | 500 | 36 MB | **12 MB** |
| add + commit | flat | 1000 | 53 MB | **13 MB** |
| add + commit | flat | 2500 | 101 MB | **14 MB** |
| add + commit | deep | 2500 | 101 MB | **14 MB** |
| status (clean) | flat | 2500 | 101 MB | **16 MB** |
| status (clean) | deep | 2500 | 101 MB | **15 MB** |

The baseline costs about **32 KB of old space per tracked file** and rises
without flattening. kompjutr costs about **0.5 KB per file** over the same range
— 2 MB more heap to go from 500 files to 2,500 — on top of a fixed floor of
roughly 12 MB, which is node's own module graph and not the repository.

Wall time and peak resident memory over the same cells:

| Scenario | Shape | N | baseline ms | kompjutr ms | baseline peak RSS | kompjutr peak RSS |
| --- | --- | --- | --- | --- | --- | --- |
| add + commit | flat | 500 | 610 | 164 | 159 MB | 16 MB |
| add + commit | flat | 1000 | 1476 | 426 | 312 MB | 13 MB |
| add + commit | flat | 2500 | 6075 | 2042 | 735 MB | 20 MB |
| add + commit | deep | 2500 | 2659 | 628 | 769 MB | 21 MB |

At 2,500 files the baseline has already touched 735 MB of resident memory. A
Durable Object gets 128 MB for the whole isolate.

## What the streaming rewrite itself bought

Same workload, kompjutr before and after the merge-join work, smallest
old-space, 5,000 files. The "scaling part" column subtracts the ~13 MB floor
that a 1,000-file run already pays.

| Scenario | Shape | Before | After | Scaling part |
| --- | --- | --- | --- | --- |
| checkout | deep | 24 MB | **16 MB** | 11 MB → 3 MB, 3.7x |
| status (clean) | deep | 21 MB | **16 MB** | 7 MB → 2 MB, 3.5x |
| checkout | flat | 23 MB | **20 MB** | 9 MB → 6 MB, 1.5x |
| status (clean) | flat | 21 MB | **20 MB** | 7 MB → 6 MB, 1.2x |
| add + commit | deep | 17 MB | **15 MB** | — |
| add + commit | flat | 17 MB | 17 MB | no change |

Three things worth stating plainly:

- **`add`/`commit` did not improve.** Its index array is under 1 MB at 5,000
  files against a 13 MB floor, so replacing it with a paged scan was never going
  to show. The change is still right — the array grows without bound and the
  scan does not — but it bought nothing measurable at this size.
- **A flat directory barely improves**, 1.2x–1.5x against 3.5x for a nested
  tree. That is the documented limit doing exactly what the documentation says:
  `readdir` and `readTree` each hand back one whole directory, so 5,000 files in
  one directory stays O(N) whatever the join does.
- **The 21 MB of object and pack cache is real but invisible here**, because
  blob payloads are `Uint8Array` and never enter old space. Reducing that budget
  is a separate decision with its own trade-off, and no number here supports
  making it.

## Cost in SQL

Statement counts are deterministic, unlike either memory figure.

| Scenario | Shape | N | baseline | kompjutr |
| --- | --- | --- | --- | --- |
| add + commit | flat | 2500 | 63,447 | 47,529 |
| add + commit | deep | 2500 | 71,322 | 58,904 |
| status (clean) | flat | 2500 | 30,034 | 12,519 |
| status (clean) | deep | 2500 | 36,160 | 18,269 |

Paging the index costs a handful of extra statements — four reads instead of one
for a 2,000-file commit — which is the price of the bound.

## Not measured

- Anything inside a real Durable Object.
- `clone`/`fetch` against a remote, which the harness can run but this sweep did
  not.
- Repositories with large individual files, where the streaming object paths
  matter and where 4 KB fixtures say nothing.
