> **Superseded by [`standalone-runtime.md`](standalone-runtime.md).**
>
> This plan optimises kompjutr *as a plugin into `@cloudflare/computer`*, reading
> its private `vfs_*` tables directly. That approach fixes reads and cannot fix
> writes: `checkout` and `clone` stay at roughly 45 statements per file, because
> every write still goes through a per-path public API. It also has to reason
> around an in-memory write buffer it cannot see.
>
> The decision taken since is to cut the dependency and own the filesystem. The
> measurements here still stand and are cited by the new plan.

# Plan — one SQL statement where there are now thousands

## The problem, measured

Prettier 3.9.6, 9,329 files, kompjutr today:

| Operation | Statements | Of which `git_*` | Wall |
| --- | ---: | ---: | ---: |
| `git.status` | 202,234 | **41** | 1.27 s |
| `git.diffSummary` | 149,348 | ~220 | 0.41 s |
| `git.add --all` | 428,550 | 42,398 | 4.80 s |
| `git.commit` | 16,542 | 16,542 | 0.25 s |
| `git.clone` (eslint, 2,358) | 125,259 | ~5,300 | 1.18 s |

Two separate faults, and the earlier report only described the first:

1. **The working tree is read one path at a time.** Every `lstat` walks the path
   from the root through `vfs_dirents`, so a 9,329-file `status` costs ~21
   statements per file. We have the same database handle DOFS has; there is no
   reason to ask it one path at a time.
2. **Our own writes are one row at a time.** `commit` writes 3,293 tree objects
   at **five statements each**: two existence probes, one metadata insert, one
   `DELETE FROM git_object_chunks`, one chunk insert. Four of the five are
   avoidable. This one is entirely ours and has nothing to do with DOFS.

## What the numbers say is reachable

Measured floors on this machine, under `cpu-lease -n 2`:

| Cost | Measured |
| --- | --- |
| SHA-1 of Prettier's 24 MB of content | 143 ms |
| zlib deflate of the same 24 MB | 430 ms |
| zlib deflate as 9,329 small buffers | **835 ms** — 90 µs of fixed cost per call |
| SHA-1 as 9,329 small buffers | 42 ms |

So `add --all` over a whole repository has an irreducible floor of roughly
**150 ms** (hashing 24 MB), and today pays another 835 ms deflating small blobs
that barely compress. Everything else in its 4.80 s is SQL round trips.

**0.1 s is reachable for `status`, `diffSummary` and `log`. It is not reachable
for a cold `add --all` or `clone` of a 24 MB repository** — hashing and moving
the bytes sets the floor. `commit` should land near 0.1 s but its floor is
deflating the tree objects, not SQL. Targets below say so per operation rather
than claiming one number.

## Statements and wall time are two different levers

Measured: writing 10,000 index rows one statement at a time takes 35 ms in
`node:sqlite`; the same rows batched through `json_each` take 38 ms in **two**
statements. A 5,000-fold statement reduction and no time saved at all, because
`node:sqlite` reuses a prepared statement for about 3.5 µs a call.

That does not make batching pointless — it makes the two targets separate:

- **Statement count is the Durable Object metric.** Every `sql.exec` there
  crosses into the storage layer and is billed by rows read and written. This is
  why the reference report treats statements as primary and refuses to treat
  in-Worker wall time as a duration at all.
- **Wall time only moves when work disappears.** The `scan` moves it — 1.2 s to
  36 ms — because it stops resolving 9,329 paths from the root. Batching object
  writes will move statements from 16,542 to about 30 and wall time much less.

So the plan targets both, separately, and does not claim that batching alone
makes anything faster in this harness.

Batching also avoids the bound-variable ceiling entirely where the rows carry no
blobs: `INSERT INTO … SELECT json_extract(j.value, '$.x') … FROM json_each(?) j
WHERE true ON CONFLICT …` is one statement with two parameters whatever the
batch size. (`WHERE true` is required — without it SQLite cannot parse the
`ON CONFLICT`.) Object chunks carry BLOBs, which JSON cannot hold cheaply, so
they use multi-row `VALUES` under a byte cap instead.

## Decision that shapes everything

DOFS's tables live in the database we already hold. Reading them directly costs
nothing in correctness: a read cannot break an invariant. Writing them means
reproducing `incrementRev`, manifest construction, blob dedup, dirent insertion,
mount and read-only checks — DOFS's internals, which we would then be pinned to.

**This plan reads `vfs_*` directly and keeps every write on the public API.**
Consequence, stated plainly: `checkout` and the checkout half of `clone` stay at
roughly 45 statements per file written, and will *not* reach 1,000 statements for
a 9,329-file tree. Lifting that needs direct `vfs_*` writes, which is a separate
decision with a real risk of corrupting a user's filesystem, and is proposed as a
gated wave 4 rather than folded in silently.

## The one behaviour this changes

DOFS keeps an in-memory write buffer, keyed by inode, for files opened through
the descriptor API (`openSync` / `writeSync`), and a pending entry with a
negative inode for a file that has been created but not flushed. Its own read
paths consult it — `statSync`, `readdirSync`, `readFileSync` all check
`getWriteBuffer` before touching a table. A direct SQL read does not, and cannot:
the cache is a module-level `WeakMap` with no exported accessor.

So after this change, a file that some other process is holding open with
unflushed bytes is seen by git in its last committed state, not its buffered one.
A pending file that has no `vfs_nodes` row yet is not seen at all.

This is a real behaviour difference and it is worth stating rather than
discovering. It is narrow — `ws.fs.writeFile` writes straight through in a
transaction and is unaffected; only a descriptor held open across a git command
is exposed — and a git command racing an open writer is already undefined. But
it is a difference, and it is the price of the read path. The alternative,
checking every path through the public API, is the 202,191 statements.

## The ideal SQL, per command

### The one primitive everything else uses: `scan`

One statement returns a page of the working tree in path order with full stat
data, resumable by keyset, pruning ignored directories before descending.

```sql
WITH RECURSIVE walk(inode, path, type, mode, mtime, size, link_target, manifest_hash) AS (
  SELECT n.inode, '', n.type, n.mode, n.mtime, n.size, n.link_target, n.manifest_hash
    FROM vfs_nodes n WHERE n.inode = ?root
  UNION ALL
  SELECT c.inode, w.path || '/' || d.name, c.type, c.mode, c.mtime, c.size,
         c.link_target, c.manifest_hash
    FROM walk w
    JOIN vfs_dirents d ON d.parent_inode = w.inode
    JOIN vfs_nodes   c ON c.inode = d.child_inode
   WHERE w.type = 'dir'
     AND c.mount_root IS NULL
     -- a subtree wholly below the cursor is never entered
     AND (w.path || '/' || d.name) >= substr(?after, 1, length(w.path || '/' || d.name))
     -- literal ignore names never enter the recursion
     AND d.name NOT IN (SELECT value FROM json_each(?pruned))
   ORDER BY 2                    -- turns the queue into a priority queue
)
SELECT path, inode, type, mode, mtime, size, link_target, manifest_hash
  FROM walk WHERE path > ?after LIMIT ?page;
```

The `ORDER BY 2` in the recursive select is the whole trick. SQLite processes a
recursive CTE's pending rows as a queue; give that select an ORDER BY and the
queue becomes a priority queue, so rows come out in ascending path order and the
outer `LIMIT` stops the traversal instead of walking the rest of the tree and
sorting it. Without it, every page re-walks everything after the cursor and
paging is quadratic.

BINARY collation is UTF-8 byte order, which is exactly the order `comparePaths`,
`indexScan` and `treeStream` already agree on — the merge-join above it does not
change at all. `json_each` is safe to rely on: DOFS itself uses it for path
resolution.

**Measured, not assumed.** Prototyped against a real DOFS database holding the
Prettier fixture; U1 lands the same comparison as a test.

| Variant | Rows | Statements | Wall |
| --- | ---: | ---: | ---: |
| today, one `lstat` per path | — | 202,191 | ~1.2 s |
| outer `ORDER BY`, one shot | 12,675 | 1 | 38 ms |
| outer `ORDER BY`, 1,000-row pages | 12,675 | 13 | 159 ms |
| **priority queue, 1,000-row pages** | 12,675 | **13** | **36 ms** |
| priority queue, 256-row pages | 12,675 | 50 | 50 ms |

Also verified on that fixture: the paged result is identical to the one-shot
result; the SQL order is identical to `comparePaths` order; **the file paths it
emits are identical, in order, to what the current walk emits** — 9,329 for
9,329, no differences; and `manifest_hash` is present on 9,329 of 9,329 files.

### `status`, `diffSummary`, `clean`

`scan` × 10 + `git_index` keyset pages × 5 (page 2,048) + HEAD tree read one
batched statement per depth level (~10) ≈ **30 statements**, and no per-file
`lstat` at all. Target ≤ 100 statements, ≤ 50 ms.

### `add --all`, `rm`, `reset <paths>`

Same three sources, plus content for files whose stat or content identity
changed, read in batches under a byte budget:

```sql
SELECT c.inode, c.idx, b.bytes
  FROM vfs_chunks c JOIN vfs_blob_bytes b ON b.hash = c.hash
 WHERE c.inode IN (SELECT value FROM json_each(?inodes))
 ORDER BY c.inode, c.idx;
```

At a 1 MB budget Prettier's 24 MB costs 24 statements. Index and object writes
become multi-row upserts. Target ≤ 400 statements, ≤ 400 ms (of which ~150 ms is
SHA-1 and cannot be removed).

### `commit`

The five-statement object write becomes two batched ones:

```sql
INSERT INTO git_objects (repo_id, oid, type, size)
     VALUES (?,?,?,?), (?,?,?,?), ...
ON CONFLICT(repo_id, oid) DO NOTHING;

INSERT INTO git_object_chunks (repo_id, oid, seq, data)
     VALUES (?,?,?,?), ...
ON CONFLICT(repo_id, oid, seq) DO NOTHING;
```

Both existence probes disappear — `DO NOTHING` *is* the probe — and the
`DELETE FROM git_object_chunks` disappears with them: the store is content
addressed, so an oid that already exists already has exactly these bytes and
exactly this chunk count. Prettier's 3,293 tree objects go from 16,465
statements to about 14. Target ≤ 100 statements, ≤ 80 ms.

### `log`, `show`, `lsTree`, `catFile`

Commit and tree reads batch by generation with one statement per level:

```sql
SELECT o.oid, o.type, o.size, c.seq, c.data
  FROM git_objects o
  JOIN git_object_chunks c ON c.repo_id = o.repo_id AND c.oid = o.oid
 WHERE o.repo_id = ? AND o.oid IN (SELECT value FROM json_each(?oids))
 ORDER BY o.oid, c.seq;
```

### `clone` / `fetch`

Pack indexing writes `git_pack_objects` one row per object; batched, eslint's
2,589 statements become ~13. The checkout half is bounded by DOFS writes — see
the decision above.

### `checkout`

Read side becomes the merge-join over `scan` and batched tree reads. Write side
unchanged in this plan.

## Two additions to our schema

**Content identity, not stat identity.** `vfs_nodes.manifest_hash` is DOFS's own
content hash and the `scan` above already returns it for free. A table keyed on
it turns "have we hashed this content before" into one batched lookup:

```sql
CREATE TABLE git_blob_ids (
  repo_id       INTEGER NOT NULL,
  manifest_hash BLOB    NOT NULL,
  oid           TEXT    NOT NULL,
  PRIMARY KEY (repo_id, manifest_hash)
) WITHOUT ROWID;
```

Populated by `add` and by `checkout`. A file that is touched but unchanged, or
restored to a previous content, never gets hashed again — which the stat cache
cannot do, because it keys on mtime. Falls back to hashing when
`manifest_hash` is NULL.

**Compress large objects only.** Loose object bodies below a threshold (proposed
4 KiB) are stored raw, with a flag on `git_objects`. This is our format, not
git's on-disk format, so it costs nothing but storage. Measured saving: most of
the 835 ms `add --all` spends deflating 9,329 small buffers that compress badly
anyway.

## Waves and units

Territories are disjoint. Every unit's done-check is a narrow test file plus a
statement-count assertion, not a wall-clock number.

**Wave 0 — seams (leader, not delegated).** `Worktree.scan()` and the bulk read
signatures in `src/core/worktree.ts`; the batched write signatures in
`src/sqlite/store.ts`; the `git_blob_ids` migration and the `git_objects`
compression flag in `src/sqlite/schema.ts`. Stub bodies that throw. Frozen after.

| Unit | Territory | Depends on | Done-check |
| --- | --- | --- | --- |
| U1 `vfs` scan | `src/sqlite/vfs.ts`, `tests/vfs.test.ts` | W0 | scan order equals `ORDER BY path`; paging equals one-shot; prune and mount fallback |
| U2 store batching | `src/sqlite/store.ts`, `src/sqlite/schema.ts`, `tests/store*.test.ts` | W0 | object write ≤ 2 statements per batch; raw/deflate round trip |
| U3 worktree seam | `src/computer/worktree.ts`, `src/core/worktree.ts`, `src/core/ops/worktree-io.ts`, `tests/worktree.test.ts`, `tests/helpers/worktree.ts` | U1 | adapter and in-memory double agree entry for entry |
| U4 status + diff | `src/core/ops/status.ts`, `src/core/ops/diff.ts`, `tests/status.test.ts`, `tests/diff.test.ts` | U3 | existing tests; ≤ 100 statements at 2,000 files |
| U5 staging | `src/core/ops/staging.ts`, `tests/staging.test.ts` | U3, U2 | existing tests; ≤ 400 statements at 2,000 files |
| U6 commit + trees | `src/core/ops/commit.ts`, `src/core/ops/tree-build.ts`, `src/core/ops/reads.ts`, `tests/commit.test.ts`, `tests/reads.test.ts` | U2 | existing tests; ≤ 100 statements at 2,000 files |
| U7 checkout + refs | `src/core/ops/checkout.ts`, `src/core/ops/refs.ts`, `tests/refs.test.ts` | U3, U2 | existing tests; read side ≤ 100 statements |
| U8 pack + clone | `src/core/ops/network.ts`, `src/sqlite/packs.ts`, `tests/clone.test.ts`, `tests/pack.test.ts` | U2 | existing tests; pack index ≤ 20 statements per 1,000 objects |

Wave 1 = U1, U2 in parallel. Wave 2 = U3. Wave 3 = U4, U5, U6 in parallel.
Wave 4 = U7, U8 in parallel. Then the leader re-runs the macro benchmark and
rewrites the results.

Single tree, no worktree isolation: the territories do not intersect, and each
green unit is committed as it lands.

## Decided at the gate

- **Reads direct, writes on the public API.** `checkout` and clone's checkout
  half stay at roughly 45 statements per file written, and the 1,000-statement
  target does not apply to them. Accepted knowingly.
- **The compression threshold is an option**, `looseCompressAbove`, default
  4 KiB. Setting it to 0 restores today's always-deflate behaviour for anyone who
  would rather pay CPU than Durable Object storage.
- **The write-buffer difference is accepted and documented** in
  `docs/architecture.md`, not worked around.
- **All four waves run**, not a trial slice.

## Out of scope unless separately approved

- **Direct `vfs_*` writes.** The only way `checkout` and `clone` reach 1,000
  statements. Needs DOFS's rev, manifest, blob-dedup and mount semantics
  reproduced exactly, behind a schema-version guard with a fallback.
- Replacing SHA-1 with WASM or `crypto.subtle`. `crypto.subtle` is async and the
  ops layer is deliberately synchronous.
- Repack and GC, push/pull/merge/stash.
