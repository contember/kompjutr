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

## Credits

The pack-native object store is dgit's idea, and parts of the pack, pkt-line
and object-codec layers are adapted from it directly — see the file headers
and `LICENSE`. dgit is a git *server* on Durable Objects; this is a client,
so the protocol side is ours, but the storage shape is theirs.

## License

MIT, with one exception: `src/core/diff/` is a port of the xdiff library as it
appears in git — its record-cleanup heuristic and indent-heuristic weights
included — and is therefore **LGPL-2.1-or-later**, like the original. Nothing
else in the package derives from it; the rest uses it as a library, which
LGPL-2.1 section 6 permits.

Matching `git diff` byte for byte is not reachable without that pipeline:
where a change group lands inside a run of equal lines is decided by those
heuristics, not by Myers. If the LGPL boundary is unwelcome in your build,
swapping `src/core/diff/` for any unified-diff generator gives valid patches
that simply place some hunks differently.

See `LICENSE`, `src/core/diff/LICENSE`, and `LICENSES/LGPL-2.1.txt`.
