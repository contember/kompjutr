---
id: 0002
title: Organize source by domain with bottom-up layers
status: accepted
date: 2026-08-30
---

# 0002 — Organize source by domain with bottom-up layers

## Context

The filesystem and the Git store use the same Durable Object SQLite database. A
storage adapter placed inside either domain would force the other domain to
depend on it. Git also contains several kinds of code with different dependency
needs: pure primitives, independent algorithms and wire codecs, persistence,
command operations, and public surfaces.

A flat source layout expresses none of that. It does not prevent a store module
from reaching back into an operation, and it does not stop a file from growing
until nobody reviews it as a whole.

## Decision

We organize `src/` into behavior domains over one shared storage kernel.

- `db/` sits below every domain. It owns the Durable Object SQLite adapter,
  structural SQL interfaces, SQLite error normalization, and shared routing
  limits. `GitError` is defined in `db/db.ts` because the adapter normalizes
  SQLite failures into stable Git-facing codes; `git/common/errors.ts`
  re-exports it and defines the Git-specific subclasses.
- `fs/`, `shell/`, and `git/` are the domains. `runtime/` composes them.
- Git uses bottom-up slices: `common` → `diff | ignore | protocol` → `store` →
  `ops` → surface. The surface is `client.ts`, `cli/`, and the entrypoints.
- `store/` owns persisted formats and explicit internal capabilities. It never
  imports `ops/`.
- `diff/` remains an LGPL-2.1-or-later boundary with its own license and SPDX
  headers.

`tests/import-graph.test.ts` enforces the dependency rules exactly:

1. `src/db` may not import another recognized domain.
2. `src/fs` may import only `src/fs` and `src/db`.
3. `src/shell` may import only `src/shell`, `src/fs`, and `src/db`.
4. `src/runtime` may import only `src/runtime`, `src/db`, `src/fs`, `src/git`,
   and `src/shell`.
5. A Git slice may import its own slice or a lower-ranked one. `common` is
   rank 0; `diff`, `ignore`, and `protocol` are independent rank-1 peers;
   `store` is rank 2; `ops` is rank 3; everything else under `git/` is the
   rank-4 surface.
6. `src/git/store` may not import `src/git/ops`.
7. No file under `src/` may import `@cloudflare/computer`
   ([ADR-0001](0001-own-the-standalone-sqlite-runtime.md)).

The witness covers relative imports, exports, dynamic imports, and import
types. `tests/file-ceiling.test.ts` enforces the size rules: 500 lines per
file, 20 direct TypeScript files per directory, and a 173-line symbol ceiling
set at the 99.5th percentile of the measured distribution, with the long
procedures past it named individually rather than raising the bar for
everyone. `tests/public-exports.test.ts` protects the published entrypoints.

## Consequences

- The directory tree states ownership: one shared storage kernel, three
  domains, a composition root, and explicit layers inside Git.
- Filesystem code shares the database adapter and routing policy without
  depending on Git.
- Persisted journal codecs and store contracts live below operations, so a
  store-to-ops value cycle cannot return.
- Internal table-family APIs are explicit without becoming package exports.
- The package keeps one release unit while the tests provide package-like
  dependency boundaries.
- A new file that violates dependency direction or a size ceiling fails the
  suite rather than the review.
- The symbol ceiling is a ratchet: a grandfathered procedure that shrinks below
  it may not be re-listed.

## Alternatives considered

- **Put the database adapter in Git.** Rejected: the filesystem uses the same
  adapter and must not depend on Git.
- **Duplicate adapters per domain.** Rejected: transaction behavior, row
  normalization, SQLite error handling, and routing limits are shared policy.
- **Split domains into workspace packages.** Rejected: no consumer needs
  separately versioned packages; directories plus witnesses give the same
  boundaries without publishing overhead.
- **Use guidelines without tests.** Rejected: dependency cycles and oversized
  files are easy to reintroduce when the rule is not executable.
