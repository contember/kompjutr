> **OUTCOME — shipped 2026-08-29.** `Shell.run()` and `Shell.exec()` now accept
> bounded caller stdin and a frozen own-property environment snapshot. One
> run-owned byte cursor preserves unread input across selected pipelines,
> including partial `head` reads; injected commands inherit env, and the Git
> adapter forwards it only when supplied. Commit map: plan and approval →
> `3554cda`, `efedcb4`, `1a77f3f`; WU1 stdin → `742f29c`; WU2 env and Git →
> `b8b7fe5`; integrated cursor correction and public reference → `7e89010`;
> closure → this archived record. Verification: WU witnesses passed 34/34 and
> 27/27; the stable shell slice passed 315/315 in 4.31 s; the routine gate
> passed 148/148 in 5.76 s; the full sliced runner passed 2,926 tests with five
> known skips and zero failures. Typecheck, Biome, build, packed-package smoke,
> and diff validation passed. Independent WU reviews were cleaned, and the
> integrated T3 review caught and verified the partial-chunk cursor fix before
> closure. No projected SQL statement barrier was added. Deferred: the external
> consumer adapter rerun remains the Phase 1 integration gate; removing existing
> projected statement barriers remains
> [backlog 60](../backlog/60-budget-targets-and-store-split.md).

# Sprint — Shell run inputs (2026-08-29)

**Goal.** Let a synchronous shell run receive bounded caller stdin and
environment values so a consumer can expose kompjutr through its existing shell
port without temporary files or lost Git identity.

**Theme.** The consumer integration gate found one package-side blocker: the
shell port already carries `stdin` and `env`, while `Shell.run()` and
`Shell.exec()` accept only source text. This sprint closes that input seam and
then returns to the consumer adapter gate. It does not turn the synchronous
query shell into a process runtime.

## Refs re-verified at HEAD (2026-08-29)

Planning is grounded at `95da5c4`; `✔` = confirmed live · `⚠` = drift or nuance
caught before implementation.

- ✔ `Shell.run()` and `Shell.exec()` accept only `source`, and `createShell()`
  passes no per-run inputs into `execute()` — `src/shell/index.ts:44-49`,
  `src/shell/index.ts:62-99`.
- ✔ A command already receives the previous pipeline stage as
  `CommandContext.stdin`, while the first stage starts with `null` —
  `src/shell/exec/context.ts:268-277`, `src/shell/exec/execute.ts:110-160`.
- ✔ An explicit `< file` currently replaces and closes a previous stage before
  reading the file; the same ownership seam can override a caller input without
  changing redirects — `src/shell/exec/execute.ts:129-150`.
- ✔ `CommandContext` has no environment field. Nested `xargs` invocations copy
  the context and replace only argv/stdin/hint, so a new readonly env field will
  naturally remain visible to injected subcommands —
  `src/shell/exec/context.ts:268-297`, `src/shell/exec/execute.ts:256-276`.
- ✔ `createGitCommand()` forwards argv and cwd but not the four identity
  variables accepted by the strict Git runner — `src/git/shell.ts:14-25`.
- ✔ The consumer adapter conformance suite passes every implemented filesystem,
  Git, scheduler, revision and log check against current HEAD, but skips its
  complete shell port because this per-run seam is absent. This confirms
  backlog 63 as an integration blocker rather than speculative parity work.
- ✔ Invariant 5 now makes SQL statement counts benchmark targets only. This
  sprint needs no statement projection, statement constant, or projected-count
  refusal; its bounds protect caller-controlled retained input only —
  `CLAUDE.md`, invariant 5.

## Frozen input contract

`Shell.run(source, options?)` and `Shell.exec(source, options?)` accept the same
optional `ShellRunOptions`:

```ts
interface ShellRunOptions {
  readonly stdin?: Uint8Array | string
  readonly env?: Readonly<Record<string, string>>
}
```

Absent options preserve today's result, operation count and command context.
Caller stdin is one run-owned byte cursor. Each selected pipeline borrows the
remaining cursor for its first stage; pipeline cleanup closes only that borrow.
Bytes already consumed stay consumed, while an earlier command that does not
read stdin leaves it for a later selected pipeline. The run closes the owned
cursor exactly once on success, short-circuit, execution failure, or early
downstream termination. Parsing and planning deliberately happen first: a
syntax error keeps today's result and precedence, creates no cursor, performs no
input measurement or reservation, and invokes no command. An explicit `< file`
replaces stdin for that stage but does not consume or close the run-owned cursor,
so a later selected pipeline may still read it. Pipeline stages after the first
receive only the previous stage's output as before.

Caller stdin is limited to 1 MiB. String size is proven in UTF-8 before the
encoded buffer is allocated. The environment accepts at most 256 own enumerable
entries and 1 MiB of cumulative UTF-8 key and value bytes. After syntax is valid,
both inputs are measured without encoded copies, their combined byte count is
reserved once from the existing retained-memory budget, and only then are the
stdin buffer and frozen own-property env snapshot allocated. The reservation
lives until the outermost execution `finally`, is reflected in
`peakRetainedBytes`, and is released on every result or exception. Exceeding a
count, intrinsic byte, or combined retained-memory bound returns the ordinary
shell limit result before input allocation, command, or filesystem work; it
never truncates semantic input.

Built-ins do not expand or otherwise read env. Injected commands receive the
snapshot through `CommandContext.env`; it is `undefined` when the caller did not
supply env. `createGitCommand()` forwards a supplied snapshot to the strict Git
runner, which retains its own allowlist and limits. Nested `invoke()` calls
inherit env and still receive no implicit stdin.

## Work units

### WU1 — Seed and bound caller stdin (effort M)

- **Problem.** A consumer must create a temporary file and `<` redirect to feed
  the first stage, adding a write, cleanup ownership, and an invented path.
- **Verify first.** Show that `shell.run("cat", { stdin: "value" })` is rejected
  by TypeScript today, while `cat < input` already produces the desired bytes.
- **Scope.** Add the shared public run-options type and optional parameter;
  after successful parsing, measure at most 1 MiB without allocating an encoded
  copy; reserve the shared input lifetime before encoding; implement the single
  run-owned cursor plus non-owning per-pipeline borrows; define redirect and
  AND/OR/list ownership exactly as frozen above. Do not add commands or parser
  syntax.
- **Acceptance / witness.** String and binary stdin match `< file` byte for byte
  through `cat` and one pipeline; a command that does not read leaves input for
  a later selected pipeline; a consuming command leaves no replay; `< file`
  overrides only its stage; skipped branches do not consume. A close-count probe
  covers ordinary success, command-not-found followed by `||`, injected-command
  throw, early downstream return, explicit redirect, and repeated borrow close;
  the existing Git command's explicit `stdin.return()` also leaves owner bytes
  available to a later selected pipeline. Borrow closure is idempotent and never
  closes the run owner; owner/reservation cleanup is exactly once on every
  execution exit. A syntax error proves that parsing wins and no owner or input
  reservation exists. Exact 1 MiB input succeeds and the first byte above it
  fails before allocation or filesystem work; stdin-only and combined-input
  retained first-excess cases report the expected `peakRetainedBytes` and do not
  leak. Runs without options retain their current result and operation count. Run
  `npx vitest run tests/shell/run-inputs.test.ts tests/shell/bounds.test.ts`.
- **Touch points.** `src/shell/index.ts`, `src/shell/exec/execute.ts`,
  `tests/shell/run-inputs.test.ts`, `tests/shell/bounds.test.ts`.

### WU2 — Carry bounded env into injected commands and Git (effort M)

- **Problem.** The consumer already has per-run env, and the Git argv contract
  accepts identity env, but the shell command-injection seam drops it.
- **Verify first.** Use one injected probe command and the Git runner spy to
  confirm neither can observe env at HEAD.
- **Scope.** Validate at most 256 entries and 1 MiB of cumulative UTF-8 key/value
  bytes without allocating encoded copies; combine those bytes with stdin in
  the one pre-allocation retained reservation; freeze one own-property snapshot;
  add optional readonly env to `CommandContext`; inherit it through pipelines
  and nested invocation; forward it from `createGitCommand()` only when supplied.
  Built-ins and the parser remain env-blind.
- **Acceptance / witness.** An injected command reads the exact snapshot; a
  mutation of the caller object during command execution cannot change it;
  nested invocation inherits it; absence remains `undefined`; exact entry and
  byte boundaries pass and first excesses fail before snapshot allocation or
  command/filesystem work. Env-only and combined stdin+env retained boundaries
  prove `peakRetainedBytes` and cleanup; the Git runner receives the four
  identity values through the same object and successfully commits with them. Run
  `npx vitest run tests/shell/run-inputs.test.ts tests/shell/git.test.ts`.
- **Touch points.** `src/shell/exec/context.ts`, `src/shell/exec/execute.ts`,
  `src/git/shell.ts`, `tests/shell/run-inputs.test.ts`,
  `tests/shell/git.test.ts`.

## Review strategy

| Scope | Risk / rationale | Required gate and review | Escalate when |
|---|---|---|---|
| Sprint integration | Public synchronous API, stream lifetime, retained-memory accounting and Git identity cross three layers. | Independent T3 review-to-clean of the frozen integrated diff; focused shell and Git witnesses must pass before closure. | Any async API, parser grammar, built-in expansion, timeout behavior, new command, or statement-count refusal. |
| WU1 | Input ownership errors can leak a stream, replay bytes, or close data before a selected branch reads it. | Direct boundary witness plus independent T3 review of ownership and every close path; fixes return to the same reviewer. | The run-owned/borrowed model cannot fit existing `ByteStream` cleanup without changing command ownership. |
| WU2 | Additive command context, but it crosses the public injection seam and Git identity precedence. | Direct env/Git witness and T2 independent review; one fix round, then repeat the focused witness. | A built-in needs env expansion, the Git runner contract changes, or the snapshot needs a new architecture seam. |
| Docs/exports | Additive public type and living reference only. | Typecheck, package smoke and link lint; no separate code review after integrated T3 approval. | A root export or package subpath changes. |

## Test cadence

- **Per WU.** Run only the exact witnesses above while iterating.
- **Stable domain slice.** Run `npm run test:shell` once after WU2 and review
  fixes settle; its current budget is about 10 seconds.
- **Routine integration.** Run `npm test`; keep the 148-test smoke gate below
  30 seconds.
- **Sprint closure.** Run `npm run test:full` once under `cpu-lease -n 2` after
  the final independent review is clean. Typecheck, Biome, build and packed
  package smoke remain closure gates.
- **Failure loop.** Reproduce a full-suite failure with its exact file or domain
  slice. Rerun the full suite only after that focused witness is stable.

## Out of scope (explicit)

- Wall-clock timeouts, cancellation and async execution. The shell remains
  synchronous and bounded by operations, retained memory and structural input.
- Parameter expansion, assignments, `env`, `printf`, `exit`, `sleep`, external
  processes, descriptor syntax beyond the current grammar, and new built-ins.
- Path-grant remapping. The consumer's SQLite workspace is host-confined; the
  adapter will reject unsupported grant/source shapes rather than emulate
  mounts in this package.
- The consumer adapter itself. After this sprint ships, the external integration
  gate wires `createShell()` plus `createGitCommand()` and runs the real workflow.
- Removing existing projected SQL barriers. That remains
  [backlog 60](../backlog/60-budget-targets-and-store-split.md).

## Decisions

- One run owns one stdin cursor; selected pipelines borrow it and cannot close
  the underlying source. This matches sequential shell reads without replaying
  bytes or weakening existing stage cleanup.
- Environment is data for injected commands only. Parser expansion would widen
  the language and remains deliberately unsupported.
- Input bounds protect real retained memory. No SQL statement target becomes a
  runtime barrier under invariant 5.
- The sprint is sequential. WU1 and WU2 share `execute.ts` and the new focused
  test file, so splitting them across implementers would violate write
  territories and add merge risk without useful parallelism.

## Sequencing

1. WU1 freezes the public options and run-owned stdin lifetime.
2. WU2 adds the env snapshot and Git forwarding over that stable per-run seam.
3. The focused diff receives independent integration review and fixes until
   clean. Only then run stable/routine/closure gates and return to the consumer.

## Plan review

An independent reviewer checks the proposal against HEAD, including input
ownership, bounds, witness strength, out-of-scope consumer contract clauses and
the proportional review gates.

- **Reviewer:** Peirce (`review_shell_inputs_plan_fast`)
- **Verdict:** approved after retained-memory and close-path corrections
- **Material findings:** The initial plan encoded stdin before its retained
  reservation and did not charge env snapshot bytes, so caller input could
  allocate outside a smaller configured memory ceiling. It also promised exact
  closure without witnesses for syntax error, command failure, early return,
  redirect and Git's explicit close. The corrected contract now parses before
  any input owner exists, measures stdin and env without encoded copies,
  reserves their combined lifetime before allocation, releases in the outermost
  execution `finally`, and adds direct boundary/close-path witnesses. Independent
  re-review approved those corrections before WU1 started.

## Run log

- 2026-08-29 — The existing external adapter passed 74 implemented conformance
  checks against current kompjutr and reported 13 explicit skips. The complete
  shell port is absent because per-run stdin/env cannot cross the package seam;
  backlog 63 is therefore scheduled before the integration gate.
- 2026-08-29 — Peirce blocked the initial plan on incomplete combined
  retained-memory preflight and unobserved close paths. Both findings are
  corrected in the frozen contract and witnesses; implementation remains
  stopped pending re-review.
- 2026-08-29 — Peirce approved the corrected proposal. The combined
  pre-allocation reservation, parse precedence and direct close-path witnesses
  resolve both blockers; WU1 may start.
- 2026-08-29 — WU1 added bounded caller stdin with one run-owned cursor and
  non-owning pipeline borrows. The focused witness passed 34 tests and
  typecheck passed. Tesla's T3 review found one missing exact-close witness;
  the expanded probe now covers every frozen exit path, and re-review approved
  the corrected WU1 with no remaining findings.
- 2026-08-29 — WU2 added the frozen own-property env snapshot, one combined
  stdin/env retained reservation, nested command inheritance and conditional
  Git forwarding. The focused witness passed 27 tests, including a real commit
  with caller-provided author and committer identity. Bacon's T2 review found
  only import ordering; targeted Biome, focused tests and typecheck passed after
  the mechanical fix, and re-review approved WU2 with no remaining findings.
- 2026-08-29 — Popper's integrated T3 review first corrected two public-doc
  claims, then found that a single-chunk owner lost the unread suffix after a
  partial `head` read. The run-owned borrow now restores a validated same-buffer
  suffix in `finally`; direct byte, zero-byte and line witnesses pass, and
  re-review approved the complete sprint with no remaining findings.
- 2026-08-29 — Closure passed the 315-test shell slice, 148-test routine gate,
  all static/package gates and the one final 2,926-test full run. Item 63 is
  consumed; the consumer adapter rerun is now the Phase 1 integration gate.
