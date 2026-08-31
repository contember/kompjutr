# Trusted-store domain architecture

Accepted 2026-08-30. The authoritative target for the restructure sprint
([`../archive/sprint-2026-08-30-trusted-store-and-domain-restructure.md`](../archive/sprint-2026-08-30-trusted-store-and-domain-restructure.md), shipped).
Decisions behind it: [ADR-0018](../decisions/0018-trust-stored-rows-validate-at-the-boundary.md)
(trust model) and [ADR-0019](../decisions/0019-organize-source-by-domain-with-bottom-up-layers.md)
(layout). By user direction this design is not subject to architecture review;
the test suite is the only gate.

## Target tree

```text
src/
  fs/              filesystem domain (unchanged internally)
  shell/           shell domain (unchanged internally)
  git/             git domain
    client.ts      public facade — assembles ops into the kompjutr/git surface
    common/        pure primitives: bytes, sha1, zlib, lru, errors, streams
                   (comparePaths, joinSorted*), paths, ref-name, object codecs,
                   and the shared guard/decoder kit
    diff/          LGPL-2.1-or-later xdiff port — keeps LICENSE + SPDX headers
    ignore/        gitignore discovery and byte-oriented matchers
    protocol/      Smart HTTP wire: pkt-line, stream, transport, remote,
                   receive-pack, progress
    store/         the SQLite store: db adapter, schema, table families,
                   projections, tracker, sparse, maintenance/
    ops/           one file per command family + repository.ts, worktree.ts,
                   context.ts
  runtime/         Workspace composition
  compat/          the only entry allowed to import @cloudflare/computer
```

Layer order inside `git/`, bottom-up — a slice imports only slices below it:

```text
common  →  diff | ignore | protocol  →  store  →  ops  →  client.ts
```

Cross-domain: `git` and `shell` may depend on `fs`; `fs` on neither; `shell`
never imports `git`. The dynamic accounting module is deleted per ADR-0017;
structural caps live beside the seams they bound.

## Mapping (old → new)

| Old | New |
|---|---|
| Legacy Git primitive modules | `src/git/common/` |
| Legacy Git diff slice | `src/git/diff/` (license boundary intact) |
| Legacy Git ignore slice | `src/git/ignore/` |
| Legacy Git protocol slice | `src/git/protocol/` |
| Legacy Git pack parser | `src/git/store/pack/` (pack parsing serves the store) |
| Legacy Git SQLite slice (adapter, schema, families, projections, maintenance) | `src/git/store/` |
| Legacy Git operation, repository, worktree, context, and sparse-workspace modules | `src/git/ops/` |
| `src/git/client.ts` | `src/git/client.ts` (unchanged path, new siblings) |
| Journal codecs in the legacy merge and operation state modules | persisted-format half moves to `src/git/store/operations.ts`; op logic stays in `ops/` |
| `IndexEntry` and legacy sparse-workspace capability contracts | `src/git/store/contracts.ts` |

Public package exports (`kompjutr`, `kompjutr/fs`, `kompjutr/git`,
`kompjutr/shell`, `kompjutr/compat/computer`) are byte-stable across the whole
restructure; `tests/public-exports.test.ts` is the witness.

## Trust model (ADR-0018 applied)

| Check | Verdict |
|---|---|
| Caller input grammar/ranges (`GitError`) | keep — through the shared decoder kit |
| Network bytes: pack trailer, ingest hashing, protocol framing | keep |
| Schema version + exact shape at open | keep |
| Write-time `CHECK` constraints and write-path validation | keep |
| Traversal cycle/termination guards; CAS, revisions, epochs, leases, provisional states | keep — algorithm and concurrency correctness |
| Structural caps: batch/queue/cache sizes, single-value limits naming a real failure, `E2BIG` on caller-unbounded enumerations | keep — the memory model (ADR-0017) |
| Structural delta-closure check on pack deletion | keep |
| Dynamic memory accounting: coordinator and reservation scopes, transfer/ownership checks, transport budget, hand-computed JS-size constants | delete (ADR-0017) |
| SQL `typeof(...)` storage-class witnesses on reads | delete |
| `CAST(... AS BLOB)` canonical text reads + canonical re-encode | delete |
| Two-phase metadata → payload read preflights | delete |
| Read-time re-authentication of projections against authoritative objects | delete |
| Pack publication re-read/re-inflate audit (publish from parse-time digests) | delete |
| Deletion-time re-hashing of promoted objects | delete |
| JS re-validation of SQL `ORDER BY` output | delete |
| Corruption-injection tests for deleted checks | delete or convert to write-`CHECK`/boundary witnesses |

Out-of-band mutation of the database is undefined behavior. The opt-in
integrity audit is [backlog 17](../backlog/17-integrity-audit-and-snapshots.md).

## Design style

Model fundamental structures as classes when behavior belongs with the data —
a bit more OOP where it makes sense, not loose functions over bare interfaces.
Store families are cohesive classes with constructor-injected dependencies;
value concepts that carry their own operations (a Git path and its ordering, a
ref name and its grammar, a decoded row shape) earn a class; a plain function
stays a function. What this rules out is today's sprawl of free helpers +
`unknown` parameters + WeakMap side-channels standing in for object structure.

## Shared kits (in `git/common/`)

Two consolidations replace today's scattered five-operand `if` chains:

- **Guards and decoders.** `expectText`, `expectSafeInteger(min?, max?)`,
  `expectBlob`, `expectNullable(...)`, plus a declarative row-shape helper so a
  store read decodes as one shape declaration (`decodeRow(row, { name: text,
  ordinal: int(1, MAX) })` → `CorruptError` on mismatch) and a public-options
  helper so ops stop hand-rolling `unknown` handling (`lsFilesExcludeRoots`-style
  `Reflect.get` loops become one typed decode → `GitError`).
- **Paths.** Git-side path work (join/split, ancestors, prefix logic,
  normalization, `comparePaths`) lives in `git/common/paths.ts` only. Ops files
  stop defining local path helpers; `fs/path.ts` remains the filesystem-side
  counterpart.

## Store internal API

The WeakMap `*Owned` friend-function dispatch is removed. `store/` modules
export explicit internal functions and interfaces (not re-exported by the
package). Ownership is fixed, not construction-ordered:

- Repo-scoped state (objects, packs, refs, config, shallow, projections,
  blob-ids) is owned by the shared store; its operations never dispatch through
  a checkout instance and cannot dangle when a checkout is removed.
- `CheckoutStore` keeps only checkout-owned state: worktree root, raw HEAD,
  index, tracker, operation journals, HEAD reflog (ADR-0009 unchanged).
- Table families follow the maintenance precedent as modules under `store/`:
  `database` (identity/routing), `shared`, `checkout`, `objects`, `pack/`,
  `refs`, `config`, `index`, `operations`, projections (`tree-index`,
  `tree-walk`, `commits`), `tracker`, `sparse`, `maintenance/`.
- No reservation plumbing in signatures: memory safety is structural
  (ADR-0017), verified by the leased cgroup benchmark scenarios.

The known regression this fixes: at `4e4f1e0`, `worktreeAdd` + `worktreeRemove`
leaves every other checkout unable to write objects
(`EWORKTREENOTFOUND` from `writeObjectsOwned` dispatching into the evicted
store). A regression test pins the fixed behavior.

## Enforcement

The rules are tests, not conventions:

- **Import-graph witness** — static check that every `src/` import respects the
  domain and layer order above.
- **File-ceiling witness** — no source file over 2,000 lines. Known offenders
  to split: `packs.ts` (read engine / ingest / publication / deletion / lease),
  `sparse-workspace.ts`, `staging.ts`, and the drafted `store/checkout.ts`.
- **Public-exports witness** — unchanged package surface.
- **Leased cgroup memory scenarios** in `bench/` — the evidence that the
  composed peak stays under the 100 MiB target without a runtime ledger.
- The regression test for the ownership fix above.

## Open items

- The git tracker installs SQLite triggers on `fs_*` tables and sparse reads
  them directly. This stays (git may depend on fs), but the fs schema is now a
  declared internal contract: a change to `fs_paths`/`fs_nodes`/`fs_chunks`
  must run the tracker and sparse suites.
- `bench/` paths and docs references update with the move; benchmarks are
  informative during the restructure (clone is expected to improve when the
  publication re-audit goes).

## Amendments at close

The final layout adds `src/db/` below the domains for the shared SQLite adapter,
error normalization, and routing limits. `GitError` is defined in `db/db.ts`
because SQLite error normalization lives in that kernel, then re-exported by
`git/common/errors.ts`. [ADR-0019](../decisions/0019-organize-source-by-domain-with-bottom-up-layers.md)
is the living record for the final tree and enforced dependency rules.
