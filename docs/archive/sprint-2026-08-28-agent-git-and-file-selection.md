> **OUTCOME — shipped 2026-08-29.** Native and Computer clients now share one
> strict synchronous local Git argv runner, `kompjutr/git/shell` exposes it as
> an injectable shell command, and `lsFiles()` can merge tracked and
> non-ignored untracked paths in Git byte order. Commit map: plan and contract →
> `737e042`, `c532445`, `a4fc714`, `b829b5d`, `316d489`; WU1 → `2376745`; WU2 →
> `b2d0786`, `906edfe`; WU3 → `361fa0f`; WU4 → `5a907cb`; WU5 → `b12ef8d`;
> WU6 → `7f4ee68`; WU7 → `b763c38`, `d2b1263`; integrated correctness fixes →
> `f7d57a1`, `3ddafd2`, `0bff9cb`, `28a7463`, `9509d38`, `d0b2332`,
> `3e36283`; stable full-suite workers → `646ad67`; closure → this archived
> record. Verification: the routine gate passed 148/148 in 5.62 s; the focused
> integration gate passed 280/280 in 29.92 s; the complete sliced runner passed
> 2,910 tests with five known skips and zero failures. Typecheck, Biome, build,
> packed-package smoke, and diff validation passed. Independent T3 integration
> review closed every correctness finding after fixes. Its remaining Computer
> traversal result — 10,019 statements for a 1,001-file plain diff — is a
> benchmark target miss under invariant 5, not a runtime refusal: no projected
> statement `E2BIG` was added, existing barriers were left unchanged, and their
> removal remains [backlog 60](../backlog/60-budget-targets-and-store-split.md).
> Deferred: wiring one real consumer adapter is the external Phase 1 integration
> gate; commands outside the frozen allowlist and mutating glob pathspecs remain
> separately filed.

# Sprint — Agent Git and file selection (2026-08-28)

**Goal.** Let an agent run the required local Git subset inside the synchronous
shell and let the builder select tracked plus non-ignored untracked files with
one bounded native call.

**Theme.** These are the final two package-side Phase 1 gaps. Both expose
existing bounded Git operations through the shape a real consumer issues: argv
inside the shell and combined `ls-files` selection. The sprint ends when the
native CLI, Computer CLI, and injected shell command agree byte-for-byte, and
the builder's complete selection call matches Git.

## Refs re-verified at HEAD (2026-08-28)

Planning is grounded at `93dbeab`; `✔` = confirmed live · `⚠` = drift or nuance
caught before implementation.

- ✔ Shell commands are synchronous generators. `Command` returns a
  `CommandResult`; the executor cannot await an async Git facade —
  `src/shell/exec/context.ts:268-324`.
- ✔ `ShellOptions.commands` is the intended injection seam and the shell layer
  does not import Git — `src/shell/index.ts:17-28`, `src/shell/index.ts:52-60`.
- ✔ Native `Git.cli()` and the Computer adapter still throw
  `EUNSUPPORTED`, while the RPC contract already declares
  `{ argv, cwd?, env?, stdin? } -> { stdout, stderr, exitCode }` —
  `src/git/client.ts:366-369`, `src/git/client.ts:757-768`,
  `src/compat/computer/client.ts:323-334`, `src/runtime/types.ts:47-57`.
- ✔ The needed local operations are synchronous below the facade: status
  formatting, diff, log, add, commit, and rebase continuation/abort already have
  bounded core entry points — `src/core/ops/status-format.ts:137-176`,
  `src/core/ops/diff.ts:67-140`, `src/core/ops/reads.ts:58-81`,
  `src/core/ops/staging.ts:126-216`, `src/core/ops/commit.ts:92-134`,
  `src/core/ops/rebase.ts:27-46`.
- ⚠ `log()` can bound a walk by count but cannot express an ancestor stop;
  `rev-list --count` can reuse the existing bounded divergence graph instead of
  adding general revision enumeration — `src/core/ops/reads.ts:58-81`,
  `src/core/ops/merge-base.ts:301-344`.
- ✔ `lsFiles()` now compiles bounded default glob pathspecs and scans tracked
  index rows only; `{ ref }` traverses one authenticated tree. Neither path has
  a worktree or ignore matcher — `src/core/ops/staging.ts:1671-1688`,
  `src/core/ops/reads.ts:157-169`, `src/core/ops/pathspec.ts:26-44`.
- ✔ The worktree layer already exposes paged path-order traversal and the ignore
  layer already loads the bounded repository `.gitignore` hierarchy; status composes both for
  untracked discovery, but `lsFiles()` has no corresponding merge —
  `src/core/ops/worktree-io.ts:280-390`, `src/core/ops/status.ts:368-470`,
  `src/core/ignore/index.ts:175-181`.
- ✔ The package has no Git-shell export. Public subpaths stop at `./git` and
  `./shell` — `package.json:12-36`.
- ✔ Git 2.54.0 is installed for differential witnesses.

## Contract frozen before implementation

WU0 records exact Git 2.54.0 results for this allowlist. No handler accepts a
prefix of a command and ignores the rest.

| Command | Accepted forms in this sprint | Deliberate rejection |
|---|---|---|
| `status` | `--porcelain`, `--porcelain=v1`, `--short`, `-s` | branch headers, ignored mode, path operands, v2 and unknown flags |
| `diff` | no operands or options | staged/ref/path modes remain on typed APIs or backlog 35 |
| `log` | At most one of `-1`, `-n <count>`, `--max-count=<count>`; at most one of `--oneline`, `--format=<template>`; then at most one `<ref>` or proven-linear `<a>..<b>` | path, graph, all-ref, merge-history ranges and general exclusion walks |
| `rev-list` | `--count <a>..<b>` | output enumeration, symmetric ranges and other flags |
| `symbolic-ref` | `--short <ref>` | writes and general formatting |
| `add` | one or more path operands; optional `--` ends option parsing | every option, glob pathspecs and index-file forms |
| `commit` | exactly one `-m <message>`/`--message=<message>` | editor, amend, signing, hooks and file input |
| `rebase` | `--continue` or `--abort` | starting or extending a rebase through argv |

Unknown subcommands and every network subcommand fail without fallback. There
is no universal usage code or diagnostic stream: each accepted or rejected form
uses the exact command-specific `{ stdout, stderr, exitCode }` triplet pinned by
WU0. In Git 2.54.0 an unknown subcommand exits 1, an unknown `status` option
exits 129 with usage, an unknown `log` option or nonnumeric log count exits 128
with one fatal line, and a refused `push` exits 128 with multiline guidance.
Expected Git-domain errors become those exact bounded bytes on either stream;
unexpected programming errors remain exceptions.
The common input has `cwd` only: it replaces native `dir`, defaults to `/`, and
selects the nearest checkout. A runtime `dir` field is rejected. Path operands
are resolved from `cwd` and may not escape the checkout. No accepted command
reads stdin; a present string is byte-bounded and ignored like Git 2.54.0.

`log` without a format uses Git's default medium record. `--format=` accepts
arbitrary bounded literal UTF-8 plus `%H`, `%h`, `%P`, `%s`, `%B`, `%an`, `%ae`,
`%at`, `%cn`, `%ce`, `%ct`, `%n`, and `%%`; every other `%` placeholder fails at
parse time. Duplicate count/format selectors and options after the revision are
usage errors. A range is accepted only when walking from the right tip reaches
the left oid through commits with exactly one parent before the exclusive stop;
merge, divergent, unrelated and shallow-boundary ranges fail closed. This
restricted result is identical to Git for the admitted linear graph and does
not claim general exclusion semantics.

Count values for `-n` and `--max-count=` are ASCII decimal digits only, with no
sign or whitespace, and must be a safe integer from 0 through 50,000. `-1` is
the sole shorthand. A leading zero is accepted. Every duplicate count selector
is rejected even when both values are equal.

The dispatcher reads only `GIT_AUTHOR_NAME`, `GIT_AUTHOR_EMAIL`,
`GIT_COMMITTER_NAME`, and `GIT_COMMITTER_EMAIL`. Author env identity exists only
when both author fields exist. Committer env fields fall back individually to
their corresponding author fields; the combined result exists only when both
are then present. Complete environment identities win over repository
`user.name`/`user.email`, then the binding default, exactly as
`resolveIdentity()` does. Other bounded environment entries are ignored.
This complete-source policy deliberately differs from Git 2.54.0, which fills a
partial environment identity field-by-field from config. The CLI preserves the
existing native identity contract; the differential witness records the
divergence instead of silently changing every typed commit operation.

Native `Git` implements the public narrow capability
`GitCliRunner.runCli(input, options?): GitCliResult`; `Git.cli(input)` is its
promise-returning wrapper. `createGitCommand(runner: GitCliRunner): Command` is
exported from `kompjutr/git/shell`, so registration is exactly
`new Map([["git", createGitCommand(workspace.git)]])`. The Computer adapter
constructs the same runner internally but does not add it to Computer's public
interface.

The optional, runtime-validated public `GitCliRunOptions` is exactly:
`maxStdoutBytes`, `maxStderrBytes`, and `maxCombinedOutputBytes` as safe integer
byte ceilings from 0 through their intrinsic maxima; `discardStderr` as a
boolean; and `logLimitHint` as a safe integer from 0 through 50,000. Intrinsic
defaults are 16 MiB stdout, 1 MiB stderr, and 16 MiB combined. The combined
ceiling is charged across both streams before either is returned. A discarded
stderr is neither retained nor charged, while the exit code is unchanged. A
log hint only tightens an absent or larger argv count; it never changes other
commands. `Git.cli()` uses the intrinsic defaults. `createGitCommand()` supplies
destination-derived ceilings, discard policy, and the shell demand hint.

Resolved run options are also passed to command handlers. A mutating handler
must run the native operation, format its success result, and apply the output
preflight inside one outer database transaction. Any exception escapes that
transaction before expected Git-domain errors are mapped; storage caches are
then revalidated after rollback. Only native-operation errors may enter domain
mapping; formatting and preflight errors are rethrown unchanged. A command that
mutates the worktree first proves `context.worktree.db === repo.store.db` and
fails closed without transaction affinity. The dispatcher repeats the output
check as defense in depth. This preserves the public runner signature while
making destination-specific `E2BIG` failures atomic. →
[ADR 0016](../decisions/0016-preflight-mutating-cli-output-inside-the-transaction.md)

## Work units

### WU0 — Pin argv, cwd, formatting, and exit contracts (effort S)

- **Problem.** The backlog names commands but not every accepted spelling,
  subdirectory behavior, empty-repository result, or exit code.
- **Verify first.** Probe Git 2.54.0 in one unborn repository, one ordinary
  history, and one conflicted rebase. Capture stdout, stderr, and status for
  every row in the matrix, including unknown options and refused `push`.
- **Scope.** Correct the frozen matrix from evidence. Add ADR 0015 for the
  one-way dependency and narrow synchronous runner capability: Git may depend
  on shell command types; shell never imports Git; async `Git.cli()` and the
  shell bridge call one synchronous dispatcher. Freeze the full grammar above,
  Git default-log format, literal-format rules, duplicate policy, recognized env
  keys and native source precedence, per-command output/error triplets, `cwd`-only
  contract, numeric grammar, and public `GitCliRunner`, `GitCliRunOptions`, and
  `createGitCommand` signatures.
- **Acceptance / witness.** The matrix is complete enough that each accepted
  and rejected form maps to one later test. ADR 0015 is accepted and indexed.
  Any WU0 correction to the command set, runner architecture or output framing
  returns the complete sprint plan for another independent review.
- **Touch points.** This sprint, `docs/decisions/0015-*.md`,
  `docs/decisions/README.md`.

#### WU0 pinned Git 2.54.0 witness

The probe used `LC_ALL=C`, empty global and system config files, fixed identity
and timestamps, and `GIT_EDITOR=true`. `∅` below means an empty byte stream. Full
usage blocks and fixture-dependent OIDs/paths map to byte-exact table cases in
the later differential files; this table pins their stream and status class.

| Family | Successful triplet | Command/domain refusal triplets |
|---|---|---|
| `status` | All four aliases: porcelain-v1 bytes on stdout, `∅` stderr, 0. Clean and unborn repositories return `∅`, `∅`, 0. Nested `cwd` keeps repository-root-relative porcelain paths. | Unknown option: `∅`, `error:` plus status usage, 129. Plain status, branch/ignored/v2 modes, paths, duplicates and extra argv are strict-parser no-op cases. |
| `diff` | Worktree patch on stdout, `∅`, 0; clean diff is `∅`, `∅`, 0. Root and nested `cwd` produce the same root-relative patch. | Unknown option: `∅`, `error:` plus diff usage, 129. `--`, staged/ref/path modes and extra argv are strict-parser no-op cases. |
| `log` | Default medium, oneline, admitted literal format, ref and linear-range bytes on stdout, `∅`, 0. Count zero and an empty format return `∅`, `∅`, 0. | Unknown option and nonnumeric count: `∅`, one `fatal:` line, 128. Unborn HEAD: `∅`, one `fatal:` line, 128. Missing ref: `∅`, three fatal/hint lines, 128. Merge, divergent, unrelated and shallow-boundary ranges fail closed before output. |
| `rev-list` | `--count a..b`: decimal plus newline on stdout, `∅`, 0 for linear, divergent and merge graphs. | Missing range or unknown option: `∅`, rev-list usage, 129. Enumeration, symmetric ranges and extra argv are strict-parser no-op cases. |
| `symbolic-ref` | `--short HEAD`: short name plus newline, `∅`, 0, including unborn HEAD and the nearest nested checkout. | Detached or missing ref: `∅`, one `fatal: ref … is not a symbolic ref` line, 128. Unknown option: `∅`, error plus usage, 129. Writes and extra formatting are strict-parser no-op cases. |
| `add` | One or more root-, cwd-, or directory-relative paths: `∅`, `∅`, 0; `--` only changes option parsing. | Missing path: `∅`, one `fatal: pathspec … did not match any files` line, 128. Checkout escape: `∅`, one `fatal: … is outside repository` line, 128. Unknown option: `∅`, error plus usage, 129. No path, glob and every option are strict-parser no-op cases. |
| `commit` | A nonempty `-m` or `--message=` commit writes Git's bracketed commit summary to stdout, `∅`, 0. | Empty cleaned message: `∅`, `Aborting commit due to empty commit message.` plus newline, 1. Clean index: two status lines on stdout, `∅`, 1. Unmerged index: stage rows on stdout, then error/hints/fatal on stderr, 128. Unknown option or missing `-m` value: `∅`, error/usage, 129. Other message spellings, duplicates and extra argv are strict-parser no-op cases. |
| `rebase` | Resolved `--continue`: commit summary on stdout, success line on stderr, 0. Conflicted `--abort`: `∅`, `∅`, 0 and restores HEAD/index/worktree. | Unresolved `--continue`: three guidance lines on stdout, `∅`, 1. Either action without a rebase: `∅`, `fatal: no rebase in progress` plus newline, 128. Unknown option: `∅`, error plus usage, 129. Starts, skip and extra argv are strict-parser no-op cases. |
| dispatcher | — | Unknown subcommand: `∅`, `git: '<name>' is not a git command. See 'git --help'.` plus newline, 1. Refused `push`: `∅`, Git's eight-line no-destination guidance, 128. Every network command is rejected before transport. Missing/outside checkout: `∅`, one `fatal: not a git repository …` line, 128. |

Default medium log records are `commit <full oid>`, an optional `Merge:` line
with seven-hex parent IDs, `Author:`, `Date:   `, one blank line, and every
message line indented by four spaces; records are separated by one blank line.
The admitted custom placeholders match Git byte-for-byte. `%B` retains its own
trailing newline before the record terminator and `%n` inserts one literal
newline. A leading-zero count is accepted. Joined `-n1`, shorthands other than
`-1`, signed/whitespace counts, values above 50,000, duplicate count/format
selectors, options after a revision, and unsupported or dangling `%` sequences
are parser refusals even where Git accepts them.

`strace -f -e read` recorded zero `read(0, …)` calls for a representative of
every accepted family, including `commit -m` and both rebase actions. Git fills
partial env identities field-by-field from repository config; native CLI keeps
the existing complete-source `resolveIdentity()` precedence recorded in
[ADR 0015](../decisions/0015-route-git-argv-through-one-synchronous-runner.md).

### WU1 — Complete bounded builder file selection (effort M)

- **Problem.** `lsFiles({ paths })` sees tracked index/ref paths only and cannot
  express `--cached --others --exclude-standard`.
- **Verify first.** Compare Git for default cached selection, explicit
  `--others`, combined cached/others, with and without `--exclude-standard`, and
  the builder glob from the repository root.
- **Scope.** Add native `cached`, `others`, and `excludeStandard` selection.
  Omitted selection retains cached-only behavior. Explicit `others` alone omits
  cached paths; `excludeStandard` requires `others`; `{ ref }` rejects worktree
  modes. Merge paged index and file/symlink worktree sources in Git byte order,
  remove every index stage from the untracked side, prune standard-ignored
  paths, deduplicate to the native API's existing unique-path contract, then
  apply the existing read pathspec and shared result bounds. Pass
  `nestedRoots(context, repo.root)` into the walk and prune every nested
  checkout subtree. `excludeStandard` means the repository `.gitignore`
  hierarchy available in this filesystem runtime; there is no `.git/info/exclude`
  file or global excludes file, and docs record that deliberate difference.
  For any mode including `others`, cap pathspecs at 64 and merged source rows at
  100,000: at most 391 index pages plus 128 indexed prefix probes, 101 worktree
  pages, 16 ignore discovery/read statements, and 64 fixed/helper statements
  total at most 700 SQL statements. The 101st worktree query is the bounded
  terminal/first-excess probe after exactly 100 full 1,000-row pages. Cached-only selection retains its current
  independently proven 903-statement maximum. Account matcher work and retained
  output before publication.
- **Acceptance / witness.** Differential cases cover tracked, untracked,
  ignored, nested checkout, conflict-stage, symlink, empty, literal-prefix and
  glob selection. A differential conflict witness records the intentional
  divergences: typed `lsFiles()` returns one path while Git's CLI emits one row
  per stage, and native selection prunes a foreign nested checkout root that Git
  2.54.0 reports as an ordinary `nested/` entry. Direct limit witnesses prove
  exact-bound success, the 700-statement combined ceiling, and first-excess
  `E2BIG` with no truncation. Run
  `npx vitest run tests/pathspec.test.ts -t "ls-files selection|builder"`.
- **Touch points.** `src/core/ops/pathspec.ts`, `src/core/ops/staging.ts`,
  `src/core/ops/worktree-io.ts`, `src/core/ignore/`, `src/git/client.ts`,
  `tests/pathspec.test.ts`, `tests/client.test.ts`.

### WU2 — Build the bounded synchronous CLI kernel (effort M)

- **Problem.** There is no shared validator, parser, result shape, error mapper,
  output preflight, or synchronous runner capability for the two public adapters
  and shell bridge.
- **Verify first.** Assert the current native and compat `cli()` witnesses return
  `EUNSUPPORTED`; assert no existing shell command can await a promise.
- **Scope.** Introduce `GitCliInput`, `GitCliResult`, fixed limits, a strict argv
  parser, cwd-to-repository invocation context, Git-shaped result helpers, and a
  public narrow synchronous `GitCliRunner.runCli()`. Define and runtime-validate
  `GitCliRunOptions` exactly as frozen above. Bound argv count/bytes, env
  count/bytes,
  stdin bytes, commit-message bytes, formatted records, and combined stdout/
  stderr bytes before returning. The native async method and shell adapter will
  receive the same runner, not reparse argv. Pass the resolved run options to
  handlers so mutations can preflight their formatted result before commit; the
  public runner signature does not change.
- **Acceptance / witness.** Table tests prove exact bounds, invalid runtime
  types, duplicate/mutually exclusive flags, missing values, unsupported
  subcommands/options, network refusal, cwd outside a checkout, and stable
  output/error framing. Run
  `npx vitest run tests/git-cli.test.ts -t "argv|bounds|unsupported|cwd"`.
- **Touch points.** `src/git/cli/types.ts`, `src/git/cli/parse.ts`,
  `src/git/cli/result.ts`, `src/git/cli/index.ts`, `tests/git-cli.test.ts`.

### WU3 — Add read-only agent commands (effort M)

- **Problem.** Status, diff, history and ref reads exist only as typed results;
  an agent needs their standard text in pipelines.
- **Verify first.** Run WU0's read-only matrix against Git and the same fixture
  state. Confirm the accepted log range is ancestor-bounded.
- **Scope.** Implement status v1/short through existing formatters, plain diff,
  bounded log formatting/count/range, `rev-list --count` through divergence,
  and read-only `symbolic-ref --short`. Use shell `limitHint` only as a tighter
  log count when the argv did not request a smaller count. Add an explicit
  bounded linear-range read that proves every traversed commit before the stop
  has exactly one parent and rejects any other graph; do not add an ancestor
  stop to the existing general walk or claim general revision enumeration.
- **Acceptance / witness.** Differential tests compare exact stdout, stderr,
  and exit status for clean/dirty/unborn/detached histories, non-ASCII paths and
  identities, root and nested cwd, empty results, default/accepted formats,
  merge/divergent/shallow range refusal, and first-excess output. Run
  `npx vitest run tests/git-cli-parity.test.ts -t "status|diff|log|rev-list|symbolic-ref"`.
- **Touch points.** `src/git/cli/read.ts`, `src/core/ops/reads.ts`,
  `tests/git-cli-parity.test.ts`, `tests/reads.test.ts`.

### WU4 — Add mutating agent commands and recovery (effort M)

- **Problem.** The agent cannot stage a resolution, commit local work, or
  continue/abort an existing rebase through the synchronous command surface.
- **Verify first.** Replay the same conflict through Git and the native rebase
  lifecycle; pin status and state after both success and refusal.
- **Scope.** Implement bounded add, one-message commit with env identity, and
  rebase continue/abort through existing transactional operations. Preserve
  nested-checkout exclusion, operation ownership, conflict stages, reflog
  causality, and rollback. Use the ADR 0016 wrapper so mutation, formatting, and
  output preflight share one outer transaction; map expected errors only after
  rollback and cache revalidation, and only when they came from the native-op
  phase. Prove worktree/database transaction affinity before continue or abort.
  Do not add a second mutation implementation.
- **Acceptance / witness.** Differential tests cover ordinary add/commit, env
  identity and its deliberate partial-env divergence, empty/missing message,
  missing path, unmerged refusal, conflicted rebase resolution via `add` plus
  `rebase --continue`, abort after reopen, and unchanged public state after every
  rejected argv or stdout/stderr/combined output overflow. Rebase witnesses
  compare the exact Git stream split: unresolved guidance is stdout-only, while
  successful continuation emits the commit summary on stdout and progress/success
  on stderr. Overflow remains a thrown `E2BIG`, not an exit triplet. Direct
  rollback witnesses cover the native and Computer worktrees; after reopen they
  prove the worktree, index, refs, reflog, operation journal, loose objects, and
  derived/object caches match the pre-call state and no orphan object is
  readable. With `discardStderr: true`, oversized stderr alone does not roll back
  a mutation because it is neither validated nor charged; stdout or combined
  first-excess still rolls back. Run
  `npx vitest run tests/git-cli-parity.test.ts -t "add|commit|rebase"` and the
  matching focused E2E rebase case.
- **Touch points.** `src/git/cli/write.ts`, `tests/git-cli-parity.test.ts`,
  `tests/e2e/rebase.test.ts`, `tests/e2e/recovery.test.ts`.

### WU5 — Wire native and Computer argv facades (effort S)

- **Problem.** Both public clients still expose throwing stubs and could drift
  if each constructs its own command semantics.
- **Verify first.** Run the existing client unsupported-method witness and pin
  the installed Computer input/result type.
- **Scope.** Bind one synchronous runner per client context. Native `Git.cli()`
  wraps public `GitCliRunner.runCli()` and Computer `cli()` wraps its private
  runner through their declared promises. Native CLI accepts `GitCliInput` with
  `cwd` and no longer exposes the development-only `dir` spelling. Do not
  broaden the Computer typed operation surface.
- **Acceptance / witness.** Native and compat clients return byte-identical
  results for every smoke command and error, use the selected checkout and env,
  and preserve unexpected exceptions. Run
  `npx vitest run tests/client.test.ts tests/compat.test.ts -t "argv CLI"`.
- **Touch points.** `src/git/client.ts`, `src/compat/computer/client.ts`,
  `src/runtime/types.ts`, `tests/client.test.ts`, `tests/compat.test.ts`.

### WU6 — Bridge the runner into synchronous shell pipelines (effort M)

- **Problem.** A consumer still cannot register the async facade as a shell
  `Command`, and the command cannot see the shell's output ceiling.
- **Verify first.** Walk an injected command through pipeline, `&&`/`||`,
  `2>&1`, and redirect behavior before changing the seam.
- **Scope.** Add `kompjutr/git/shell` with a one-line command factory over the
  public `GitCliRunner`. Pass shell cwd, argv and demand hint to the same
  dispatcher; stream its stdout as bytes, write its stderr through a new raw-byte
  diagnostic seam, and return its status. Raw diagnostics honor `2>&1` and
  `2>/dev/null` without adding a prefix, newline or decoding. Keep `warn()`
  unchanged for existing commands. Expose the planned stdout destination and
  byte ceiling needed for preflight: direct terminal output uses the remaining
  public sink budget, redirects use the atomic redirect budget, and an upstream
  pipeline uses the intrinsic Git CLI output cap plus any demand hint. Direct
  stderr uses its remaining sink budget; merged stderr shares the stage output
  budget; dropped stderr retains nothing. Keep all filesystem access out of the
  adapter and keep `src/shell/` free of Git imports. `RunResult.operations`
  continues to exclude Git's separately bounded SQL work.
- **Acceptance / witness.** Shell tests cover `git status --porcelain | wc -l`,
  `git log --oneline | head -3`, `git diff > out.patch`, `&&`/`||`, exact
  multiline stderr, merged and dropped diagnostics, a refused `git push`, and
  atomic overflow in terminal/pipeline/redirect modes with no partial semantic
  result. The public witness registers `createGitCommand(workspace.git)` in one
  line. Run
  `npx vitest run tests/shell/git.test.ts tests/shell/bounds.test.ts`.
- **Touch points.** `src/git/shell.ts`, `src/shell/exec/context.ts`,
  `src/shell/exec/execute.ts`, `package.json`, `tests/shell/git.test.ts`,
  `tests/shell/bounds.test.ts`, `tests/package-smoke.test.ts` or the package
  smoke script.

### WU7 — Integrate public exports, smoke coverage, and current docs (effort S)

- **Problem.** The new capability crosses native Git, compat, shell and package
  exports; partial wiring would look complete from only one entry point.
- **Verify first.** Import every public type/value from source and the packed
  package before editing indexes.
- **Scope.** Add a small deterministic CLI/shell slice to `npm test`, keep the
  exhaustive real-Git matrix full-suite-only, update package examples and the
  Git/shell support maps, and rescope/delete backlog 61 and the Phase 1 part of
  backlog 36 only after witnesses pass.
- **Acceptance / witness.** Source and packed-package exports resolve, the smoke
  gate stays below 30 seconds (target below 15 seconds), and docs state the exact
  allowlist, bounds, SQL accounting, and deferrals. Run `npm test`,
  `npm run package:smoke`, and `git diff --check`.
- **Touch points.** `src/git/index.ts`, `src/index.ts`, `package.json`,
  `scripts/package-smoke.mjs`, `tests/public-exports.test.ts`,
  `tests/git-cli-smoke.test.ts`, `docs/reference/git-support.md`,
  `docs/reference/shell.md`, `README.md`, `docs/backlog/36-glob-pathspecs.md`,
  `docs/backlog/61-git-shell-command-and-argv-entry.md`, `docs/backlog/README.md`.

## Review strategy

The label summarizes the gate; the concrete witness and escalation rule bind it.

| Scope | Risk / rationale | Required gate and review | Escalate when |
|---|---|---|---|
| Sprint integration (T3) | One synchronous dispatcher crosses core operations, two async facades, shell streaming, exports and file selection. | After all WUs, one independent reviewer checks the frozen integrated diff for exact allowlist/error parity, bounds, transaction ownership, layering and honest deferrals. Run the routine gate and focused cross-layer suite. Any fix to a public contract, mutation, traversal bound or shell execution seam returns to review until clean. | A network command, new schema, general rev-list, mutating glob, async shell, or consumer-side code becomes necessary. |
| WU0 (T1) | Evidence and one ADR; no runtime change. | Direct Git 2.54.0 probe and complete per-command stdout/stderr/status matrix are sufficient. The mandatory independent plan review checks the ADR direction and scope. | Probe evidence changes the command set, runner architecture, output framing or requires a new core capability. |
| WU1 (T3) | Untrusted globs combine an index cursor, worktree traversal and ignore evaluation. | Differential plus exact cost/bound witnesses and independent review-to-clean of ordering, unique-path divergence, nested-root/ignore pruning, 700-statement combined allocation, memory budgets and ref-mode rejection. Every traversal or bound fix is re-reviewed. | A schema/index change, materialized whole-tree snapshot, mutating pathspec, additional exclude source, or >700-statement combined path is needed. |
| WU2 (T3) | The parser and mapper define the security boundary for untrusted argv and outputs. | Exact parser/bounds table plus independent review-to-clean. Every accepted-language, runtime-validation, exception-mapping or limit change is re-reviewed. | Shell grammar changes, subprocess fallback, or dynamic command registration enters scope. |
| WU3 (T2) | Read-only formatting over existing bounded ops; one separate linear-chain reader is new. | Differential file plus one independent review of single-parent range proof, formats, cwd and output accounting. One fix pass; re-review only if the admitted graph or bounds change. | Merge history, general exclusion ordering, path-filtered history, staged diff or a two-sided graph walk is needed; promote to T3 before proceeding. |
| WU4 (T3) | Add/commit/rebase continuation mutate index, worktree, refs and durable operation state. | Differential lifecycle witness and independent review-to-clean of transaction reuse, recovery, identity, rollback and rejected-argv non-mutation. Every mutation fix is re-reviewed. | Rebase start/skip, new journal state, new mutation path, or compat-only semantics are required. |
| WU5 (T2) | Thin public binding over one runner, but two API contracts must agree. | Complete facade witness plus one independent review of types, lazy context and exception identity. Re-review only for a public signature or binding-lifecycle fix. | Compat requires a different command result or behavior. |
| WU6 (T3) | The sync bridge meets lazy pipeline consumption, diagnostics, redirects and output budgets. | Shell integration/bounds suite and independent review-to-clean of layering, stream cleanup, status timing, output preflight and `operations` accounting. | An async command, raw filesystem access, or shell-wide semantic change is needed. |
| WU7 (T1) | Mechanical exports, smoke selection and docs after contracts freeze. | Source/package import witnesses, routine timing and diff check are sufficient; final integration review covers cross-layer omissions. | An export forces a new dependency into the root or shell entry. |

## Test cadence

- **Per WU.** Run only the exact focused witness above while iterating. The
  real-Git parity file is filterable by command family; do not run unrelated
  E2E, network or pack tests.
- **Routine integration.** `npm test` includes only a small CLI/shell smoke
  slice. It must stay below 30 seconds; the target is below 15 seconds.
- **Stable domain slices.** Run `npm run test:shell` once after WU6 and the
  affected E2E rebase files once after WU4. Do not run them after every parser
  or formatter edit.
- **Sprint closure.** Run `npm run test:full` once under `cpu-lease` after all
  reviews and focused fixes settle, followed by typecheck, Biome, build, package
  smoke and diff validation.
- **Failure loop.** Reproduce a closure failure with its exact file/domain slice;
  rerun the full suite only after that witness is stable.

## Out of scope (explicit)

- Network CLI commands, clone/init/checkout/branch/tag/remote/config/plumbing
  argv coverage, external-process fallback, hooks, editor invocation, signing,
  credential helpers and arbitrary environment effects.
- Starting, skipping, rebasing onto, or otherwise extending rebase through argv;
  the typed native lifecycle remains available.
- Staged diff remains in [backlog 35](../backlog/35-staged-diff.md). General log
  exclusion/order, path history and patch output remain in
  [backlog 37](../backlog/37-history-reads-patch-and-paths.md). General rev-list
  remains in [backlog 39](../backlog/39-plumbing-read-surface.md).
- Glob pathspecs for add/rm/reset/checkout/clean/diff/status remain in
  [backlog 36](../backlog/36-glob-pathspecs.md). The CLI add handler retains the
  core operation's exact/directory-prefix semantics.
- Consumer adapter code and its real workflow run are the Phase 1 integration
  gate after this sprint, not package code in this public repository.

## Decisions

- One strict synchronous dispatcher owns argv semantics. Native `Git` publicly
  implements narrow `GitCliRunner.runCli()`; async client methods wrap the same
  runner, and `createGitCommand(workspace.git)` invokes it directly. → ADR 0015
  in WU0.
- Mutating CLI handlers receive resolved run options and preflight their result
  inside the same outer database transaction as the native operation; expected
  native-operation failures are mapped only after rollback and cache
  revalidation. Formatting/preflight failures are rethrown, and worktree writes
  require database identity. → ADR 0016.
- Git may import shell command types in the dedicated adapter entry. Shell never
  imports Git, and the root entry does not silently install the command.
- `lsFiles()` defaults remain cached-only. Worktree selection is explicit and
  cannot be combined with `{ ref }`.
- The CLI is an allowlist, not a compatibility promise for arbitrary Git argv.
  Unsupported syntax fails before any operation runs.
- Routine tests prove wiring; full differential parity remains outside the
  ordinary sub-30-second loop.

## Sequencing

1. WU0 freezes the contract and ADR before runtime work.
2. WU1 and WU2 then proceed independently.
3. WU3 and WU4 start after WU2 freezes parser/result interfaces and may run in
   parallel in separate handler/test sections.
4. WU5 binds the complete dispatcher after WU3/WU4. WU1 facade wiring is
   sequenced around the same client file.
5. WU6 lands after the runner capability freezes. WU7 then owns shared exports,
   package metadata and docs.
6. WU reviews close before one frozen integrated T3 review and the closure gates.

Single-tree isolation is used. Agents may read any file but write only their
declared territory. Shared `src/git/cli/index.ts`, `src/git/client.ts`,
`tests/git-cli-parity.test.ts`, exports and docs are sequenced, not edited
concurrently.

## Plan review

An independent reviewer checks the complete proposal against HEAD, including
whether each tier is proportionate and whether the reduced routine suite still
catches every cross-layer wiring failure.

- **Reviewer:** Bohr (`agent_git_plan_review`)
- **Verdict:** approved after WU0 framing re-review
- **Material findings:** Initial review blocked implementation on an undefined
  public sync seam, stderr rewriting through `warn()`, an invalid general
  ancestor-stop assumption, overclaimed conflict/exclude-standard parity, and
  an ambiguous argv/env/cwd grammar. The plan now freezes
  `GitCliRunner.runCli()` plus `createGitCommand()`, adds raw diagnostic bytes and
  destination-specific output preflight, restricts ranges to proven linear
  chains, states unique-path and `.gitignore`-only divergences with an exact
  700-statement combined allocation, and completes the grammar and public run
  options. Final proposal review approved those corrections. WU0 then proved
  that Git uses command-specific exit codes and may write failure or success
  diagnostics to either stream, so the framing contract was corrected and
  returned for another review.

## Run log

- 2026-08-28 — Sprint grounded at `93dbeab`; implementation is blocked on the
  independent plan review.
- 2026-08-28 — Bohr blocked the initial proposal with five material findings;
  all were corrected in the plan and returned for independent re-review before
  implementation.
- 2026-08-28 — The first re-review retained two precise blockers: public run
  options were undefined and the 100,000-row worktree needed one terminal page.
  The plan now freezes every option/limit and accounts for the 101st query in a
  700-statement combined ceiling.
- 2026-08-28 — Bohr approved the corrected proposal. Implementation may start;
  any WU0 change to command scope, runner architecture or output framing returns
  the plan for independent review.
- 2026-08-28 — WU0 stopped without edits after Git 2.54.0 contradicted the
  universal usage/framing assumption: `log` failures use exit 128, unresolved
  rebase guidance is stdout-only, and successful continuation splits summary and
  progress across streams. The plan now pins a command-specific triplet and
  records native partial-env identity as a deliberate divergence. Re-review is
  required before WU0 resumes.
- 2026-08-28 — Bohr approved the command-specific framing delta. The separate
  stdout/stderr/combined limits and raw shell diagnostic seam support Git's
  observed stream split without changing `CommandResult.status()`; WU0 may
  resume.
- 2026-08-28 — WU0 completed the controlled Git 2.54.0 matrix. All accepted
  families preserve the frozen command scope and made zero stdin reads; nested
  cwd, default/merge log records, literal formats, numeric grammar, linear versus
  non-linear ranges, identity precedence, network refusal, commit failures and
  rebase stream splits are pinned above. The runner architecture is unchanged.
  → [ADR 0015](../decisions/0015-route-git-argv-through-one-synchronous-runner.md)
- 2026-08-28 — WU4 stopped before edits because the WU2 kernel applied caller
  output ceilings only after a mutating handler returned. The corrected seam
  passes resolved limits to handlers and requires mutation, result formatting,
  and preflight inside one outer transaction; the public runner stays unchanged.
  The first plan-delta review additionally required phase-aware error mapping,
  fail-closed worktree/database affinity, and direct orphan-object/cache plus
  native/Computer rollback witnesses. Independent re-review is required before
  WU4 resumes. →
  [ADR 0016](../decisions/0016-preflight-mutating-cli-output-inside-the-transaction.md)
- 2026-08-29 — Noether approved the corrected atomicity seam. Phase-aware
  mapping, database-affinity checks, internal rollback witnesses, and
  discard-stderr commit semantics are now binding; ADR 0016 is accepted and WU4
  may resume.
- 2026-08-29 — WU1 shipped as `2376745`. T3 independent review was clean after
  fixes; the cached/others/ignore/pathspec witness passed 34/34.
- 2026-08-29 — WU2 shipped as `b2d0786`. T3 independent review was clean; the
  parser, runtime-validation, and output-bound witness passed 104/104.
- 2026-08-29 — WU3 shipped as `361fa0f`. Independent review closed clean at T3;
  focused CLI reads passed 13/13, diff passed 17/17, and core reads passed 53/53.
- 2026-08-29 — WU4 shipped as `5a907cb` after multi-pass T3 review-to-clean.
  Fixes covered transaction/output atomicity, mixed ignored adds, nested-root
  rebase exclusion, dirty clean-index status, and rollback/cache/OID witnesses.
  The final CLI mutation witness passed 16/16 in 12.7 seconds; relevant core and
  E2E slices were clean.
- 2026-08-29 — WU5 shipped as `b12ef8d`. T2 review approved after correcting a
  test name/filter; native client and Computer facade witnesses passed 44/44 in
  5.66 seconds.
- 2026-08-29 — WU6 shipped as `7f4ee68` after T3 review-to-clean. Fixes closed a
  suspended-start iterator leak, structural `E2BIG` mapping, upstream closure,
  and replaced-stdin closure. Final focused tests passed 36/36 in 2.78 seconds,
  the shell slice passed 299/299 in 10.30 seconds, and typecheck, build, import,
  Biome, and diff gates were clean.
- 2026-08-29 — WU7 source exports and deterministic CLI/shell smoke passed
  15/15. The routine gate passed 148/148 in 7.01 seconds. Typecheck, Biome,
  build, packed-package imports (including `kompjutr/git/shell`), and diff checks
  are clean. Agent-docs lint reports only the pre-existing unrelated
  `docs/AGENTS.md` stray-root error; it found no broken link from the backlog 61
  deletion.
- 2026-08-29 — Integrated T3 review closed record validation, nested checkout
  discovery, combined conflict diff parity, no-final-newline rendering, output
  accounting, and retained-memory findings. The final projected statement-count
  finding is not a release blocker under the corrected invariant 5. It is
  retained as benchmark evidence for backlog 60; no new runtime refusal was
  added and existing statement barriers were not removed in this sprint.
- 2026-08-29 — The closure-focused CLI, Computer, shell, pathspec, and export
  set passed 280/280 in 29.92 seconds. The routine gate passed 148/148 in 5.62
  seconds. Typecheck, Biome, build, packed-package smoke, and diff checks passed.
  The first full-suite attempt completed its 365 tests but hit Vitest worker RPC
  timeouts because four workers ran under a two-vCPU lease. The runner was
  aligned to two workers as `646ad67`; the affected shard then passed 365/365,
  and the complete sliced gate passed 2,910 tests with five known skips.
