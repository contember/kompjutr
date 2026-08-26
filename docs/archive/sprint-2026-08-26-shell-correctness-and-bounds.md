> **OUTCOME — shipped 2026-08-26.** The accepted shell subset now evaluates
> complete AND-OR lists, routes redirects per stage, rejects unsupported flags,
> pages path expansion and discovery, and uses set-based metadata listing,
> SQLite-internal copy, and metadata-only touch. One 16 MiB default
> retained-memory budget now covers argv, line state, blocking stages, search, xargs,
> merged diagnostics, and redirect inputs; stdout and stderr keep independent
> public caps, and redirects stream atomically. Commit map: plan → `2d7b185`;
> WU1 → `f9161f8`; WU2 → `333d2c3`; WU3 → `9454a94`; WU4 → `aef7bea`;
> WU5 → `880a530`; WU6 → `fcef49c`; WU7 → `a0130e0`; WU8 → `59ce213`.
> Verification: typecheck and Biome check; CPU-leased build; CPU-leased full
> suite — 110 files, 1,936 passed, 5 skipped; clean 574-file package smoke;
> docs lint. Backlog closed: 49 and 54–60. Deferred: general Bash constructs,
> locale-sensitive collation, ignore-file handling, filesystem watchers, a
> process runtime, and a shell-to-Git dependency remain deliberately out of
> scope.

# Sprint — Shell correctness and bounds (2026-08-26)

**Goal.** Make every accepted shell construct truthful, move copy, touch, and
listing onto bounded set-based filesystem operations, and enforce one explicit
retained-memory boundary across complete pipelines.

**Theme.** Backlog items 49 and 54–60 described one trust boundary. The
current shell already accepts these constructs and commands, so plausible wrong
answers, silent truncation, per-path query loops, and isolate-wide intermediate
allocations are correctness defects rather than optional features. Success is a
shell whose accepted Bash-shaped subset matches real tools, whose filesystem
work scales by bounded pages instead of paths, and whose stdout, stderr, argv,
line, blocking-stage, and redirect state all fail closed below the project-wide
100 MiB operation ceiling.

## Refs re-verified at HEAD (2026-08-26)

`✔` = confirmed live · `⚠` = drift/nuance caught.

- ✔ A connector is stored on the statement before its successor, but execution
  currently breaks the complete step loop after a false `&&` or true `||` —
  `src/shell/parse/ast.ts:63`, `src/shell/exec/execute.ts:51`.
- ✔ Redirections are planned per command, while execution records stdout files
  only for the last stage and sends merged diagnostics directly to the final
  sink — `src/shell/plan/types.ts:27`, `src/shell/exec/execute.ts:96`,
  `src/shell/exec/execute.ts:145`.
- ✔ Argument globs materialize a 10,000-row result without a completeness
  witness; the long-pattern fallback retains every matching path —
  `src/shell/exec/execute.ts:185`, `src/shell/exec/execute.ts:215`.
- ✔ The fast `find -name` branch materializes up to 100,000 paths and then
  returns, while the scan branch is already lazy and paged —
  `src/shell/commands/list.ts:147`, `src/shell/commands/list.ts:165`.
- ✔ `Filesystem.scan()` already returns metadata-bearing path-ordered pages,
  but `glob()` returns only an optionally truncated array and `readdir()` omits
  metadata — `src/fs/types.ts:204`, `src/fs/types.ts:246`,
  `src/fs/types.ts:202`.
- ✔ Recursive `cp` pages discovery but retains every destination entry and all
  file bodies before one write; recursive regular files lose `contentId` —
  `src/shell/commands/files.ts:39`, `src/shell/commands/files.ts:70`.
- ✔ The filesystem has no bulk copy primitive and the Node compatibility
  `copyFile` surface still throws `ENOSYS` — `src/fs/types.ts:252`,
  `src/fs/compat/node.ts:359`.
- ✔ Shell `touch` reads and rewrites existing file contents, cannot update a
  directory, and clears an existing content identity —
  `src/shell/commands/files.ts:198`.
- ✔ `ls -l` performs one `stat()` per visible child and `ls -R` performs one
  `readdir()` per directory — `src/shell/commands/list.ts:58`.
- ✔ `Limits` bounds final stdout, filesystem calls, and per-statement reads,
  but has no retained-memory or stderr boundary —
  `src/shell/exec/context.ts:29`, `src/shell/exec/execute.ts:43`.
- ✔ Known materializations remain in multi-file `cat`, `sort`, `xargs`, file
  redirects, line splitting, and exponentially growing `head`/`tail` probes —
  `src/shell/commands/read.ts:30`, `src/shell/commands/text.ts:72`,
  `src/shell/commands/xargs.ts:69`, `src/shell/exec/execute.ts:248`,
  `src/shell/exec/bytes.ts:49`, `src/shell/commands/read.ts:253`.
- ✔ Accepted flag tables still contain observable no-ops; repeated `-e`
  overwrites the preceding pattern in both search surfaces —
  `src/shell/commands/files.ts:18`, `src/shell/commands/list.ts:14`,
  `src/shell/commands/read.ts:53`, `src/shell/commands/xargs.ts:35`,
  `src/shell/commands/grep.ts:65`, `src/shell/commands/rg.ts:91`.
- ⚠ The backlog describes all expected command failures escaping `RunResult`.
  Several commands already catch `UsageError`, but `wc`, `sort`, and `uniq` do
  not, and lazy filesystem failures can still escape after command creation —
  `src/shell/commands/read.ts:138`, `src/shell/commands/text.ts:72`,
  `src/shell/commands/index.ts:17`.

## Work units

### WU1 — Correct list selection and stage-local streams (effort L)

- **Problem.** AND-OR selection terminates the whole script, and per-command
  redirections do not route through the stream consumed by the next stage.
- **Verify first.** Pin current failures for `false && echo no || echo yes`,
  semicolon recovery, skipped `cd`, intermediate `>`/`>>`, `2>&1 | head -1`,
  and `2>/dev/null | ...` against Bash.
- **Scope.** Evaluate flat statements left to right while retaining the last
  executed status. Give each planned command its own stdout/stderr router.
  Merge stderr before downstream consumption, drain intermediate file redirects
  atomically, and preserve final-stage behavior and lazy cancellation.
- **Acceptance / witness.** Differential cases match Bash in stdout, stderr,
  exit status, filesystem state, and session cwd. A skipped pipeline performs no
  filesystem call or cwd mutation. Alternating output from an injected command
  keeps order through `2>&1`.
- **Touch points.** `src/shell/exec/context.ts`,
  `src/shell/exec/execute.ts`, `src/shell/plan/types.ts`,
  `tests/shell/shell.test.ts`, `tests/shell/session.test.ts`.

### WU2 — Make the accepted command surface truthful (effort L)

- **Problem.** Several accepted flags are no-ops, repeated patterns are reduced
  to the last one, byte ordering is not explicit, and some expected built-in
  failures escape the shell result contract.
- **Verify first.** Inventory every flag in each built-in against its code path.
  Ask GNU tools for repeated `-e`, `wc -m`, non-BMP C-locale sort order, and the
  rejected no-op flags before choosing implementation or rejection.
- **Scope.** Reject unsupported no-op flags with exit 2, implement `wc -m`, OR
  repeated grep/rg patterns, disable literal pushdown unless it represents the
  complete pattern set, sort text in UTF-8 byte order, and wrap only built-ins so
  expected usage/filesystem failures become `RunResult` failures while injected
  programming errors still throw.
- **Acceptance / witness.** A differential matrix covers every corrected flag,
  repeated file/stdin patterns, stdout, stderr, status, and mutations. No flag
  admitted by a built-in is an untested no-op.
- **Touch points.** `src/shell/commands/`, `src/shell/exec/context.ts`,
  `tests/helpers/parity.ts`, `tests/shell/`, `docs/reference/shell.md`.

### WU3 — Page path expansion and indexed find (effort M)

- **Problem.** A full glob page is indistinguishable from a truncated result,
  and the fast `find` path materializes its complete capped answer.
- **Verify first.** Record the exact 10,000-match glob failure, confirm the
  long-pattern scan gives the same path order, and measure `find ... | head`
  before changing the primitive.
- **Scope.** Add a cap-plus-one, keyset-paged glob result with an explicit next
  cursor. Stream it through `find`; retain argument expansion only up to explicit
  path-count and UTF-8 byte limits, then fail with a stable `E2BIG`-shaped result
  before command invocation. Give the scan fallback identical limits.
- **Acceptance / witness.** 10,001 argv matches fail closed, no old 100,000-row
  find ceiling remains, Unicode and >50-byte patterns agree across paths, and a
  downstream `head` stops additional pages.
- **Touch points.** `src/fs/types.ts`, `src/fs/filesystem.ts`,
  `src/fs/store/scan.ts`, `src/shell/exec/context.ts`,
  `src/shell/exec/execute.ts`, `src/shell/commands/list.ts`,
  `tests/fs/scan.test.ts`, `tests/shell/bounds.test.ts`,
  `tests/shell/cost.test.ts`.

### WU4 — Add set-based metadata listing (effort M)

- **Problem.** Long and recursive listing regress to one metadata operation per
  path or directory even though the store already owns all rows in path order.
- **Verify first.** Pin real `ls` output for wide, deep, hidden, symlinked, and
  multi-target fixtures, including recursive section order.
- **Scope.** Add a paged metadata-bearing listing primitive ordered for direct
  and recursive rendering. Keep bare `ls` cheap. Render `-l` and `-R` from
  bounded pages without per-entry `stat()`, per-directory `readdir()`, or a
  complete-tree buffer.
- **Acceptance / witness.** Correctness matches the supported `ls` matrix. Two
  tree sizes prove SQL and shell operation counts scale by pages/output, and an
  eligible trailing `head` stops later pages.
- **Touch points.** `src/fs/types.ts`, `src/fs/filesystem.ts`,
  `src/fs/store/scan.ts`, `src/shell/exec/context.ts`,
  `src/shell/commands/list.ts`, `tests/fs/scan.test.ts`,
  `tests/shell/shell.test.ts`, `tests/shell/cost.test.ts`.

### WU5 — Add set-based copy (effort L)

- **Problem.** Copy is the only bulk verb missing from `Filesystem`; shell
  recursive copy retains the whole tree and reimplements metadata semantics.
- **Verify first.** Pin Node/GNU behavior for regular files, directories,
  symlinks, hard-linked names, existing destinations, self-descendants, and
  unsupported preservation flags.
- **Scope.** Add a paged set copy that resolves source/destination pairs once,
  copies content inside SQLite, preserves type, mode, mtime, and `contentId`,
  and never returns file bodies to the isolate. Wire `NodeFsCompat.copyFile`
  and replace shell `collectSubtree()`; reject `cp -p` unless the primitive
  implements its complete contract.
- **Acceptance / witness.** Conformance and shell parity cover the verify-first
  matrix. A 5,000-file copy scales by bounded metadata pages and moves zero
  content BLOB bytes through the isolate. Every mutating page is atomic and
  bumps the revision once.
- **Touch points.** `src/fs/types.ts`, `src/fs/filesystem.ts`, new or existing
  `src/fs/store/` copy code, `src/fs/compat/node.ts`,
  `src/shell/exec/context.ts`, `src/shell/commands/files.ts`, `tests/fs/`,
  `tests/shell/`.

### WU6 — Add metadata-only bulk touch (effort M)

- **Problem.** Touch copies complete file bodies through the isolate, clears
  content identities, and throws on directories.
- **Verify first.** Pin real `touch` behavior for files, directories, final and
  dangling symlinks, missing files, and a mixed operand set.
- **Scope.** Add one preflighted bulk timestamp mutation that follows the normal
  final-symlink contract, creates missing regular files, preserves every
  non-time field, updates hard-linked inodes once, and bumps one revision. Wire
  shell touch and applicable Node compatibility timestamp methods.
- **Acceptance / witness.** Differential/conformance tests cover the matrix. A
  multi-megabyte file moves no content BLOB into the isolate, keeps `contentId`,
  and a failed mixed set leaves all operands unchanged.
- **Touch points.** `src/fs/types.ts`, `src/fs/filesystem.ts`,
  `src/fs/store/ops.ts`, `src/fs/compat/node.ts`,
  `src/shell/exec/context.ts`, `src/shell/commands/files.ts`, `tests/fs/`,
  `tests/shell/`.

### WU7 — Enforce one retained-memory budget (effort L)

- **Problem.** Final stdout and call counts do not bound argv, stderr, complete
  blocking stages, file batches, long lines, or redirect state.
- **Verify first.** Add one failing boundary test for each known materializer
  before changing it: glob argv, stderr, multi-file cat, sort, xargs, redirects,
  long line splitting, and head/tail range growth.
- **Scope.** Add a configurable retained-byte budget with a conservative
  default below 100 MiB and a stable limit error. Charge every shell-owned
  retained buffer before keeping it, cap each public stdout/stderr stream,
  stream cat batches and redirects, bound line carry and range probes, and make
  blocking stages fail rather than truncate semantic input. Roll back a redirect
  if any upstream stage or limit fails.
- **Acceptance / witness.** Exact-limit and first-over-limit tests cover every
  named site plus a combined pipeline. No failure partially mutates a redirect
  target. The accepted combined witness remains below the project memory gate.
- **Touch points.** `src/shell/exec/bytes.ts`, `src/shell/exec/context.ts`,
  `src/shell/exec/execute.ts`, `src/shell/commands/read.ts`,
  `src/shell/commands/search*.ts`, `src/shell/commands/text.ts`,
  `src/shell/commands/xargs.ts`, filesystem streamed writes,
  `tests/shell/bounds.test.ts`, `tests/shell/cost.test.ts`.

### WU8 — Prove the complete shell contract and close docs (effort M)

- **Problem.** Unit fixes do not prove that list selection, stream routing,
  bulk mutations, lazy discovery, and shared limits compose in one run.
- **Verify first.** Write a mixed journey using AND-OR recovery, merged stderr,
  a bounded find/list pipeline, recursive copy, touch, sort/xargs, and file
  redirect before implementation is declared complete.
- **Scope.** Run focused filesystem and shell suites, differential binaries,
  typecheck, format/lint, build, package smoke, and the CPU-leased full suite.
  Update the shell reference and public limits. Stamp the completion header, archive this
  sprint, delete backlog 49 and 54–60, and refresh all docs indexes only after
  every witness passes.
- **Acceptance / witness.** The journey has exact stdout/stderr/status/fs-state
  assertions and bounded operation/memory measurements. All repository gates
  pass from the worktree, and docs lint reports no new finding.
- **Touch points.** `tests/shell/`, `tests/fs/`, `README.md`,
  `docs/reference/shell.md`, `docs/INDEX.md`, `docs/sprints/`,
  `docs/archive/`, `docs/backlog/`.

## Out of scope (explicit)

- General Bash features remain excluded: grouping, subshells, variables,
  command/process substitution, `set -e`, `pipefail`, jobs, and compound
  commands. The parser continues to reject them by name.
- New commands and flags are not added unless an existing accepted shape needs
  a truthful implementation. Unsupported no-op flags are removed from the
  accepted matrix instead.
- Locale-sensitive collation is excluded. Text sort uses the existing controlled
  C-locale/UTF-8 byte contract.
- Ignore-file handling remains the documented deliberate `rg` divergence.
- Filesystem watchers, a general process runtime, and importing Git into the
  shell layer remain excluded.

## Decisions

- Connector execution remains a flat left-associative list because that is the
  typed AST. Selection skips only the next pipeline; `;` always starts a new
  selected segment.
- Redirection routing is command-local. `2>&1` joins that stage before its pipe;
  an intermediate stdout file leaves an empty stream for the next stage.
- Existing public `glob()` remains compatible; a new explicit paged primitive
  carries completeness and keyset continuation for bounded callers.
- Bulk copy keeps ordinary copy semantics: each destination regular file gets
  an independent inode unless an explicit future preservation mode says
  otherwise. Source hard links do not become destination hard links by accident.
- Ordinary touch follows a final symlink. A missing target is created as an
  empty regular file; no `-h` behavior is added.
- Stdout and stderr each use `maxOutputBytes`; `truncated` is true when either
  public stream hits its cap. Intermediate retained state uses a separate
  `maxRetainedBytes` limit, whose default leaves substantial headroom below
  100 MiB for SQLite and runtime overhead.
- Expected failures are normalized only for built-ins. Arbitrary injected
  command exceptions remain programmer-visible.
- WU7 starts only after WU3 and WU5 remove the two known unbounded path/tree
  collectors recorded as blockers of backlog 57.

## Sequencing

| Phase | Work | Dependency / parallelism |
|---|---|---|
| 1 | WU1, WU2 | Independent semantic baselines; land separately. |
| 2 | WU3, WU4 | Share paged metadata discovery; WU3 defines the cursor first. |
| 3 | WU5, WU6 | Independent bulk mutations over the settled filesystem surface. |
| 4 | WU7 | Depends on WU3 and WU5; audits all remaining materializers. |
| 5 | WU8 | Runs only after every focused witness passes. |

## Run log

<!-- Append as you work: discoveries, deviations, blockers. Graduate each entry:
     changed the *why* → ../decisions/NNNN ; new future work → ../backlog/NN ;
     transient → leave it (dies with the sprint on archive). After graduating,
     trim to a one-line pointer ("→ ADR-0007"). -->

- WU8's exact command inventory found that `sed 2p` did not duplicate the
  selected line. The parity correction landed in `59ce213`.
- The first full-suite attempt waited for Git's interactive rebase editor in
  the agent PTY. The deterministic editor setting is now in `tests/CLAUDE.md`;
  the repeated leased suite passed.
