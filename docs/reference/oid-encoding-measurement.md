# OID encoding measurement

**Decision result:** keep persisted OIDs as lowercase hexadecimal `TEXT`. A
20-byte `BLOB` reduced the representative database by 7.6% with a real pack and
24.3% without pack payload, but it made decoded tree traversal 60.0–75.6% slower
and point lookup 14.5–16.7% slower. The current JavaScript API uses hex strings,
so the BLOB result pays conversion on every boundary.

This is the evidence for [ADR 0005](../decisions/0005-keep-oid-columns-as-text.md).
The reproducible harness is [`bench/oid-encoding.ts`](../../bench/oid-encoding.ts).

## Reproduce from a clean checkout

Run one command. The unleased parent prepares the pinned fixture through the
standard fixture helper, then re-executes the timed child through `cpu-lease`:

```bash
NODE_NO_WARNINGS=1 node --experimental-transform-types \
  --import ./bench/register.mjs bench/oid-encoding.ts \
  --repetitions=12 --warmups=3 > oid-encoding.json
```

The child requires an internal marker and verifies Linux `Cpus_allowed_list`
before timing. This run invoked:

```text
cpu-lease run -n 2 --no-smt -- \
  /home/matej21/.local/share/fnm/node-versions/v24.4.0/installation/bin/node \
  --experimental-transform-types \
  --import /home/matej21/projects/oss/kompjutr/bench/register.mjs \
  /home/matej21/projects/oss/kompjutr/bench/oid-encoding.ts \
  --repetitions=12 --warmups=3
```

It observed CPU affinity list `10`, exactly one runnable logical CPU. This is the
expected `--no-smt` lease shape: the sibling is kept idle. A timed child refuses
to run if the marker or affinity proof is absent.

The timing-free correctness mode prepares the same fixture but needs no lease:

```bash
NODE_NO_WARNINGS=1 node --experimental-transform-types \
  --import ./bench/register.mjs bench/oid-encoding.ts --check
```

The harness rejects a result unless TEXT and BLOB have the same row counts,
decoded OID set and order checksums, and commit/tree traversal result. It binds
each BLOB OID as a real 20-byte `Uint8Array` and decodes each returned BLOB to
hex. Changing affinity while still binding strings is not a BLOB comparison.

## Environment and fixture

Measured at `2026-08-25T15:30:24.229Z`:

- Node `v24.4.0`; SQLite `3.50.2` through `node:sqlite`.
- Git `2.54.0`.
- Linux `6.17.0-41-generic`, x64.
- AMD Ryzen 7 PRO 8840HS.
- 4 KiB SQLite pages; databases compacted with `VACUUM INTO`; zero freelist pages.
- 3 warmups followed by 12 recorded repetitions. Timings are warm local wall time.

The benchmark uses `FIXTURES.nextjs`: upstream ref `v15.5.2` from
`https://github.com/vercel/next.js.git`. `prepareFixture` rebuilt the cached
single-commit repository at revision
`381a9c8089ed7a244dcfa374fbb27d37032e208a`.

The packed workload contains:

- 24,252 tracked paths.
- 30,613 reachable objects; 30,757 unique packed objects and 30,901 physical pack
  entries across two packs.
- 43,608,581 pack bytes stored in 43 one-MiB SQLite rows.
- 11,070 parsed trees and 34,996 immediate tree entries.

It retains the real pack payload and uses the fixture's real OIDs, pack locations,
index rows, tree objects, names, raw entries, and cumulative traversal costs. The
separate loose-shaped workload removes pack-payload dilution. It has 32,768
deterministic loose objects with one 64-byte proxy chunk each, 4,096 trees,
32,768 tree entries, and 4,096 commits.

The prototype mirrors the production rowid organization, primary keys, secondary
indexes, and representative unchanged payload columns for all included tables.
In particular, `git_shallow`, `git_objects`, and `git_pack_objects` remain rowid
tables; parsed trees include `name`, `name_bytes`, `raw_entry`, and
`cumulative_base`; commits include identities, timestamps, message, size, and
cache accounting.

`git_commits.parents` is not treated as one scalar OID. TEXT stores an ordered,
space-separated OID list. BLOB stores the ordered concatenation of 20-byte OIDs;
zero parents is a zero-length BLOB. The loose workload includes zero-, one-, and
two-parent commits.

## Equivalence proof

Both encodings produced the following identical logical evidence:

| Workload | Decoded OIDs | OID-set SHA-256 | Ordered-row SHA-256 | Traversal rows | Traversal SHA-256 |
|---|---:|---|---|---:|---|
| Packed Next.js | 30,757 | `d6b64e674ea43bf02f107b420623fa102a2f1803cb051c1bfe7a1c81c2a3a6e4` | `85722f98d640e27a24f322942ece23572e1fadb8ba070987aeb41f3f6e7d5b07` | 34,996 trees + 1 commit | `ec16137283e7fe33be6688e80f0f1a40d9d19e549781107f7bfee3144b98c8be` |
| Loose-shaped | 32,768 | `0dde28ed62b91ca3bcf48a0e2b8dc6931d4ab3824236069f5d752c6a8007b71b` | `4f90977c6baa5e2045732fc4b17c52589c71cd7775f3fd1e7fc39a4441f3a134` | 32,768 trees + 4,096 commits | `d0efd5bd6d813a406ccb3531252d660df8d8ba6a76f201ffb1115c5c988d297f` |

Row counts were also identical between encodings:

| Table | Packed | Loose-shaped |
|---|---:|---:|
| `git_refs` | 1 | 1 |
| `git_index` | 24,252 | 24,252 |
| `git_blob_ids` | 24,252 | 24,252 |
| `git_shallow` | 0 | 32 |
| `git_objects` | 0 | 32,768 |
| `git_object_chunks` | 0 | 32,768 |
| `git_pack_meta` | 2 | 0 |
| `git_pack_data` | 43 | 0 |
| `git_pack_objects` | 30,757 | 0 |
| `git_commits` | 1 | 4,096 |
| `git_tree_sources` | 11,070 | 4,096 |
| `git_tree_entries` | 34,996 | 32,768 |
| `git_tree_effective` | 11,070 | 4,096 |

## Results

Medians below are the mean of the two central values from the 12 raw samples.
Point lookup performs 2,048 prepared statements per repetition. Each tree or
commit traversal performs one statement. Boundary conversion performs no SQL.

| Workload and metric | TEXT | BLOB | BLOB change |
|---|---:|---:|---:|
| Packed database bytes | 65,024,000 | 60,076,032 | -7.6% |
| Packed lookup, ns | 22,421,927 | 26,163,992 | +16.7% |
| Packed tree traversal, ns | 92,216,000 | 147,522,885 | +60.0% |
| Packed commit traversal, ns | 22,161 | 20,138 | -9.1% |
| Packed boundary encode, ns / 30,757 OIDs | 7,033,017 | 32,621,154 | +363.8% |
| Packed boundary decode, ns / 30,757 OIDs | 10,256,232 | 13,743,374 | +34.0% |
| Loose database bytes | 25,124,864 | 19,021,824 | -24.3% |
| Loose lookup, ns | 23,047,994 | 26,400,237 | +14.5% |
| Loose tree traversal, ns | 83,105,127 | 145,945,675 | +75.6% |
| Loose commit traversal, ns | 14,183,400 | 20,156,735 | +42.1% |
| Loose boundary encode, ns / 32,768 OIDs | 8,618,587 | 38,635,389 | +348.3% |
| Loose boundary decode, ns / 32,768 OIDs | 11,264,114 | 11,856,379 | +5.3% |

The packed database is dominated by 43,671,552 bytes of unchanged pack payload.
The loose workload gives the clearer upper bound on key-storage savings. The
savings are real, including in compound tree keys and rowid-table primary-key
indexes. They do not produce an end-to-end lookup or traversal win while core
code consumes hex strings.

## SQLite page data

Each cell is `bytes/pages`, directly from `dbstat`. File bytes equal used page
bytes in all four databases.

### Packed Next.js

| SQLite object | TEXT | BLOB |
|---|---:|---:|
| Entire database | 65,024,000 / 15,875 | 60,076,032 / 14,667 |
| `git_blob_ids` | 1,638,400 / 400 | 1,163,264 / 284 |
| `git_index` | 3,321,856 / 811 | 2,813,952 / 687 |
| `git_pack_data` | 43,671,552 / 10,662 | 43,671,552 / 10,662 |
| `git_pack_objects` | 2,461,696 / 601 | 1,748,992 / 427 |
| `git_pack_objects_loc` | 462,848 / 113 | 462,848 / 113 |
| `sqlite_autoindex_git_pack_objects_1` | 1,527,808 / 373 | 909,312 / 222 |
| `git_tree_effective` | 593,920 / 145 | 372,736 / 91 |
| `git_tree_entries` | 6,320,128 / 1,543 | 4,841,472 / 1,182 |
| `git_tree_entries_by_name_bytes` | 2,433,024 / 594 | 1,720,320 / 420 |
| `git_tree_sources` | 675,840 / 165 | 454,656 / 111 |
| `sqlite_autoindex_git_index_1` | 1,855,488 / 453 | 1,855,488 / 453 |

The remaining 13 empty/single-row objects total 61,440 bytes in both variants.

### Loose-shaped

| SQLite object | TEXT | BLOB |
|---|---:|---:|
| Entire database | 25,124,864 / 6,134 | 19,021,824 / 4,644 |
| `git_blob_ids` | 1,638,400 / 400 | 1,163,264 / 284 |
| `git_commits` | 1,118,208 / 273 | 847,872 / 207 |
| `git_index` | 3,301,376 / 806 | 2,793,472 / 682 |
| `git_object_chunks` | 3,850,240 / 940 | 3,174,400 / 775 |
| `sqlite_autoindex_git_object_chunks_1` | 1,667,072 / 407 | 995,328 / 243 |
| `git_objects` | 2,031,616 / 496 | 1,359,872 / 332 |
| `sqlite_autoindex_git_objects_1` | 1,630,208 / 398 | 966,656 / 236 |
| `git_tree_effective` | 221,184 / 54 | 143,360 / 35 |
| `git_tree_entries` | 5,390,336 / 1,316 | 4,038,656 / 986 |
| `git_tree_entries_by_name_bytes` | 2,109,440 / 515 | 1,454,080 / 355 |
| `git_tree_sources` | 253,952 / 62 | 172,032 / 42 |
| `sqlite_autoindex_git_index_1` | 1,855,488 / 453 | 1,855,488 / 453 |

The remaining 12 empty/small objects total 57,344 bytes in both variants.

## Raw timing samples

All values are nanoseconds in execution order.

### Packed Next.js — TEXT

- Lookup: `22677692, 23058493, 22444102, 22399751, 22364646, 22385194, 23042103, 22284458, 22139551, 23678836, 22221842, 22559254`
- Tree traversal: `99185675, 86343906, 89121381, 101738747, 85281499, 91647583, 87924066, 92784416, 101710154, 97599684, 100188171, 83362145`
- Commit traversal: `20447, 23013, 34864, 22762, 22612, 20067, 21710, 20588, 20268, 23413, 21539, 28592`
- Boundary encode: `7152962, 6954056, 6886621, 6883436, 7143105, 7117718, 7117267, 7012574, 7053459, 6974233, 7124200, 6936074`
- Boundary decode: `10256848, 10219920, 10273319, 10261417, 10224048, 10280442, 10833972, 10494517, 10224709, 10204652, 10195536, 10255616`

### Packed Next.js — BLOB

- Lookup: `26257945, 26775579, 26120452, 26207532, 25707101, 24627903, 26961811, 24746451, 25135468, 27456242, 25703554, 38748357`
- Tree traversal: `153558434, 155886993, 170084848, 146831707, 138578498, 142923550, 157589227, 148214062, 140034820, 138305525, 151933673, 137753770`
- Commit traversal: `41998, 21800, 20949, 23564, 22421, 22322, 19245, 18484, 19326, 18955, 19175, 18294`
- Boundary encode: `43056761, 30601724, 30417355, 30993095, 30550480, 32698025, 44983870, 31214083, 32544282, 44087700, 33810554, 33625834`
- Boundary decode: `13971479, 11720344, 17533128, 16352023, 19024965, 17327399, 11865040, 10877431, 13515269, 17718830, 10890045, 10670300`

### Loose-shaped — TEXT

- Lookup: `22662434, 23352485, 22411753, 23288967, 22788496, 22963779, 22270392, 22988214, 23335543, 24134615, 23107773, 23571398`
- Tree traversal: `78662801, 79149057, 79134299, 80273517, 85936736, 80249754, 91468533, 115475654, 106880575, 148053908, 89516669, 75811720`
- Commit traversal: `14466821, 13087281, 12419421, 13899978, 12398903, 13701612, 19681064, 17949896, 19616244, 18572732, 17071287, 13601608`
- Boundary encode: `9013860, 8650260, 8536410, 8403655, 8358944, 9013428, 8526081, 8586913, 8461673, 8655189, 9149219, 8778055`
- Boundary decode: `11254235, 11239708, 11247553, 12167648, 11422756, 11118305, 11178326, 11712138, 11254856, 11273371, 11914111, 11395105`

### Loose-shaped — BLOB

- Lookup: `25919793, 26232388, 41925468, 25601997, 27341591, 26376974, 27226709, 26423500, 25973321, 27448918, 26057907, 27296228`
- Tree traversal: `143936004, 147955346, 143303289, 151768749, 153155552, 148227197, 160274963, 157739184, 131081413, 129422928, 130320581, 132404599`
- Commit traversal: `21152484, 39816093, 18663440, 19468522, 16499364, 29331566, 37135857, 18974423, 16073681, 17652799, 20844947, 26632976`
- Boundary encode: `32624680, 35023488, 33274236, 33827235, 40204138, 38452472, 45081440, 33865575, 39394025, 42218146, 44577752, 38818306`
- Boundary decode: `12067724, 11776457, 11838041, 11893192, 11351855, 11874717, 12252674, 11338951, 12136520, 12119419, 11535413, 11515737`

## Limitations and reopening signal

This is a decision prototype, not a production migration benchmark:

- It uses local `node:sqlite`, not Durable Object SQL. Worker-side synchronous
  wall time is not observable, so this evidence does not claim a production
  duration.
- Included OID-bearing tables match production rowid organization, keys, indexes,
  and representative unchanged payload. The prototype omits non-OID tables,
  triggers, operation journals, pending-pack rows, migrations, and cross-repository
  concurrency.
- The packed fixture is intentionally rebuilt as one commit. The loose workload
  supplies the compound-parent stress case.
- The loose chunk is a fixed 64-byte proxy. It isolates key overhead and is not a
  claim about typical compressed Git object size.
- Timing is one leased local run on one machine, in fixed TEXT-then-BLOB order.
  The raw samples preserve the observed variance; no cold-cache claim is made.

Reopen ADR 0005 if the core API adopts binary OIDs, persisted size becomes a
measured production limit, or a Durable Object statement/row probe shows that
the smaller B-trees offset conversion and migration cost in complete operations.
