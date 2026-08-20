# Plan — the standalone runtime

Target architecture for cutting `@cloudflare/computer` and shipping our own
workspace runtime: a filesystem over Durable Object SQLite, with git inside it,
and a seam for a shell layer later.

The decision to cut is made. This document designs the destination and the
route. Every claim about existing behaviour cites `file:line`.

**Reading order for the ten decisions:** §1 topology, §2 fork-or-rewrite,
§3 schema, §4 filesystem API, §5 git API, §6 exec seam, §7 per-operation SQL,
§8 migration, §9 out of scope, §10 cost and risk. §11 is the route. §12 records
the four decisions taken at the gate — none is left open.

Two consumers are referred to throughout as **the static site generator** and
**the agent runtime**. Their requirements were measured, not assumed.

---

## 0. The shape, in one page

```
                    Runtime  (owns the Database, composes the two below)
                       │
        ┌──────────────┴──────────────┐
        │                             │
   Filesystem                       Git
   fs_* tables                    git_* tables
        │                             │
        └──────────────┬──────────────┘
                       │
              Database (DO SqlStorage)
```

- **One package**, several entry points. The filesystem ships without git in
  its graph; git ships without the runtime.
- **Our own schema.** `fs_paths` is keyed by the full canonical path under
  BINARY collation, which is byte-for-byte git's tree order — the order the
  entire git core already merges on (`src/core/streams.ts:29`,
  `docs/architecture.md:110-113`). The working-tree walk stops being a
  recursive CTE and becomes an indexed range scan.
- **The filesystem does not hash anything.** No content addressing, no
  sha256, no manifests, no blob GC. Writers may supply an opaque `content_id`;
  git supplies the blob oid it already knows.
- **Bulk primitives are the API, not a side door.** `scan`, `readFiles`,
  `writeFiles`, `removeFiles`, `makeDirectories` are first-class; the
  node:fs-shaped surface both consumers use today is a shim over them.
- **No write-back buffer.** The correctness hazard that blocks direct reads
  under Computer (`docs/plans/bulk-sql.md:88-106`) is removed by construction,
  not worked around.
- Every operation lands under 1,000 statements at 9,329 files, including
  `checkout` and `clone`, which are structurally impossible under Computer.

### The numbers this buys

Prettier 3.9.6, 9,329 tracked files. Today's column is
`docs/benchmark-macro.md`; the target column is derived in §7.

| Operation | today | target | of which is the filesystem |
|---|---:|---:|---:|
| `status` | 202,234 | **≤ 170** | 15 |
| `diffSummary` | 149,348 | **≤ 180** | 15 |
| `add --all` | 428,550 | **≤ 230** | 27 |
| `commit` | 16,542 | **≤ 15** | 0 |
| `checkout` (9,329 files) | ~420,000 | **≤ 200** | 23 |
| `clone` | 595,018 | **≤ 240** | 23 |
| `log -n 50` | ~150 | **≤ 100** | 0 |

Wall-clock: `status`, `diffSummary`, `commit` and `log` land under 0.1 s.
`add --all`, `checkout` and `clone` do not, and cannot — see §7.8. The target
was retargeted at the gate to **≤ 0.1 s for any operation touching ≤ 1,000
changed files** (D3).

### 0.1 State of play, on disk today

Worth stating before planning anything, because the working tree is mid-flight:

- **The tree does not typecheck.** `npx tsc -p tsconfig.json --noEmit` reports
  `TS2420` at `src/computer/worktree.ts:55` and `TS2739` at
  `src/computer/client.ts:249` — `ComputerWorktree` is missing `scan` and
  `readMany`, plus the same error at every test call site.
- **`Worktree.scan()` and `Worktree.readMany()` are declared and never
  implemented.** `src/core/worktree.ts:97` and `:103`. No caller anywhere in
  `src/` invokes either; every operation still goes through `stat()` /
  `readdir()` / `readFile()` one path at a time.
- **`VfsReader` is written and instantiated nowhere.** `src/sqlite/vfs.ts:116`
  holds the recursive-CTE scan and the `json_each` chunk join. It is the only
  `json_each` in the whole package.
- **`git_blob_ids` and `git_objects.stored` are dead schema** (§3.4).
- **Every write in the store is one row per statement** — `indexPut`
  (`src/sqlite/store.ts:605`), `indexRemove` (`:624`), `setRef` (`:478`),
  `setShallow` (`:761`), the object chunk loop (`:281`), the stream chunk loop
  (`:339`), and `packs.#insertObject` (`src/sqlite/packs.ts:642`). There is no
  multi-row `VALUES` and no `json_each` anywhere in `store.ts`, `packs.ts` or
  `schema.ts`.

So `docs/plans/bulk-sql.md` landed its wave-0 seams and stopped. This plan
supersedes it: the seams stay, the `vfs_*` reader becomes the importer (§8.2),
and the bulk write path targets our own tables instead of Computer's.

---

## 1. Topology

### 1.1 One package, four entry points

**Decision: one package.**

```
kompjutr
├── .              runtime: Workspace, composing fs + git
├── ./fs           the filesystem alone — no git in the module graph
├── ./git          the git client alone, over any Filesystem
├── ./compat/computer   GitClientFactory façade + the vfs_* importer
└── ./testing      in-memory storage, the conformance harness
```

Reasons, in order of weight:

1. **The git layer and the fs layer share one database and one schema
   version.** Splitting them into two npm packages makes the table layout a
   published API between them, and makes a schema bump a two-package release
   dance. It is one migration or it is a support problem.
2. **The static site generator imports only `kompjutr/fs`.** It consumes a
   structurally-typed interface it owns, and needs four sync methods plus a
   revision counter. `sideEffects: false` plus a subpath export means git,
   pako, and the pack layer never enter its bundle. A second package would buy
   it nothing it does not already get.
3. **One test suite, one CI, one version.** The inherited conformance tests
   (§2.3) cover the fs; the existing 5,518 lines under `tests/` cover git. Both
   must stay green against the same `Database`.

`./compat/computer` is the only entry point that references
`@cloudflare/computer` types, and it does so through an **optional peer
dependency** so nobody who does not import it pays for it. It is scheduled for
deletion in §5.3.

### 1.2 Is git a module inside the runtime, or a peer of it?

**Peer, composed by the runtime.**

The filesystem knows nothing about git — no `oid` column, no `git_*` table
name, no import. The git layer depends on the filesystem's *interface* plus a
documented bulk contract. The runtime object owns the `Database` and hands the
same handle to both.

This is already how the code is arranged: `src/core/` talks to the working tree
through `Worktree` (`src/core/worktree.ts:72`) and knows nothing else, and
`docs/architecture.md:38-41` states the rule. The change is that `Worktree`
becomes a *slice* of the filesystem's own interface rather than an adapter over
somebody else's.

**The git layer never writes SQL against `fs_*` tables.** The bulk API in §4 is
designed for exactly the queries git needs; a side door would make the table
layout an API and forfeit the freedom the new schema buys. One escape hatch is
named in §7.9 and is gated on measurement.

### 1.3 The name

`kompjutr` is Czech-phonetic for "computer". It was chosen when this was a
plugin *into* Computer. After the cut, the name refers to a dependency we no
longer have, and describes neither of the two things the package actually is (a
filesystem and a git implementation).

The name is cheap to change now — the package is `0.0.0` and unpublished
(`package.json:4`) — and expensive to change after the first consumer pins it.

**Decided at the gate: `kompjutr` stays.** It reads as "computer" generically,
it is short and free on npm, and the README carries the one line of explanation
this costs. See §12 D1.

---

## 2. Fork or rewrite the filesystem

**Decision: rewrite, over a new schema, keeping DOFS's function signatures so
its test suite ports.**

### 2.1 The two options, costed

The fork and schema questions are not independent. Every query in DOFS names
`vfs_dirents` / `vfs_nodes` / `vfs_chunks` / `vfs_blobs`; changing the schema
rewrites the bodies whether or not the files are forked.

**Option F — fork DOFS, keep the `vfs_*` schema.**

Ported verbatim: `fs/` minus the sync-only parts, `provider.ts`,
`storage.ts`, `path.ts`, `rev.ts`, `errors.ts`, `types.ts`, `schema/`.
That is ~6,200 lines (measured: `src/fs` 4,350 + root 1,414 + `schema` 391,
minus `with-db*` 123).

Dropped: `sync/` (1,266 lines), `bench/` (763).

New: bulk reads (the recursive-CTE scan, already written at
`src/sqlite/vfs.ts:67-84`, 176 lines) plus bulk *writes* into `vfs_*`, which
means reproducing:

- `incrementRev` per mutation (`rev.ts:11-21`)
- inode allocation through `AUTOINCREMENT` (`fs/writeFile.ts:502-512`)
- dirent insertion after a per-segment parent resolve
  (`fs/writeFile.ts:57-126`)
- sha256 of every chunk (`fs/writeFile.ts:139-143`)
- content-addressed blob upsert, two statements per chunk
  (`fs/writeFile.ts:514-526`)
- a JSON manifest row per file (`sync/manifests.ts:62-73`)
- the read-only mount guard (`fs/mount-guard.ts:32-60`)

Estimated new/adapted: ~1,000 lines. **Total ~7,200 lines.**

What it costs at runtime: every checkout-written file pays a sha256 and a JSON
manifest that nothing consumes, because the sync protocol they exist for is out
of scope (§9). What it costs in maintenance: the schema is at v5 with four
migrations already shipped (`schema/migrations.ts:145-150`), and we would be
maintaining a bug-compatible reimplementation of the write path underneath it.
`docs/plans/bulk-sql.md:296-301` already gated direct `vfs_*` writes as "a real
risk of corrupting a user's filesystem"; Option F makes that the foundation.

**Option R — rewrite over a new schema.**

| module | DOFS lines | ours | why |
|---|---:|---:|---|
| `path.ts` | 52 | 52 | verbatim |
| `errors.ts` | 36 | 36 | verbatim |
| `storage.ts` | 115 | 115 | verbatim — savepoint reentrancy and `normalizeRow` are exactly right |
| `types.ts` | 16 | 16 | verbatim |
| `resolve.ts` | 259 | 100 | path key means a point lookup, not a per-segment walk |
| `resolveCache.ts` | 129 | **0** | nothing to cache — resolution is one statement |
| `blobCache.ts` | 87 | **0** | no content addressing |
| `writeBuffer.ts` + `pendingWriteBuffer.ts` | 204 | **0** | dropped, see §2.4 |
| `gc.ts` | 55 | **0** | chunks die with their inode |
| `mount-guard.ts` | 98 | **0** | mounts out of scope |
| `watch.ts` | 163 | **0** | polling the rev counter replaces it |
| `stat.ts` | 87 | 70 | |
| `readdir.ts` | 178 | 70 | one range scan; no pending-buffer merge |
| `readFile.ts` | 274 | 130 | |
| `writeFile.ts` | 1,288 | 400 | ~450 lines of the original are buffer machinery |
| `rm.ts` + `unlink.ts` | 215 | 100 | recursive rm is a range delete |
| `mkdir.ts` | 149 | 70 | |
| `rename.ts` | 230 | 80 | one UPDATE over a path range |
| `symlink.ts` + `readlink.ts` | 98 | 60 | |
| `chmod.ts` | 34 | 30 | |
| `link.ts` | 84 | 40 | |
| `find.ts` + `ls.ts` | 237 | 90 | GLOB range scan |
| `grep.ts` | 221 | 120 | |
| `provider.ts` | 934 | 550 | shape kept, bodies shrink |
| `schema/` | 391 | 200 | |
| `sync/` | 1,266 | **0** | |
| — bulk primitives | — | 500 | new |
| — runtime object | — | 200 | new |
| — RPC mirror | — | 250 | new |
| — `vfs_*` importer | — | 250 | new |
| **total** | **7,421** (non-bench) | **≈ 3,530** | |

**Option R is less than half the code and hits the statement targets Option F
structurally cannot.** That is the decision.

### 2.2 What carries over conceptually

Not the code, but the hard-won semantics:

- POSIX error mapping and when each code fires — `ENOENT` vs `ENOTDIR` vs
  `EISDIR` vs `ELOOP`, and the rule that a missing dirent and a file-typed
  intermediate both surface as the same `null` (`fs/resolve.ts:47-51`).
- Symlink follow rules: intermediate links always followed, final link followed
  only when the caller asks, `SYMLOOP_MAX` of 40 shared across one resolution
  (`fs/resolve.ts:43-45`, `fs/resolve.ts:234-246`).
- Path canonicalisation, including `..` clamping at root
  (`path.ts:10-52`) — ported verbatim.
- Mode masking to twelve bits and the `S_IF*` bits a stat must carry, because
  a stat without them is rejected (`provider.ts:745-757`).
- Dirent ordering by UTF-8 bytes, not `localeCompare`
  (`fs/readdir.ts:168-178`).
- The `Database` transaction discipline: `transactionSync` is the only
  sanctioned way to open a transaction, with savepoints for reentrancy
  (`storage.ts:6-11`, `storage.ts:61-74`). Kompjutr already depends on this
  (`src/sqlite/db.ts:11-16`).

### 2.3 What is genuinely inherited: the tests

Measured on the checkout at
`tmp/computer-src/packages/dofs`:

- 37 test files, 9,268 lines, 337 KB, all MIT.
- Excluding the subtrees we drop (`sync/`, `schema/`, `mount-guard`,
  `blobCache`, `resolveCache`, `gc`, `watch`, `rev`, `testing`):
  **19 files, 4,672 lines.**
- Of those 4,672 lines, **82 mention `vfs_` at all** — 1.8%.

**Those three figures are correct. The inference drawn from them was not.**
E1's sibling probe classified all 517 test cases individually, and the result
is worse than the line count suggests:

| measure | result |
|---|---|
| in-scope cases | 270 |
| **API-shaped — port against any correct implementation** | **151 = 55.9%** |
| API-shaped granting mechanical helper substitution | 231 = 85.6% |
| restricted to the 19 portable files | 61.1% / 91.5% |
| most generous defensible reading | 93.9% |

**Line mentions are the wrong denominator, because coupling concentrates in
helpers.** `writeFile.test.ts`'s `readBack` is 27 lines that name `vfs_chunks`
and `vfs_blob_bytes` exactly twice (`:19`, `:26`) — 2 of the 82 — and it is the
assertion vehicle for **22 of that file's 36 cases**. Its author says why at
`:12-13`: *"A deliberately minimal helper so writeFile tests can stand alone
without depending on readFile."* Two lines couple 61% of the largest portable
file.

A literal pass rate would be **lower** than 55.9%, not higher: classification
cannot see behavioural divergence. `readFile.test.ts:97` names no table, reads
as API-shaped, and would still fail — dofs' open-stream snapshot is an artifact
of content-addressed blobs plus deferred GC, both of which §3.3 drops.

**And the part that matters most has no inherited coverage at all.** `scan`,
`readFiles`, `writeFiles`, `removeFiles` and `glob` are, in §4.2's words, the
point of the exercise. dofs has no such API, so every test for them is new.

### How the inheritance is actually recovered

Not by constraining the production interface. Six of the nine porting blockers
are interface mismatches, not schema ones — `stat` inverting its error
contract, the two `Stat` shapes, the missing `readdir` options bag,
`resolveInode` as the assertion vehicle for 41 cases. Bending `Filesystem` to
match dofs would be letting a test suite design the product.

Instead: **a dofs-shaped conformance adapter lives in
`tests/fs/conformance/harness.ts`**, mapping dofs' free-function calls
(`stat(db, path)`, `readdir(db, path, options)`, `resolveInode`, `readBack`)
onto `Filesystem`. The ported tests call the adapter; production code never
carries the shape. That converts blockers 1, 2, 5 and 6 from interface
decisions into thirty lines of test harness.

Two things the adapter cannot fix, and both are cheap and additive, so §4.1
takes them: `Stat` gains `rev` (the column already exists in `fs_nodes`), and
the filesystem takes an injected clock. Together they recover 6 more cases and
every `mtime` assertion.

Drop `writeBuffer.test.ts` (344 lines) with the buffer — but note the buffer's
reach is wider than one file: **56 cases across 6 files** test it, including 15
in `provider.test.ts:669-916`.

**Budgeted honestly: we inherit roughly 230 of 270 in-scope cases after the
adapter, and hand-port or discard the remaining ~40.** That is a real gate and
worth having. It is not the free 4,330 lines this section originally claimed.

Attribution: a `LICENSES/` entry and file headers naming
`cloudflare/computer`, MIT, matching how `src/core/diff/` and the dgit-derived
pack code are already handled (`README.md:65-70`, `README.md:72-85`).

### 2.4 Dropping the write-back buffer

DOFS keeps an in-memory, per-inode write buffer between an explicit open and
release (`fs/writeBuffer.ts:1-8`), plus a "pending create" entry with a negative
inode for a file that exists only in the buffer (`fs/writeBuffer.ts:37-50`).
Its own reads consult it — `readFileSync` at `provider.ts:360-380`, `lstatSync`
at `provider.ts:159-171`, `readdir` at `fs/readdir.ts:57-69`, `fileSize` at
`provider.ts:764-770`.

This is the correctness hazard that blocks direct SQL reads under Computer, and
the cost is not only the bug: `flushPendingByPath` / `flushPendingUnderNode`
calls are threaded through `unlinkSync` (`provider.ts:239-240`), `renameSync`
(`provider.ts:325-328`), `linkSync` (`provider.ts:310-311`) and `rmdirSync`
(`provider.ts:224`), each with a paragraph explaining which data-loss case it
prevents.

**We do not have it.** File descriptors write through: a `writeSync` is a
`writeRange`, which is one chunk read plus one chunk write. Every read, bulk or
otherwise, sees every committed byte, because there is nowhere else for a byte
to be.

What this costs: a caller that issues thousands of small `writeSync` calls to
one fd pays two statements each instead of zero. Nothing in either consumer
does that today. The trigger to revisit is a shell layer (§6): if `just-bash`
turns out to append byte-at-a-time, add a bounded write-back buffer *inside*
the filesystem module where the bulk read paths can also consult it — which is
possible for us and was not possible from outside DOFS, because its cache is a
module-level `WeakMap` with no exported accessor
(`docs/plans/bulk-sql.md:92-95`).

---

## 3. Schema

**Decision: our own schema, plus a one-way compatibility *reader* and
*importer* for `vfs_*`. No bit-compatibility, no dual-write, ever.**

### 3.1 Why not stay compatible

The two things compatibility buys:

1. **Coexistence with Computer in one database.** Physically possible (the
   table names are disjoint) and semantically worthless: two filesystems over
   the same paths diverge on the first write, and there is no reconciliation
   protocol. §8 makes the divergence a loud error instead.
2. **Inheriting the 337 KB test suite.** §2.3 shows this does not depend on the
   schema — 98.2% of the portable tests never name a table.

The two things it costs:

1. **No path column, anywhere.** Path resolution walks `vfs_dirents` one
   segment per statement (`fs/resolve.ts:225-229`), and the recursive-CTE
   workaround (`src/sqlite/vfs.ts:67-84`) only fixes reads. The write path stays
   at ~15 statements per created file — count them in `writeFileSync`
   (`fs/writeFile.ts:1191-1227`): `resolveWriteTarget` (2 per segment), one
   dirent probe, `insertFileNode`, `insertFileDirent`, `incrementRev`, two blob
   statements and one chunk statement per chunk, `buildManifest`, and the final
   `UPDATE vfs_nodes`.
2. **A hash and a JSON manifest per write that nothing reads.** sha256 at
   `fs/writeFile.ts:139-143`, manifest at `sync/manifests.ts:62-73`. Both exist
   for the container sync protocol, which is out of scope.

### 3.2 The one insight the new schema is built on

SQL `ORDER BY path` under BINARY collation is UTF-8 byte order, which is
exactly git's tree DFS order when a directory sorts as `name/`. This is already
asserted and relied on across the codebase:

- `comparePaths` (`src/core/streams.ts:29`) is the one comparator all merge
  joins use, and it compares code points, not UTF-16 units, for this reason
  (`docs/architecture.md:121-125`).
- `git_index` has `(path, stage)` as its primary key and the index scan pages on
  it (`src/sqlite/store.ts:669`, `docs/architecture.md:107-113`).
- The tree builder relies on SQLite's `ORDER BY path, stage` already matching
  git's tree order and deliberately does not re-sort
  (`src/core/ops/tree-build.ts:20-29`).

If `fs_paths` is keyed on the full path under BINARY collation, then **the
physical storage order of the filesystem is the order the entire git core
merges on.** The working-tree walk stops being a traversal and becomes a keyset
range scan. That is the whole design.

### 3.3 The DDL

```sql
-- ===================================================================
-- Filesystem. Everything under fs_. No table is shared with git_.
-- ===================================================================

CREATE TABLE fs_meta (
  k TEXT PRIMARY KEY,
  v INTEGER NOT NULL
);
-- Seeded rows: 'schema_version', 'rev', 'next_inode'.
--   rev        — monotonic, bumped once per mutating *call*, not per row.
--                This is the counter a poller reads.
--   next_inode — explicit allocator. No AUTOINCREMENT: a bulk write must
--                know its inodes before it builds the fs_paths payload,
--                and AUTOINCREMENT also writes sqlite_sequence per insert.

CREATE TABLE fs_nodes (
  inode       INTEGER PRIMARY KEY,
  type        TEXT    NOT NULL CHECK(type IN ('file','dir','symlink')),
  mode        INTEGER NOT NULL DEFAULT 420,   -- 0o644, permission bits only
  mtime       INTEGER NOT NULL,               -- milliseconds
  size        INTEGER NOT NULL DEFAULT 0,     -- 0 for dirs; target length for symlinks
  rev         INTEGER NOT NULL DEFAULT 0,     -- fs_meta.rev at last mutation
  nlink       INTEGER NOT NULL DEFAULT 1,     -- number of fs_paths rows
  link_target TEXT,                           -- symlinks only
  content_id  BLOB                            -- opaque; see 3.5. NULL = unknown
);

-- Path key. WITHOUT ROWID so the row lives in the PK b-tree leaf and a
-- range scan on `path` is the physical scan order, with `inode` read
-- straight from the leaf.
--
-- `path` is always a REAL path: fully canonical, every symlink on the way
-- already resolved. Never a lexical path. See 3.6 — this is the single
-- most dangerous invariant in the design.
CREATE TABLE fs_paths (
  path   TEXT    NOT NULL PRIMARY KEY,
  parent TEXT    NOT NULL,        -- '' for '/', otherwise the parent's path
  inode  INTEGER NOT NULL
) WITHOUT ROWID;

-- readdir: WHERE parent = ? ORDER BY path. Covering — the index leaf
-- carries `path` (the PK is the row locator on a WITHOUT ROWID table).
-- The basename is sliced in JS; there is no `name` column.
CREATE INDEX fs_paths_by_parent ON fs_paths(parent, path);

-- Reverse lookup for unlink/link/nlink.
CREATE INDEX fs_paths_by_inode ON fs_paths(inode);

-- Content. A rowid table on purpose: rows carry up to CHUNK_SIZE of
-- payload, and WITHOUT ROWID wants small rows — the same reason dofs
-- left vfs_blob_bytes as a rowid table (schema/core.ts:67-72).
CREATE TABLE fs_chunks (
  inode INTEGER NOT NULL,
  idx   INTEGER NOT NULL,
  bytes BLOB    NOT NULL,
  PRIMARY KEY (inode, idx)
);
```

`CHUNK_SIZE = 512 * 1024`, matching `fs/writeFile.ts:29`. The Durable Object
BLOB ceiling is 2 MB; 512 KB leaves room for the bulk-insert payload framing.

Deliberately absent:

- **No index on `fs_nodes.rev`.** The column stays because it is the seam a
  future change-feed would need, but nothing reads it today and the index would
  cost an entry per row on every bulk write. Add it when something needs it.
- **No content-addressed blob table, no manifest table, no `last_seen`.** Two
  identical files store their bytes twice. In exchange there is no hashing on
  the write path and no GC pass — chunks are deleted with their inode.
- **No `_vfs_mounts`, `_vfs_watermark`, `_vfs_fetch_cursor`, `vfs_changes`.**
  See §9.

### 3.4 The git tables

**Almost unchanged.** Twelve tables carry over verbatim from
`src/sqlite/schema.ts`: `git_meta`, `git_repositories`, `git_refs`,
`git_config`, `git_index`, `git_shallow`, `git_objects`, `git_object_chunks`,
`git_pack_meta`, `git_pack_data`, `git_pack_objects`, `git_pack_pending`.

Three additions are needed and **none of them exists in the tree today**.
An earlier draft of this plan said they did; that draft was written against an
uncommitted working copy that has since been reverted. Verified against
`git show HEAD:src/sqlite/schema.ts`:

- `git_blob_ids` — the `content_id` → blob-oid map. This is what makes
  `status` free (§7.1).
- `git_objects.stored` — the storage-format column that removes the deflate
  tax (§7.3).
- `git_commits` — below.

All three land together with their migration in the seam wave, before any
unit depends on them.

This is worth stating plainly: **a workspace already running kompjutr as a
Computer plugin keeps its entire git repository through the switch.** Only the
working tree is imported (§8).

One addition, lazily populated:

```sql
-- Parsed commit headers, so `log` is a graph walk in SQL instead of one
-- object read per commit. Written by whatever first parses a commit —
-- ingest, log, or show — so a repeat log is one statement. Never
-- authoritative: a missing row means "read the object".
CREATE TABLE git_commits (
  repo_id INTEGER NOT NULL,
  oid     TEXT    NOT NULL,
  parents TEXT    NOT NULL,   -- space-separated oids, '' for a root commit
  tree    TEXT    NOT NULL,
  time    INTEGER NOT NULL,   -- committer time, seconds
  PRIMARY KEY (repo_id, oid)
) WITHOUT ROWID;
```

And one change of meaning, not of shape: `git_blob_ids.content_id`
(`src/sqlite/schema.ts:65-70`) was designed against DOFS's `manifest_hash`. It
now holds `fs_nodes.content_id`.

`git_blob_ids` and `git_objects.stored` were drafted as wave-0 seams for
`docs/plans/bulk-sql.md` and reverted when that plan was superseded. They are
re-introduced here as part of the seam wave, this time with the code that reads
them landing in the same run.

### 3.5 `content_id`: the filesystem does not hash

`content_id` is defined as: *an opaque identity for the current bytes. Equal
ids mean equal bytes. NULL means the store cannot say.*

- A plain `writeFile` sets it to **NULL**. The filesystem computes nothing.
- A caller that already knows an identity passes it:
  `writeFiles(entries, { … })` where each entry may carry `contentId`.
- Any mutation of the bytes clears it, at the same choke point that updates
  `size` and `mtime`.

Git supplies the blob oid it already has. On `checkout`, every written file
lands with `content_id = <the blob oid>` and one row in `git_blob_ids` for
free. On `add`, a file whose `content_id` is non-NULL and present in
`git_blob_ids` is **not read and not hashed** — the join in §7.1 answers it.

This is strictly stronger than git's stat cache, which guesses from
`(size, mtime, ino)` (`src/sqlite/schema.ts:53-56`,
`docs/architecture.md:202-204`): a file touched but unchanged, or restored to a
previous content, never gets re-hashed. The stat columns stay for the NULL case.

### 3.6 The invariant that will bite

`fs_paths.path` is a **real** path. If `/a` is a symlink to `/b`, then `/a/c`
must be stored as `/b/c`. Writing a literal `/a/c` row would shadow the target
and diverge from every POSIX filesystem.

Therefore: **every path entering the store is canonicalised through symlinks
first, at one choke point.** This is the job `resolveParent`
(`fs/writeFile.ts:57-126`) does today, one statement per segment. Ours does it
in one statement (§4.5).

The invariant is enforced by construction: the only functions that touch
`fs_paths` take a `RealPath` branded type, and the only producer of a
`RealPath` is `realpath()`. A test asserts that writing through a symlinked
directory lands on the target — DOFS has one already
(`fs/writeFile.test.ts`, the symlink-target cases at `:452`, `:545`).

### 3.7 Rename, and the cost of a path key

The one operation a path key makes worse.

- **File rename:** one `UPDATE fs_paths SET path = ?, parent = ? WHERE path = ?`.
  Same as before.
- **Directory rename:** one statement, but it rewrites every descendant's key:

```sql
UPDATE fs_paths
   SET path   = ?newRoot || substr(path, ?oldLen + 1),
       parent = CASE WHEN parent = ?oldRoot THEN ?newRoot
                     ELSE ?newRoot || substr(parent, ?oldLen + 1) END
 WHERE path >= ?oldRoot || '/' AND path < ?oldRootSuccessor;
```

  `?oldLen` is **`[...oldRoot].length` — code points, not bytes.** This is a
  TEXT `substr()`, so it inherits §7.0's trap exactly: with a byte length, a
  directory whose own name is non-ASCII mis-slices every descendant. Measured
  on the E1 fixture, the byte-length form corrupts 5,223 of 5,252 paths and
  silently loses 294 more to primary-key collisions. It does not always raise.

  `?oldRootSuccessor` is `subtreeSuccessor(oldRoot)` — `oldRoot + "0"`, since
  `'0'` is `0x30` and `'/'` is `0x2F` (§4.1).

  The second statement is the root row itself, whose `parent` also changes when
  the destination directory differs:

```sql
UPDATE fs_paths SET path = ?newRoot, parent = ?newParent WHERE path = ?oldRoot;
```

  `fs_nodes` and `fs_chunks` are untouched — no content moves.

Under an inode+dirent schema this is one row. Under a path key it is N. That is
the trade, and it is why the two-table split exists: only the key table is
rewritten.

**Measured (E1), `node:sqlite`, under `cpu-lease -n 2`:**

| files | statements | rows written | in-memory | file-backed (WAL) |
|---:|---:|---:|---:|---:|
| 500 | 2 | 525 | 1.5 ms | 3.0 ms |
| 1,000 | 2 | 1,050 | 2.9 ms | 5.1 ms |
| **5,000** | **2** | **5,250** | **17.6 ms** | **24.8 ms** |
| 20,000 | 2 | 21,000 | 75.9 ms | 120.9 ms |

Linear in descendants at ~3.5 µs/row, no knee. The inode+dirents equivalent is
1 statement and 1 row at every size. Correctness was verified field by field
against an independently computed expected table, including a six-times
round-trip returning the table byte-for-byte to its original.

Three things the headline number hides:

- **Rows written is N+1**, not N: the descendants plus the root row. A
  "5,000-file" tree is 5,250 rows once directories and the root are counted.
- **Roughly half the wall time is the two secondary indexes.** Each logical row
  rewrite is three b-tree entries, so a 5,000-file rename moves ~15,750
  entries. Dropping the indexes takes the same rename from 17.7 ms to 9.4 ms.
- **Whether Durable Object billing counts secondary-index entries as rows
  written is not verified.** R1 is stated in billed rows, so the ×3 multiplier
  is an open question, not a settled cost.

R1 does not fire: 2 statements and 25 ms against a ~50 ms line. But the margin
is ~2×, not 10×, and at 20,000 descendants it is already spent. Risk R1 in §10
stays open as a ceiling, not as a blocker.

### 3.8 Hardlinks and the join

`fs_paths` → `fs_nodes` is a join on every read. The join exists only so that
two paths can name one inode. Everything else would be faster denormalised onto
the path row.

What it costs: a full `status` scan reads 12,675 path rows and does 12,675
integer-PK lookups — inside the same statement, no extra round trips, roughly
2× the rows read.

What it buys: POSIX hardlinks, a stable `st_ino`, and a correct `nlink`.
Neither consumer needs hardlinks; Computer's own shell adapter already refuses
them (`backends/worker-shell/adapter.ts:242`, `ENOSYS`, "hard links are not
supported by the workspace store"). But `ino` is used — the git index caches it
(`src/sqlite/schema.ts:56`) and the fd surface returns it.

**Decided at the gate: two tables.** It is the reversible choice, the statement
targets in §7 are met either way, and the cost is rows read inside one
statement rather than round trips. See §12 D2.

---

## 4. The filesystem API surface

Two layers. **`Filesystem` is first-class**: path-based, synchronous,
bulk-first, and the only thing git talks to. **`NodeFsCompat` is a shim**: the
node:fs-shaped surface both consumers already call, implemented over
`Filesystem` so neither has to change a line.

### 4.1 First-class: `Filesystem`

```ts
// ---------------------------------------------------------------
// Values
// ---------------------------------------------------------------

export type EntryType = "file" | "dir" | "symlink";

/**
 * A path that has been canonicalised AND resolved through every symlink
 * on the way. The only key `fs_paths` ever holds. Produced only by
 * `realpath()`; the brand exists so a lexical path cannot reach the store
 * by accident. See §3.6.
 */
export type RealPath = string & { readonly __real: unique symbol };

export interface Stat {
  type: EntryType;
  /** Full st_mode, S_IF* bits included. */
  mode: number;
  size: number;
  /** Milliseconds. */
  mtime: number;
  ino: number;
  nlink: number;
  /**
   * `fs_meta.rev` as of this entry's last mutation. Free — the column is
   * already on `fs_nodes` (§3.3) — and six inherited conformance cases
   * assert on it.
   */
  rev: number;
  /** Symlinks only. */
  target: string | null;
  /**
   * Opaque content identity. Equal ids mean equal bytes. `null` means the
   * store cannot say and the content has to be read to be identified.
   */
  contentId: Uint8Array | null;
}

export interface Dirent {
  name: string;
  type: EntryType;
}

/** One row of a bulk scan: the dirent and its stat, together. */
export interface ScanEntry extends Stat {
  /** Absolute, canonical, real. */
  path: string;
}

export interface ScanOptions {
  /**
   * Resume strictly after this path. The caller steers: to skip an
   * ignored subtree, resume at `subtreeSuccessor(dir)`. There is no
   * server-side prune list — only the caller can evaluate ignore rules.
   */
  after?: string;
  /** Hard cap on rows returned. The caller pages. */
  limit: number;
  /** Omit directory rows. Files and symlinks only. */
  filesOnly?: boolean;
}

export interface ReadBatch {
  /** Bytes, keyed by path. A path that has gone missing is absent. */
  files: Map<string, Uint8Array>;
  /**
   * Set when the byte budget stopped the batch early. Re-call with the
   * remaining paths. Never partial *within* a file.
   */
  remaining: string[];
}

export interface WriteEntry {
  path: string;
  /** Omit for a directory or when `target` is set. */
  bytes?: Uint8Array;
  /** Set to write a symlink. */
  target?: string;
  /** Permission bits. Defaults to 0o644 for files, 0o755 for directories. */
  mode?: number;
  /** Opaque content identity to record. Omitted means NULL — unknown. */
  contentId?: Uint8Array;
}

export interface WriteOptions {
  /** Create missing parent directories. Default true. */
  parents?: boolean;
  /** Bytes per SQL statement. Default 1 MiB; hard ceiling 2 MB. */
  payloadBudget?: number;
}

export interface RemoveOptions {
  /** Remove directories and everything under them. Default false. */
  recursive?: boolean;
  /** A path that is not there is not an error. Default true. */
  force?: boolean;
}

// ---------------------------------------------------------------
// The interface
// ---------------------------------------------------------------

export interface FilesystemOptions {
  /**
   * Milliseconds. Injected so tests can pin `mtime`; dofs threads the same
   * thing as a trailing argument on every mutator, and every inherited
   * timestamp assertion depends on it. Defaults to `Date.now`.
   */
  now?: () => number;
}

export interface Filesystem {
  /** The database this filesystem lives in. Shared with the git layer. */
  readonly db: SqlDatabase;

  // -- identity ------------------------------------------------------

  /**
   * Monotonic revision. Bumped once per mutating call, not per row.
   * One statement. This is what a poller reads.
   */
  rev(): number;

  /**
   * Canonicalise and resolve every symlink on the path. One statement in
   * the common case; one more per symlink encountered. The only producer
   * of a `RealPath`.
   */
  realpath(path: string): RealPath;

  // -- single-path reads --------------------------------------------

  /** lstat semantics: a symlink reports as a symlink. `null` when absent. */
  stat(path: string): Stat | null;
  /** stat semantics: follows a trailing symlink. */
  statTarget(path: string): Stat | null;
  exists(path: string): boolean;
  readFile(path: string): Uint8Array;
  /** Up to `length` bytes at `offset`. Short only at EOF. */
  readRange(path: string, offset: number, length: number): Uint8Array;
  readlink(path: string): string;
  readdir(path: string): Dirent[];

  // -- BULK reads (first-class; this is why the runtime exists) ------

  /**
   * One page of everything under `root`, directories included unless
   * `filesOnly`, in path byte order — the order `comparePaths` defines.
   *
   * ONE statement per page. An indexed range scan on `fs_paths`, not a
   * traversal: BINARY collation on the full path is git's tree order
   * (§3.2), so the merge joins above this layer consume it directly.
   */
  scan(root: string, options: ScanOptions): ScanEntry[];

  /**
   * The contents of several files in one round trip, under a byte budget.
   * ~one statement per `payloadBudget` of content.
   */
  readFiles(paths: readonly string[], options?: { budget?: number }): ReadBatch;

  /**
   * Every path under `root` matching a glob, in path order. One statement.
   * `pattern` is matched against the whole path and is capped at 50 bytes
   * by the platform's GLOB limit.
   */
  glob(root: string, pattern: string, options?: { limit?: number }): string[];

  // -- BULK writes (first-class) -------------------------------------

  /**
   * Create or overwrite many entries. Directories, files and symlinks may
   * be mixed; entries are applied in path order so a parent always lands
   * before its children.
   *
   * A constant number of statements for the metadata, plus one per
   * `payloadBudget` of content. See §7.5 for the exact shape.
   */
  writeFiles(entries: readonly WriteEntry[], options?: WriteOptions): void;

  /**
   * Create directories, parents included. Existing ones are left alone.
   * Constant in the number of paths: measured at 8 statements for 10 and
   * for 5,000, and 2 on a repeat call when there is nothing to create.
   */
  makeDirectories(paths: readonly string[]): void;

  /**
   * Remove many paths. Constant in the number of paths: measured at 6 for
   * one path, for 500, and for a 5,000-file recursive tree. A recursive
   * removal is a range delete, so removing a tree costs what removing one
   * file costs. The six are classify, rev bump, orphan chunks, orphan
   * nodes, nlink recount, path range delete.
   */
  removeFiles(paths: readonly string[], options?: RemoveOptions): void;

  // -- single-path writes (thin wrappers over the bulk primitives) ---

  writeFile(path: string, bytes: Uint8Array, options?: { mode?: number; contentId?: Uint8Array }): void;
  /** Create or truncate, ready for writeRange. Creates parents. */
  createFile(path: string, mode: number): void;
  /** Write at `offset`. The file must exist. Clears `contentId`. */
  writeRange(path: string, bytes: Uint8Array, offset: number): void;
  truncate(path: string, length: number): void;
  mkdir(path: string, options?: { recursive?: boolean; mode?: number }): void;
  symlink(target: string, path: string): void;
  /** A second name for one inode. See §3.8 / D2. */
  link(existingPath: string, newPath: string): void;
  unlink(path: string): void;
  rmdir(path: string): void;
  rm(path: string, options?: RemoveOptions): void;
  rename(oldPath: string, newPath: string): void;
  chmod(path: string, mode: number): void;

  // -- scopes --------------------------------------------------------

  /**
   * Bracket a batch of reads. Inside a scope the filesystem may memoise
   * resolutions and stat rows, because no mutation may occur.
   *
   * Ref-counted across concurrent callers so they share one scope.
   * LEXICALLY NESTED CALLS THROW — a nested scope is a bug, not a
   * feature. Any mutation attempted inside a scope throws.
   */
  withReadScope<T>(fn: () => T): T;
}

/** The byte after every path under `dir`. Used to skip a subtree. */
export function subtreeSuccessor(dir: string): string;
```

### 4.2 What is first-class and what is a shim

**First-class** — designed for, documented, versioned, and the only surface the
git layer uses:

`db`, `rev`, `realpath`, `stat`, `statTarget`, `exists`, `readFile`,
`readRange`, `readlink`, `readdir`, **`scan`**, **`readFiles`**, **`glob`**,
**`writeFiles`**, **`makeDirectories`**, **`removeFiles`**, `writeFile`,
`createFile`, `writeRange`, `truncate`, `mkdir`, `symlink`, `unlink`, `rmdir`,
`rm`, `rename`, `chmod`, `withReadScope`.

The five bulk primitives are the point of the exercise. They are not a fast
path bolted onto a per-path API; the per-path methods are wrappers over them.

**Compatibility shims**, in `kompjutr/fs/node-compat`:

| shim | maps to | why it is a shim |
|---|---|---|
| `statSync` / `lstatSync` returning a node `Stats` | `statTarget` / `stat` | the `dev`/`blksize`/`birthtime` padding is node's shape, not ours (`provider.ts:772-801`) |
| `readdirSync(path, {withFileTypes})` | `readdir` | the `Dirent` object with seven predicate methods is node's shape |
| `readFileSync(path, encoding?)` | `readFile` | the string-or-bytes union is node's |
| `existsSync` | `exists` | |
| `writeFileSync`, `mkdirSync`, `rmSync`, `unlinkSync`, `rmdirSync`, `renameSync`, `chmodSync`, `symlinkSync`, `readlinkSync`, `linkSync`, `realpathSync`, `accessSync`, `truncateSync` | the matching first-class method | naming only |
| `writeRangeSync`, `readRangeSync`, `createFileSync` | `writeRange`, `readRange`, `createFile` | naming only |
| `walk(dir, options)` | `glob` / `scan` | the agent runtime's name for it |
| `readFiles`, `writeFiles`, `rmFiles` | `readFiles`, `writeFiles`, `removeFiles` | naming only — these are first-class |
| `openSync` / `readSync` / `writeSync` / `fstatSync` / `ftruncateSync` / `closeSync` | a small fd table over the path methods | **fds are node's concept and the core has no use for them.** ~80 lines, modelled on `provider.ts:61-69` + `provider.ts:100-131` + `provider.ts:560-657` |
| `.db` | `Filesystem.db` | the agent runtime reads it directly and will keep doing so |
| every async twin (`stat`, `readFile`, `writeFile`, …) | `Promise.resolve(sync)` | DOFS does exactly this (`provider.ts:96-98`, `:133-135`, …) |

`existsSync` must not throw: DOFS swallows everything
(`provider.ts:511-518`), and the shell adapter documents why — throwing ENOENT
across Workers RPC makes workerd report an uncaught exception even when the
caller is deliberately probing (`backends/worker-shell/adapter.ts:101-103`).

### 4.3 The static site generator's four methods

Its entire requirement is `readdirSync`, `readFileSync`, `statSync`,
`existsSync`, plus a cheap monotonic revision counter. All four are on the
compat shim above, with working `isFile()` / `isDirectory()` on the `Dirent`.

**Synchronicity is preserved by construction.** The core is synchronous because
DO SQLite is synchronous; async is a wrapper, never the other way round. Its
compilation stays a map lookup inside the object that owns the store.

The revision counter is `fs.rev()` — one statement,
`SELECT v FROM fs_meta WHERE k = 'rev'`. Its current read is
`SELECT v FROM vfs_meta WHERE k = 'rev'`; the shape is identical, and the
importer (§8) carries the value across so a poller does not see the counter go
backwards.

No file watching is needed or offered (§9).

### 4.4 The agent runtime's provider extensions

Every name it calls is in the table in §4.2. `writeRangeSync`, `walk`,
`readFiles`, `writeFiles`, `rmFiles` and `.db` are first-class or trivial
renames; the fd trio is the one genuine shim.

`withReadScope` is the one item whose contract we cannot verify from source.
It is described as ref-counted and explicitly not nested, and it is a top-level
export of the *prerelease tarball* the agent runtime pins — it does not appear
anywhere in the checked-out source at `tmp/computer-src`, nor in the
`@cloudflare/computer@0.2.1` type surface in `node_modules`
(`dist/index.d.ts:443` lists every export; `withReadScope` is not among them).

**Ambiguous.** The signature we can honour is
`withReadScope(db, fn)` as a free function forwarding to
`Filesystem.withReadScope`, with the semantics written in §4.1. Before locking
it, read the pinned tarball.

### 4.5 `realpath` in one statement

The implementation resolves every component in order. This is required for
POSIX cases such as `file/../target`: lexical normalization must not erase the
fact that `file` is not a directory. One indexed statement asks about every
ancestor at once:

```sql
SELECT p.path, n.type, n.link_target
  FROM fs_paths p JOIN fs_nodes n ON n.inode = p.inode
 WHERE p.path IN (SELECT value FROM json_each(?))
 ORDER BY length(p.path);
```

The query is driven by `json_each(?)` and probes `fs_paths` through its primary
key; it does not scan the repository. If an ancestor is a symlink, resolution
rewrites the remaining component stream at that point and retries. The common
case, including a miss, is **one statement**; each symlink batch adds one. The
same `SYMLOOP_MAX` of 40 applies (`src/fs/store/resolve.ts`).

Inputs and expanded symlink paths are capped at 4,096 UTF-16 code units before
their prefix lists are built. Stored link targets are projected through a
4,097-code-point sentinel and rejected if they exceed the same bound. This
keeps the ancestor batch below the 100 MB operation target even for adversarial
path depth.

There is no resolve cache. `fs/resolveCache.ts` (129 lines) and the
`inTransaction` gating that makes it rollback-safe (`storage.ts:61-74`,
`fs/resolveCache.ts:77-80`) both disappear, because there is nothing left to
amortise.

---

## 5. The git API surface

### 5.1 What replaces `GitClient`

`GitClient` (`tmp/computer-src/packages/computer/src/git/index.ts:232-317`) is
40 methods. Kompjutr implements 30 of them and throws
`UnsupportedOperationError` on 7 (`src/computer/client.ts:216-236`).

**Decision: keep the shape, own the type.** `export interface Git` in
`kompjutr/git`, structurally the subset we implement, with:

- Every method that exists today, same names, same option bags
  (`src/computer/client.ts:93-237`).
- `push` / `pull` / `merge` / `stashPush` / `stashList` / `stashPop` **removed
  from the type**, not stubbed. A method that always throws is a worse contract
  than a method that is not there — the caller finds out at compile time.
- `cli(input)` kept: it is the only method the shell reach-back needs
  (`stub.ts:577-579`), and dropping it would close §6 before it opens.
- `symbolicRef(name, target?)` accepting any ref name. Computer's only accepts
  `HEAD`, which is why the agent runtime hardcodes `defaultBranch: undefined`.
  Closing that gap is a one-line capability win.

The five methods the agent runtime actually calls — `status`, `log`, `catFile`,
`configGet`, `hashObject` — are all present and all keep their current shapes
(`src/computer/client.ts:104`, `:138`, `:202`, `:192`, `:199`).

### 5.2 The throwing getter is load-bearing

The agent runtime detects "no git configured" by catching the throw from
Computer's `git` getter (`workspace.ts:463-474`:
`if (!this.#gitFactory) throw new Error(GIT_NOT_CONFIGURED_MESSAGE)`).

Our runtime keeps that behaviour exactly: `Workspace.git` throws when no git
was configured, with a message containing the same substring. It is not an
accident of Computer's design that we are free to improve — it is a probe
somebody wrote code against.

### 5.3 The Computer-compatible façade, and its expiry

`kompjutr/compat/computer` exports `createSqliteGitClient(): GitClientFactory`
— today's `src/computer/client.ts` (256 lines), unchanged except that it now
adapts our `Git` to Computer's `GitClient` instead of being it.

Lifetime, stated up front:

| milestone | state |
|---|---|
| first release of the standalone runtime | shipped, documented, tested |
| both consumers on the native surface | marked deprecated in the changelog and in the JSDoc |
| one minor after that | deleted, with the `@cloudflare/computer` optional peer removed |

It exists so a switch is a one-line import change per consumer rather than a
migration, and so both can run side by side while the switch is verified (§8.3).
It does not exist so we can support Computer indefinitely.

---

## 6. The exec seam

Out of scope to build. In scope to not preclude. The task is to make the seam
sit where a shell layer can be added without reshaping the core.

### 6.1 What the shell actually needs, from the source

Reading `tmp/computer-src/packages/computer`:

1. **The shell runs in a dynamically-loaded Worker with no network and no
   storage.** `WorkerShellBackend` loads it through a Worker Loader binding —
   `loader.get(loaderId, () => ({ compatibilityDate, mainModule: "shell.js",
   modules: {...}, env: { HOST: ctx.exports.WorkspaceServiceProxy({ props }) },
   ...dynamicWorkerEgress(this.#egress) }))`
   (`backends/worker-shell/worker-shell.ts:235-251`), then
   `worker.getEntrypoint("ShellWorker")` (`:254`). The default egress policy is
   `{ mode: "none" }` (`:167`), which maps to `globalOutbound: null`
   (`runtime/egress.ts:9-20`).
2. **Every filesystem call comes back over RPC.**
   `backends/worker-shell/index.ts:4-7`: *"Every filesystem operation from
   inside the shell forwards back to the host Durable Object through a
   WorkspaceServiceProxy loopback; the DO's SQLite is the single authoritative
   store."* Consequently the handle declares `sync: "none"`
   (`worker-shell.ts:201-209`), and Computer's entire push/pull bracket
   (`shell.ts`, 355 lines) short-circuits.
3. **The reach-back chain is four hops.** DO declares `__getWorkspaceStub()` on
   the prototype (`with-workspace.ts:71-77`) → DO builds
   `ctx.exports.WorkspaceServiceProxy({ props: { binding, id } })` → the loaded
   Worker calls `env.HOST.getWorkspace()`
   (`backends/worker-shell/entrypoint.ts:196`) → the proxy resolves
   `env[binding].get(idFromString(id)).__getWorkspaceStub()` (`proxy.ts:186-189`,
   `:219-228`). The `binding` is a *string* because a raw
   `DurableObjectNamespace` does not survive structured clone
   (`proxy.ts:143-149`).
4. **The reach-back surface is small.** `WorkspaceFilesystemStub` is 16 methods
   (`stub.ts:91-288`) and `WorkspaceGitStub` is exactly **one** — `cli(input)`
   (`stub.ts:577-579`), because progress callbacks and `onAuth` do not cross
   Workers RPC (`stub.ts:559-563`).
5. **The process handle *is* a ReadableStream.**
   `WorkspaceRuntimeExecHandle<E> extends ReadableStream<WorkspaceRuntimeEvent<E>>`
   with `id`, `backend`, `result()`, `kill()`, `[Symbol.dispose]`
   (`runtime/types.ts:130-137`). `result()` returns
   `{ status, exitCode, stdout, stderr, value?, pushed, pulled, skipped, sync }`
   (`runtime/types.ts:92-102`), with `status` derived from the exit code
   (`runtime/runtime.ts:339-341`).
6. **`just-bash` is a plain dependency, pre-bundled at pack time**
   (`package.json:120`, `backends/worker-shell/script/build-bundle.mjs`), needs
   `defenseInDepth: { enabled: false }` under workerd because its loader hooks
   use `node:module.registerHooks`, which workerd exposes and then throws from
   (`backends/worker-shell/entrypoint.ts:231-238`).

There is **no "unsupported process runner"** anywhere in this source — a
repo-wide grep for `processRunner` / `ProcessRunner` returns zero hits. It is
in the prerelease tarball. **Ambiguous**; the design below does not depend on
its shape.

### 6.2 The seam, in three parts

**(a) Every filesystem method exists in a sync and an async shape, generated
from one list.**

This is the only structural requirement, and it must be honoured from day one.
RPC is async; our core is sync. If the async surface is derived mechanically
from one declaration, the RPC mirror is generated, not hand-written, and it
cannot drift. If it is hand-written, it drifts on the first added method.

```ts
/** The async mirror. Every member is the sync member returning a Promise. */
export type Async<T> = {
  [K in keyof T]: T[K] extends (...a: infer A) => infer R
    ? (...a: A) => Promise<Awaited<R>>
    : T[K];
};

export type AsyncFilesystem = Async<Omit<Filesystem, "db" | "withReadScope">>;
```

`db` and `withReadScope` are excluded on purpose: a database handle and a
synchronous bracket do not cross a wire.

**(b) A `ProcessHost` interface the core declares and never implements.**

```ts
export type ExitStatus = "completed" | "failed" | "cancelled";

export interface ProcessEvent {
  id: string;
  seq: number;
  name: "stdout" | "stderr" | "exit";
  /** Present on stdout/stderr. */
  chunk?: Uint8Array;
  /** Present on exit. */
  code?: number;
}

export interface ProcessResult {
  status: ExitStatus;
  exitCode: number;
  stdout: Uint8Array;
  stderr: Uint8Array;
}

export interface ProcessHandle extends ReadableStream<ProcessEvent>, Disposable {
  readonly id: string;
  result(): Promise<ProcessResult>;
  kill(signal?: string): Promise<void>;
}

export interface ProcessHost {
  exec(command: string, options?: {
    id?: string;
    cwd?: string;
    env?: Record<string, string>;
    stdin?: Uint8Array;
    timeoutMs?: number;
  }): Promise<ProcessHandle>;
}
```

`ProcessHandle` extends `ReadableStream` and carries `result()`,
`[Symbol.dispose]` and `status | exitCode | stdout | stderr`, matching
`runtime/types.ts:130-137` and `:92-102` field for field, so an existing caller
does not have to be rewritten.

`Workspace.exec` throws when no `ProcessHost` was configured, with the same
shape as the `git` getter (§5.2). That is the default: an unconfigured runtime
refuses, loudly, and a benchmark harness swaps in a real one.

**(c) An `RpcHost` object, defined but not wired.**

```ts
/** Exactly what a dynamically-loaded Worker may reach. Nothing else. */
export interface RpcHost {
  readonly fs: AsyncFilesystem;
  readonly git: { cli(input: GitCliInput): Promise<GitCliResult> };
}
```

The filesystem half is generated from `Filesystem`. The git half is one method,
because that is all Computer's shell needed and the reason is structural, not
incidental — network-bound git subcommands run host-side precisely because the
shell isolate has no network (`backends/worker-shell/git-command.ts:3-9`).

**The reach-back is an RPC problem, not a filesystem problem.** Nothing in §3
or §4 changes to support it: no second store, no sync, no watermarks. When the
shell lands it declares the equivalent of `sync: "none"` and Computer's entire
355-line push/pull bracket has no analogue here.

### 6.3 What the seam explicitly does not decide

- Which RPC library. capnweb is what Computer uses, with a documented reason
  (`stub.ts:35-40`: capnweb's `RpcTarget` resolves under both workerd and node,
  `cloudflare:workers` only under workerd). Worth copying, worth deciding later.
- Whether the shell is `just-bash` or something else.
- Whether output is streamed or buffered. Computer's shell buffers the whole run
  into at most three events (`backends/worker-shell/entrypoint.ts:272-281`).
- Reattach. Computer's shell refuses it — `getExec` always throws ENOENT
  (`backends/worker-shell/entrypoint.ts:290-292`) — because the shell holds no
  per-call state across requests.

---

## 7. Per-operation SQL design

All counts at 9,329 files / 3,346 directories / 12,675 nodes / 24 MB, the
Prettier 3.9.6 fixture (`docs/benchmark-reference.md`). Page sizes: worktree
scan 1,000 rows, index scan 2,048 rows, payload budget 1 MiB.

Statement counts are the Durable Object metric; wall time is reported from
local runs only and is not a duration inside a Worker
(`docs/benchmark-reference.md`, measurement rule 1).

### 7.0 The three primitives everything is built from

**P1 — the working-tree scan. One statement per page.**

```sql
SELECT p.path, p.inode,
       n.type, n.mode, n.mtime, n.size, n.nlink, n.rev, n.link_target, n.content_id
  FROM fs_paths p
  JOIN fs_nodes n ON n.inode = p.inode
 WHERE p.path > ?after AND p.path < ?rootSuccessor
 ORDER BY p.path
 LIMIT ?page;
```

An indexed range scan on the `fs_paths` PK b-tree, joined to `fs_nodes` on an
integer primary key. No recursion, no CTE, no priority-queue trick. BINARY
collation makes the output order identical to `comparePaths`
(`src/core/streams.ts:29`), so `joinSorted3` (`src/core/streams.ts:183`)
consumes it unchanged.

To skip an ignored subtree the caller resumes at `subtreeSuccessor(dir)` —
`dir + "0"`, since `'0'` is `0x30` and `'/'` is `0x2F`. The current page is
discarded, costing at most one extra statement per pruned directory. This is
strictly better than a server-side prune list
(`src/sqlite/vfs.ts:80`), which could only match literal directory *names* and
could not evaluate a `.gitignore` pattern.

**The initial cursor is `root + "/"`, not `root`.** This is the bug the
bounds check exists to catch, and the SQL above is written as if `?after`
started at `root` itself. It must not: `/repo/src-extra` and `/repo/src.txt`
both sort above `/repo/src` and below `/repo/src0`, so they land inside the
range. `'-'` is 0x2D and `'.'` is 0x2E, both below `'/'` at 0x2F, so a lower
bound of `root + "/"` excludes them and `subtreeSuccessor(root)` still bounds
the top. Root `/` is special-cased to `/`, since `//` would exclude `/!foo`.

`?root` is an already-resolved `RealPath`, resolved **once** by the caller and
held across every page. Resolving per page doubles the statement count.

12,675 rows ÷ 1,000 = **13 statements**, plus ~2 for prunes = **15**.

Measured against the alternative, on a real 9,329-file database under
`cpu-lease -n 2`:

| shape | rows | statements | wall |
|---|---:|---:|---:|
| inode + dirents, recursive-CTE priority queue | 12,675 | 13 | 43 ms |
| **path-keyed range scan (P1)** | 12,675 | **13** | **15 ms** |

Same paths, same order, verified row by row. Query plan for P1 is
`SEARCH fs_paths USING PRIMARY KEY (path>? AND path<?)`. **The statement count
is not what the path key buys** — the CTE reaches it too, over dofs' existing
schema. What it buys is ~3× wall time, the removal of the resume-predicate and
ordering arguments the CTE needs to prove, and the bulk *write* path in P3,
which the inode+dirent shape cannot have at all.

**P2 — bulk read. One statement per byte budget.**

```sql
SELECT c.inode, c.idx, c.bytes
  FROM fs_chunks c
 WHERE c.inode IN (SELECT value FROM json_each(?inodes))
 ORDER BY c.inode, c.idx;
```

The caller sizes each batch from the `size` it already has from P1, so the
result set never exceeds the budget. 24 MB ÷ 1 MiB ≈ **24 statements**; at a
2 MB budget, 12.

`json_each(?)` is one bound parameter regardless of batch size, so the
100-parameter ceiling is never approached. DOFS relies on the same construct
(`fs/resolve.ts:150`).

**P3 — bulk BLOB insert. One statement per payload.**

```sql
INSERT INTO fs_chunks (inode, idx, bytes)
SELECT json_extract(j.value, '$.i'),
       json_extract(j.value, '$.x'),
       substr(?payload, json_extract(j.value, '$.at'), json_extract(j.value, '$.n'))
  FROM json_each(?offsets) j
 WHERE true
ON CONFLICT(inode, idx) DO UPDATE SET bytes = excluded.bytes;
```

Three bound parameters: the concatenated payload BLOB, the JSON offset array,
and nothing else. Measured at 2,000 rows in 1 statement, 4 ms, round-trip
byte-identical. `WHERE true` is mandatory — SQLite cannot parse `ON CONFLICT`
after a `SELECT` without it.

Metadata rows carry no BLOBs and use the JSON form directly:

```sql
INSERT INTO fs_nodes (inode, type, mode, mtime, size, rev, nlink, link_target, content_id)
SELECT json_extract(j.value,'$.i'), json_extract(j.value,'$.t'), …
  FROM json_each(?) j
 WHERE true
ON CONFLICT(inode) DO UPDATE SET
  mode = excluded.mode, mtime = excluded.mtime, size = excluded.size,
  rev = excluded.rev, content_id = excluded.content_id;
```

9,329 node rows serialise to ~840 KB of JSON — one statement, well under the
2 MB parameter ceiling.

**The trap in P3, if the payload form is ever used for text.** `substr()`
counts **bytes** over a BLOB and **characters** over TEXT. The `fs_chunks` form
above is safe because the payload is a BLOB. Anyone reaching for the same trick
to bulk-insert `fs_paths` — concatenating paths into one TEXT payload — must
compute offsets in code points, not bytes. Getting this wrong is silent: it
raises no error and returns the right *number* of rows, with every path after
the first non-ASCII byte sliced at the wrong boundary. Measured on the Prettier
fixture, which has non-ASCII test filenames: 422 of 12,675 paths corrupted, no
diagnostic. Prefer the JSON form for paths; if the payload form is used, the
offsets are `[...path].length`.

### 7.1 `status` — ≤ 170 statements

| step | statements | shape |
|---|---:|---|
| ignore-file discovery | 1 | `glob(root, '*/.gitignore')` — one range scan of `fs_paths` |
| ignore-file contents | 1 | P2 over those inodes (typically < 10 files) |
| working-tree scan | 15 | P1, 13 pages + prunes |
| index scan | 5 | `indexScan` as it stands (`src/sqlite/store.ts:669`), 2,048/page |
| HEAD tree | 25–150 | tree objects, batched per generation |
| content reads | 0 | see below |
| **total** | **47–172** | |

The three sources feed the existing `joinSorted3` (`src/core/ops/status.ts:91`)
unchanged; the comparator, the key extractors and the streaming structure all
stay.

**Content reads are zero when nothing changed.** The scan statement carries the
answer:

```sql
SELECT p.path, p.inode, n.type, n.mode, n.size, n.mtime, n.content_id, b.oid
  FROM fs_paths p
  JOIN fs_nodes n ON n.inode = p.inode
  LEFT JOIN git_blob_ids b ON b.repo_id = ?repo AND b.content_id = n.content_id
 WHERE p.path > ?after AND p.path < ?rootSuccessor
 ORDER BY p.path LIMIT ?page;
```

`b.oid` non-null and equal to the index entry's oid means the file is unchanged
— no read, no SHA-1, no stat heuristic. Only a file whose `content_id` is NULL
(written through a plain `writeFile`) is read and hashed, batched through P2.

**What this join is and is not responsible for.** The drop from 202,234
statements to under 200 is the *bulk scan*, not the join — any bulk walk gets
there. Measured on a real 9,329-file database: a recursive-CTE priority queue
over dofs' own `vfs_nodes`/`vfs_dirents` returns the same 12,675 rows in **13
statements / 43 ms**, and the path-keyed range scan returns them in **13
statements / 15 ms**. Identical paths, identical order, verified.

The join buys something different and still worth having: the ~24 P2 statements
the content read would otherwise cost, and — the real prize — the SHA-1 and the
byte movement behind them, which is the difference between a `status` that
finishes in milliseconds and one that finishes in about a second. `content_id`
is carried for wall time, not for statement count.

**The HEAD tree is the loose end.** 3,346 tree objects, read through
`treeStream` (`src/core/ops/tree-stream.ts:22`) at ~2 SELECTs per object on an
LRU miss today. Batched per generation with

```sql
SELECT o.oid, o.type, o.size, o.stored, c.seq, c.data
  FROM git_objects o
  JOIN git_object_chunks c ON c.repo_id = o.repo_id AND c.oid = o.oid
 WHERE o.repo_id = ? AND o.oid IN (SELECT value FROM json_each(?oids))
 ORDER BY o.oid, c.seq;
```

that becomes one statement per tree depth level (~12 for Prettier), plus the
pack chunks those objects span. The 16 MiB object LRU
(`docs/architecture.md:88-92`) holds Prettier's whole tree set, so the pack
chunk reads are paid once. Worst case, with a cold 4 MiB chunk LRU thrashing
against a 10 MB pack, is ~150.

If measurement says otherwise, the escape hatch is a flattened HEAD-tree cache
— `git_tree_cache(repo_id, commit_oid, path, mode, oid)` written at checkout
and commit, making the HEAD side a third range scan at 5 statements. It is
~750 KB per cached commit and one bulk insert to maintain. **Not built now**;
the numbers above do not need it.

Also fixed here: `status` currently scans `git_index` **twice** end to end,
once for the join and once inside `trackedDirectories`
(`src/core/ops/status.ts:93` and `:208`, reached from `:87` whenever
`untrackedFiles !== "all"`). The directory set can be derived from the first
scan.

Wall time: the scan is 13 index-ordered page reads; nothing is hashed and
nothing is read. **Under 0.1 s. Target met.**

### 7.2 `diff` / `diffSummary` — ≤ 180 statements

Same three sources as `status` (`src/core/ops/diff.ts:140`, `:144`, `:156`),
same counts, plus content for changed paths only, batched through P2 instead of
the current one `readFile` per path (`src/core/ops/worktree-io.ts:147`, reached
from `src/core/ops/diff.ts:200`).

A no-change `diffSummary` is `status`'s count. A 500-file `diff` adds ~2
statements of content. **Target met**, and the lazy `bytes()` thunk
(`src/core/ops/diff.ts:85-86`) keeps memory at one file at a time.

### 7.3 `add --all` — ≤ 230 statements

| step | statements |
|---|---:|
| ignore discovery + contents | 2 |
| working-tree scan (P1, with the `git_blob_ids` join) | 15 |
| index scan | 5 |
| HEAD tree (only for `commit -a`; `src/core/ops/staging.ts:70`) | 0–150 |
| content of changed files (P2, worst case all 24 MB) | 24 |
| `git_objects` metadata, one JSON batch | 2 |
| `git_object_chunks`, P3 at 1 MiB | 24 |
| `git_index` upsert, one JSON batch (~930 KB) | 1 |
| **total** | **73–223** |

Two changes to the store are required, and both are pure wins with no call-site
change:

1. `indexApply` (`src/sqlite/store.ts:716`) and `indexReplace` (`:636`) batch
   *transactions*, not statements — one `indexPut` (`:605`) or `indexRemove`
   (`:624`) per row, 512 per transaction. Both already buffer a `pending` array
   of exactly the right shape (`:638`, `:720`); converting the flush to a
   `json_each` upsert is local.
2. `write` (`src/sqlite/store.ts:259`) costs `has()` (1–2 SELECTs) + 1 INSERT +
   1 DELETE + one INSERT per chunk — **≥ 4 statements per staged file**. All of
   it collapses into P3 plus one metadata batch: `ON CONFLICT DO NOTHING` *is*
   the existence probe, and the `DELETE FROM git_object_chunks` disappears with
   it because the store is content-addressed — an oid that exists already has
   exactly these bytes.

**Wall time: not met, and it cannot be.** The floor is SHA-1 of 24 MB (143 ms
measured) plus deflate. The `git_objects.stored` column already exists for the
raw/zlib split (`src/sqlite/schema.ts:89`, with its migration at `:167`) but
**nothing reads or writes it** — `store.ts` never mentions it, so every object
is still deflated. Wiring it up with a threshold (proposed 4 KiB) removes most
of the 835 ms currently spent deflating 9,329 small buffers that barely
compress. The hash stays. Expect ~250–400 ms for a cold full stage.

### 7.4 `commit` — ≤ 15 statements

| step | statements |
|---|---:|
| conflict probe (`src/core/ops/commit.ts:32`) | 1 |
| HEAD + ref (`src/core/ops/commit.ts:36`) | 2 |
| identity config (`src/core/ops/commit.ts:72`) | 2 |
| index scan | 5 |
| 3,293 tree objects: metadata batch + P3 (~800 KB) | 2 |
| commit object | 1 |
| `setHead` + `setRef` | 2 |
| **total** | **15** |

Down from 16,542, of which 16,465 are the five-statement-per-tree write in
`tree-build.ts:71` → `store.ts:259`.

Nothing else about `commit` changes: `buildTree`
(`src/core/ops/tree-build.ts:30`) is already a single depth-bounded pass over
`indexScan`, holds a stack proportional to depth rather than file count
(`src/core/ops/tree-build.ts:1-8`), and touches no worktree method at all.

Wall time: SHA-1 over 800 KB of tree bytes is ~4 ms; the remaining cost is
deflating 3,293 small buffers at ~90 µs of fixed cost each, which is why
`git_objects.stored` needs wiring up (§7.3). With it, **under 0.1 s. Target
met.** Without it, ~300 ms.

### 7.5 `checkout` — ≤ 200 statements

This is the operation Computer makes structurally impossible: ~45 statements
per file written, ~420,000 for this fixture
(`docs/plans/bulk-sql.md:81-86`).

**Read side** (~171): target tree stream (25–150) + index scan (5) + working
tree scan (15). One fix: the unforced path currently walks the target tree
twice and scans the index twice — `refs.ts:237-239` for the guard and
`checkout.ts:59` for the write. One pass feeds both.

**Write side** — `writeFiles(entries)` for 9,329 files and 24 MB:

| step | statements |
|---|---:|
| which directories exist (`SELECT path FROM fs_paths WHERE path IN json_each(?)`) | 1 |
| reserve an inode range (`UPDATE fs_meta … RETURNING v`) | 1 |
| insert missing `fs_nodes` for directories (JSON batch) | 1 |
| insert missing `fs_paths` for directories (JSON batch) | 1 |
| which target files exist | 1 |
| drop old chunks (`DELETE FROM fs_chunks WHERE inode IN json_each(?)`) | 1 |
| reserve inodes for new files | 1 |
| upsert `fs_nodes` (~840 KB JSON) | 1 |
| insert `fs_paths` (~560 KB JSON) | 1 |
| content, P3 at 1 MiB | 24 |
| bump `fs_meta.rev` once | 1 |
| **write side total** | **34** |

Plus `removeFiles` for pruned paths — **5 statements regardless of count**, of
which the recursive case is a range delete:

```sql
DELETE FROM fs_chunks WHERE inode IN (
  SELECT inode FROM fs_paths WHERE path >= ?root AND path < ?rootSuccessor);
DELETE FROM fs_paths  WHERE path >= ?root AND path < ?rootSuccessor;
DELETE FROM fs_nodes  WHERE inode NOT IN (SELECT inode FROM fs_paths)
                        AND inode IN (SELECT value FROM json_each(?));
```

`pruneEmptyDirectories` (`src/core/ops/checkout.ts:123-132`) — one `readdir`
and one `rmdir` per candidate — becomes part of the same range delete.

**Total `checkout` ≈ 200 statements.** Memory is bounded by the payload budget:
the caller reads a batch of blobs from the pack under 1 MiB, writes it, and
repeats. Peak working set ~5 MB, against a 100 MB ceiling.

Wall time: writing 24 MB through 24 statements, plus inflating the pack.
Expect 200–400 ms. **Not met.**

### 7.6 `clone` / `fetch` — ≤ 240 statements

| step | today | target |
|---|---:|---|
| pack chunk writes (`packs.ts:442`, 1 per `PACK_CHUNK`) | ~10 | 10 — already bulk-sized |
| `git_pack_objects` (`packs.ts:646`, **1 `INSERT OR IGNORE` per object**) | 12,676 | **2** — 12,676 rows ≈ 1.5 MB of JSON |
| pending deltas (`packs.ts:530`, `:623`) | varies | 1 per drain pass |
| ref/config/repository writes (`network.ts:183-207`, 1 per ref) | ~10 | 3 — one JSON batch for refs |
| `setShallow` (`store.ts:764`, 1 per oid) | varies | 1 |
| checkout | ~420,000 | 200 |
| **total** | 595,018 | **≈ 220** |

`#insertObject` (`src/sqlite/packs.ts:642-646`) is the single biggest remaining
statement source and needs the same JSON-batch treatment as the index and the
object store. A 100k-object pack is 100k statements today.

Wall time: SHA-1 per object during ingest, plus inflate. **Not met**, and the
known lever is `crypto.subtle.digest("SHA-1", …)` — byte-identical, ~24× faster
per dgit's measurement, and async, which is why it has not been done
(`docs/architecture.md:250-255`). Out of scope here.

### 7.7 `log` — ≤ 100 statements, with a caveat

`log` reads commits one at a time and cannot batch, because each parent is
discovered only after its child is parsed. `repo.walk`
(`src/core/repository.ts:230-246`) is a date-ordered priority queue implemented
as insertion sort into an array — O(queue) per push.

- `log -n 50`: ~50 object reads, ~2 statements each on an LRU miss, plus ref
  resolution. **≤ 100. Target met.**
- Unbounded `git log` on a 10,000-commit history: ~20,000 statements.
  **Target not met, and it cannot be with the objects as the only source.**

`git_commits` (§3.4) closes it. Populated lazily by whatever first parses a
commit, it turns the walk into one recursive CTE over rows the second time the
same history is walked:

```sql
WITH RECURSIVE hist(oid, time) AS (
  SELECT oid, time FROM git_commits WHERE repo_id = ? AND oid = ?tip
  UNION
  SELECT c.oid, c.time FROM hist h
    JOIN git_commits c ON c.repo_id = ?
   WHERE instr(' ' || (SELECT parents FROM git_commits
                        WHERE repo_id = ? AND oid = h.oid) || ' ',
               ' ' || c.oid || ' ') > 0
)
SELECT oid FROM hist ORDER BY time DESC LIMIT ?;
```

A cold `log` costs what it costs today; every subsequent one is one statement.
The table is never authoritative — a missing row means "read the object" —
so it cannot go stale in a way that produces a wrong answer.

Also worth fixing while here: resolving a short ref name costs up to **seven**
scalar SELECTs (`src/core/repository.ts:20-27` lists six candidates,
`:122-127` re-reads the winner). One `IN (SELECT value FROM json_each(?))`
answers all six at once.

### 7.8 Where the wall-clock target cannot be met, and why

The owner's target is ≤ 0.1 s wall for **every** operation. Three do not reach
it and the reason is physics, not SQL:

| operation | floor | why |
|---|---|---|
| `add --all`, cold | ~250 ms | SHA-1 of 24 MB is 143 ms measured; deflate of what remains above the raw threshold adds the rest |
| `checkout` / `clone`, full tree | ~250–400 ms | 24 MB has to be inflated from the pack and written; the SQL is 24 statements, the bytes are the cost |
| `clone` ingest | ~150 ms + transfer | one SHA-1 per object over the whole pack |

Statement counts hit the target for all of them. Wall time does not, and no
schema fixes it — only a native hash (`crypto.subtle`, async) and a smaller
working set would.

**Decided at the gate: the wall target is retargeted to a working set** —
**≤ 0.1 s for any operation touching ≤ 1,000 changed files.** That is the shape
of real traffic, it is measurable, and it holds the code to a number. A
full-repository `add --all`, `checkout` or `clone` stays above it, and the
benchmark reports the measured figure rather than a pass. The async-SHA-1 work
is not taken now. See §12 D3.

### 7.9 The one escape hatch, named

If the HEAD-tree read turns out to dominate `status`, the next lever is to push
the worktree × index join into SQL:

```sql
SELECT p.path, n.type, n.mode, n.content_id, b.oid AS wt_oid,
       i.mode AS ix_mode, i.oid AS ix_oid
  FROM fs_paths p
  JOIN fs_nodes n ON n.inode = p.inode
  LEFT JOIN git_blob_ids b ON b.repo_id = ?r AND b.content_id = n.content_id
  LEFT JOIN git_index    i ON i.repo_id = ?r AND i.stage = 0
                          AND i.path = substr(p.path, ?rootLen)
 WHERE p.path > ?after AND p.path < ?rootSuccessor
 ORDER BY p.path LIMIT ?page;
```

This is git SQL naming `fs_*` tables, which §1.2 forbids by default. It is
listed here so that if it is ever taken, it is taken deliberately, behind a
measurement, and with the table layout promoted to a documented internal
contract at the same time.

---

## 8. Migration and coexistence

### 8.1 What has to move

| state | where it lives now | what happens |
|---|---|---|
| git objects, refs, index, config, packs | `git_*` (ours) | **nothing** — carried over untouched |
| working tree | `vfs_*` (Computer's) | imported once, §8.2 |
| a Computer-managed `.git` directory | `vfs_*` as files | **not imported** — see below |
| mounts, sync watermarks, change log | `_vfs_*`, `vfs_changes` | dropped (§9) |

A workspace already running kompjutr as a plugin keeps its entire repository.
Only the working tree moves.

A workspace running Computer's own isomorphic-git client has a real `.git`
directory sitting in the filesystem. **We do not import it.** Parsing
`.git/index`, the loose object layout and the packed-refs file is a feature in
its own right, and both consumers can reach the same state more cheaply: the
agent runtime clones from HTTPS, and a local-only repository can be
re-`init`ed and re-`add`ed from the imported working tree. What is lost is
local history that was never pushed. Stated, not hidden.

### 8.2 The importer

`kompjutr/compat/computer` exports `importFromComputer(db, options)`. The
implementation migrates directly from `vfs_*` to `fs_*` inside SQLite. It does
not materialise file payloads in JavaScript. A successful import is **8 SQL
statements** for both 933 and 9,329 files, with no BLOB result returned to
JavaScript and at most two bindings per statement.

The caller must pass the literal quiescence acknowledgement and must stop using
the Computer provider in that isolate first. Computer can hold private fd and
write-buffer state that direct SQL cannot observe. The acknowledgement turns
that otherwise unverifiable precondition into an explicit API decision.

Carried across: `path`, `type`, `mode`, `mtime`, `link_target`. `size` is
recomputed. A validated `manifest_hash` becomes `content_id`; valid
manifestless files produced by Computer's range, truncate, fd and create paths
import with `content_id = NULL`. Manifest-backed files validate the complete
manifest and tolerate stale `vfs_nodes.size`. Manifestless files instead
require contiguous chunks from index zero, present BLOB rows, exact per-chunk
sizes, and an aggregate byte length equal to `vfs_nodes.size`.
`vfs_meta.rev` is copied into `fs_meta.rev` so a poller never sees the counter
go backwards.

Not carried: inode numbers (ours are allocated fresh), `vfs_changes`,
watermarks, mounts, `stub_size`, `mount_root`.

The importer is the only code that ever reads a `vfs_*` table.

### 8.3 Coexistence, and the latch

**The two runtimes must never write the same database.** They are two
filesystems over one path namespace with no reconciliation protocol; they
diverge on the first write and nothing detects it.

Import writes a latch:

```sql
INSERT INTO fs_meta (k, v) VALUES ('imported_vfs_rev', ?), ('imported_at', ?);
```

Every subsequent open compares `vfs_meta.rev` — one statement — against
`imported_vfs_rev`, and **throws** if it moved. That converts silent divergence
into a startup error naming the problem. When `vfs_meta` is absent (a fresh
database) the check is skipped.

Running side by side during the switch is supported in exactly one shape:
**shadow reads.** A wrapper answers each read from both runtimes and asserts
they agree, writing through neither. ~50 lines, ships in `./testing`, and is
the only honest way to gain confidence before the cutover. It is a switch-over
tool, not a mode anybody runs in production.

### 8.4 How each consumer switches

**The static site generator.** Its library layer imports neither Computer nor
node:fs — it consumes a structurally-typed interface it owns, of four methods
plus a counter. Switching is changing which object is passed in. Both objects
satisfy the same structural type, so it can be done per-deployment with no
code change in the library at all. Computer is a devDependency used to compile
one example; that example moves to `kompjutr/fs`.

**The agent runtime.** Three steps, each independently revertible:

1. Swap the provider for `kompjutr/fs`'s node-compat shim. Every method it
   calls is in §4.2. Its two modules that hard-code `vfs_meta`, `vfs_nodes`,
   `vfs_dirents`, `vfs_changes` and `vfs_nodes_by_rev` — documented on their
   own side as "private schema, not an API" — either switch to `fs_*` or, better,
   delete: their native `status` fast path exists because Computer's git took
   7.8 s where their SQL took 50 ms, and §7.1 makes ours a range scan. Each of
   those readers already degrades to `undefined` on failure, so the switch is
   safe to stage.
2. Keep `createSqliteGitClient()` from `./compat/computer` at first — no git
   code changes. Move to the native `Git` surface afterwards, which is when
   `symbolicRef` closes the `defaultBranch` gap (§5.1).
3. Drop the pinned prerelease tarball. This removes the failure mode where a
   cleared temp directory makes the repository un-installable, which is on its
   own sufficient reason to do step 1 early.

Its private benchmark harness — the worker-shell backend, the capnweb reach-back
and `git.clone` over HTTPS with Basic auth — depends on §6, which is not built.
Until then that harness stays on Computer. Clone over HTTPS with Basic auth is
ours already (`src/core/ops/network.ts:219`).

---

## 9. Explicitly out of scope

| dropped | evidence | what a consumer loses |
|---|---|---|
| **Container sync protocol** — apply, coalesce, changes, watermarks, fetch, push, manifests, blobs, ignore, invariant, paths (1,266 lines under `sync/`) | `sync/apply.ts` is 594 lines of it | running a container beside the workspace with files synchronised both ways. Neither consumer does. |
| **Mounts** — `_vfs_mounts`, the read-only guard (`fs/mount-guard.ts`, 98 lines), the R2 provider | `fs/mount-guard.ts:1-15` | mounting an R2 bucket read-only into the tree. No consumer uses it. |
| **Content addressing, dedup and GC** — `vfs_blobs`, `vfs_blob_bytes`, `vfs_manifests`, `fs/gc.ts`, `fs/blobCache.ts` | `sync/manifests.ts:62-73`, `fs/gc.ts:20-45` | two identical files cost twice the storage. In exchange: no hash on the write path, and no GC pass at all — chunks die with their inode. |
| **File watching** — `fs/watch.ts` (163 lines), `vfs_changes`, the `vfs_nodes_by_rev` index | `provider.ts:678-701` | `fs.watch`. The static site generator explicitly polls a counter instead; the agent runtime does not watch. `fs.rev()` covers the cheap case. |
| **The write-back fd buffer** — `fs/writeBuffer.ts` + `fs/pendingWriteBuffer.ts` (204 lines) | §2.4 | many small `writeSync` calls each cost SQL instead of nothing. Removes the invisible-bytes hazard entirely. |
| **Multi-backend cursors** — `_vfs_watermark`, `_vfs_fetch_cursor` | `schema/sync.ts:31-47` | nothing; there is one store. |
| **`@platformatic/vfs` / FUSE contract** | `provider.ts:1-8`, `workspace.ts:500-513` | the `VirtualProvider` shape as a *promise*. We keep the method shapes; we do not promise FUSE-mountability. `internalModuleStat`, `copyFile`, `appendFile` are already `ENOSYS` in DOFS (`provider.ts:496-533`). |
| **Assets, artifacts, AI tools, the JavaScript module backend** | Computer's `src/assets/`, `src/artifacts/`, `src/tools/`, `src/backends/worker-javascript/` (1,771 lines) | those features. Never ours. |
| **Exec / shell** | §6 | running commands. Deferred, with the seam designed so it is additive. |
| **`push` / `pull` / `merge` / `stash`** | `src/computer/client.ts:216-236` — already unimplemented | nothing that works today. Removed from the type rather than left throwing. |
| **Hardlinks**, if D2 goes that way | §3.8 | `ln` without `-s`. Computer's own shell adapter already refuses them (`backends/worker-shell/adapter.ts:242`). |

---

## 10. Cost and risk

### 10.1 Line count

**Filesystem module (new).**

| bucket | lines | what |
|---|---:|---|
| ported verbatim | 220 | `path.ts` 52, `errors.ts` 36, `storage.ts` 115, `types.ts` 16 |
| adapted — same signatures, new bodies | 1,910 | the table in §2.1 |
| new | 1,400 | bulk primitives 500, runtime object 200, RPC mirror 250, `vfs_*` importer 250, schema+migrations 200 |
| **filesystem total** | **3,530** | replacing 7,421 |

**Changes to what already exists.**

| area | lines changed | what |
|---|---:|---|
| `src/core/worktree.ts` | +40 | `writeMany` / `removeMany` / `mkdirpMany` on the interface |
| `src/core/ops/checkout.ts` | ~120 | bulk write path; one tree pass instead of two |
| `src/core/ops/status.ts`, `staging.ts`, `diff.ts` | ~200 | consume `scan` / `readFiles`; drop the double index scan and the double stat |
| `src/core/ops/refs.ts` | ~60 | share one tree pass with `checkoutTree` |
| `src/core/ignore/index.ts` | ~50 | batch rule loading (one `glob` + one `readFiles`, replacing one stat+read per directory at `ignore/index.ts:113-115`) |
| `src/core/repository.ts` | ~40 | batch ref-candidate resolution; use `git_commits` |
| `src/sqlite/store.ts` | ~150 | batched index and object writes |
| `src/sqlite/packs.ts` | ~60 | batched `#insertObject` |
| deleted | −592 | `src/computer/` 416, `src/sqlite/vfs.ts` 176 → moves to `./compat` |
| **subtotal** | **~720 changed, −592 deleted** | |

**Tests.**

| bucket | lines |
|---|---:|
| inherited from DOFS, ~82 lines to fix | 4,330 |
| existing kompjutr suite, kept | 5,518 |
| new — bulk primitives, importer, statement-count assertions | ~900 |

**Total production code after the change:** ~8,500 − 592 + 720 + 3,530 ≈
**12,160 lines**, from 8,500. The filesystem it replaces is 7,421.

### 10.2 The three risks most likely to kill this

**R1 — the path key collapses under a rename-heavy workload.**

A directory rename rewrites every descendant key in a WITHOUT ROWID b-tree
(§3.7): 2 statements, N row writes. Rows written are billed, and an agent that
reorganises a large tree does this often. If the row-write cost turns out to
dominate a realistic agent session, the schema is wrong and there is no cheap
patch — the inode+dirent indirection exists precisely to make this O(1).

*Earliest signal:* a `rename` benchmark on a 5,000-file subtree, run in the
first wave alongside the scan benchmark, showing rows-written per session
climbing past the read cost. Run it **before** any op is ported.

*If it fires:* keep `fs_paths` as a pure key table (it already is) and add a
`dir_inode` column so a rename updates one row and the scan joins through a
per-directory prefix. That is a schema change and a partial rewrite of §7.0 —
which is exactly why the signal has to come first.

**R2 — the ported filesystem is subtly wrong and the inherited tests do not
prove it.**

The entire fork-versus-rewrite argument rests on 4,330 lines of somebody else's
conformance suite porting cleanly (§2.3). If the pass rate stalls — because the
tests depend on write-buffer semantics we dropped, or on inode numbering, or on
error codes we mapped differently — then the rewrite is unvalidated and we are
shipping a filesystem on hope.

*Earliest signal:* week one. Port the 19 files against the new store **before
writing a single bulk primitive** and record the pass rate. Below ~95% after
the mechanical fixes, stop and reconsider Option F.

*If it fires:* the fallback is Option F with the CTE reader and no bulk writes
— which is `docs/plans/bulk-sql.md` as already gated, i.e. `status` fixed and
`checkout` not.

**R3 — neither consumer switches, and we maintain two things.**

The agent runtime pins an unpublished prerelease tarball, reads a private
schema in two modules, and already bypasses Computer's git on its hot path. The
static site generator needs synchronous reads as an architectural property. If
our surface misses one method either of them calls, the switch stalls
indefinitely and the standalone runtime becomes a third thing to maintain
beside the plugin.

*Earliest signal:* write both consumers' call sites against our **types only**,
compiling, before implementing any of them. A method we cannot answer shows up
as a type error on day two, not in month three. §4.2's table is that exercise
done on paper; the compile is the proof.

*If it fires:* the compat shim widens to cover whatever is missing, and the
first-class surface stays clean. The failure mode to avoid is widening the
*first-class* surface to match a shim.

### 10.3 Risks worth naming but not ranking

- **Memory.** Every bulk primitive is budgeted in bytes, never in rows, and the
  caller pages. The existing code already holds this discipline
  (`docs/architecture.md:83-99`). The failure mode is a new bulk call site that
  forgets to page — catchable by asserting peak payload in the same test that
  asserts statement count.
- **`withReadScope` semantics.** Ambiguous (§4.4). Cheap to get wrong, cheap to
  fix, but it should be read from the pinned tarball before the API is frozen.
- **Licence hygiene.** DOFS is MIT and `"private": true` — never published to
  npm. Forking source and tests from a public MIT repository is fine with
  attribution; the `LICENSES/` entry and file headers must land in the same
  commit as the first ported line, not later.

---

## 11. The route

Territories are disjoint; each wave ends green and committed.

**Wave 0 — evidence, before any code.** Two things, in this order:

1. The R1 rename benchmark on a 5,000-file subtree.
2. Port the 19 DOFS test files against a stub store and record what fails
   mechanically (R2's gate).

Neither is a deliverable. Both can invalidate the plan, which is the point.

**Wave 1 — the store.** `fs_meta` / `fs_nodes` / `fs_paths` / `fs_chunks` DDL,
the inode allocator, `realpath`, and the five bulk primitives. Done-check:
`scan` order equals `comparePaths` order; a paged scan equals a one-shot scan;
`writeFiles` of 2,000 files is a constant statement count plus content;
`removeFiles` of a 5,000-file tree is five statements.

**Wave 2 — the per-path surface.** `stat`, `readdir`, `readFile`, `writeFile`,
`mkdir`, `rm`, `rename`, `symlink`, `chmod`, `link`. Done-check: the inherited
suite green.

**Wave 3 — the compat shim and the importer.** node:fs names, the fd table,
`importFromComputer`, the divergence latch, shadow reads. Done-check: both
consumers' call sites compile against our types; the importer round-trips a
real Prettier-sized `vfs_*` database.

**Wave 4 — git on top.** `Worktree` becomes a slice of `Filesystem`; `status`,
`diff`, `add` consume `scan` / `readFiles`; `checkout` consumes `writeFiles`;
`store.ts` and `packs.ts` batch their writes. Done-check: the existing 5,518
lines green, plus a statement-count assertion per operation against §7.

**Wave 5 — the runtime and the seam.** `Workspace`, `AsyncFilesystem`,
`ProcessHost`, `RpcHost` — declared, typed, and unimplemented for exec.

Waves 1 and 2 are sequential. Wave 3 and wave 4 are parallel once wave 2 is
green. Wave 5 is small and last.

---

## 12. Decided at the gate

All four open questions are closed. Nothing in this plan is now blocked on the
owner.

### D1 — the package name → **`kompjutr` stays**

The name describes the dependency being removed, which is the joke and also the
problem. Kept anyway: it reads as "computer" generically, it is short, it is
free on npm, and one line in the README covers it. Renaming stays free until
the first consumer pins a version; if it is going to happen it has to happen
before then, not at 1.0.

### D2 — hardlinks and the join → **two tables**

`fs_paths` → `fs_nodes` stays. Two paths can name one inode, `nlink` is
correct, `st_ino` is stable — which the git index stat cache already reads
(`src/sqlite/schema.ts:56`).

The cost is real and bounded: a full `status` scan reads 12,675 path rows and
does 12,675 integer-PK lookups **inside the same statement**, roughly 2× the
rows read, zero extra round trips. The statement targets in §7 are unaffected.

Chosen because it is the reversible direction. Collapsing to one table later is
a schema migration we can do; adding the indirection back later means rewriting
every query.

### D3 — the wall-clock target → **retargeted to a working set**

The target is now: **≤ 0.1 s for any operation touching ≤ 1,000 changed files.**

The old target — ≤ 0.1 s for every operation — is arithmetically unreachable
for a full-repository `add --all`, `checkout` or `clone`. The floor is SHA-1 of
24 MB, measured at 143 ms, plus moving the bytes. That is the processor, not
SQL, and in a single-threaded isolate no schema moves it.

What holds unconditionally: **≤ 1,000 SQL statements and ≤ 100 MB for every
operation.** Those are the numbers the benchmark gates on. For the three
write-heavy operations the benchmark reports the measured wall time as a figure
rather than a pass or a fail.

The async-`crypto.subtle` work is **not** taken now. It is byte-identical and
roughly 24× faster, but it is async against a deliberately synchronous ops
layer (`docs/architecture.md:250-255`), and threading a promise through the
buffered-entry path is a separate piece of work with its own estimate.

### D4 — `withReadScope` → **resolved; ours is a no-op shim**

The pinned prerelease tarball still exists and was read. The real signature and
behaviour:

```ts
async function withReadScope<T>(db: Database, work: () => Promise<T>): Promise<T>
```

It opens a **depth-counted** read scope on a `WeakMap` keyed by `db`, caching
resolved nodes, path resolutions and directory listings for the duration of one
high-level operation. `beginReadScope`/`endReadScope` increment and decrement;
the scope is deleted at zero. `dropScopedReads(db)` empties it on a mutation
mid-operation. `lookupScopedNode`/`storeScopedNode` bypass the cache entirely
when `db.inTransaction`. Its own JSDoc: *"Nesting is fine and shares the
outermost scope, so a filesystem call made inside a git call does not start a
second one."*

**It exists only because dofs resolves a path one statement per segment.** It
is a cache in front of a cost we are deleting. Over a path-keyed table a lookup
is a single indexed read, so there is nothing to memoise and nothing to
invalidate.

Therefore `withReadScope` in our runtime is a compatibility shim that runs the
work and returns:

```ts
// Kept so the agent runtime's adapter compiles unchanged. There is no scope to
// open: a path lookup is one indexed read, not one statement per segment.
export const withReadScope = <T>(_db: Database, work: () => Promise<T>): Promise<T> => work();
```

It ships in `./compat/computer` with the rest of the façade (§5.3) and expires
with it.
