# Sprint — shell POSIX surface (2026-08-31)

**Goal.** Add `printf`, `exit`, `1>&2`, and named parameter expansion to
`kompjutr/shell`, each with bash parity evidence.

**Theme.** These four are one theme, not four chores: they are exactly the gap
between our shell and the command lines a hosted agent actually writes. An LLM
holding a Bash tool emits `printf`, redirects a diagnostic with `1>&2`, ends a
script with `exit`, and reads `"$VAR"` — none of which we answer today. The
[roj](https://github.com/contember/roj) SDK's platform conformance suite is the
concrete witness: these four missing features block three shell checks; a fourth
check separately requires timeout semantics.

Expansion is the one that moves a documented boundary
([`reference/shell.md`](../reference/shell.md) "Deliberate boundaries"), so it
carries an ADR. The other three are additions ADR-0002 already anticipates —
"adding syntax or a command requires a bounded execution strategy and parity
evidence where a real binary exists".

Success condition: `printf`, `exit`, `1>&2`, and `$NAME`/`${NAME}` behave as
bash does for the accepted surface, proven differentially, with no regression in
`RunResult.operations` for any existing corpus line.

## Refs re-verified at HEAD (2026-08-31)

`✔` = confirmed live · `⚠` = drift/nuance caught.

- ✔ `echo` is the only text emitter; the registry has no `printf` and no `exit`
  — `src/shell/commands/text.ts:332`, `src/shell/commands/index.ts:19`.
- ✔ `1>&2` is rejected by the planner, and the code already names it as the
  missing mirror of `2>&1` — `src/shell/plan/plan.ts:107`, throw at
  `src/shell/plan/plan.ts:113`.
- ✔ Stream destination is a three-value `StderrMode` (`inherit`/`drop`/`merge`)
  — `src/shell/plan/types.ts:20`, consumed at `src/shell/exec/execute.ts:421`,
  `:463`.
- ✔ Expansion is rejected in four places, all lexical: the `${` prefix in
  `REJECTED` (`src/shell/parse/lexer.ts:38`), bare `$name` in `tokenize`
  (`:75`), and again inside `readWord` (`:201`) and `readDoubleQuoted` (`:229`).
- ⚠ **Expansion cannot live in the lexer.** `createShell` plans before it sees
  the run's env: `planScript(parse(source))` at `src/shell/index.ts:71`, env
  passed to `execute` only at `:96`. So a `$NAME` must survive parse as a word
  part and be expanded in exec — the same shape `Glob` already uses
  (`src/shell/parse/lexer.ts:186`, resolved at `src/shell/exec/execute.ts:636`).
  This is a fit, not a workaround: it keeps `plan/` pure, as
  `src/shell/CLAUDE.md` requires.
- ✔ The env snapshot already reaches exec and is already bounded (256 entries,
  1 MiB, shared with stdin under `maxRetainedBytes`) —
  `src/shell/exec/execute.ts:280`, `:314`; limits table in
  [`reference/shell.md`](../reference/shell.md).
- ⚠ Today that snapshot reaches **injected commands only**
  (`CommandContext.env`, `src/shell/exec/context.ts:277`). Built-ins never read
  it. WU4 is what makes env mean anything to the shell itself.
- ✔ The `&&`/`||`/`;` list is a flat loop over `plan.steps` with a running
  `exitCode` — `src/shell/exec/execute.ts:65`. A run-terminating `exit` breaks
  that loop; there is no other control flow to unwind.
- ✔ A pipeline's status is its last stage's, no `pipefail` —
  `src/shell/exec/execute.ts:222`.
- ✔ The parity harness spawns real binaries and demands the same bytes back,
  controlling `LC_ALL=C` — `tests/helpers/parity.ts:23`. CI installs only
  `ripgrep` (`.github/workflows/ci.yml:32`); `bash` and `printf` are present on
  the runner image, so a bash harness needs no new CI dependency.
- ⚠ The concurrent
  [`everyday Git shell`](sprint-2026-08-31-everyday-git-shell.md) sprint changes
  `Shell.run()/exec()`, command invocation, and stream consumption to async in its
  WU1. This sprint's harness can await the current sync result immediately, but
  WU2-WU5 must target the settled async executor rather than the current loop.

## Work units

### WU1 — bash parity harness (effort S)

- **Problem.** WU2–WU5 all need "what does bash do", and we have no harness for
  it. `tests/helpers/parity.ts` compares one corpus through `grep`/`rg`; nothing
  runs a *source line* through `bash` and through us.
- **Verify first.** `bash --version` on the runner image; confirm `spawnSync`
  with `LC_ALL=C` and a scrubbed env reproduces a known `echo` line byte for
  byte through both sides.
- **Scope.** `tests/helpers/shell-parity.ts`: run one source string in a temp
  directory through `bash --noprofile --norc` and through `createShell` over a
  filesystem seeded with the same tree; await the shell result so the harness is
  valid before and after the async foundation, then compare stdout, stderr, and
  exit code.
  Controlled dimensions, declared in the header the way `parity.ts` declares
  its own: `LC_ALL=C`, a fixed `IFS`, an explicit env allowlist, and cwd.
- **Acceptance / witness.** `npx vitest run tests/shell/parity-bash.test.ts` —
  a starter set over `echo`, `cat`, `2>&1`, and `2>/dev/null` passes, i.e. the
  harness agrees with bash on the surface we already claim to match.
- **Touch points.** `tests/helpers/shell-parity.ts`,
  `tests/shell/parity-bash.test.ts`.

### WU2 — `1>&2` (effort S)

- **Problem.** `src/shell/plan/plan.ts:113` rejects it. `printf err 1>&2` is the
  ordinary way an agent writes a diagnostic, and it is the second half of a
  redirection pair we already half-support.
- **Verify first.** Confirm the stage's stdout bytes can reach the diagnostic
  sink without becoming pipeline bytes — read `src/shell/exec/execute.ts:463`,
  where `discardStderr` and `merge` already re-route one sink into another.
- **Scope.** Widen the stream destination beyond `StderrMode` to name the
  mirror, and retain redirections as an ordered list of descriptor-binding
  operations rather than collapsing them into final stdout/stderr fields. The
  executor resolves that list left to right; a duplicated descriptor captures
  the destination bound at that point. Stdout sent to the diagnostic sink is
  charged to stderr, yields no pipeline bytes, and preserves file
  creation/truncation side effects in ordering-sensitive combinations.
- **Acceptance / witness.** `npx vitest run tests/shell/parity-bash-redirection.test.ts`
  covers `echo out 1>&2`, pipeline output, and the ordered matrix
  `1>&2 2>/dev/null`, `2>/dev/null 1>&2`, `2>&1 1>&2`, `1>&2 2>&1`,
  `>file 1>&2`, and `1>&2 >file`, including file bytes and creation/truncation.
  Plus
  `npx vitest run tests/shell/plan.test.ts` for the planned shape.
- **Touch points.** `src/shell/plan/types.ts`, `src/shell/plan/plan.ts`,
  `src/shell/exec/execute.ts`, `tests/shell/parity-bash-redirection.test.ts`.

### WU3 — `printf` (effort M)

- **Problem.** Not in the registry (`src/shell/commands/index.ts:19`). `echo`
  is the only emitter, and it cannot write without a trailing newline except
  through `-n`, nor format a value.
- **Verify first.** Establish with the harness what bash's `printf` does for the
  cases we intend to accept — especially format recycling (`printf '%s\n' a b c`)
  and a missing operand (`printf '%s %s\n' a`).
- **Scope.** Implement the command in a dedicated `commands/printf.ts`. Admit
  `%s`, `%%`, and `%d` for signed ASCII decimal operands only, plus the escape
  set `\n \t \r \\ \0`; reject other numeric spellings explicitly. Include
  format-string recycling while operands remain, and empty/zero for a missing
  operand. Width, precision, `%b`, `%q`, and `%c` are intentional unsupported
  divergences tested locally, not compared as refusals with Bash. Output goes
  through the existing sink, so stdout and retained-byte ceilings apply.
- **Acceptance / witness.** `npx vitest run tests/shell/parity-bash-printf.test.ts`
  compares admitted forms and truly invalid `%Z` behavior with Bash, while local
  cases pin intentional refusals. It compares `Shell.exec()` bytes so `\0` is
  observable; any diagnostic-prefix normalization is declared in the harness.
- **Touch points.** `src/shell/commands/printf.ts`, the serialized registry seam
  in `src/shell/commands/index.ts`, and
  `tests/shell/parity-bash-printf.test.ts`.

### WU4 — `exit` (effort M)

- **Problem.** Not a command, so `exit 3` is `command not found` (127) rather
  than a status of 3. An agent that ends a script with `exit` gets a lie.
- **Verify first.** Confirm with the harness what bash returns for `exit` with
  no operand, `exit 300`, `exit -1`, and `exit foo`, and confirm that
  the settled async executor still has one list-control loop a termination must
  escape.
- **Scope.** `exit [N]`: no operand uses the current status; `N` is taken mod
  256; a non-numeric operand is a diagnostic and status 2, as bash does. It
  terminates the run — the remaining `&&`/`||`/`;` steps do not run — and the
  run's cwd, stdin cursor, and retained-byte releases settle exactly as they do
  on a normal return. **`exit` is accepted only as a single-stage pipeline**;
  in a multi-stage pipeline it is a usage error. Bash runs it in a subshell
  there and does *not* exit, and we have no subshells — a usage error is honest
  where silent divergence is not.
- **Acceptance / witness.** `npx vitest run tests/shell/parity-bash-exit.test.ts`
  for the operand forms and for `false; exit; echo unreachable`, plus a case
  asserting the multi-stage usage error (declared as a divergence in the
  harness header, since bash accepts it). `tests/shell/run-inputs.test.ts` proves
  run-input close and retained-byte release happen exactly once on every exit
  path; `tests/shell/session.test.ts` shows cwd persists across an exited run.
- **Touch points.** `src/shell/commands/control.ts`, the serialized registry seam
  in `src/shell/commands/index.ts`, `src/shell/exec/context.ts`,
  `src/shell/exec/execute.ts`, `tests/shell/parity-bash-exit.test.ts`, and
  `tests/shell/run-inputs.test.ts`.

### WU5 — named parameter expansion (effort L)

- **Problem.** Four lexical rejections (`src/shell/parse/lexer.ts:38`, `:75`,
  `:201`, `:229`) make `"$HOME"` a syntax error, and the env snapshot a caller
  passes reaches injected commands only. This is the WU that moves a documented
  boundary.
- **Verify first.** Record an exact `operations` baseline for a curated corpus
  with no `$`; it must remain unchanged and must not be rebaselined. Confirm the
  current AST preserves ordered quote kinds while the plan flattens them, and
  record current behavior for `$1`, `$@`, `$?`, `$$`, mixed words, and relative
  glob spelling before changing the representation.
- **Scope.** `$NAME` and `${NAME}` for `[A-Za-z_][A-Za-z0-9_]*`, resolved from
  the run's env snapshot; an unset name expands to empty, as bash does with
  `nounset` off. Carry each argument as ordered literal, parameter, and glob parts
  with quote context through AST and plan; do not flatten mixed words before exec.
  Inside double quotes, expansion stays one field with no splitting or globbing.
  Unquoted expansion splits on default IFS, then pathname-expands each resulting
  field. Fix relative glob projection so both typed and parameter-generated
  relative patterns yield relative argv as Bash does. Parameters in command names
  and redirection targets are explicitly rejected in this sprint; assignment,
  `${...}` operators, `$1`, `$@`, `$?`, and `$$` are explicitly rejected rather
  than retained as accidental literals. Generated fields and matches share the
  existing argv-count and retained-byte bounds.
- **Acceptance / witness.** `npx vitest run tests/shell/parity-bash-expansion.test.ts`
  covers mixed words, multiple parameters, quoted and unquoted empty values,
  default-IFS splitting, escaped dollars, relative glob spelling, generated argv
  bounds, and the explicit command-name/redirection/operator rejections. Plus
  `npx vitest run tests/shell/parse.test.ts tests/shell/plan.test.ts tests/shell/cost.test.ts`;
  the pre-recorded no-parameter operations corpus remains exact.
- **Touch points.** `src/shell/parse/ast.ts`, `src/shell/parse/lexer.ts`,
  `src/shell/plan/types.ts`, `src/shell/plan/plan.ts`,
  `src/shell/exec/execute.ts`, `src/shell/exec/glob.ts`, and
  `tests/shell/parity-bash-expansion.test.ts`.

### WU6 — docs and the decision (effort S)

- **Problem.** [`reference/shell.md`](../reference/shell.md) states the opposite
  of what ships: line 49 says built-ins do not expand env, line 168 lists
  variables and parameter expansion under "Deliberate boundaries".
- **Verify first.** `grep -rn "expansion" docs/` — catch every place the old
  boundary is asserted before editing one of them.
- **Scope.** Update the supported-command table, the execution-model paragraph
  on env, the limits table if WU5 adds one, and the boundaries list. Write
  `decisions/0021-admit-a-bounded-posix-shell-surface.md`: why the finite
  surface grew, what stayed rejected and why, and that parity against bash is
  the standing gate for anything admitted next. Link it from ADR-0002.
- **Acceptance / witness.** `npm run check`; every claim in the edited sections
  is traceable to the baseline harness or the redirection, printf, exit, and
  expansion parity files, including each declared intentional divergence.
- **Touch points.** `docs/reference/shell.md`,
  `docs/decisions/0021-*.md`, `docs/decisions/0002-*.md`, `docs/INDEX.md`,
  `docs/decisions/README.md`, `src/shell/CLAUDE.md`.

## Review strategy

| Scope | Risk / rationale | Required gate and review | Escalate when |
|---|---|---|---|
| Sprint integration | Four changes converge on one executor; the cost model is the thing that can silently regress | `npm run test:full` at closure plus `tests/shell/cost.test.ts`; no blanket integration peer review after the critical WUs are clean. | Any `operations` number moves on a line without `$`, `printf`, or `exit` |
| WU1 | Test-only; wrong here means every later witness is worthless | Its own witness plus independent review of controlled dimensions; repeat only for blocking findings. | Any dimension is controlled rather than compared without a header note |
| WU2 | Ordered descriptor binding over existing bounded destinations | Direct witness only | It changes generic sink accounting rather than selecting the established stdout/stderr/file budgets. |
| WU3 | Self-contained command, no filesystem access | Direct witness only | `printf` needs anything from `BoundedFs` |
| WU4 | Control flow stays inside the executor's reviewed cleanup boundary | Direct parity and exactly-once cleanup witnesses; no peer review. | A release or cursor close moves out of the existing `finally` path, which escalates to review. |
| WU5 | Fundamental: new word part through parse → plan → exec, and it moves a documented boundary | Independent review to clean: fixes get another review. Witness plus `cost.test.ts` unchanged. | Splitting or globbing semantics diverge from bash anywhere the harness does not declare |
| WU6 | Docs and an ADR describe already witnessed behavior | `npm run check` and traceability to parity cases; no peer review. | The ADR introduces a new constraint not reviewed with WU5. |

## Test cadence

- **Per WU.** The exact witness named above. Add `npm run test:shell` when the
  change lands in `src/shell/exec/`.
- **Routine integration.** `npm test`, kept under 30 s.
- **Sprint closure.** Run `npm run typecheck`, `npm run check`, `npm run build`,
  and `npm run package:smoke`, then once
  `GIT_EDITOR=true GIT_SEQUENCE_EDITOR=true cpu-lease run -n 4 -- npm run test:full`
  after review and focused fixes have settled.
- **Failure loop.** Reproduce with the exact file or `npm run test:shell` before
  rerunning the full suite.

## Out of scope (explicit)

- **Timeouts, and therefore the last conformance check.** roj's shell contract
  has `timeoutMs` and a `timedOut` result; an async execution model does not by
  itself define wall-clock cancellation, and runs remain bounded by
  `maxOperations` and `maxRetainedBytes`. This sprint closes three of
  the four gaps — the fourth needs a decision on roj's side (a timeout sub-port
  a host may decline, the way `shell.paths` and `shell.host` already work), not
  code here. **After this sprint the adapter can be built, but it cannot be
  advertised as conformant until timeout lands or that contract changes.**
- Per-run `cwd`. The session already carries one and the roj adapter can bridge
  it; nothing to change here.
- Variable *assignment* (`FOO=bar cmd`), `${...}` operators, `$?`, `$@`,
  positional parameters, `export`, `set`. Rejected today and still rejected.
- `sleep`, and any command whose meaning is elapsed time.
- Widening the strict Git argv subset (no `init`, `checkout`, `branch`) — a
  separate theme with a separate cost model.

## Decisions

1. **Expansion is an exec-time concern, not a lexical one.** The lexer emits a
   `Param` word part; exec resolves it against the env snapshot. Forced by
   `src/shell/index.ts:71` planning before env is known, and it preserves the
   pure `plan/` rule in `src/shell/CLAUDE.md`.
2. **Full bash field semantics for expansion**, including splitting and
   pathname expansion of unquoted fields. A half-measure — expanding but not
   splitting — would need a permanently declared divergence in the parity
   harness, which is worse than the surface it saves. `expandGlob` already runs
   at exec, so the machinery exists.
3. **`exit` is single-stage only.** Bash runs it in a subshell inside a pipeline
   and does not exit; we have no subshells, so we reject rather than diverge
   silently.
4. **Bash parity is the standing gate for anything admitted to the surface
   next.** → ADR-0021 (WU6).

## Sequencing

| Order | Unit | Parallel with |
|---|---|---|
| 1 | WU1 (harness) | Everyday Git shell WU1; it writes only new test files and awaits sync or async results |
| 2 | Wait for everyday Git shell WU1 | WU2-WU5 target its reviewed async executor contract |
| 3 | WU2 and WU3 | Each other and everyday Git shell WU2-WU8; WU3 owns dedicated command/test files and the registry edit is serialized |
| 4 | WU4 | Starts after WU2 because both change `execute.ts`; it may overlap everyday Git WU2-WU8 |
| 5 | WU5 | Everyday Git WU2-WU8; coordinate shared shell tests and reference docs |
| 6 | WU6 | — describes what actually shipped |

WU5 last deliberately: it is the only unit that touches parse, plan, and exec at
once, and reviewing it against a moving executor would waste the review.

## Cross-sprint boundary

This sprint owns `printf`, `exit`, `1>&2`, parameter expansion, their bash parity
harness, and ADR-0021. The everyday Git shell sprint owns the async executor and
Git argv surface. The shared executor is changed once, by its WU1; this sprint
builds on that contract rather than carrying a second async conversion. Feature
parity cases live in separate files, and edits to `commands/index.ts`, shared
shell tests, and shell reference docs are serialized by the sprint leader.

## Plan review

- **Reviewer:** independent general agent (`ses_fa737998effehXcj6nThGBVqAh`)
- **Verdict:** approved
- **Material findings:** The initial review blocked on planned-word structure,
  ordered descriptor semantics, printf divergence witnesses, overlapping write
  territories, and incomplete closure gates. The plan now defines and witnesses
  each seam, serializes executor edits, and requires peer review only for WU1 and
  WU5; final re-review found no blocker.

## Run log

<!-- Append as you work. -->
