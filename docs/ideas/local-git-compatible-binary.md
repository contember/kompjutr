# Local Git-compatible binary and repository import

## Idea

Ship a Unix command that wraps `LocalWorkspace.git.runCli()` and behaves like
`git` for the argv surface that kompjutr implements. Repository discovery would
use a `.git` marker instead of requiring callers to supply the canonical root
and state directory explicitly.

The command would:

1. discover the repository from the host working directory;
2. map that directory into the checkout's virtual Git path;
3. open the shared SQLite repository and the checkout's disk drive;
4. pass argv, stdin, and supported `GIT_*` environment values to `runCli()`;
5. write the Git-shaped stdout, stderr, and exit status; and
6. close the workspace and release every lifetime lock.

This is a compatibility command for the implemented command and option set, not
a promise that every program expecting `/usr/bin/git` will work unchanged.

## Existing seams

- [`LocalWorkspace`](../../packages/local/src/workspace.ts) already composes
  `node:sqlite`, `DiskDrive`, recovery, and a root-keyed process lock.
- The public [`Git`](../../packages/git/src/client-types.ts) interface already
  implements `GitCliRunner` through asynchronous `runCli()`.
- The argv layer already returns bounded Git-shaped stdout, stderr, and exit
  codes without falling back to another Git implementation.
- Clone, fetch, and pull already provide the pack-ingest and ref-publication path
  needed to copy reachable history from another repository.

The Durable Object shell adapter is not required. It adapts `GitCliRunner` to
the separate query shell; a host binary can call `runCli()` directly.

## Repository discovery and state layout

Two layouts remain viable.

### SQLite inside the common `.git` directory

```text
main/.git/
  git.sqlite
  worktrees/<checkout-id>/

linked/.git
  # gitdir: /absolute/main/.git/worktrees/<checkout-id>
```

This is self-contained and follows Git's familiar discovery shape. A linked
worktree's `.git` file identifies its administration directory; a `commondir`
pointer from there locates the common `.git` directory and `git.sqlite`.

This layout changes the current local-runtime invariant that SQLite and recovery
state stay outside the worktree. `.git` would have to become a protected
namespace excluded from every worktree scan and mutation. It also creates a
coexistence risk: native Git sees the same `.git` directory but does not use the
SQLite state.

### `.git` as a locator for external state

Every checkout has a small `.git` pointer, including the primary checkout. The
pointer resolves to a shared administration directory outside all worktrees,
where `git.sqlite` remains isolated from worktree traversal and recovery.

This preserves the current safety boundary and treats every checkout uniformly,
but moving or copying a project directory no longer carries its repository state
without an explicit relocation operation.

The leading question is therefore not whether `.git` can locate SQLite. It is
whether self-contained repository state is worth weakening the existing
state-outside-worktree invariant.

## Linked worktrees

A pointer is necessary but not sufficient for ordinary sibling worktrees such
as `/projects/app` and `/projects/app-feature`. The current `DiskDrive` maps one
host root to virtual `/`, and its local parity witness creates linked checkouts
below that root.

Arbitrary sibling worktrees require:

- routing a checkout identity to its canonical host root;
- selecting the correct drive from the cwd discovered by the binary;
- coordinating the shared SQLite transaction with every affected drive;
- holding lifetime locks for all roots touched by worktree creation or removal;
- keeping each undo recovery directory rename-compatible with its worktree,
  including when linked worktrees live on different devices; and
- settling interrupted shared-database and per-worktree filesystem effects
  idempotently.

The `.git` pointer should identify shared administration state and checkout
identity. It should not make the primary worktree directory itself the durable
repository identity.

## Importing an existing `.git`

The first importer should use native Git as a read-only protocol source instead
of parsing every historical `.git` layout directly:

1. expose the source through `git upload-pack` or `git http-backend`;
2. reuse kompjutr's existing negotiation, pack ingest, and ref publication;
3. import the current `HEAD`, branch upstream, remotes, and relevant config;
4. establish an index baseline for the existing disk worktree without replacing
   its files; and
5. verify the resulting status, refs, and reachable history against native Git.

This path naturally imports objects, packs, refs, and history. Reflogs,
shallow/partial-clone metadata, stash, hooks, rerere, LFS state, credential
helpers, submodules, and global configuration need separate scope decisions.

Import is a one-time ownership transfer, not bidirectional synchronization. Once
the SQLite repository becomes authoritative, native Git must not independently
mutate the old object, ref, index, or checkout state. The importer needs a clear
marker and an atomic failure outcome so an interrupted conversion does not leave
two plausible authorities.

## Suggested progression

1. Build a single-checkout command with explicit state configuration and prove
   argv, cwd, stdin, output, exit-status, signal, and close behavior.
2. Add `.git` discovery for a newly initialized SQLite repository.
3. Spike read-only import from native `upload-pack`, preserving an existing dirty
   worktree and comparing public state with native Git.
4. Decide the common state location and ownership marker from that evidence.
5. Add standard-shaped linked-worktree pointers and a multi-root drive/recovery
   design as a separate work unit.

## Open questions

- Must a copied project directory carry all repository state with it?
- Must native Git remain usable after import, or is the conversion exclusive?
- May import depend on an installed Git binary while normal operation does not?
- Are sibling linked worktrees required in the first command release?
- Should the executable be named `git`, `kompjutr`, or exposed through a wrapper?
- Which Git commands and process conventions define the first compatibility
  claim?

## Graduation criteria

Graduate this idea when a spike proves:

- repository discovery from a nested cwd without caller-supplied paths;
- one imported repository has the same HEAD, refs, reachable history, and status
  as native Git without rewriting worktree files;
- interrupted import leaves exactly one recoverable authority;
- `.git` metadata cannot enter worktree scans or Git commits; and
- the chosen layout states how sibling worktrees, cross-device recovery, and
  native Git coexistence are handled or explicitly deferred.
