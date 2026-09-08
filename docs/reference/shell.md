# Shell reference

`@kompjutr/do/shell` is a bounded command surface over `Filesystem`. It resembles
Bash for the supported agent workload, but it is not a general shell or process
runtime. Unsupported syntax and options fail explicitly.

## Execution model

Commands pass through `parse → plan → execute`. Planning is pure and has no
filesystem dependency. Execution is asynchronous and pull-based: when `head`
stops pulling, an upstream scan, search, or listing stops issuing pages.
`ByteStream` is the public union of synchronous and asynchronous byte iterators;
consumers await each pull and close.

The grammar supports simple commands, quotes and escapes, named parameters in
arguments, unquoted path globs, pipelines, and flat left-associative `&&`, `||`,
and `;` lists. Pipeline status is the last stage's status; there is no
`pipefail`. The [baseline Bash parity suite](../../tests/shell/parity-bash.test.ts)
pins existing `echo`, `cat`, `2>&1`, and `2>/dev/null` behavior. Each stage owns
its redirections:

- `< file`, `> file`, and `>> file` preserve atomic publication. Synchronous
  output streams feed the filesystem transaction incrementally. Asynchronous
  output is pulled sequentially under `maxRetainedBytes` before the one
  synchronous filesystem publication; an upstream rejection publishes nothing.
- `2>&1` and `1>&2` duplicate the destination currently bound to the other
  descriptor. Redirections resolve left to right. A file named by an earlier
  binding is still created or truncated even if a later binding replaces it.
  Stdout bound to stderr does not become pipeline input.
- `2>/dev/null` drops diagnostics without allocating an intermediate buffer.
- Redirecting stderr to a file and duplicating descriptors other than `1` and
  `2` are rejected.

The [ordered-redirection Bash parity suite](../../tests/shell/parity-bash-redirection.test.ts)
pins descriptor routing, pipeline behavior, left-to-right ordering, and file
side effects.

Expected usage and filesystem errors from built-ins return a `RunResult`.
Exceptions from injected commands remain visible to the caller.

`Shell.run(source, options?)` and `Shell.exec(source, options?)` accept caller
input through `ShellRunOptions`:

```ts
const counted = await shell.run("cat | wc -c", {
  stdin: "bytes or text",
});
const committed = await shell.run("git commit -m update", {
  env: {
    GIT_AUTHOR_NAME: "Agent",
    GIT_AUTHOR_EMAIL: "agent@example.com",
  },
});
```

Caller stdin is one cursor for the complete run. Selected pipelines borrow its
remaining bytes without replaying consumed input. Closing a pipeline borrow
does not close the run cursor, and `< file` replaces input only for that stage.
The run awaits cursor and stream cleanup on every result or exception. Pipeline
status and list sequencing are evaluated only after drain or close completes.

Environment values are a frozen snapshot of the caller's own enumerable
properties. In command arguments, `$NAME` and `${NAME}` accept names matching
`[A-Za-z_][A-Za-z0-9_]*`; an unset name expands to empty. Double-quoted
expansion remains one field without pathname expansion. Unquoted expansion
splits on the fixed default IFS whitespace characters (space, tab, and newline),
then pathname-expands each generated field. Injected commands also read the
same snapshot through `CommandContext.env`, including nested invocations. The
[named-expansion Bash parity suite](../../tests/shell/parity-bash-expansion.test.ts)
pins mixed words, quoting, empty values, splitting, pathname expansion, bounds,
and the explicit rejection boundary.

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
| `printf` | Required format; `%s`, `%%`, and `%d` with signed ASCII-decimal operands; `\n`, `\t`, `\r`, `\\`, and `\0`; format recycling and Bash's missing-operand defaults. Width, precision, `%b`, `%q`, `%c`, other escapes, and non-decimal numeric spellings are rejected. |
| `exit` | `exit [N]`; no operand uses the current status, and numeric status is reduced modulo 256. It terminates the run and is accepted only as a single-stage pipeline. |
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

`git` is not built in. Register the explicit adapter from
`@kompjutr/do/git-shell`:

```ts
import { createGitCommand } from "@kompjutr/do/git-shell";
import { createShell } from "@kompjutr/do/shell";

const shell = createShell({
  fs: workspace.filesystem,
  commands: new Map([["git", createGitCommand(workspace.git)]]),
});
```

The shell layer never imports the Git layer and the root entry does not install
the command implicitly. The adapter exposes only the strict argv subset
listed in [Git support](git-support.md#strict-argv-runner). It closes an
upstream stdin stream without reading it, because no accepted Git command reads
stdin. When a run supplies env, the adapter forwards its snapshot to the Git
runner; only the four documented Git identity variables affect commits.
Network authentication, headers, and abort signals come from the Git workspace
binding, never from the shell environment.

Git stdout remains pipeline bytes. The adapter awaits the runner before exposing
its settled result. Git stderr uses the raw diagnostic seam, so
the adapter adds no command prefix, newline, or decoding. It therefore preserves
Git's command-specific bytes under direct stderr, `2>&1`, and `2>/dev/null`.
Existing built-ins keep using the prefixed `warn()` seam.

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
| Caller stdin | 1 MiB | UTF-8 text is measured before encoding; binary input is copied only after the combined input reservation succeeds. |
| Caller env | 256 own entries and 1 MiB cumulative UTF-8 key/value bytes | The frozen snapshot and stdin share one `maxRetainedBytes` reservation for the complete run. |
| Expanded argv | 10,000 entries | The first excess entry fails with an `E2BIG`-shaped result before invocation. Generated UTF-8 bytes are reserved against the run's shared `maxRetainedBytes` ceiling until the command settles. |
| Async redirect input | `maxRetainedBytes` | Input is pulled sequentially before atomic publication. Synchronous producers continue to stream incrementally without retaining the complete output. |

`RunResult.truncated` is the OR of public sink truncation and every settled
command's truncation signal. `RunResult.operations` reports the shell-visible filesystem call count.
`RunResult.peakRetainedBytes` reports the measured peak intermediate-byte
reservation for the run. It excludes public stdout and stderr, because those
have their own caps. An injected Git command performs separately bounded SQL
work through its runner, so that SQL is deliberately excluded from
`RunResult.operations`.

Before Git runs, the adapter derives output ceilings from the planned
destination. Terminal output gets the bytes remaining in the public sink; a
redirect gets the atomic redirect ceiling; an upstream pipeline gets Git's
intrinsic ceiling and any trailing-`head` demand hint. Direct stderr gets the
remaining stderr sink, merged stderr shares the stage-output budget, and dropped
stderr retains and charges nothing. The Git runner then applies its intrinsic
16 MiB stdout, 1 MiB stderr, and 16 MiB combined maxima. Read-only and
pre-publication excess fails with an output limit. A network command that has
already published local or remote state instead returns the bounded prefix and
contributes `truncated: true` to the shell result.

Every admitted local mutating Git argv command performs its mutation, success
formatting, and output preflight in one database transaction. A terminal,
pipeline, merged, or redirect overflow therefore leaves no partial index,
worktree, ref, or operation-state change. Redirect publication remains atomic as
for every other command.

Clone, fetch, pull, ls-remote, and push remain transport operations owned by the
Git layer. Their published-result certainty and truncation policy is documented
in [Git support](git-support.md#strict-argv-runner); the shell only propagates
the settled result. `git pull --rebase [<remote> [<branch>]]` enters the durable
rebase lifecycle after fetch publication. A conflict exits non-zero and remains
recoverable through `git rebase --continue`, `--skip`, or `--abort`, including
after the workspace is reopened.

## Deliberate boundaries

Named expansion is restricted to command arguments. Variable assignment,
parameters in command names or redirection targets, `${...}` operators,
positional parameters, and special parameters such as `$@`, `$?`, and `$$` are
rejected. Command and process substitution, arithmetic, grouping and subshells,
conditionals and loops, functions, here-documents, background jobs, and compound
commands also remain rejected. There is no external-process fallback.

`printf` deliberately rejects the forms listed in its command row. `exit` in a
multi-stage pipeline is a local usage error because this shell has no subshell
in which to run it. The [printf parity suite](../../tests/shell/parity-bash-printf.test.ts)
and [exit parity suite](../../tests/shell/parity-bash-exit.test.ts) compare the
admitted forms with Bash and pin these intentional refusals locally. Bash parity
is the standing admission gate for future shell syntax and commands; see
[ADR-0019](../decisions/0019-admit-a-bounded-posix-shell-surface.md).

The completed design and historical measurements remain in the
[archived shell plan](../archive/plans/shell.md). Agent-facing implementation
rules are in [`packages/do/src/shell/CLAUDE.md`](../../packages/do/src/shell/CLAUDE.md).
