# Macro benchmark — kompjutr against the Computer report

Measured 2026-08-20 on Linux 6.17, node 24.4, every run under `cpu-lease -n 2` —
the lease width the reference experiment used. Reproduce with `npm run
bench:macro`.

The target is `docs/benchmark-reference.md`: an earlier experiment that
optimised DOFS *underneath* Computer's isomorphic-git client. This suite
replays that experiment's fixtures and operations, and runs **both** clients
through them in one harness, so the comparison does not have to cross two
runtimes.

## What runs

Six repositories pinned by tag, fetched once and rebuilt as a single-commit
repository — that rebuild is what lets one serve as a local Smart HTTP origin.
Tracked-file counts come out equal to the reference's own sizing pass: express
218, tailwind 541, vue 1,075, eslint 2,358, prettier 9,329, next.js 24,252.

Two halves, one process each:

- **packed** — `git.clone` from the local origin, then `git.status`. Every
  object is in a packfile.
- **loose** — the files are written into the workspace, `git.init`, then
  `git.add --all`, `git.commit`, `git.diffSummary`, `git.status`. Every object
  was written locally.

The reference moved between the two by deleting `.git` mid-run. kompjutr has no
`.git` to delete, so the loose half is a separate process over the same files.
`git.clone` is measured here; the reference cloned outside its measured region.

## The harness reproduces the reference's `main` column

Prettier 3.9.6, 9,329 files, statements:

| Operation | reference `main` | this harness, `createGitClient()` |
| --- | ---: | ---: |
| `git.status` packed | 293,013 | 296,312 (+1.1%) |
| `git.status` loose | 297,870 | 296,120 (−0.6%) |
| `git.add --all` | 605,482 | 574,794 (−5.1%) |
| `git.commit` | 59,489 | 59,433 (−0.1%) |
| `git.diffSummary` | 297,223 | 297,027 (−0.1%) |

Different runtime, different isomorphic-git version, and four of the five land
within about a percent. That is what licenses reading the kompjutr column
against the reference's tables.

**Wall time does not transfer.** These runs are roughly twice as fast as the
reference's for the same client, because bare node with `node:sqlite` is not
`workerd`. Time is only ever compared within one table here.

## Prettier 3.9.6 — 9,329 files

| Operation | `createGitClient()` | kompjutr | reduction | optimised DOFS, for reference |
| --- | ---: | ---: | ---: | ---: |
| `git.status` packed | 296,312 stmt / 1.98 s | 203,356 stmt / 1.53 s | 1.5x | 49 stmt / 1.77 s |
| `git.status` loose | 296,120 stmt / 1.41 s | 202,234 stmt / 1.27 s | 1.5x | 1,418 stmt / 2.52 s |
| `git.add --all` | 574,794 stmt / 16.73 s | 428,550 stmt / **4.80 s** | 1.3x / 3.5x time | 27,296 stmt / 11.32 s |
| `git.commit` | 59,433 stmt / 2.81 s | 16,542 stmt / **0.25 s** | 3.6x / 11x time | 901 stmt / 1.90 s |
| `git.diffSummary` | 297,027 stmt / 2.95 s | 149,348 stmt / **0.41 s** | 2.0x / 7.3x time | 1,638 stmt / 2.72 s |
| `git.clone` | 922,634 stmt / 5.51 s | 595,018 stmt / 3.32 s | 1.6x | not measured there |

The last column is a different machine and runtime; it is there to show the
shape of the other optimisation, not to be raced against.

## Next.js v15.5.2 — 24,252 files

The reference's largest fixture. Both clients completed it here; a Durable
Object would not have let the baseline try.

| Operation | `createGitClient()` | kompjutr | reduction |
| --- | ---: | ---: | ---: |
| `git.status` packed | 875,158 stmt / 7.97 s | 634,014 stmt / 7.19 s | 1.4x |
| `git.status` loose | 856,356 stmt / 10.94 s | 623,493 stmt / 6.61 s | 1.4x |
| `git.add --all` | 1,684,911 stmt / 95.13 s | 1,257,205 stmt / **21.83 s** | 1.3x / 4.4x time |
| `git.commit` | 194,383 stmt / 11.89 s | 55,797 stmt / **1.44 s** | 3.5x / 8.2x time |
| `git.diffSummary` | 857,313 stmt / 11.75 s | 421,634 stmt / **1.12 s** | 2.0x / 10.5x time |
| `git.clone` | 3,053,433 stmt / 21.02 s | 1,689,096 stmt / 11.80 s | 1.8x |

`git.add --all` peaked at **6,634 MB** for the baseline and **190 MB** for
kompjutr — 35x, on a fixture a Durable Object gets 128 MB to hold.

The reference's inherited Next.js numbers for `main` were 875,152 / 877,542 /
1,702,422 / 199,875 / 876,349 statements for the five operations above. This
harness reads 875,158 / 856,356 / 1,684,911 / 194,383 / 857,313 — the packed
`status` differs by six statements out of 875,152.

## Where kompjutr's statements actually go

`git.status` loose on Prettier costs kompjutr 202,234 statements. Broken down by
the table they hit:

| Query | Count |
| --- | ---: |
| `SELECT … FROM vfs_nodes WHERE inode = ?` | 94,742 |
| `SELECT child_inode FROM vfs_dirents WHERE parent_inode = ? AND name = ?` | 83,740 |
| `SELECT size FROM vfs_nodes WHERE inode = ?` | 9,332 |
| `SELECT COUNT(*) FROM vfs_dirents WHERE child_inode = ?` | 9,332 |
| `readdir` | 3,343 |
| path-resolution CTE | 1,684 |
| `vfs_chunks` and `vfs_blob_bytes` reads | 18 |
| **everything against `git_*`** | **41** |

That is the top twelve queries; two statements of the 202,234 fall outside it.

**Forty-one statements are git. The other 202,191 are the filesystem.** They are
one `lstat` per tracked path, and each `lstat` walks the path from the root a
segment at a time through `vfs_dirents`, because DOFS's `readdir` hands back a
dirent carrying only a name and a type — `wrapDirent` drops the size, mtime and
inode the directory query already read.

That is the same axis the optimised-DOFS branch worked on, and it explains its
49-statement `status` exactly: with a filesystem that answers a directory walk
in bulk, what remains is the git side, and kompjutr's git side already costs 41.

The two optimisations are complementary, not competing. Nothing kompjutr can do
behind Computer's public filesystem surface removes those 202,191 statements.

`git.add --all` splits differently. Of its 428,550 statements the top twelve
queries cover 97%: 374,780 against `vfs_*` (87%, reading every file to hash it)
and 42,398 against `git_*` (10%) — 9,321 index upserts, 7,913 object rows and
7,931 chunk inserts, which is real work for 9,329 files, not overhead.

## Memory — the ceiling the DOFS work could not move

Peak resident memory added by the operation, `git.add --all`:

| Files | `createGitClient()` | kompjutr |
| ---: | ---: | ---: |
| 218 | 68.6 MB | 6.9 MB |
| 541 | 196.6 MB | 10.1 MB |
| 1,075 | 368.0 MB | 13.1 MB |
| 2,358 | 759.5 MB | 28.4 MB |
| 9,329 | 2,549.7 MB | 87.8 MB |
| 24,252 | **6,634.4 MB** | **190.3 MB** |

The reference's third headline finding was that the branch does **not** raise the
`git.commit` ceiling: both revisions exhausted a Durable Object's isolate memory
between 535 and 985 tracked files, staging the index. The numbers above are that
finding from the other side. The baseline's added peak passes 128 MB
between 218 and 541 files — consistent with the reference putting the real
ceiling at 535 to 985 — and reaches 2.5 GB at 9,329 and 6.6 GB at 24,252.
kompjutr is at 87.8 MB and 190.3 MB, and part of that is the in-memory database
rather than the heap (see the caveats below).

## Scaling, 218 → 24,252 files

Statements, both clients:

| Operation | 218 | 541 | 1,075 | 2,358 | 9,329 | 24,252 |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| `status` loose, baseline | 5,332 | 14,076 | 26,722 | 58,966 | 296,120 | 856,356 |
| `status` loose, kompjutr | 3,143 | 8,885 | 16,608 | 36,595 | 202,234 | 623,493 |
| `add --all`, baseline | 13,414 | 33,959 | 62,779 | 130,003 | 574,794 | 1,684,911 |
| `add --all`, kompjutr | 7,409 | 21,247 | 40,837 | 88,888 | 428,550 | 1,257,205 |
| `commit`, baseline | 1,787 | 2,271 | 2,802 | 6,806 | 59,433 | 194,383 |
| `commit`, kompjutr | 363 | 574 | 765 | 1,894 | 16,542 | 55,797 |

Per tracked file at 9,329: the baseline spends 31.7 statements on `status` and
kompjutr 21.7, which is the filesystem bill both pay. On `commit`, where the
working tree is barely touched, it is 6.4 against 1.8.

Wall time, seconds, at 9,329 files: `add` 16.73 → 4.80, `commit` 2.81 → 0.25,
`diffSummary` 2.95 → 0.41, `status` 1.41 → 1.27. The operations that touch the
working tree least improve most, which is the same statement above told in time.

## Two caveats on the memory figures

1. **Peak RSS delta favours a process that is already bloated.** It is measured
   from a high-water mark reset after the previous phase, so a baseline holding
   2.5 GB of already-resident pages can satisfy a new allocation without
   growing, and reports a small delta. That is why `status` loose at 9,329 files
   reads 0.7 MB for the baseline and 22.6 MB for kompjutr — the baseline had
   already taken the memory during `add`.
2. **The database is inside RSS here.** `SqliteTestStorage` is `:memory:`, so
   every object, chunk and working-tree byte counts toward the figure. In a
   Durable Object that storage is not in the isolate heap. This biases the
   numbers *against* kompjutr, which deliberately puts more in SQL and less in
   the heap.

The metric that avoids both is the smallest V8 old-space the workload completes
in, found by bisection with `--max-semi-space-size=1`. It is the metric
`docs/benchmark-results.md` settled on, and it is available for real
repositories too — for the whole loose suite, `add` through `status`:

| Fixture | Files | `createGitClient()` | kompjutr |
| --- | ---: | ---: | ---: |
| vue | 1,075 | 55 MB | **16 MB** |
| eslint | 2,358 | 95 MB | **17 MB** |

About 31 KB of old space per tracked file for the baseline — the synthetic sweep
put it at 32 KB, on 4 KB files rather than real ones — against roughly 0.8 KB per
file for kompjutr over a fixed floor of about 13 MB, which is node's own module
graph rather than the repository. Prettier and Next.js were not bisected; a
bisection is a dozen full runs of the cell.

## Clone is the remaining hotspot

`git.clone` was never inside the reference's measured region, and it has not
been optimised here either. It is the one operation where kompjutr's peak stays
in the hundreds of megabytes: 322.9 MB for Prettier and 591.5 MB for Next.js,
against the baseline's 431.7 MB and 880.7 MB. Better, but not bounded.

Part of that figure is the in-memory database — a clone writes the pack, the
pack index and the whole working tree, and all of it is resident here. How much
is heap and how much is the database has not been separated, so this is stated
as an open question rather than a claim about a Durable Object.

## A correctness difference the benchmark found

Restoring a sampled file without its mode reset it from 0755 to 0644.
`createSqliteGitClient()` reported the path modified; `createGitClient()`
reported the tree clean. Real `git status` agrees with the former. The benchmark
was wrong to change the mode — it now carries it — but the baseline is wrong not
to notice.

## Not measured

- Anything inside a real Durable Object. This is `node:sqlite`. The statement
  counts transfer, an absolute isolate ceiling does not, and nothing here claims
  one.
- The bulk filesystem operations (`fs.readFiles`, `fs.rmFiles`) from the
  reference's tables. They measure DOFS, which kompjutr does not change, and
  0.2.1 has no bulk API to call.
- Repositories with large individual files. Every fixture here has a median file
  of a few hundred bytes to a few kilobytes, which is where the streaming object
  paths say the least.
