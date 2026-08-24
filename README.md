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

The native client supports repository initialization, clone, fetch, single-branch
Smart HTTP push, status, staging, commit, log, diff, checkout, branches, tags,
refs, config, remotes, and the plumbing operations exposed by `Git`. Unsupported
commands fail with `EUNSUPPORTED` instead of falling back to another
implementation.

```ts
await workspace.git.init({ dir: "/" });
workspace.fs.writeFileSync("/README.md", "# project\n");
await workspace.git.add({ paths: ["README.md"] });
const commit = await workspace.git.commit({ message: "Initial commit" });
```

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

## Credits

The pack-native object store is based on ideas from dgit. Adapted files retain
their source headers and license notices. Files ported from
`@cloudflare/computer` are covered by `LICENSES/cloudflare-computer.txt`.

## License

MIT, except `src/core/diff/`, which is a port of Git's xdiff implementation and
is LGPL-2.1-or-later. See `LICENSE`, `src/core/diff/LICENSE`, and
`LICENSES/LGPL-2.1.txt`.
