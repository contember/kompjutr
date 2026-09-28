# Sprint — shell surface expansion (2026-09-28)

**Goal.** Close the gaps between the shell and the command lines coding agents
actually send: fix the silent word-level divergences, admit compound syntax and
command substitution, and add the text, link, tree, system, `patch`, `jq`, and
`awk` commands.

**Theme.** Every item widens the admitted surface of
[ADR-0019](../decisions/0019-admit-a-bounded-posix-shell-surface.md) under its
Bash parity gate and ADR-0018's bounded execution. The batch succeeds when a
probe of ~70 common agent command lines no longer hits a silent divergence and
every admitted form is pinned by a differential test.
[ADR-0027](../decisions/0027-widen-the-shell-to-compound-syntax-and-text-tools.md)
records the decisions.

## Refs re-verified at HEAD (2026-09-28)

- ✔ `echo ~/x` prints `~/x` with status 0 — a silent divergence (probe).
- ✔ A bare `{}` or `}` word fails as "command group" — `parse/lexer.ts:112`.
- ✔ `&>` fails as "background execution" — `parse/lexer.ts:116`.
- ✔ `cat` has no option parser; `cat -n` reads a file named `-n` — `commands/read.ts:14`.
- ✔ `commands/` has 17 direct files of the 20 allowed; new families take
  subdirectories.
- ⚠ The installed coreutils are uutils 0.2.2, `awk` is mawk 1.3.4, `jq` is
  1.8.1, `patch` is GNU 2.8. Parity compares against the installed binaries
  (decision below).

## Work units

Wave 0 (seams, done by the leader): `BoundedFs.readlink/symlink/link/chmod/rmdir`,
`ShellOptions.now` → `CommandContext.now()`, and one empty command map per new
family in `commands/<family>/index.ts`, spread by the registry.

| WU | Scope | Territory | Depends on |
|---|---|---|---|
| S1 | `~` and `~/` from `HOME`, bare `{}`/`}` words, brace expansion `{a,b}` and `{1..3}`, `&>`/`&>>` | `parse/`, `plan/`, `exec/` | W0 |
| S2 | `( … )`, `{ …; }`, `if/elif/else/fi`, `for … in … do … done`, `$?`, `set -e`, `set -o pipefail` | `parse/`, `plan/`, `exec/` | S1 |
| S3 | `$( … )`, backquotes, `NAME=value`, `NAME=value cmd`, `export`, `unset` | `parse/`, `plan/`, `exec/` | S2 |
| C1 | `cut`, `tr`, `nl`, `rev`, `comm`, `seq` | `commands/columns/` | W0 |
| C2 | `cat -n/-b/-A/-E/-s`, `sort -k/-t/-o/-s/-V`, `ls -h`, `type`, `command -v` | `commands/{read,text,list}.ts` | W0 |
| C3 | `ln`, `chmod`, `rmdir`, `readlink`, `realpath` | `commands/links/` | W0 |
| C4 | `du`, `tree` over paged listings | `commands/tree/` | W0 |
| C5 | `env`, `date`, `sleep`, `mktemp`, `sha256sum`/`sha1sum`, `base64` | `commands/system/` | W0 |
| C6 | `find -exec … ;`/`+`, `-delete`, `-size`, `-newer`, `-empty`, `-mmin`/`-mtime` | `commands/find*.ts` | S1 |
| C7 | `diff -r` | `commands/diff/` | W0 |
| C8 | `patch` | `commands/patch/` | W0 |
| C9 | `jq` subset | `commands/jq/` | W0 |
| C10 | `awk` subset | `commands/awk/` | W0 |

Each unit owns its tests: `tests/shell/<unit-named>.test.ts`. Docs
(`docs/reference/shell.md`, ADR-0027 evidence list) are integrated by the
leader from each unit's report.

## Review strategy

| Scope | Risk / rationale | Required gate and review | Escalate when |
|---|---|---|---|
| Integration | Units share the registry and `BoundedFs` seams only | `npm run test:shell`, `npm test`, then `npm run test:full` at close | any existing parity test moves |
| S1–S3 | Grammar and executor state; every script is affected | Own parity suite + all `tests/shell`; independent agent review | a parity failure outside the unit's new forms |
| C6, C8, C9, C10 | Mutation (`-delete`, `-exec`, `patch`) or a language interpreter | Own parity suite; independent agent review | a cap without a named failure |
| C1–C5, C7 | Leaf commands | Own parity suite; leader review | — |

## Test cadence

- **Per WU.** Its own test file(s) plus `npm run typecheck` and `npm run check`.
- **Routine integration.** `npm run test:shell` after each commit.
- **Sprint closure.** `npm run test:full` once.

## Out of scope (explicit)

- `while`/`until`, `case`, functions, background jobs, process substitution,
  arithmetic expansion. Only `for … in` has a structural bound (the argv ceiling).
- `awk` `while`, `do`, and C-style `for`; `jq` `recurse`-style generators
  without a bound on input size, `until`, `while`, `limit`-free `range`.
- `tar`, `xxd`, `file`, `od`.

## Decisions

- **Parity reference is the installed toolchain** (uutils coreutils, mawk, jq
  1.8.1, GNU patch). The harness compares against whatever `bash` finds on PATH.
- **Loops: `for … in` only.** Its iteration count is bounded by the expanded
  word list, which already has the 10,000-entry argv ceiling.
- **`sleep` waits for real**, capped at the value that keeps one run inside a
  request; `date` reads `ShellOptions.now`; `mktemp` names come from
  `crypto.getRandomValues`.

## Sequencing

| Wave | Units |
|---|---|
| 0 | seams (leader) |
| 1 | S1, C1, C2, C3, C4, C5, C7 |
| 2 | S2, C6, C8, C9, C10 |
| 3 | S3 |

## Plan review

- **Reviewer:** user (gate in session)
- **Verdict:** approved
- **Material findings:** parity against uutils, `for`-only loops, `sleep` admitted.

## Run log
