# Scoped packages and local SQLite Git runtime

## Purpose

Split kompjutr into independently installable packages and add a Unix local
runtime whose Git state remains in SQLite while its worktree lives on disk. The
split must preserve the existing Durable Object filesystem integration and its
measured cost.

The first release is a library API. It is not a replacement for the `git`
executable and does not read or write a conventional `.git` directory.

## Package graph

The repository is a private npm workspace root with five publishable packages.
All packages use one lockstep version and one release tag.

```text
@kompjutr/sqlite
├── @kompjutr/drive
├── @kompjutr/git ── pako
│   └── @kompjutr/git/do-fs
├── @kompjutr/do ── sqlite + drive + git
└── @kompjutr/local ── sqlite + drive + git
```

The graph denotes package dependencies, not runtime imports from every entry.
`@kompjutr/git/do-fs` is an explicitly exported integration subpath in the Git
package. The ordinary `@kompjutr/git` entry does not import it.

### `@kompjutr/sqlite`

Owns the structural `SqlDatabase` interface and shared SQLite utilities:

- synchronous nested transaction semantics;
- lazy cursor normalization;
- BLOB binding and decoding;
- SQLite failure normalization;
- shared routing limits.

It has no Worker or Node adapter. The current common coded error constructor
stays single-copy here and is re-exported by Git so adapter failures and
Git-specific subclasses retain one runtime identity.

### `@kompjutr/drive`

Owns only the filesystem vocabulary required by Git:

- `RealPath`, entry, stat, scan, read-batch, and write-batch types;
- the minimal synchronous `GitDrive` contract;
- an optional ordered scan-stream capability for non-indexed drives;
- opaque mutation-scope identity;
- native realpath, scan, and exact-state receipt registries.

The contract retains bulk reads and writes. It does not turn them into scalar
loops. A richer filesystem may structurally satisfy `GitDrive` without adapting
its public API.

### `@kompjutr/git`

Owns the complete SQLite Git engine:

- `git_*` schema and storage;
- objects, packs, refs, indexes, projections, and maintenance;
- Git operations, Smart HTTP, CLI-shaped runner, and public client;
- generic drive traversal, hashing, checkout, merge, replay, and rebase paths.

It depends only on `@kompjutr/sqlite`, `@kompjutr/drive`, and `pako`. The
supported `node:zlib` compatibility import remains the sole platform import in
the ordinary Git graph.

The `@kompjutr/git/do-fs` subpath owns Git-side code that deliberately knows the
Durable Object filesystem tables:

- index tracker installation and `fs_paths`, `fs_nodes`, and `fs_chunks`
  triggers;
- tracker resealing's exact filesystem-root check;
- selected-path and sparse-workspace projections joining `git_*` and `fs_*`;
- the same-database provenance receipts for those projections.

Keeping this code in the Git package avoids publishing broad Git internals as an
integration ABI. Exact lockstep versions protect the specialized subpath.

### `@kompjutr/do`

Owns the current Worker-facing implementation:

- Durable Object `SqlDatabase` adapter;
- SQLite filesystem and Node-shaped compatibility facade;
- shell runtime and Git shell adapter;
- optimized initial worktree writer and exact-path source;
- `Workspace` composition and testing helpers.

`Workspace` composes `@kompjutr/git/do-fs` directly. The package exposes
`@kompjutr/do`, `/fs`, `/shell`, `/git-shell`, and `/testing` entry points. No
entry is retained under the old unscoped `kompjutr` package name.

### `@kompjutr/local`

Owns all unsupported Worker imports and local state:

- production `node:sqlite` adapter;
- Unix `DiskDrive`;
- process lock and crash-recovery journal;
- persistent disk observation revisions;
- `LocalWorkspace`.

No other package may import `node:fs`, `node:path`, `node:os`, or `node:sqlite`,
except for the existing Worker-supported compatibility imports explicitly
allowed by the module rules.

## Durable Object fast path

The package split is a relocation, not an abstraction rewrite, for the Durable
Object composition.

The following behavior remains concrete:

1. `createFilesystem()` registers callbacks that call `realpathOwned()` and
   `scanOwned()` directly.
2. Ordinary worktree traversal and merge snapshot traversal resolve one native
   receipt per realpath or scan page and then call the existing SQL
   implementation. The hot scans keep one `WeakMap` lookup per page.
3. Exact root states remain one bounded `fs_*` query.
4. Initial clone and eligible first checkout retain the create-only bulk writer.
5. Tracker triggers remain attached directly to the three filesystem tables.
6. Sparse receipts continue to validate exact database identity and source kind.
   Sparse status, staging, checkout, and commit retain their mixed SQL sources.
7. Filesystem and Git writes retain one shared Durable Object transaction.

The generic drive contract must not replace any of these SQL paths. The frozen
statement and returned-row counts must remain unchanged, and a CPU-leased
before/after Next.js workflow must show no wall-time regression.

## Mutation scopes

Every database and writable drive exposes an opaque mutation-scope identity.
Existing adapters may use their database object as the default identity. The
Durable Object database and filesystem share one identity. The local database
and disk drive share one recovery coordinator identity.

A Git operation that writes both database and drive checks this identity before
its first side effect. Unsupported combinations fail with `EUNSUPPORTED`.
Client and CLI entry points use the same checks, including clone, checkout,
worktree lifecycle, hard reset, non-cached removal, merge, replay, rebase,
`readTree({ updateWorktree: true })`, and clean.

The public mutation inventory in `tests/public-exports.test.ts` remains the
source list. A second frozen drive-writing subset maps every coupled operation
to one central write seam:

| Public operation | Central drive-writing seam | Required preflight | Committed database effects before preflight | Existing DO transaction witness | Required local witness |
|---|---|---|---|---|---|
| `clone` publish and abandoned-clone discard | provisional clone initial materializer and cleanup callback | At clone entry, before reservation or network work; recheck inside publication/cleanup | None | `clone-initial.test.ts`, `concurrency-clone.test.ts` | publish and discard kill points |
| typed `checkout`; CLI checkout, switch, restore, and path checkout | checkout planner and batched apply | Before promised-blob hydration; recheck at checkout apply | None | `checkout-initial.test.ts`, `checkout-sparse.test.ts`, `git-cli-write.test.ts` | late DB and disk failure for full/path apply |
| `reset({ hard: true })` and CLI hard reset | hard-reset checkout apply | Before ref mutation and checkout transaction | None | `staging.test.ts`, `git-cli-write.test.ts` | ref/index/worktree rollback and crash |
| `rm` when `cached !== true` | physical rm batches | After read-only safety planning, before transaction writes | None | `staging.test.ts` | file and recursive removal rollback |
| `clean` when not dry-run | clean unlink/rmdir apply | After read-only planning, before first removal | None | `client.test.ts`, `git-cli-write.test.ts` | multi-path all-or-old rollback |
| `merge` start | merge snapshot/apply operation | At entry before object, journal, index, or worktree writes | None | `merge-lifecycle.test.ts`, `merge-apply.test.ts` | clean/conflicted start rollback and crash |
| `mergeAbort` | saved merge snapshot restore | At entry before journal or worktree changes | None | `merge-lifecycle.test.ts` | abort rollback and crash |
| `cherryPick` and `revert` start | replay snapshot apply | At entry before object, journal, index, or worktree writes | None | `cherry-pick.test.ts`, `revert.test.ts` | clean/conflicted start rollback and crash |
| `cherryPickSkip` and `revertSkip` | replay snapshot restore | At entry before journal or worktree changes | None | `cherry-pick.test.ts`, `revert.test.ts` | skip rollback and crash |
| `cherryPickAbort` and `revertAbort` | replay snapshot restore | At entry before journal or worktree changes | None | `cherry-pick.test.ts`, `revert.test.ts` | abort rollback and crash |
| `rebase` start and first step | rebase lifecycle drive step | At entry before plan, object, journal, index, or worktree writes | None | `rebase.test.ts`, `rebase-restart.test.ts` | first-step rollback and crash |
| `rebaseContinue`, including empty continuation and later steps | rebase lifecycle drive step | At entry before journal, index, commit, or worktree changes | None | `rebase.test.ts`, `rebase-restart.test.ts` | conflict and empty continuation kill points |
| `rebaseSkip` | rebase lifecycle snapshot restore/next step | At entry before journal or worktree changes | None | `rebase.test.ts`, `rebase-restart.test.ts` | skip/next-step rollback and crash |
| `rebaseAbort` | rebase baseline restore | At entry before journal, index, ref, or worktree changes | None | `rebase.test.ts`, `rebase-restart.test.ts` | abort rollback and crash |
| typed/free/CLI `readTree` with `updateWorktree: true` | checkout-tree apply | Before scratch/index or worktree transaction writes | None | `plumbing-write.test.ts` | index/worktree late-failure rollback |
| typed/free `worktreeAdd` | checkout creation callback and initial checkout | Before checkout-row creation | None | `worktrees.test.ts` | directory/create-checkout rollback and crash |
| typed/free `worktreeRemove` | checkout removal callback | After read-only dirty check, before checkout or directory removal | None | `worktrees.test.ts` | recursive removal rollback and crash |
| `pull` local merge or rebase integration | merge/rebase seams above | Before fetch so an unsupported scope cannot publish fetched state; recheck after fetch | None | `pull.test.ts`, `concurrency-network.test.ts` | fetch plus local integration rollback boundary |

Read-only drive operations and Git-only mutations do not require this preflight.
`rm({ cached: true })`, non-hard reset, and dry-run clean stay valid without a
writable drive scope. Mutation-scope tests freeze the matrix against the public
inventory and inject failures at central writers rather than duplicating every
CLI alias.

`SqlDatabase.transactionSync()` remains the owner of nested transaction
composition. Shared and Worker-facing code never emits transaction SQL. The
Node adapter may emit `BEGIN IMMEDIATE`, `COMMIT`, and `ROLLBACK` internally.

## Local workspace API

The initial API is:

```ts
const workspace = new LocalWorkspace({
  root: "/projects/example",
  stateDirectory: "/var/lib/kompjutr/example",
});

await workspace.git.status();
workspace.close();
```

`root` and `stateDirectory` are canonical absolute Unix paths. The state
directory must not equal, contain, or be contained by the worktree. The SQLite
database lives in the state directory. A root-keyed SQLite lock file lives beside
the worktree so alternate state configurations still contend. A configurable
recovery directory defaults to a hidden sibling of the worktree so backup renames
stay on the same filesystem.

Git's virtual root `/` maps to the configured host root. Virtual paths never
escape that root through `..` or symlinks observed during resolution. Symlinks
themselves remain tracked as links and are not followed during tree traversal.
The pure Node implementation does not claim containment against a process that
ignores the lifetime lock and swaps an already checked directory ancestor before
the following path-based filesystem call.

`LocalWorkspace` holds one exclusive lock for its lifetime and implements
`close()` plus `Symbol.dispose`. A second live process fails with `EBUSY`.
The lock is an exclusive transaction in a dedicated SQLite lock database. The
kernel releases it when a process exits, including after a crash, and SQLite
serializes contenders so only one can win.

## Ordered disk traversal

`DiskDrive` supplies the optional scan-stream capability. Git selects it once at
the start of a traversal; the Durable Object drive continues through paged SQL.

The stream:

- emits canonical virtual paths in UTF-8 byte order;
- does not follow directory symlinks;
- retains fixed-size name batches and a fixed-fan-in merge heap;
- spills sorted runs into the external state area for an unusually wide
  directory;
- removes spill files on completion, error, startup, or close;
- preserves Git's directory-pruning behavior without materializing the whole
  worktree. A fixed aggregate frontier budget spills otherwise-small directory
  remainders on deep traversals.

Disk reads and writes retain the existing operation byte limits. Host failures
are normalized to stable filesystem-style error codes.

## Disk stat identity

Disk `contentId` is always `null`. Host inode and timestamp metadata is not
strong enough to prove equal bytes in the racily-clean window.

An independently committed SQLite database leases persistent
observation-revision ranges. One
logical scan uses one revision; standalone stat reads consume another. A new
process reserves a range above every previously issued value. Therefore an
index row can reuse a stat only within the observation that produced it; a later
status hashes file content instead of accepting an ambiguous metadata match.

This policy does not widen `git_index` or add a disk branch to the Durable
Object per-row path. A later metadata mirror or watcher requires separate
benchmark evidence and a new decision.

## Local undo protocol

The local database adapter and `DiskDrive` share a recovery coordinator. At the
outermost SQLite transaction:

1. The lifetime process lock is acquired before the database or recovery state
   is opened. The canonical root and recovery directory are bound into the state
   database on first open and must match thereafter. SQLite performs its own WAL
   recovery before a manifest is settled.
2. The adapter starts `BEGIN IMMEDIATE` and reads committed recovery generation
   `G`.
3. The journal is a sequence of length- and checksum-framed records. Initial
   creation syncs the file and journal directory before any probe or application
   mutation.
4. Before a batch changes caller paths, the coordinator validates every existing
   target and every nearest existing parent against the backup directory's
   `st_dev`. It then performs a live rename-capability probe for every distinct
   source-parent/recovery pair; equal device IDs alone are not accepted as proof.
   Each random exclusive probe name is appended and synced as its own intent
   before its forward rename from recovery into a worktree directory. The probe
   is renamed back and removed, or removed idempotently during recovery. Only
   after all probes succeed does the coordinator append and sync the application
   intent batch. A mismatch or failed probe returns `EXDEV` and the enclosing
   SQLite transaction rolls back.
5. Existing target roots are renamed into the sibling recovery directory after
   their complete application intent is durable.
   Missing targets are recorded so rollback can remove newly created paths.
   Backup moves sync both source and destination parent directories.
6. DiskDrive applies the requested writes. Replacement regular files are written
   to same-directory temporary files, synced, renamed into place, and followed
   by a destination-directory sync. Directory and symlink changes sync their
   destination directories. Reads in the same operation see the new state.
7. If disk changed, the adapter writes generation `G + 1` in the same SQLite
   transaction as Git and index publication.
8. SQLite commits before recovery backups are discarded.

Journal entries are ordered and first-touch aware. An earlier covered ancestor
owns later descendant changes. Overlapping entries that cannot be collapsed are
restored in reverse order. Missing parent directories created by a write are
journaled too.

Only an incomplete final frame may be discarded after a crash, because no path
mutation begins until that frame has been synced. A complete frame with a bad
checksum, invalid sequence, unsupported version, or invalid payload is semantic
corruption and fails closed without changing the worktree.

On a normal exception, SQLite rolls back before disk state is restored. A
`COMMIT` error is always uncertain: while retaining the lifetime lock, the
adapter closes and reopens SQLite, lets SQLite recover, reads the committed
generation, and only then selects rollback or roll-forward. Startup uses the
same sequence and the coordinator compares the manifest target with the
committed generation:

- committed generation below target: remove created paths and restore backups;
- committed generation at or above target: retain new disk state and remove
  backups.

Rollback and roll-forward sync every affected parent after restores, removals,
and backup cleanup. Final settlement removes the journal, syncs its directory,
removes the transaction directory, and syncs the recovery root. A crash at any
cleanup step leaves an idempotently settleable prefix.

Kill tests cover initial journal creation; every append boundary; rename-probe
placement and cleanup; backup rename; file replacement; deletion; generation
commit; both outcomes of a reported `COMMIT` error; backup cleanup; journal
unlink; and transaction-directory removal. Every point is reopened once with
the old generation and once with the new generation where both states are
reachable.

The crash matrix tests the shared coordinator and every disk mutation shape,
then crosses the real public Git boundary with checkout. It does not repeat the
same kill matrix for every command: the frozen coupled-operation inventory proves
that each drive-writing command reaches the same transaction owner before
publication, while real-Git parity covers command-specific behavior.

The protocol covers process termination and host restart under ordinary Unix
rename and fsync guarantees. A different-device target, same-device distinct
mount, nested mount, or unsupported rename layout leaves pre-existing caller
entries and committed Git state unchanged after settlement. A successful probe
may transiently create its reserved scratch name and changes directory metadata
and filesystem-event streams; those observations are explicitly outside the
atomicity guarantee. Network filesystems are unsupported.

## Release and packaging

The private root orchestrates tests, builds, and package smoke. Each package has
its own manifest, declarations, exports, README, and applicable licenses.
Internal dependencies pin the exact lockstep version.

One `v<version>` tag verifies that every package has the same non-placeholder
version. CI packs all five artifacts, installs those exact tarballs into isolated
Worker and Node consumers, and rejects:

- a missing export or declaration;
- a Node-only import reachable from Worker entries;
- an integration subpath reachable from ordinary Git;
- duplicate public error constructors;
- a package dependency not satisfied by the packed artifacts.

The release job publishes verified tarballs in dependency order through npm OIDC.
The `@kompjutr` scope and trusted publishers must exist before the first tag;
local publication is never used as a workaround.

## Acceptance

The implementation is accepted only when:

- all existing tests pass through the package graph;
- package, import-graph, and packed-consumer witnesses pass;
- the existing deterministic DO statement/row baselines do not change;
- leased before/after Next.js runs show no DO-path wall regression;
- local init, clone, status, add, commit, checkout, reset, merge, replay, rebase,
  linked worktrees, and restart scenarios agree with real Git where applicable;
- same-size and timestamp-adjacent disk edits are detected;
- ordered traversal stays bounded on wide and deep fixtures;
- process contention rejects deterministically;
- kill-point tests prove rollback before SQLite publication and roll-forward
  after publication.

## Out of scope

- Windows support.
- A drop-in `git` executable or conventional `.git` interoperability.
- Concurrent local writers or fine-grained Git-compatible lock files.
- Containment against processes that ignore the lifetime lock and concurrently
  replace directory ancestors or fixed state artifacts.
- Pre-existing bind-mounted aliases of nested worktree, state, or recovery
  directories; exact directory aliases are rejected.
- A filesystem watcher or SQLite metadata mirror.
- Backward-compatible unscoped package imports.
- Backward-compatible local recovery formats during the development phase.
