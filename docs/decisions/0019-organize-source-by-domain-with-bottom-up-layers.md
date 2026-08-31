---
id: 0019
title: Organize source by domain with bottom-up layers
status: accepted
date: 2026-08-30
---

# 0019 — Organize source by domain with bottom-up layers

## Context

The filesystem and Git store use the same Durable Object SQLite database. A
storage adapter inside either domain would force the other domain to depend on
it. Git also contains several kinds of code with different dependency needs:
pure primitives, independent algorithms and wire codecs, persistence, command
operations, and public surfaces. A flat source layout does not express those
ownership or dependency boundaries and does not prevent store-to-operation
cycles or unbounded file growth.

## Decision

We organize `src/` into behavior domains over one shared storage kernel.

- `db/` is below every domain. It owns the Durable Object SQLite adapter,
  structural SQL interfaces, SQLite error normalization, and shared routing
  limits. `GitError` is defined in `db/db.ts` because the adapter normalizes
  SQLite failures to stable Git-facing codes; `git/common/errors.ts` re-exports
  it and defines Git-specific subclasses.
- `fs/`, `shell/`, and `git/` are domains. `runtime/` composes them and
  `compat/` contains the optional external adapter.
- Git uses bottom-up slices: `common` → `diff | ignore | protocol` → `store` →
  `ops` → surface. The surface is `client.ts`, `cli/`, entrypoints, and Git-side
  adapters.
- `store/` owns persisted formats and explicit internal capabilities. It never
  imports `ops/`. Repository-scoped operations stay on the shared store;
  checkout-scoped operations stay on the checkout composition root.
- `diff/` remains an LGPL-2.1-or-later boundary with its own license and SPDX
  headers.
- Every TypeScript source file stays at or below 2,000 lines.

`tests/import-graph.test.ts` enforces these rules exactly:

1. `src/db` may not import any other recognized source domain.
2. `src/fs` may import only `src/fs` and `src/db`.
3. `src/shell` may import only `src/shell`, `src/fs`, and `src/db`.
4. Git slices may import their own slice or a lower-ranked Git slice. `common`
   is rank 0; `diff`, `ignore`, and `protocol` are independent rank-1 peers;
   `store` is rank 2; `ops` is rank 3; all other files below `git/` are the
   rank-4 surface.
5. `src/git/store` may not import `src/git/ops`.
6. Only `src/compat` may import `@cloudflare/computer`.

The import witness covers relative TypeScript imports, exports, dynamic imports,
and import types. A separate source-file witness enforces the line ceiling.
`tests/public-exports.test.ts` protects the published entrypoint surface.

## Consequences

- The directory tree states ownership: shared storage kernel, three domains,
  and explicit layers inside Git.
- Filesystem code can share the database adapter and routing policy without
  depending on Git.
- Persisted journal codecs and store contracts live below operations, so the
  store-to-ops value cycle cannot return.
- Internal table-family APIs are explicit without becoming package exports.
- The package keeps one release unit while tests provide package-like dependency
  boundaries.
- New source files that violate dependency direction or the 2,000-line ceiling
  fail the suite.

## Alternatives considered

- **Put the database adapter in Git.** Rejected: the filesystem uses the same
  adapter and must not depend on Git.
- **Duplicate adapters per domain.** Rejected: transaction behavior, row
  normalization, SQLite error handling, and routing limits are shared policy.
- **Split domains into workspace packages.** Rejected: no consumer needs
  separately versioned packages; directories plus witnesses enforce the needed
  boundaries without publishing overhead.
- **Use guidelines without tests.** Rejected: dependency cycles and oversized
  files are easy to reintroduce when the rule is not executable.
