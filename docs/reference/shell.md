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

The grammar supports simple commands, quotes and escapes, parameters and
command substitution in words, unquoted path globs, tilde and brace expansion,
pipelines, `!` negation, `&&`/`||`/`;` lists, and the compound commands
`( list )`, `{ list; }`, `if … then … [elif … then …] [else …] fi`, and
`for NAME in WORDS; do … done`. A newline separates statements as `;` does, and
a statement continues across newlines after `&&`, `||`, or `|`. `#` at the start
of a word comments to the end of the line. Backslash-newline outside single
quotes joins lines. Reserved words are recognized only in command position (and
`in` after `for NAME`); elsewhere they are ordinary words.

A compound command takes redirections after its closing word and can be any
pipeline stage. `( … )` runs on a copy of the cwd, variables, and options;
`{ …; }`, `if`, and `for` share the current shell. As in Bash, every stage of a
multi-stage pipeline runs on its own copy, so `cd x | cat` changes nothing and
`exit` there ends only that stage. A compound stage runs lazily inside its
stdout, so `{ …; } | head -1` stops the body. Commands in a compound body share
the stage's stdin in order: over a redirected file the unread rest goes to the
next reader; over a pipe or here-document a chunk once read is consumed, so
`head -c N` followed by another reader diverges from Bash, which reads exactly
N bytes.

The [script](../../tests/shell/parity-bash-scripts.test.ts),
[compound](../../tests/shell/parity-bash-compound.test.ts), and
[baseline](../../tests/shell/parity-bash.test.ts) Bash parity suites pin these
forms together with here-documents and the small built-ins below. Each stage
owns its redirections:

- `< file`, `> file`, and `>> file` preserve atomic publication. `< /dev/null`
  is empty input. Synchronous
  output streams feed the filesystem transaction incrementally. Asynchronous
  output is pulled sequentially under `maxRetainedBytes` before the one
  synchronous filesystem publication; an upstream rejection publishes nothing.
- `2>&1` and `1>&2` duplicate the destination currently bound to the other
  descriptor. Redirections resolve left to right. A file named by an earlier
  binding is still created or truncated even if a later binding replaces it.
  Stdout bound to stderr does not become pipeline input.
- `&> file`, `&>> file`, `>& file`, and `1>& file` are `> file 2>&1` and
  `>> file 2>&1`.
- `2>/dev/null` drops diagnostics without allocating an intermediate buffer.
- `<<DELIM` and `<<-DELIM` read a here-document body from the lines after the
  command line, up to a line equal to `DELIM`; `<<-` strips leading tabs.
  A quoted delimiter keeps the body literal. An unquoted one expands parameters
  and command substitutions and honours `\$`, `` \` ``, `\\`, and
  backslash-newline. `<<< word`
  supplies the word and a newline. Neither splits fields nor expands paths.
  The body bytes are reserved against `maxRetainedBytes` while the stage reads
  them. A body without its delimiter line is rejected.
- `2> file` and `2>> file` hold the stage's diagnostics against
  `maxRetainedBytes` and publish them after the stage settles. Descriptors
  other than `0`, `1`, and `2` are rejected.

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

### Words and expansion

Words expand in Bash's order: braces, tilde, parameters and command
substitution, field splitting, and pathname expansion.

- **Braces.** Unquoted `pre{a,b}post`, nested and empty alternatives, and
  sequences `{1..5}`, `{5..1}`, `{a..e}`, `{1..10..3}`, `{01..10}`, and negative
  bounds expand as Bash expands them. Braces that form no expansion (`{}`, `}`,
  `{a}`, `a{b`) are literal words, so `xargs -I{} echo {}` works. Generated
  words count against the argv ceiling as they are produced. Here-documents,
  here-strings, and quoted text never brace-expand.
- **Tilde.** An unquoted `~` or `~/…` at the start of a word, and after the `=`
  or an unquoted `:` of a `NAME=value`-shaped word, expands to `HOME`; the
  value is neither split nor globbed. Redirection targets expand a tilde; a
  here-string expands one at its start and after each unquoted `:`;
  here-documents do not.
- **Parameters.** The caller's env is a frozen snapshot of its own enumerable
  properties; the run layers shell variables over it and never mutates it.
  `$NAME`, `${NAME}`, `$?`, `${#NAME}`, and `${NAME:-word}`, `${NAME-word}`,
  `${NAME:+word}`, `${NAME+word}`, `${NAME:=word}`, `${NAME=word}`,
  `${NAME:?word}`, `${NAME?word}` expand in arguments, command names,
  redirection targets, assignment values, `for` lists, and here-text, with
  Bash's `set -u` rules. `${#NAME}` counts characters under a UTF-8
  `LC_ALL`/`LC_CTYPE`/`LANG` and bytes otherwise.
- **Splitting.** Double-quoted expansion is one field. Unquoted expansion
  splits on the fixed default IFS (space, tab, newline) and then
  pathname-expands. A command name that expands to no field leaves only
  assignments and redirections. An unquoted redirection target that expands to
  no field or several is Bash's `ambiguous redirect`, status 1.
- **Command substitution.** `$( … )` and backquotes (with Bash's backslash
  rules, nested) run the list as a subshell: a copy of the cwd, variables, and
  options, without `set -e`, sharing the run's operation and loop-iteration
  budgets. Trailing newlines are removed and NUL bytes dropped with Bash's
  warning; other output is decoded as UTF-8, so invalid bytes become U+FFFD
  where Bash keeps them. Output is held against `maxRetainedBytes`; overflow
  fails the run with exit 2. The substitution's stderr follows the expanding
  command's current stderr binding, and each substitution sets `$?`. A command
  with no name takes the status of its last substitution.
- **Assignments.** `NAME=value` and `NAME+=value` alone assign shell variables,
  which are not exported unless the name already is. Before a command they are
  exported to that command only. `export NAME[=value]`, `export -n NAME`, and
  `unset [-v] NAME` follow Bash's diagnostics. Subshells and pipeline stages
  work on copies. Variable bytes use the retained budget. Injected commands see
  the exported variables through `CommandContext.env`, including nested
  invocations.

The [word](../../tests/shell/parity-bash-words.test.ts),
[named-expansion](../../tests/shell/parity-bash-expansion.test.ts), and
[substitution](../../tests/shell/parity-bash-substitution.test.ts) Bash parity
suites pin these forms and their refusals.

### Status and options

`$?` and `${?}` expand to the most recent pipeline's status. A pipeline's status
is its last stage's; with `set -o pipefail`, the rightmost non-zero stage's. An
`if` with no branch taken and a `for` with no iterations return 0. A missing
command fails its own stage with status 127 and `bash: line N: NAME: command not
found`, routed through the stage's stderr bindings; the rest of the pipeline
still runs. A redirection target the filesystem refuses reports
`bash: line N: TARGET: <error>` and fails the command with status 1.

`set` is an executor builtin accepting `-e`/`+e`, `-u`/`+u`, and
`-o`/`+o errexit|nounset|pipefail`, combined as in `set -euo pipefail`.
`set -e` follows Bash's exceptions: not in `if`/`elif` conditions, not before
`&&`/`||`, not under `!`, and not for a group, `if`, or `for` that fails only
through an ignored command; a failed redirection on a compound still exits.
Subshells and pipeline stages exit and their parent then sees the status.
`set -u` reports `bash: line N: X: unbound variable` and ends the shell with
Bash's status (127 at top level and in a simple pipeline stage, 1 in a
subshell, a compound stage, or under `set -e`). `break [N]` and `continue [N]`
leave N enclosing `for` loops, with Bash's diagnostics. A `for` loop variable
is a shell variable: `$NAME` sees it during and after the loop, but
`CommandContext.env` shows it only if the name is exported.

## Supported commands

Options not listed here are rejected unless the row states otherwise. Short
boolean options may be bundled. Valued options accept a separate value, a short
attached value, or `--long=value`.

Each command's output, diagnostics, and exit status are compared with the
tool installed on the test host: GNU Bash 5.2, uutils coreutils 0.2.2, GNU
grep, sed, find, and diffutils, util-linux `rev`, tree 2.2.1, mawk 1.3.4, and
jq 1.8.1. A row names the reference where it differs from that list.

| Commands | Supported surface |
|---|---|
| `cat` | Files or stdin (`-`), streamed in operand order. `-n`, `-b`, `-s`, `-E`, `-T`, `-v`, `-A`, `-e`, `-t`, `-u` (ignored), long spellings with unique prefixes, and `--`; numbering and squeezing continue across inputs. Unknown options print uutils' argument-error text with status 1. Plain `cat` keeps its batched read and honours a trailing `head -N` as one ranged read. |
| `head` | `-N`, `-n`/`--lines`, `-c`/`--bytes`, `-q`, `-v`; files or stdin. |
| `tail` | `-N`, `-n`/`--lines`, and `-n +N` to start at line N; one file or stdin/multiple-file stream. |
| `wc` | `-l`/`--lines`, `-w`/`--words`, `-m`/`--chars`, `-c`/`--bytes`; `-` names stdin. GNU layout: operand names, a `total` row for several operands, and GNU's column width. |
| `diff` | Two files, a file and `-` for stdin, a file against a directory (compares `DIR/basename`), or two directories. Normal output, `-u`, `-U N`, `-q`/`--brief`, `-s`, `-r`/`--recursive`, and `-N`/`--new-file`; exit 0 equal, 1 different, 2 trouble. Unified headers print mtimes in UTC. Directory comparison prints GNU's `Only in`, `Common subdirectories` (without `-r`), type-mismatch, and `Binary files … differ` lines, and a `diff SWITCHES A/f B/f` header before each differing pair; entries follow byte order and symlinks are followed. It walks both trees with paged listings merge-joined by name, and reads a pair only when identity does not settle it (equal inodes, equal content ids, two empty files; unequal sizes under `-q`). The edit script is minimal, but where several minimal scripts exist, a hunk may sit elsewhere than GNU diff puts it. Whitespace options, `-a`, `-c`, `-y`, `-e`, `-x`/`--exclude`, `-X`, `-P`, `--no-dereference`, and `--from-file`/`--to-file` are refused. |
| `tee` | `-a`/`--append`. Files are created or truncated before input is read and published once when it ends; their bytes are held against `maxRetainedBytes`. A consumer that stops early does not shorten the files. |
| `ls` | `-l`, `-a`, `-A`, `-1`, `-R`, `-d`, `-h`. Output is one entry per line. Missing operands are reported, then files, then directories, each group in name order. `-l` prints its own stable fields, not GNU's owner and date columns; `-h` prints its size as uutils does (powers of 1024, rounded up, one decimal below 10). `-R` groups follow path byte order. |
| `find` | Several starting points (default `.`); `-name`, `-iname`, `-path`, `-ipath`, `-type f\|d\|l` with comma lists, `-maxdepth`, `-mindepth`, `-depth`/`-d`, `-prune`, `-size [+-]N[cwbkMG]`, `-empty`, `-newer FILE`, `-mmin [+-]N`, `-mtime [+-]N`, `-print`, `-print0`, `-delete`, `-exec CMD … \;`, `-exec CMD … {} +`, `-true`, `-false`; `!`/`-not`, `-a`/`-and`, `-o`/`-or`, and parentheses. Without an action the expression prints. See [find actions](#find-actions). Malformed expressions exit 1 with GNU's diagnostics; `-execdir`, `-ok`, `-okdir`, `-regex`, access- and change-time tests (`-atime`, `-amin`, `-ctime`, `-cmin`, `-anewer`, `-cnewer`, `-newerXY`, `-used`, `-daystart`), and other predicates are refused with status 2: the filesystem keeps only mtime. Results follow path byte order, where GNU follows readdir. |
| `stat` | One or more paths; stable text fields for file, size, type, mode, and mtime. |
| `cp` | Files and `-r`/`-R`/`--recursive` trees. Metadata and content identity are preserved. |
| `mv` | One or more sources and one destination; no options. |
| `rm` | `-r`/`-R`/`--recursive`, `-f`/`--force`. |
| `mkdir` | `-p`/`--parents`. |
| `touch` | Files, directories, and final symlinks; creates missing files. No options. |
| `echo` | Bash's leading `-n`, `-e`, and `-E` option words. `-e` interprets `\a`, `\b`, `\c`, `\e`, `\f`, `\n`, `\r`, `\t`, `\v`, `\\`, `\0nnn`, and `\xHH`; `\u` and `\U` are rejected. |
| `printf` | Required format; `%s`, `%%`, and `%d` with signed ASCII-decimal operands; `\n`, `\t`, `\r`, `\\`, and `\0`; format recycling and Bash's missing-operand defaults. Width, precision, `%b`, `%q`, `%c`, other escapes, and non-decimal numeric spellings are rejected. |
| `exit` | `exit [N]`; no operand uses the current status, and numeric status is reduced modulo 256. It ends the current shell: the run, a `( … )` subshell, or its own stage of a multi-stage pipeline. |
| `pwd`, `true`, `false`, `:` | No options. `:` ignores its operands. |
| `test`, `[` | POSIX argument-count dispatch with `!` and a parenthesised whole expression. File tests `-e`, `-f`, `-d`, `-s`, `-L`, `-h`, `-r`, `-w`, `-x` (one stat each); `-n`, `-z`, `=`, `==`, `!=`; `-eq`, `-ne`, `-lt`, `-le`, `-gt`, `-ge`. Other operators and longer expressions are rejected with status 2. |
| `basename`, `dirname` | GNU output; `basename -a`, `-s`, `-z` and `dirname -z`. No filesystem access. |
| `cd` | Exactly one directory; the session retains the resulting cwd. |
| `which` | Reports built-in and injected command names as `/usr/bin/<name>`. |
| `type` | Bash 5.2 wording over the registry: `NAME is a shell keyword`, `NAME is a shell builtin` for Bash builtins (including the executor's `set`, `break`, `continue`, `export`, `unset`), and `NAME is /usr/bin/NAME` otherwise; `-t`, `-p`, `-P`, `-f`. A missing name prints `bash: line N: type: NAME: not found` and exits 1. `-a` is refused. |
| `command` | `-v` prints a builtin's or keyword's name, or `/usr/bin/NAME`; `-V` prints `type`'s description. `-p` and running `command NAME ARGS` are refused. |
| `set`, `break`, `continue`, `export`, `unset` | Executor builtins; see [Status and options](#status-and-options) and [Words and expansion](#words-and-expansion). |
| `sort` | `-k KEYDEF` (repeatable; `F[.C][OPTS][,F[.C][OPTS]]` with per-key `b d f h n r V`), `-t SEP`, `-o FILE` (read fully, then published atomically, so it may name an input), `-s`, `-u`, `-r`, `-n`, `-h`, `-V`, `-f`, `-d`, `-b`, `-c`/`--check[=silent\|quiet\|diagnose-first]`, `-C`, `-z`, and their long spellings. Byte order in the C locale; numbers compare as exact decimals. Holds its input against `maxRetainedBytes`; `-c` streams. Argument and KEYDEF errors match uutils 0.2.2; `-g`, `-M`, `-R`, `-i`, `-m`, `--sort`, `-S`, `-T`, `--parallel`, `--debug`, and `--files0-from` are refused. |
| `uniq` | `-c`/`--count`, `-d`, `-u`. |
| `sed` | Scripts from the operand or repeated `-e`, commands separated by `;` or newlines: `s` with `g`, `p`, `i`/`I`, and a numeric occurrence, `\1`–`\9` and `&` in the replacement; `p`, `d`, `q [status]`, `=`, one-line `a`, `i`, `c`, and `{ }` blocks. Addresses are line numbers, `$`, `/re/[I]`, `addr,addr`, `addr,+N`, `0,/re/`, and `!`. `-n`, `-E`/`-r`, and `-i` (in place, published once per file). Hold space, branches, labels, and file commands are refused by name. Script errors use GNU's `-e expression #N, char M:` diagnostics. |
| `xargs` | `-n`/`--max-args`, `-I`/`--replace`, `-d`/`--delimiter`, `-0`/`--null`, `-r`/`--no-run-if-empty`. |
| `cut` | `-b`, `-c` (bytes, as uutils in the C locale), `-f` with LIST (`N`, `N-M`, `N-`, `-M`, comma or space lists); `-d DELIM`, `-w`, `-s`, `--complement`, `--output-delimiter`, `-z`; files or stdin. |
| `tr` | SET1 [SET2] from stdin only; `-d`, `-s`, `-c`/`-C`, `-t`; ranges, backslash and octal `\NNN` escapes, all twelve `[:class:]` names, `[=c=]`, `[c*]`, and `[c*n]`. Byte-oriented; holds no input. |
| `nl` | `-b`/`-h`/`-f` `a\|t\|n`, `-n ln\|rn\|rz`, `-w`, `-s`, `-v`, `-i`, `-l`, `-p`, `-d` and `\:\:\:` section delimiters; files or stdin. `pREGEX` styles are refused. |
| `rev` | Files or stdin, `-0`/`--zero`. util-linux 2.41 in the C locale: a byte above 0x7f stops the run with its `fgetwc()` error. |
| `comm` | Two sorted inputs (`-` is stdin), `-1`, `-2`, `-3`, `--output-delimiter`, `-z`, `--total`, `--check-order`/`--nocheck-order`, with uutils' unsorted-input diagnostics. |
| `seq` | `LAST`, `FIRST LAST`, `FIRST INCR LAST` over exact decimals (exponents allowed); `-s`, `-t`, `-w`, `-f` with one `%f`/`%e`/`%g` directive. Output is pulled, so `seq 1 1000000000 \| head -2` stops early. `inf`, hexadecimal operands, and `%a` are refused. |
| `ln` | `-s`, `-f`, `-n`/`--no-dereference`, `-T`, `-v`, `-r` (with `-s`); hard links; `ln TARGET` into the cwd; `ln TARGET… DIR`. Refused: `-t`, `-b`, `-S`, `-i`, `-L`, `-P`, and a hard link whose source is a symlink. |
| `chmod` | Octal and symbolic modes (`u+x`, `go-w`, `a=r`, `+x`, `u=g`, `X`, `s`, `t`, comma lists), `-R`, `-v`, `-c`, and mode options such as `-w`. Directories keep their set-ID bits as on the host. The umask is a fixed 022. `-R` pages the subtree with `scan`, skips inner symlinks, and costs one call per changed entry. Refused: `-f`, `--reference`, `--preserve-root`, `--no-preserve-root`, `--dereference`, `-h`, `-H`/`-L`/`-P`. |
| `rmdir` | `-p`/`--parents`, `-v` (announces on stdout, as uutils does), `--ignore-fail-on-non-empty`. |
| `readlink` | Without options, a symlink's target, and status 1 silently otherwise. `-f`, `-e`, `-m`, `-n`, `-z`, `-v`, `-q`/`-s`. It stops at the first failed operand, as uutils does. |
| `realpath` | Default (all but the last component must exist), `-e`, `-m`, `-s`/`--no-symlinks`, `-z`, `-q`, `--relative-to=DIR`, `--relative-base=DIR`. Refused: `-L`, `-P`. |
| `tree` | `-a`, `-d`, `-L N`, `-f`, `-F`, `-i`, `-I PAT`, `-P PAT`, `--noreport`, `--dirsfirst`, `--charset=ascii\|utf-8`; operands default to `.`. tree 2.2.1 output under `LC_ALL=C`: ASCII lines unless `--charset=utf-8`, siblings in byte order, C-locale name escaping. `-I`/`-P` take tree's wildcards with `\|` alternatives. A symlink prints `name -> target` and is not descended. One listing page per shown directory, with one look-ahead sibling per open level; `\| head` stops the walk. Other options are refused with status 1. |
| `du` | `-a`, `-s`, `-c`, `-h`, `-b`/`--bytes`, `--apparent-size`, `-k`, `-m`, `-d N`/`--max-depth=N`. The filesystem has no blocks, so every size is apparent: a file's length, a symlink's target length, and 0 for a directory. The default and `-k` print 1024-byte units rounded up. Each operand is one keyset scan in path byte order, so sibling order differs from the host's readdir order. Other options, including `--exclude`, are refused with status 1. |
| `env` | `-i`, `-0`, `-u NAME`, `-`, `NAME=VALUE…`, and an optional command run through the `invoke` seam with the edited environment. Without a command it prints the run environment in snapshot order. Refused: `-C`, `-f`, `-v`, `-S`, `-a`, `--ignore-signal`, integer-like names, and a command when the stage has stdin. |
| `date` | Reads `ShellOptions.now`; UTC is the only zone (another `TZ` is refused unless `-u`). `-u`, `-d @EPOCH[.frac]` or ISO-8601, `+FORMAT` with the uutils conversions and one flag of `- _ 0 ^ #` plus a width, `-I[FMT]`, `-R`, `--rfc-3339=FMT`. Refused: setting the clock, `-f`, `-r`, `-s`, relative `-d` strings, `%c`, `%x`, `%X`, `%r`, `%Q`, `%f`, and more than one output format. |
| `sleep` | `N[smhd]…`, summed; fractions and exponents are allowed. It waits for real. A total above 60 seconds is refused, because one run is one Durable Object request. Hexadecimal intervals are refused. |
| `mktemp` | `-d`, `-u`, `-q`, `-t`, `-p DIR`, `--tmpdir[=DIR]`, `--suffix=S`, `[TEMPLATE]`. The default is `$TMPDIR` or `/tmp` plus `tmp.XXXXXXXXXX`; random characters come from `crypto.getRandomValues`. It creates a 0600 file or a 0700 directory and never creates the parent. |
| `sha1sum`, `sha256sum`, `sha512sum` | `-b`, `-t`, `--tag`, `-z`, and `-c` with `--quiet`, `--status`, `-w`, `--strict`, `--ignore-missing`; uutils output and check grammar. Each input is held whole under the retained budget. There is no `md5sum`: WebCrypto has no MD5. |
| `base64` | `-d`, `-i`, `-w COLS`, `[FILE]`. It streams in fixed slices both ways and decodes with uutils' strict rules. |
| `jq` | `jq [OPTIONS] FILTER [FILES…]`, a jq 1.8.1 subset. Options: `-r`, `-j`, `-c`, `-n`, `-s`, `-e`, `-S`, `-a`, `-R`, `-M`, `--tab`, `--indent N`, `--arg`, `--argjson`, `--args`, `--jsonargs`, `--raw-output0`, `--`, and their long spellings. See [jq](#jq). |
| `awk`, `mawk` | mawk 1.3.4 semantics over bytes (C locale). `-F fs`, `-v var=value`, one `-f progfile`, `--`; operands are files, `-`, or `var=value` assignments applied when reached. See [awk](#awk). |
| `patch` | Unified diffs from stdin, `-i FILE`, or a second operand; plain `---`/`+++`, `Index:`, `Prereq:`, and git headers (`diff --git`, new/deleted file mode, `/dev/null`, rename, copy, mode). Options: `-pN`/`--strip`, `-R`, `--dry-run`, `-N`, `-s`, `-d DIR`, `-f`, `-t`, `-E`, `--no-backup-if-mismatch`, `-F N`, `-r FILE` (`-` discards), `-i FILE`, and an ORIGFILE operand. Offsets and fuzz (default 2), unified `.rej`, `.orig` on mismatch, reversed/applied detection with the no-terminal default answers, `\ No newline at end of file`, and exit statuses and messages as GNU patch 2.8 prints them. Names that are absolute, contain `..`, or pass through a directory symlink out of the working directory are not patched (an operand is exempt); a final symlink is not a regular file. Refused with status 2: context, normal, and ed diffs, symlink patches (mode 120000), `-o`, `-b`, and the other GNU options not listed. Git binary patches are skipped with GNU's message. |

`patch` holds the diff against `maxRetainedBytes` with a 4-byte-per-line
index. Hunk lines are offsets into it, and hunks, plan steps, rejects, and
progress messages are reserved typed-array rows or byte chunks. Each patched
file is held with an 8-byte-per-line index and hash. A hash index lets each
fuzz level probe only the positions of the hunk's rarest line; it is built
only when it fits comfortably in the remaining budget, and otherwise the
search scans, comparing hashes before bytes. Every reservation is returned on
success and on failure. Output streams from the plan in chunks of at most
64 KiB. The work runs before stdout is returned, so it does not depend on
stdout's reader. Git-style outputs are staged in one hidden
`.patch-staging~` directory, published by one bulk backup copy and bulk copies
of at most 1,000 files, and removed in one call; a dry run creates none. A
failed run removes the directory with a call not counted against
`maxOperations`, so exhausting the budget leaves nothing hidden behind. A
backup is copied before its target is replaced, and a file already written in
the run is not backed up again. When added lines follow a copied final line
that has no newline, `patch` ends that line first; GNU patch sometimes joins
them, for example after fuzz.

`grep` uses GNU grep defaults: non-recursive, dotfiles included, and BRE unless
`-E` is present. It supports `-r`/`-R`/`--recursive`, `-i`, `-n`, `-l`, `-L`,
`-v`, `-E`, `-F`, `-c`, `-w`, `-x`, `-h`, `-H`, `-s`, `-o`, `-q`, `-A`, `-B`,
`-C`, repeated `-e`/`--regexp`, and `--include`/`--exclude`. `-m` is rejected
with an explicit instruction to use `head`.

Both searches exit 2 when a path fails, even if another path matched; `-q`
exits 0 on a match despite such a failure. `-q` stops at the first selected
line and runs as `-l`, so a literal pattern is still answered by the database.
`-o` prints each non-empty match on its own line. The two binaries differ
around it, and each surface follows its own: GNU grep drops context lines but
keeps their `--` separators and prints nothing under `-v`; rg keeps context
lines and prints whole selected lines under `-v`.

`rg` is recursive by default, skips hidden paths by default, and uses ERE. It
supports `-i`, `-S`, `-s`, `-n`, `-N`, `-l`, `-v`, `-F`, `-c`, `-w`, `-x`, `-o`, `-q`,
`--hidden`, filename controls, `--no-heading`, `--no-ignore`, `-A`, `-B`, `-C`,
repeated `-e`/`--regexp`, `-g`/`--glob`, and `-t`/`--type`. Known types are
`ts`, `js`, `md`, `json`, `css`, `html`, `py`, `go`, `rust`, `sh`, `yaml`,
`toml`, and `sql`. Ignore files are deliberately not read.

File searches also support `-m`/`--max-count`, `-U`/`--multiline`, and `--json`.
JSON records carry UTF-8 byte offsets and grouped submatches; multiline searches
can span source lines. Non-UTF-8 record content uses base64 `bytes` fields; named
binary files keep JSON output and report `binary_offset` in the end record.
These three flags are refused on stdin. JSON mode refuses
count, file listing, inverted matches, only-matching, quiet and context options;
multiline mode refuses inverted matches, only-matching and context options.

### find actions

- `-exec CMD ARGS… \;` runs the registered command once per path; `{}` is
  replaced wherever it appears, including in the command name. It is a test:
  true when the command exits 0. An unknown command prints
  `find: 'CMD': No such file or directory` and the test is false. After each
  run the walk re-reads one scan page, so a row the command removed gets GNU's
  `No such file or directory` diagnostic and its subtree is skipped.
- `-exec CMD ARGS… {} +` batches paths; `{}` must be the last argument before
  `+`. A batch holds at most 131,072 bytes and 10,000 argv entries. It is always
  true; find exits 1 if any batch failed. Expressions with `-exec` use the scan
  walk, not the indexed glob.
- `-delete` implies `-depth`. It removes files, symlinks, and empty
  directories; a non-empty directory prints `cannot delete 'X': Directory not
  empty` and find exits 1. Deletions are queued in generations, children before
  parents, and flushed every 1,000 paths, before any `-exec`, and at the end:
  one `removeFiles` call per generation. Without `-exec`, `-delete` returns true
  when the path is queued. With `-exec` each deletion is immediate.
- When the expression has `-delete` or `-exec`, closing find's stdout (for
  example `| head`) finishes the walk with output discarded, bounded by the
  operation ceiling. Pure expressions stop early.
- A starting point ending in `/` follows a symlink to a directory; one that is
  not a directory prints `'X': Not a directory` and find exits 1.
- `-size` rounds up to whole units (default 512-byte blocks); a directory
  counts as 4,096 bytes. `-empty` reads directory emptiness from the scan page
  already read. `-newer FILE` compares against FILE's mtime, stat'ed once.
  `-mmin` and `-mtime` compare against `ShellOptions.now`, sampled once;
  `-mtime +N` means at least N+1 whole days old.

### jq

`jq` follows jq 1.8.1 byte for byte: output formatting, number literals kept as
typed, parse errors, and `(at file:N)` positions. The language covers paths,
`..`, slices, construction, arithmetic with jq's type rules, comparisons in
jq's total order, `and`/`or`/`not`/`//`, `if`/`elif`/`else`, `try`/`catch`,
`?`, `as` with destructuring, `reduce`, `foreach`, `label`/`break`,
non-recursive `def`, string interpolation, the `@text`, `@json`, `@csv`,
`@tsv`, `@html`, `@uri`, `@urid`, `@sh`, `@base64`, and `@base64d` formats,
`$ENV`, `$ARGS`, `$__loc__`, and the assignment operators. Builtins cover jq's
core set, including `walk`, `IN`, `INDEX`, `tostream`, `transpose`, `pick`,
`halt_error`, regex functions, UTC dates, `input`, `inputs`, `debug`, `stderr`,
and `input_filename`.

Regexes use Oniguruma syntax and run on a linear-time matcher, so no pattern
can backtrack without bound. Where Oniguruma stops with `retry-limit-in-match
over`, `jq` here returns the real result. Lookaround, backreferences, and
inline options other than a leading `(?i)` or `(?x)` are refused. Recursive
walks over input values use an explicit stack, so input nested 10,000 deep
works. Each input is charged at its estimated parsed size, and values a program
builds count against `maxRetainedBytes`.

Refused with status 2: `while`, `until`, `repeat`, recursive `def`,
`recurse(f)` where `f` is not a chain of path steps, unbounded `range`,
modules, `?//`, `input_line_number`, other builtins outside the admitted set,
programs nested deeper than the JavaScript stack, and the options `-C`,
`--seq`, `--stream`, `-f`, `-L`, `--slurpfile`, `--rawfile`, and
`--unbuffered`.

### awk

Programs admit `BEGIN`/`END` (several), pattern-action rules, pattern-only
rules, range patterns, functions, `if`/`else`, `for (k in a)`, `next`,
`nextfile`, `exit [n]` (END still runs), `delete a[k]`, `delete a`, and
`print`/`printf` to stdout. Expressions follow mawk's precedence and strnum
comparison rules; `$expr` and `NF` assignment rebuild `$0` with OFS; SUBSEP
subscripts and `(i,j) in a` work. Builtins are `length`, `substr`, `index`,
`split`, `sub`, `gsub`, `match`, `sprintf`, `tolower`, `toupper`, `int`,
`sqrt`, `exp`, `log`, `sin`, `cos`, `atan2`, and `fflush`. FS and RS may be a
single blank, a single character, empty, or a regex; `RS=""` is paragraph mode.
Regexes use mawk's dialect with POSIX classes and `{n,m}` intervals, matched
leftmost-longest in linear time. Number conversion follows CONVFMT/OFMT and C
`printf` rounding. Diagnostics and exit status 2 follow mawk. Records stream;
arrays, strings, fields, and buffered output are charged to
`maxRetainedBytes`.

`for (k in a)` visits keys in insertion order; mawk's hash order is not
reproduced. No loop lacks a structural bound: `while`, `do`, and C-style `for`
are refused, and a call graph with a cycle is refused at parse time. Nesting
deeper than 100 levels is a syntax error, and a call chain deeper than 100 is
refused, so parsing and evaluation stay within a Worker's stack. CPU time is
not budgeted. `getline`, output redirection and pipes, `system`, `close`, the
clock functions, and `rand`/`srand` are refused by name with status 2.

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
`find` scans keyset pages and resumes past a pruned or too-deep subtree rather
than reading it; an expression of only `-name`, `-path`, and actions uses
keyset-paged indexed globs narrowed by the `-name` pattern. Literal recursive
search pushes the content predicate into SQLite when its semantics permit it.

`find`, `ls`, `grep -r`, and `rg` print a result under an operand as the
operand typed plus the rest of the path, so `find .` prints `./a` and
`grep -r x src/` prints `src/a`. `grep -r` and `rg` without a path search the
working directory and print bare relative paths. The
[path parity suite](../../tests/shell/parity-bash-paths.test.ts) compares these
with the GNU tools.

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
| Loop iterations | 10,000 per run | Every `for` iteration, in subshells and pipeline stages too, counts against one run-wide budget equal to the argv ceiling; the first excess fails the run with exit 2. |
| Nesting | 64 levels | Compound commands, command substitutions, and `${…}` words nested deeper are refused before anything runs. |
| Async redirect input | `maxRetainedBytes` | Input is pulled sequentially before atomic publication. Synchronous producers continue to stream incrementally without retaining the complete output. |

`RunResult.truncated` is the OR of public sink truncation and every settled
command's truncation signal. `RunResult.operations` reports the shell-visible filesystem call count.
`RunResult.peakRetainedBytes` reports the measured peak intermediate-byte
reservation for the run. It excludes public stdout and stderr, because those
have their own caps. An injected Git command performs separately bounded SQL
work through its runner, so that SQL is deliberately excluded from
`RunResult.operations`.

Before Git runs, the adapter derives output ceilings from the planned
destination. Terminal stdout gets the bytes remaining in the public sink and
direct stderr the remaining stderr sink, each capped by the available retained
memory. An upstream pipeline or a redirect gets Git's intrinsic ceiling and any
trailing-`head` demand hint; merged stderr follows its stdout destination, and
dropped stderr retains and charges nothing. The Git runner then applies its
intrinsic 16 MiB stdout, 1 MiB stderr, and 16 MiB combined maxima. A read-only
Git command that exceeds its ceiling fails with an output limit.

Every admitted mutating Git argv command, local or network, commits its outcome
before its output is sized. Only a terminal sink truncates: direct stdout or
stderr returns the prefix that fits, keeps Git's exit status, and contributes
`truncated: true` to the shell result. Pipe and redirect bytes are semantic
input, so when they exceed `maxRetainedBytes` the mutation persists; the shell's
retained limit fails the run with exit 2, and a redirect target stays
unchanged. The Git-side policy is documented in
[Git support](git-support.md#strict-argv-runner).

Clone, fetch, pull, ls-remote, and push remain transport operations owned by the
Git layer. Their published-result certainty and truncation policy is documented
in [Git support](git-support.md#strict-argv-runner); the shell only propagates
the settled result. `git pull --rebase [<remote> [<branch>]]` enters the durable
rebase lifecycle after fetch publication. A conflict exits non-zero and remains
recoverable through `git rebase --continue`, `--skip`, or `--abort`, including
after the workspace is reopened.

## Deliberate boundaries

Positional and special parameters other than `$?`; `${…}` operators other than
the default, alternative, assign, and error forms and `${#NAME}`; `$'…'`,
`$"…"`, and `$(< file)`; arrays; `readonly`, `local`, `declare`, and `typeset`;
prefix assignments before `export` or `unset`; the listing forms of `export`
and `unset`; and any change to `IFS` are rejected. So is a command substitution
or unquoted expansion in a redirection target after a stderr redirection other
than `2>/dev/null`. Arithmetic (`$((…))`, `((…))`, `for ((…))`), process
substitution, `while`, `until`, `case`, `select`, functions, `[[ ]]`, `time`,
`coproc`, `for NAME` without `in`, and background jobs remain rejected. A
malformed command is refused before anything runs, where Bash would first run
the lines before the syntax error. There is no external-process fallback.

Tilde prefixes other than a bare `~` (`~user`, `~+`, `~-`), a tilde with no
`HOME`, braces or a tilde in a command name, `$NAME{…}` after an unbraced
parameter, an unquoted `$` inside a brace expression, character sequences
across letter cases (`{a..Z}`), and brace nesting deeper than 64 levels are
rejected with exit 2. A named tilde prefix known before the run starts is
rejected before any statement runs.

`printf`, `echo`, and `test` deliberately reject the forms listed in their
command rows. `exit`, `test`, and `[` report errors as Bash's builtins do, as
`bash: line N:` with the source line the command starts on.
The [printf](../../tests/shell/parity-bash-printf.test.ts),
[exit](../../tests/shell/parity-bash-exit.test.ts), and
[script](../../tests/shell/parity-bash-scripts.test.ts) parity suites compare the
admitted forms with Bash and pin these intentional refusals locally. Bash parity
is the standing admission gate for future shell syntax and commands; see
[ADR-0019](../decisions/0019-admit-a-bounded-posix-shell-surface.md) and
[ADR-0027](../decisions/0027-widen-the-shell-to-compound-syntax-and-text-tools.md).

The completed design and historical measurements remain in the
[archived shell plan](../archive/plans/shell.md). Agent-facing implementation
rules are in [`packages/do/src/shell/CLAUDE.md`](../../packages/do/src/shell/CLAUDE.md).
