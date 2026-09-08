# @kompjutr/git

SQLite-native Git engine over an injected synchronous drive.

Use `createGit()` with a `SqliteGitDatabase` and a `GitDrive`, or use one of the
ready compositions in `@kompjutr/do` and `@kompjutr/local`. The engine contains
Git objects, refs, indexes, packs, Smart HTTP, typed operations, and the strict
argv adapter. It never invokes a system `git` executable.

Cloudflare Worker consumers must enable the `nodejs_compat` compatibility flag;
the engine uses the Workers-supported `node:zlib` module.

`@kompjutr/git/do-fs` is the isolated Durable Object integration for mixed
filesystem/Git SQL and native capability receipts. Ordinary `@kompjutr/git`
imports do not load it.
