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
the checked-out branch. Unsupported commands fail with `EUNSUPPORTED` instead
of falling back to another implementation.

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
merge replay, `--onto`, `--root`, and pull-rebase are not part of this surface.

Push creates, fast-forwards, force-updates, or deletes one `refs/heads/*` ref.
It streams a replayable full-object pack and updates the local remote-tracking
ref only after `receive-pack` confirms success. Multi-ref pushes, tags, push
options, SSH, and outbound Git deltas are not implemented yet.

## Shell

`kompjutr/shell` is a bash-shaped command surface over `Filesystem`, in which a
command compiles to a bounded query rather than a tree walk: `find -name` is one
`glob`, `grep -rl` on a literal is one indexed content search, `ls` is one
`readdir`. It is a separate entry point, not part of `Workspace`.

```ts
import { createShell } from "kompjutr/shell";

const shell = createShell({ fs: workspace.filesystem });
const { stdout, operations } = shell.run("grep -rl createShell /src");
```

Output bytes and filesystem operations are bounded by the executor, so a command
without `| head` still returns a bounded result. `git` is not a built-in; a
consumer injects it through `commands`. See [the shell reference](docs/reference/shell.md) for
the command set and the deliberate divergences from bash.

## Compatibility

Applications that still use `@cloudflare/computer` can opt into the migration
adapter explicitly:

```ts
import { Workspace } from "@cloudflare/computer";
import { createSqliteGitClient } from "kompjutr/compat/computer";

const workspace = new Workspace({
  storage: ctx.storage,
  git: createSqliteGitClient(),
});
```

`@cloudflare/computer` is an optional peer dependency. It is not loaded by
`kompjutr`, `kompjutr/fs`, `kompjutr/git`, or `kompjutr/testing`.

Native pull returns the same structured outcomes as merge and preserves
restart-safe conflict or no-commit state. The compatibility interface returns
`void` as declared by Computer; if integration conflicts, it rolls back the local
index and worktree while retaining the successful fetch and tracking ref. The
installed Computer Git contract has no rebase methods; rebase is native-only.

## Resource model

The storage and traversal layers use byte-bounded caches, paged SQLite queries,
bounded BLOB results, and fail-closed input limits. Received packs remain
compressed in SQLite and are read in physical order. Tree walks use a parsed,
source-qualified edge index and do not read object BLOBs.

The universal targets are at most 1,000 SQL statements and less than 100 MiB of
operation memory. The repository has adversarial gates for these bounds. The
wall target is below 0.1 seconds for operations touching at most 1,000 changed
paths. This wall target is not yet met by full-repository `status` and
`checkout`; they remain bounded by full tree, index, and filesystem scans.

See [the architecture](docs/reference/architecture.md) for the storage model and current
limits, and [the current benchmark](docs/reference/benchmark-current.md) for the native
Next.js workflow. Older comparisons are historical pre-standalone evidence.

## Status

Experimental. The standalone API and compatibility adapter are tested, but the
remaining wall-time gaps above still block a performance-complete release.

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

MIT, except `src/core/diff/`, which is a port of Git's xdiff implementation and
is LGPL-2.1-or-later. See `LICENSE`, `src/core/diff/LICENSE`, and
`LICENSES/LGPL-2.1.txt`.
