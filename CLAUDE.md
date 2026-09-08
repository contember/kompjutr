# kompjutr

SQLite-native Git runtime with Cloudflare Durable Object and Unix local
compositions. Neither creates a `.git` directory.

The project is still in development and has no production users, so backward compatibility, including schema migrations, is not required unless explicitly requested.

## Commands

```bash
npm test                             # fast cross-layer smoke suite, target <30 s
npm run test:fs                      # filesystem slice
npm run test:shell                   # shell slice
npm run test:e2e                     # end-to-end slice
npm run test:full                    # exhaustive batched suite; sprint closure and CI only
npx vitest run tests/status.test.ts  # exact focused witness
npm run typecheck                    # tsc --noEmit over packages + tests + bench
npm run check                        # biome lint + format check
npm run format                       # biome format --write
npm run build                        # project-reference build -> packages/*/dist
```

Benchmarks have their own rules. Read `bench/CLAUDE.md` before running one.

## Project structure

```
packages/sqlite/  Shared SQLite contracts, errors, limits, and codecs
packages/drive/   Synchronous Git drive contracts and capability receipts
packages/git/     Generic Git engine; `do-fs` is the isolated DO integration
packages/do/      Worker adapter, SQLite filesystem, shell, and Workspace
packages/local/   Unix node:sqlite adapter, disk drive, recovery, LocalWorkspace
tests/            Vitest suite, parity and conformance harnesses
bench/            Standalone benchmark harness
docs/             Architecture, current benchmarks, plans, and history
```

Layering is bottom-up: `sqlite|drive → git → do|local`. Inside Git:
`common → diff|ignore|protocol → store → ops → client|cli`. Ordinary Git cannot
reach `git/do-fs`; Worker-facing packages cannot reach `local` or Node-only
builtins. Source cannot import `@cloudflare/computer`. The import-graph suite
enforces the exact rules.

## Conventions

- ESM with explicit `.js` extensions on relative imports. `import type` for
  type-only imports (`verbatimModuleSyntax`, `isolatedModules`).
- Worker-facing packages use only platform-supported `node:` imports. Node-only
  imports belong in `@kompjutr/local`.
- Errors carry a stable `code`. Git errors subclass `GitError`; filesystem
  errors come from `filesystemError()`. Callers branch on `error.code`, never
  `instanceof`.
- Comments explain *why*, in a header block or above the subtle line. Match the
  existing density; do not exceed it.
- No `any`, no `as` casts, no `@ts-expect-error`. `noUncheckedIndexedAccess` is on.
- Source files stay under 500 lines; split along a seam before you get there. A
  suite witness enforces this.
- Source directories contain at most 20 direct TypeScript files. Group a growing
  family in a semantic subdirectory without changing its architectural layer.
- Recurring checks and comparisons go through the shared guard/decoder and path
  kits; do not hand-roll multi-operand `typeof` chains or local path helpers.

## Critical invariants

1. **Never order paths with `<`, `>`, or a bare `.sort()`.** JavaScript compares
   UTF-16 code units; Git trees and SQLite `BINARY` compare UTF-8 bytes, and the
   two disagree above the BMP. Use `comparePaths`
   (`packages/git/src/common/{streams,paths}.ts` for Git,
   `packages/do/src/fs/path.ts` for DOFS, and `packages/local/src/paths.ts` for
   disk).
2. **Shared and Worker code never emits `BEGIN`, `COMMIT`, or `ROLLBACK`.** Use
   `db.transactionSync()`. Transaction SQL is allowed only inside the local
   Node adapter.
3. **Traversals use `db.iterate()`, never `db.all()`.** `all()` materialises the
   cursor and is for bounded result sets only. A traversal that materialises
   defeats the entire cost model.
4. **Validate at the boundary; trust the store.** Caller input fails with
   `GitError`; network bytes are validated at ingest; the schema is validated
   at open; write paths and `CHECK` constraints guard what gets stored. Rows
   the store wrote are trusted at read — no read-time re-authentication, no
   SQL `typeof` witnesses, no two-phase preflights. Decode a row with the
   shared guards only because the type system requires it; a failed guard is
   `CorruptError` and that is the whole read-time check. Out-of-band database
   mutation is undefined behavior
   ([ADR-0004](docs/decisions/0004-trust-stored-rows-validate-at-the-boundary.md)).
5. **Bound the cost structurally; do not manufacture the failure.** Stream
   traversals, fix batch and cache sizes, cap caller-unbounded enumerations —
   and never refuse work from an invented currency (projected statements or a
   byte ledger). ≤1,000 SQL statements and <100 MiB per operation is a
   *target*, measured in `bench/`
   ([ADR-0005](docs/decisions/0005-bound-real-failures-and-measure-cost.md)).
   A cap survives only if it names the real failure it prevents; never
   truncate silently.

## Module context

Read the file for a directory before changing code in it:

- `packages/git/src/CLAUDE.md` — Git layers, cost model, shared kits, trust rules
- `packages/git/src/store/CLAUDE.md` — row ownership, packs, and maintenance
- `packages/do/src/fs/CLAUDE.md` — POSIX semantics, handles, and bulk operations
- `packages/do/src/shell/CLAUDE.md` — parse → plan → execute
- `packages/local/src/CLAUDE.md` — Unix paths, locking, recovery, and traversal
- `tests/CLAUDE.md` — parity against real binaries, conformance against `node:fs`
- `bench/CLAUDE.md` — measurement rules; a number measured wrong is worse than none

<!-- AGENT-DOCS:POINTER (managed by the agent-docs skill — edit the body freely,
     keep the markers) -->
## Docs

Project docs live in [`docs/`](./docs/) and follow a fixed structure — start at
[`docs/CLAUDE.md`](./docs/CLAUDE.md) (the operating manual) and
[`docs/INDEX.md`](./docs/INDEX.md) (the map). In short:

- `docs/reference/` — how the system works now.
- `docs/decisions/` — living ADRs (the *why*).
- `docs/backlog/` — decided work not yet scheduled · `docs/sprints/` — active
  work-plans · `docs/archive/` — shipped.
- `docs/ideas/` — proposals, no commitment.

Path is the status (no `status:` fields); when you finish or supersede something,
move/delete it per `docs/CLAUDE.md`.
<!-- /AGENT-DOCS:POINTER -->
