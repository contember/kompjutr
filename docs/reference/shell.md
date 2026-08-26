# Shell reference

`kompjutr/shell` is a bounded command surface over `Filesystem`. It resembles
Bash for the supported agent workload, but it is not a general shell or process
runtime. Unsupported syntax and options fail explicitly.

## Execution model

Commands pass through `parse → plan → execute`. Planning is pure and has no
filesystem dependency. Execution is pull-based: when `head` stops pulling, an
upstream scan, search, or listing stops issuing pages.

The grammar supports simple commands, quotes and escapes, unquoted path globs,
pipelines, and flat left-associative `&&`, `||`, and `;` lists. Pipeline status
is the last stage's status; there is no `pipefail`. Each stage owns its
redirections:

- `< file`, `> file`, and `>> file` stream without retaining the complete file.
  Output writes are atomic, including rollback when an upstream stage fails.
- `2>&1` merges that stage's diagnostics before the downstream pipe consumes
  them.
- `2>/dev/null` drops diagnostics without allocating an intermediate buffer.
- Redirecting stderr to a file and other descriptor duplication are rejected.

Expected usage and filesystem errors from built-ins return a `RunResult`.
Exceptions from injected commands remain visible to the caller.

## Supported commands

Options not listed here are rejected unless the row states otherwise. Short
boolean options may be bundled. Valued options accept a separate value, a short
attached value, or `--long=value`.

| Commands | Supported surface |
|---|---|
| `cat` | Files or stdin. Multiple files stream in operand order. |
| `head` | `-N`, `-n`/`--lines`, `-c`/`--bytes`, `-q`, `-v`; files or stdin. |
| `tail` | `-N`, `-n`/`--lines`; one file or stdin/multiple-file stream. |
| `wc` | `-l`/`--lines`, `-w`/`--words`, `-m`/`--chars`, `-c`/`--bytes`. |
| `ls` | `-l`, `-a`, `-A`, `-1`, `-R`, `-d`. Output is one entry per line. |
| `find` | One root; `-name`, `-type f\|d\|l`, `-maxdepth`. |
| `stat` | One or more paths; stable text fields for file, size, type, mode, and mtime. |
| `cp` | Files and `-r`/`-R`/`--recursive` trees. Metadata and content identity are preserved. |
| `mv` | One or more sources and one destination; no options. |
| `rm` | `-r`/`-R`/`--recursive`, `-f`/`--force`. |
| `mkdir` | `-p`/`--parents`. |
| `touch` | Files, directories, and final symlinks; creates missing files. No options. |
| `echo` | `-n` when it is the first argument. |
| `pwd`, `true`, `false` | No options. |
| `cd` | Exactly one directory; the session retains the resulting cwd. |
| `which` | Reports built-in and injected command names as `/usr/bin/<name>`. |
| `sort` | `-r`/`--reverse`, `-n`/`--numeric-sort`, `-u`/`--unique`, `-f`; UTF-8 byte order. |
| `uniq` | `-c`/`--count`, `-d`, `-u`. |
| `sed` | `s<d>pattern<d>replacement<d>[gi]` and `[from[,to]]p`, with optional `-n`. |
| `xargs` | `-n`/`--max-args`, `-I`/`--replace`, `-d`/`--delimiter`, `-0`/`--null`, `-r`/`--no-run-if-empty`. |

`grep` uses GNU grep defaults: non-recursive, dotfiles included, and BRE unless
`-E` is present. It supports `-r`/`-R`/`--recursive`, `-i`, `-n`, `-l`, `-L`,
`-v`, `-E`, `-F`, `-c`, `-w`, `-x`, `-h`, `-H`, `-s`, `-A`, `-B`, `-C`,
repeated `-e`/`--regexp`, and `--include`/`--exclude`. `-m` is rejected with an
explicit instruction to use `head`.

`rg` is recursive by default, skips hidden paths by default, and uses ERE. It
supports `-i`, `-S`, `-s`, `-n`, `-N`, `-l`, `-v`, `-F`, `-c`, `-w`, `-x`,
`--hidden`, filename controls, `--no-heading`, `--no-ignore`, `-A`, `-B`, `-C`,
repeated `-e`/`--regexp`, `-g`/`--glob`, and `-t`/`--type`. Known types are
`ts`, `js`, `md`, `json`, `css`, `html`, `py`, `go`, `rust`, `sh`, `yaml`,
`toml`, and `sql`. Ignore files are deliberately not read.

`git` is not built in. Consumers inject it or another command through
`ShellOptions.commands`; the shell layer never imports the Git layer.

## Query and mutation shapes

All filesystem access passes through `BoundedFs`. Bare `ls` uses a direct
directory read. Long and recursive listings use metadata-bearing keyset pages.
`find -name` uses keyset-paged indexed globs. Literal recursive search pushes
the content predicate into SQLite when its semantics permit it.

Recursive copy discovers bounded pages and copies content inside SQLite; file
bodies do not enter the isolate. `touch` performs one preflighted metadata-only
mutation and preserves content identities. Redirect writes consume stream
chunks inside one filesystem transaction. Copy, touch, and each redirect bump
one logical filesystem revision per mutating call.

## Limits and results

| Limit | Default | Behavior at the boundary |
|---|---:|---|
| `maxOutputBytes` | 1,000,000 bytes | Applied separately to public stdout and stderr. Either cap sets `truncated`. |
| `maxOperations` | 10,000 calls | Counts shell-visible filesystem calls and fails with exit 2 before the next call. |
| `readBudget` | 1,500,000 bytes | Caps bytes requested per bulk/range read statement. |
| `maxRetainedBytes` | 16 MiB | Caps live shell-owned intermediate bytes across the complete pipeline; overflow fails with exit 2 and never truncates semantic input. |
| Expanded argv | 10,000 entries and 1,000,000 UTF-8 bytes | The first excess entry or byte fails with an `E2BIG`-shaped result before invocation. |
| Redirect input | 96 MiB and 900 content statements | The complete transaction rolls back on overflow or upstream failure. |

`RunResult.operations` reports the shell-visible filesystem call count.
`RunResult.peakRetainedBytes` reports the measured peak intermediate-byte
reservation for the run. It excludes public stdout and stderr, because those
have their own caps. All structural operations remain subject to the project
limits of at most 1,000 SQL statements and less than 100 MiB per operation.

## Deliberate boundaries

The parser rejects variables and parameter expansion, command and process
substitution, arithmetic, grouping and subshells, conditionals and loops,
functions, here-documents, background jobs, and compound commands. There is no
external-process fallback.

The completed design and historical measurements remain in the
[archived shell plan](../archive/plans/shell.md). Agent-facing implementation
rules are in [`src/shell/CLAUDE.md`](../../src/shell/CLAUDE.md).
