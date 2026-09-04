# kompjutr

`kompjutr` is a standalone filesystem and Git runtime for Cloudflare Durable
Objects. The working tree, Git objects, refs, index, and received packs all live
in the Durable Object's SQLite database. No `.git` directory or external
filesystem runtime is required.

```ts
import { createGit, Workspace } from "kompjutr";

export function createWorkspace(ctx: DurableObjectState): Workspace {
  return new Workspace({
    storage: ctx.storage,
    git: createGit(),
    defaultGitIdentity: {
      name: "Workspace agent",
      email: "agent@example.com",
    },
  });
}
```

The workspace exposes:

- `workspace.fs`: a Node-style synchronous filesystem facade.
- `workspace.filesystem`: the raw bounded filesystem API.
- `workspace.git`: the lazily created Git client.
- `workspace.db`: the shared Durable Object SQLite adapter.
- `workspace.exec()`: an optional seam for a process host. It requires an
  injected `ProcessHost` and is not wired to the shell.

## Filesystem only

The filesystem can be used without importing the Git runtime:

```ts
import { Database, createFilesystem, NodeFsCompat } from "kompjutr/fs";

const db = new Database(ctx.storage);
const filesystem = createFilesystem(db);
const fs = new NodeFsCompat(filesystem);

fs.mkdirSync("/src", { recursive: true });
fs.writeFileSync("/src/index.ts", "export const value = 1;\n");
```

## Git

The native client supports repository initialization, clone, fetch, pull,
single-branch Smart HTTP push, status, staging, commit, log, diff, checkout,
branches, tags, refs, config, remotes, local two-head merge, one-commit
cherry-pick and revert, bounded linear rebase, reflog inspection and ref recovery,
linked-checkout lifecycle, caller-selected divergence, raw ref reads, and the
plumbing operations exposed by `Git`. Pull fetches the configured upstream and
delegates fast-forward or divergent integration to the native merge lifecycle.
Merge supports fast-forward, forced merge commits, clean and conflicted
integration, `commit: false`, restart-safe continue, and path-scoped abort for
the checked-out branch. Promise-returning `runCli()` and `cli()` expose a strict
local subset for status, diff, log, rev-list count, symbolic-ref reads, add,
commit, and rebase continue/abort. Unsupported typed operations throw
`EUNSUPPORTED`; the argv runner returns command-specific Git-shaped results.
Neither surface falls back to another implementation.

```ts
await workspace.git.init({ dir: "/" });
workspace.fs.writeFileSync("/README.md", "# project\n");
await workspace.git.add({ paths: ["README.md"] });
const commit = await workspace.git.commit({ message: "Initial commit" });

const session = await workspace.git.worktreeAdd({
  dir: "/",
  root: "/sessions/one",
  target: { kind: "new-branch", name: "session-one" },
});
const distance = await workspace.git.divergence({
  dir: session.root,
  current: "HEAD",
  upstream: "main",
});
const remoteHead = await workspace.git.readRef({
  dir: session.root,
  ref: "refs/remotes/origin/HEAD",
});
```

Each `dir` selects the nearest registered checkout root. Checkouts of one store
share objects, packs, ordinary refs, config, and shallow state. Their raw `HEAD`,
index, dirty paths, in-progress operation, working tree, and `HEAD` history stay
isolated. `worktreeList()` reports every registered checkout and whether its root
is present. `worktreeRemove()` refuses the primary checkout and every checkout
with a live operation. Its `force` option bypasses only the dirty-worktree check.
`worktreePrune()` removes missing non-primary checkouts atomically.

`reflog()` returns typed, ordinal-paged ref history. `HEAD@{0}` through
`HEAD@{1023}` select active history for the checkout selected by `dir`; ordinary
ref history is shared by every checkout of the store. `recoverRef()` restores an
active old or new endpoint to one direct ref with expected-current
compare-and-swap. Entries remain active only while they are both at most 90 days
old and among the newest 1,024 entries for that ref or checkout `HEAD`.

`cherryPick()` and `revert()` return a `ReplayResult`: `committed` includes the
new OID, `conflicted` leaves restart-safe state for continue, skip, or abort,
and `empty` describes a no-change operation. Empty reason `source` means the
selected source commit introduces no tree change relative to its selected
parent. Empty reason `result` means applying the change would leave the current
tree unchanged. Cherry-pick keeps either empty result active until
`cherryPickSkip()` or `cherryPickAbort()`; revert treats an empty result as a
completed no-op. Recovery methods are operation-specific and reject the wrong
or missing operation state.

`rebase({ upstream })` replays one checked-out linear branch and returns a
`RebaseResult`: `up-to-date`, `conflicted`, or `completed` with the final OID and
replayed/skipped counts. The branch remains at its original OID while replay is
in progress. Continue, skip, and abort survive a workspace restart, and the
completed branch publishes once after every step succeeds. Interactive rebase,
merge replay, `--onto`, and `--root` are not part of this surface.

`pull({ rebase: true })` and `pull.rebase=true` fetch first, then enter the same
restart-safe rebase lifecycle with the fetched OID captured in its journal.
`pull()` returns a `PullResult` discriminated by `strategy`, wrapping either a
`MergeResult` or `RebaseResult`. Merge remains the default.

Push creates, fast-forwards, force-updates, or deletes one `refs/heads/*` ref.
It streams a replayable full-object pack and updates the local remote-tracking
ref only after `receive-pack` confirms success. Multi-ref pushes, tags, push
options, SSH, and outbound Git deltas are not implemented yet.

## Shell

`kompjutr/shell` is a bash-shaped command surface over `Filesystem`, in which a
command compiles to bounded, keyset-paged queries rather than per-path tree
walks. Literal recursive search uses indexed content discovery; long and
recursive listings, path expansion, copy, and touch use set-based filesystem
operations. It is a separate entry point, not part of `Workspace`.

```ts
import { createGitCommand } from "kompjutr/git/shell";
import { createShell } from "kompjutr/shell";

const shell = createShell({
  fs: workspace.filesystem,
  commands: new Map([["git", createGitCommand(workspace.git)]]),
});
const { stdout, operations } = await shell.run("git status --porcelain | wc -l", {
  env: {
    GIT_AUTHOR_NAME: "Agent",
    GIT_AUTHOR_EMAIL: "agent@example.com",
  },
});
```

Stdout, stderr, filesystem operations, and live intermediate bytes are bounded
by the executor, so a command without `| head` still returns a bounded result.
Each run may receive up to 1 MiB of caller stdin and a frozen, bounded env
snapshot for injected commands. Caller input shares the retained-memory budget.
File redirects stream atomically and roll back on an upstream failure. `git` is
not a built-in; the explicit adapter exposes a strict local allowlist and never
falls back to a process. See
[the shell reference](docs/reference/shell.md) for the exact command set,
limits, and deliberate divergences from Bash.

## Resource model

The storage and traversal layers use byte-bounded caches, paged SQLite queries,
bounded BLOB results, and fail-closed input limits. Received packs remain
compressed in SQLite and are read in physical order. Tree walks use a parsed,
source-qualified edge index and do not read object BLOBs.

The universal targets are at most 1,000 SQL statements and less than 100 MiB of
operation memory. The repository has adversarial gates for these bounds. The
wall target is below 0.1 seconds for operations touching at most 1,000 changed
paths. On the local 24,252-path Next.js fixture, explicit 100-path add and
commit, clean post-commit status, and real 100-change checkout transitions meet
that wall target. Modified and staged full-repository status remain above it.

See [the architecture](docs/reference/architecture.md) for the storage model and current
limits, and [the current benchmark](docs/reference/benchmark-current.md) for the native
Next.js workflow. Older comparisons are historical pre-standalone evidence.

## Status

Experimental. The standalone API is tested. A
production Durable Object probe, concurrent and interrupted-operation
conformance, storage maintenance, integrity tooling, and the first tag-driven
release remain outstanding.

## Development and releases

Maintainer checks use Node.js 24 and npm 11. Pull requests and changes to `main`
must pass formatting and lint checks, type checking, the full test suite, the
production build, and an isolated-consumer smoke test of the packed npm artifact.
Benchmarks are measured separately and do not run in ordinary CI.

Publishing is tag-driven and runs only in GitHub Actions. See the
[release runbook](docs/reference/release.md) for the supported toolchain, package
gate, and release sequence. Do not publish this package from a local checkout.

## Credits

The pack-native object store is based on ideas from dgit. Adapted files retain
their source headers and license notices. Files ported from
`@cloudflare/computer` are covered by `LICENSES/cloudflare-computer.txt`.

## License

MIT, except `src/git/diff/`, which is a port of Git's xdiff implementation and
is LGPL-2.1-or-later. See `LICENSE`, `src/git/diff/LICENSE`, and
`LICENSES/LGPL-2.1.txt`.
