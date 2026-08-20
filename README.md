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

## Benchmarks

Both clients through one harness, on the fixtures the earlier DOFS experiment
used. Prettier 3.9.6, 9,329 tracked files:

| Operation | `createGitClient()` | kompjutr |
| --- | --- | --- |
| `git.add --all` | 16.7 s, 2,550 MB peak | 4.8 s, 88 MB peak |
| `git.commit` | 2.8 s, 59,433 statements | 0.25 s, 16,542 statements |
| `git.diffSummary` | 2.9 s | 0.41 s |
| `git.status` | 1.4 s | 1.3 s |

`git.status` barely moves because 202,191 of its 202,234 statements are the
working-tree walk through DOFS, which both clients share; only 41 are git.

On the largest fixture, `vercel/next.js` at 24,252 files, `git.add --all` costs
the shipped client 95 s and **6,634 MB**; it costs kompjutr 22 s and **190 MB**.
A Durable Object gets 128 MB for the whole isolate.

`docs/benchmark-macro.md` has the full tables and what does not carry from a
`node:sqlite` harness into a Durable Object. `docs/benchmark-results.md` covers
the synthetic memory sweep.

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
