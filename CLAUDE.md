# kompjutr

SQLite-native filesystem and Git runtime for Cloudflare Durable Objects. The
working tree, Git objects, refs, index, and received packs are all rows in the
Durable Object's SQLite database. There is no `.git` directory and no external
filesystem runtime.

## Commands

```bash
npm test                             # full suite
npx vitest run tests/status.test.ts  # single file
npm run typecheck                    # tsc --noEmit over src + tests + bench
npm run check                        # biome lint + format check
npm run format                       # biome format --write
npm run build                        # tsc -p tsconfig.build.json -> dist/
```

Benchmarks have their own rules. Read `bench/CLAUDE.md` before running one.

## Project structure

```
src/core/      Git engine: ops, object store, packs, protocol, diff, ignore
src/fs/        The filesystem over Durable Object SQLite
src/shell/     kompjutr/shell — bash-shaped commands compiled to queries
src/sqlite/    Database adapter, schema, migrations
src/runtime/   Workspace: composes db + filesystem + git
src/git/       Git client facade over core/ops
src/compat/    Migration adapter; the only entry allowed to import @cloudflare/computer
tests/         Vitest suite, parity and conformance harnesses
bench/         Standalone benchmark harness
docs/plans/    Design documents; standalone-runtime.md is the current one
```

Layering is one-way: `shell` and `git` may depend on `fs`, never the reverse,
and `shell` never imports `git`.

## Conventions

- ESM with explicit `.js` extensions on relative imports. `import type` for
  type-only imports (`verbatimModuleSyntax`, `isolatedModules`).
- Target is the Workers runtime. `node:` imports only where the platform
  provides them — `node:zlib` in `src/core/zlib.ts`, `node:buffer` in the compat
  facades. Do not add others.
- Errors carry a stable `code`. Git errors subclass `GitError`; filesystem
  errors come from `filesystemError()`. Callers branch on `error.code`, never
  `instanceof` — the compat classes are re-declared, so identity does not hold.
- Comments explain *why*, in a header block or above the subtle line. Match the
  existing density; do not exceed it.
- No `any`, no `as` casts, no `@ts-expect-error`. `noUncheckedIndexedAccess` is on.

## Critical invariants

1. **Never order paths with `<`, `>`, or a bare `.sort()`.** JavaScript compares
   UTF-16 code units; Git trees and SQLite `BINARY` compare UTF-8 bytes, and the
   two disagree above the BMP. Use `comparePaths` (`src/core/streams.ts` for the
   git side, `src/fs/path.ts` for the filesystem side).
2. **Never emit `BEGIN`, `COMMIT`, or `ROLLBACK`.** The platform rejects SQL
   transaction statements. Use `db.transactionSync()`, which delegates every
   nesting level to Durable Object storage.
3. **Traversals use `db.iterate()`, never `db.all()`.** `all()` materialises the
   cursor and is for bounded result sets only. A traversal that materialises
   defeats the entire cost model.
4. **Every SQL row is untrusted.** Validate numeric, text, BLOB, size, revision,
   and ordinal fields before use. Derived tree and commit rows validate against
   an authoritative loose object or a complete packed source.
5. **Bound before allocating.** YOU MUST fail closed with a stable error when an
   operation exceeds a structural limit — never truncate silently, never continue
   unbounded. The budget is ≤1,000 SQL statements and <100 MiB per operation.

## Module context

Read the file for a directory before changing code in it:

- `src/core/CLAUDE.md` — op structure, merge-join cost model, packs, trust rules
- `src/fs/CLAUDE.md` — POSIX semantics, handles and revalidation, the bulk API
- `src/shell/CLAUDE.md` — a command is a query; parse → plan → execute
- `tests/CLAUDE.md` — parity against real binaries, conformance against `node:fs`
- `bench/CLAUDE.md` — measurement rules; a number measured wrong is worse than none
