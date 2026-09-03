# Local SQLite Git runtime with a disk worktree

## Idea

Offer a local runtime that keeps Git repositories, refs, indexes, objects, and
packs in SQLite while materialising the working tree on the host filesystem.
The same Git engine would then support two compositions:

```text
Git core
├── Durable Object runtime
│   ├── SqliteGitDatabase
│   ├── SQLite Filesystem
│   ├── index tracker
│   └── sparse workspace
└── local runtime
    ├── SqliteGitDatabase
    ├── node:sqlite
    └── DiskWorktree
```

This would initially be a local library runtime, not a command-line-compatible
replacement for the `git` executable.

## Why the current boundary is promising

Most of the storage separation already exists:

- Git operations consume the structural [`Worktree`](../../src/git/ops/worktree/worktree.ts)
  interface and have no Durable Object dependency.
- [`SqliteGitDatabase`](../../src/git/store/database/database.ts) consumes `SqlDatabase`, not
  Durable Object storage directly.
- The test stack already runs the database through `node:sqlite` in
  [`tests/helpers/storage.ts`](../../tests/helpers/storage.ts).
- Durable Object-specific acceleration is injected by
  [`Workspace`](../../src/runtime/workspace.ts): the SQLite filesystem, index
  tracker, sparse workspace source, and initial clone writer are not required by
  the Git client itself.

A local composition can therefore bind `SqliteGitDatabase` to a disk-backed
`Worktree` without routing the existing SQLite filesystem through a new generic
storage layer.

## The difficult parts

### Ordered, paged disk traversal

The SQLite filesystem pages through a path-keyed table. Every `scan()` page is
an indexed range query in Git path order. A disk has no equivalent index.

A naive disk adapter would rebuild a directory traversal for every
`scan(root, { after })` call and discard paths before `after`. That becomes
quadratic across enough pages. Materialising and sorting the entire tree once
avoids repeated traversal but abandons the current bounded-memory model.

A production disk adapter likely needs an optional cursor-oriented capability,
such as `openScan()` or `scanStream()`. It can retain a bounded traversal heap
for one walk. The SQLite implementation should keep the existing paged
`scan()` path unchanged. Capability selection should happen once per traversal,
not once per emitted row.

The cursor must also preserve Git's UTF-8 byte order. Native directory order and
JavaScript's default string order are not sufficient.

### Reliable disk change identity

The SQLite filesystem has a monotonic revision. The index can trust an
unchanged `(size, mtime, inode, revision, mode)` tuple without reading content.
A normal filesystem has no equivalent revision, and timestamp granularity
creates the usual racily-clean case.

A disk adapter needs a conservative identity policy based on the strongest host
metadata available, including device, inode, mode, size, nanosecond mtime, and
nanosecond ctime. One possible design is an opaque disk identity carried as the
worktree `contentId` and mapped to an OID through the existing `git_blob_ids`
table. An identity inside the filesystem's racy window must be treated as
unknown and force content hashing.

This policy must not weaken `contentId`'s contract: trusting two equal identities
must be sufficient to trust equal bytes. If host metadata cannot establish that,
the adapter must return no identity and accept the hashing cost.

The core may need an optional stat policy so a disk worktree can require
content-identity validation even when the basic index stat fields match. The
SQLite filesystem must retain its current revision-based fast path.

### Atomicity and process concurrency

The Durable Object composition stores Git state and the working tree in one
database. A local composition cannot atomically commit SQLite mutations and
host filesystem mutations.

A useful local runtime needs at least:

- a repository lock preventing concurrent mutating processes;
- a database location outside the scanned working tree, or a mandatory internal
  path exclusion;
- explicit recovery after a process stops during checkout or reset;
- a policy for stale WAL and lock ownership after a crash.

A coarse lock is sufficient for a first runtime. Fine-grained compatibility
with Git's index and ref lock behaviour can wait until there is a demonstrated
need. Crash recovery is separate from locking: preventing interleaving does not
repair a partially materialised worktree.

### Runtime and package boundary

The existing package targets Workers and deliberately avoids Node platform
imports. The local implementation should live in a Node-only entry point or a
separate package. Importing the Worker-facing entry points must not pull in
`node:fs`, `node:path`, or `node:sqlite`.

The minimal local composition needs:

- a production `node:sqlite` implementation of `SqlDatabase`, based on the
  existing test adapter;
- `DiskWorktree`, with bounded reads and writes and an ordered traversal;
- a small `LocalWorkspace` that opens both and binds `createGit()`;
- disk parity tests and a separate local benchmark fixture.

## Options

| Option | Covers | Main cost or risk | Rough scope |
| --- | --- | --- | --- |
| Keep the current Durable Object-only composition | The current product and performance model | No local disk runtime | None |
| Add a thin disk adapter over the existing `scan()` contract | A feasibility spike and local API experiments | Repeated disk traversal and an incomplete stat identity can make it slow or incorrect | 700–1,200 lines across 6–10 files |
| Add a separate local runtime with optional disk capabilities | A production-oriented local library without changing the SQLite filesystem hot path | New traversal and stat-identity contracts need differential and adversarial tests | 1,500–3,000 lines across 12–20 files |
| Mirror disk metadata into SQLite and maintain it with filesystem events | Fast repeated status on large local trees | Cross-platform watchers, missed events, startup reconciliation, and stale metadata become a subsystem | 3,000–6,000+ lines plus platform-specific maintenance |

The promising default is a separate local runtime with optional disk
capabilities. A SQLite metadata mirror should follow only if a real-disk
benchmark shows that a bounded cursor traversal is not sufficient.

## Protecting the SQLite filesystem

The local runtime must be additive:

- Do not change the SQL or bulk operations in `src/fs/` for disk compatibility.
- Keep `Workspace` on the current concrete SQLite filesystem, index tracker, and
  sparse workspace source.
- Put disk-only branches behind optional `Worktree` capabilities and choose the
  implementation outside per-row loops.
- Avoid widening `git_index` rows or adding nullable disk metadata columns to
  the Durable Object path unless measurements prove that a shared field is
  necessary.
- Keep Node-only modules outside Worker entry points and verify their bundle
  graphs independently.
- Treat the current benchmark's statement counts as regression gates, not only
  its output values.

The current 24,252-file benchmark reports a clean status in 8 SQL statements
and 1.9 ms, and clean post-checkout status in 8–9 statements and 0.7 ms. Those
figures in [`benchmark-current.md`](../reference/benchmark-current.md) should not
regress when the local runtime is unused.

## Product boundary

The first useful result is an API such as:

```ts
const workspace = new LocalWorkspace({
  root: "/project",
  database: "/state/project.sqlite",
});

const status = await workspace.git.status();
```

It is not yet a drop-in `git` executable. The current argv entry point is
explicitly unsupported. CLI compatibility would additionally require command
parsing, exact output and exit status behaviour, repository discovery, config
precedence, credentials, hooks, SSH, and implementation of unsupported Git
commands. That should be evaluated as a separate product phase.

## Suggested feasibility spike

Before changing a shared interface:

1. Productionise the existing `node:sqlite` adapter outside the Worker entry
   points.
2. Implement a Unix-only `DiskWorktree` against the current interface.
3. Exercise init, clone, status, add, commit, checkout, merge, and restart from a
   second process.
4. Benchmark clean and 100-file-modified status and checkout on the existing
   24,252-file fixture.
5. Record traversal count, filesystem metadata calls, content hashes, SQLite
   statements, wall time, and peak memory.
6. Use the result to choose the smallest optional traversal and stat-identity
   extensions.

This spike is evidence gathering. It does not commit the project to a public
local API.

## Open questions

- Is the first target a library for agents and applications, or an executable
  intended to replace the `git` command?
- Is an initial Unix-only implementation acceptable?
- Must the SQLite database travel with the working tree, or can it live in a
  separate state directory?
- Must multiple processes read and mutate one repository concurrently?
- What crash-recovery guarantee is required for checkout and reset?
- What clean-status target would justify adding a metadata mirror or filesystem
  watcher?
- Does interoperability require import from or export to a conventional `.git`
  directory?

## Graduation criteria

Graduate this idea into a design or sprint only after a disk-backed spike
demonstrates:

- no SQL statement or wall-time regression in the existing SQLite filesystem
  benchmark when the local runtime is unused;
- bounded disk traversal without whole-tree materialisation;
- correct detection of same-size and timestamp-adjacent file changes;
- a credible lock and crash-recovery model;
- a clear choice between a library runtime and CLI compatibility.
