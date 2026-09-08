# @kompjutr/local

Unix local workspace backed by SQLite Git state and a disk working tree.

```ts
import { LocalWorkspace } from "@kompjutr/local";

const workspace = new LocalWorkspace({
  root: "/projects/example",
  stateDirectory: "/var/lib/kompjutr/example",
});

await workspace.git.status();
workspace.close();
```

Requires Node.js 24 and Unix filesystem semantics. `root`, `stateDirectory`,
and `recoveryDirectory` must be canonical absolute paths and must not overlap.
The root-keyed process lock uses a hidden SQLite file beside the worktree and
lasts for the workspace lifetime. SQLite publication and disk changes share a
generation-backed undo journal that is settled automatically on reopen.
Traversal uses bounded external sorting, and disk content is rehashed
conservatively.

Path resolution rejects lexical and observed symlink escapes. This pure Node
implementation assumes that processes which ignore the workspace lock do not
concurrently replace directory ancestors or fixed state artifacts. Pre-existing
bind-mounted aliases of nested worktree or state directories are unsupported.

This package is a library. It does not install a replacement `git` executable.
