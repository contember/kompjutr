# kompjutr

An experimental replacement for `@cloudflare/computer/git` that keeps the git
repository in the Durable Object's SQLite database and the working tree in
DOFS — with no `.git` directory anywhere.

Computer's shipped git client runs `isomorphic-git` over a filesystem
adapter:

```
isomorphic-git → filesystem API → @platformatic/vfs → DOFS → SQLite
```

This package replaces that with:

```
git engine ├── git database → SQLite directly
           └── working tree → DOFS
```

It plugs in through the extension point Computer already exposes, so nothing
in Computer has to change:

```ts
import { Workspace } from "@cloudflare/computer";
import { createSqliteGitClient } from "kompjutr";

const ws = new Workspace({ storage: ctx.storage, git: createSqliteGitClient() });
```

## Why

Computer documents its `isomorphic-git` pack/index cache as unbounded: a
workspace that clones a 1 GB repository holds the parsed pack in Durable
Object memory. Every cache here is bounded in bytes, and received packs stay
compressed in SQLite and are read one chunk at a time.

## Status

Experimental. See `docs/` for the design notes and the phase plan.

## License

MIT
