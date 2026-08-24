# tests

Vitest under plain Node. `tests/helpers/storage.ts` backs
`DurableObjectStorageLike` with `node:sqlite`, so the whole stack runs without
a Worker — Workers' DO SQL surface is a subset of it.

```
helpers/db.ts        TestDatabase — use for store tests, no Workspace needed
helpers/storage.ts   node:sqlite DurableObjectStorageLike
helpers/git.ts       fixtures built by the real git binary
helpers/http-backend.ts real Smart HTTP through `git http-backend`
helpers/parity.ts    differential harness for grep and rg
helpers/workspace.ts full runtime under test
fs/conformance/      the dofs suite, ported; MIT, keep the file headers
shell/               parse, plan, bounds, cost, parity, session
```

## Correctness is differential, not asserted

Do not write an expectation from your own reading of a spec when a real
implementation can be asked instead.

- **Git behaviour** — pack layout, tree hashing, the wire protocol — is checked
  against the `git` binary through `helpers/git.ts`. Its fixtures pin
  `GIT_*_DATE` and identity so hashes are reproducible; do not introduce a
  fixture with a floating timestamp.
- **`grep` and `rg`** run the same corpus through the installed binaries and
  demand the same bytes back (`helpers/parity.ts`). Two dimensions are
  controlled rather than compared: `LC_ALL=C`, and `--no-ignore` with an empty
  `RIPGREP_CONFIG_PATH`. `rg --sort path` compares ordered; GNU grep has no
  equivalent, so its recursive cases compare as sets —
  `agree(parity, { ordered: false })`. That the shell's own order is sorted is
  asserted separately, as a property of the shell.
- **Filesystem behaviour** is checked by the ported conformance suite against
  POSIX/Node semantics.

If a parity test fails, the shell is wrong until proven otherwise. Never relax
an assertion to make it pass, and never weaken the controlled dimensions.

## Rules

- Prefer `TestDatabase` over a full `Workspace` when the subject is a store or
  a stream — it is faster and the failure points at the right layer.
- Test Smart HTTP success paths against `helpers/http-backend.ts`. Reserve mocks
  for malformed frames and transport failures that real Git cannot produce.
- Cost is behaviour: assert statement and operation counts where the suite
  already does (`tests/shell/cost.test.ts`, `tests/shell/bounds.test.ts`). A change that
  keeps outputs identical and raises the counts must fail a test.
- Timeouts are 60 s for tests and hooks. A test needing more is measuring the
  wrong thing.
- `@cloudflare/computer` is inlined by the vitest config and its
  `cloudflare:workers` import is aliased to a stub. Only compat tests need it.
