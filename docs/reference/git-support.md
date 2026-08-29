# Git support checklist

What of Git kompjutr implements, command by command, down to the options that
matter.

## How to read this

kompjutr has no external process or general Git command line. Its primary API is
the typed `Git` interface from `kompjutr/git` (and the narrower `GitClient` from
`kompjutr/compat/computer`). A strict local argv runner covers the agent command
subset described below. It never falls back to a binary or admits an unlisted
command.

The tables therefore map the familiar command-line spelling to the option that
provides it. **A flag that is not listed is not supported.** Unsupported typed
input fails with a stable `error.code`; the argv runner returns its frozen
command-specific refusal. Nothing silently degrades.

| Mark | Meaning |
|---|---|
| ✔ | supported |
| ~ | supported with a stated difference from Git |
| ✘ | not supported — fails, or has no equivalent |
| ★ | issued by the [reference workload](#the-reference-workload); it combines with the support mark, so `★ ✘` is a gap that workload runs into |

Two surfaces exist. The native `Git` interface is the full one. The Computer
compatibility client exposes a subset — see [Surface
differences](#surface-differences).

## The reference workload

The ★ marks come from one concrete consumer: a per-project sandbox hosted by a
Durable Object, in which a coding agent edits a checkout of a GitHub repository.
It is the closest running workload to what kompjutr replaces, so what it issues
is recorded here command by command.

Two callers issue Git, with different needs.

**The orchestrator**, outside the sandbox, owns the repository lifecycle: a
partial clone of the project, one worktree per session on that clone, a
force-pushed branch mirror plus a snapshot of the *uncommitted* worktree after
every agent turn, publish by fast-forward merge into `main`, rebase onto `main`,
discard and restore, and periodic pruning of its own mirror refs. It
authenticates per command with a short-lived token, and keeps state in refs
outside `refs/heads/*` — `refs/checkpoints/<id>`, `refs/backups/<id>/<ts>`,
`refs/recovery/…`.

**The agent**, inside the sandbox, runs local Git only: `status --short`,
`add <paths>`, `commit -m`, `log`, `diff`, and conflict resolution during a
rebase (`add <file>`, `rebase --continue`, `rebase --abort`). Every network
subcommand is refused before it runs, because the sandbox holds no credentials —
so `push`, `fetch`, `pull`, `clone` and `ls-remote` never appear on that side.

[Reference workload coverage](#reference-workload-coverage) collects what that
workload would need gained, or routed differently.

The native surface supports several isolated session checkouts over one shared
store, bounded divergence against a caller-selected base, offline raw ref reads,
atomic checkpoint transport, and remote ref discovery. A consumer adapter
belongs to the consumer repository, not this package. Partial clone remains the
main network gap. Local snapshot replay is available without textual patch
interchange.

## Strict local argv runner

Native `Git` implements synchronous
`runCli(input, options?): GitCliResult`; `cli(input)` is its asynchronous wrapper.
The Computer compatibility client's `cli(input)` invokes the same dispatcher.
`GitCliRunner`, `GitCliInput`, `GitCliResult`, and `GitCliRunOptions` are public
types from `kompjutr` and `kompjutr/git`.

The accepted argv grammar is exact:

| Command | Accepted argv |
|---|---|
| `status` | Exactly one of `--porcelain`, `--porcelain=v1`, `--short`, `-s` |
| `diff` | No operands or options |
| `log` | At most one of `-1`, `-n <count>`, `--max-count=<count>`; at most one of `--oneline`, `--format=<template>`; then at most one ref or admitted `<a>..<b>` range |
| `rev-list` | Exactly `--count <a>..<b>` |
| `symbolic-ref` | Exactly `--short <ref>` |
| `add` | One or more literal paths; an optional `--` ends option parsing |
| `commit` | Exactly `-m <message>` or `--message=<message>` |
| `rebase` | Exactly `--continue` or `--abort` |

`log` counts are ASCII decimals from 0 through 50,000; `-1` is the only joined
shorthand. Custom log formats accept literal UTF-8 plus `%H`, `%h`, `%P`, `%s`,
`%B`, `%an`, `%ae`, `%at`, `%cn`, `%ce`, `%ct`, `%n`, and `%%`. A log range is
admitted only when the right tip reaches the left OID through a single-parent
chain. Merge, divergent, unrelated, and shallow-boundary ranges fail closed.
`rev-list --count` retains its bounded two-sided graph semantics and therefore
also handles merge and divergent histories.

Expected command and Git-domain failures are returned as a command-specific
`{ stdout, stderr, exitCode }` triplet. They are not collapsed into one generic
usage result. For example, unknown `status` and `diff` options exit 129 with
usage on stderr; invalid `log` options and counts exit 128 with a fatal line; an
unknown subcommand exits 1; and `fetch`, `push`, `pull`, `clone`, and `ls-remote`
exit 128 without reaching transport. Commit refusals may report status on
stdout. A successful rebase continuation places the commit summary on stdout
and completion text on stderr. Unexpected implementation errors still throw.

`cwd` is an absolute checkout path and defaults to `/`; the input does not
accept the typed API's `dir` field. Paths resolve from `cwd`, cannot escape the
selected checkout, and keep repository-root-relative output. Accepted commands
do not read stdin; a supplied string is validated and ignored. Only
`GIT_AUTHOR_NAME`, `GIT_AUTHOR_EMAIL`, `GIT_COMMITTER_NAME`, and
`GIT_COMMITTER_EMAIL` affect commit identity. Complete environment identities
win over repository config and the binding default. Unlike Git, a partial
environment identity is not completed field-by-field from config.

Input limits are 256 argv entries and 1 MiB of argv bytes, 256 environment
entries and 1 MiB of environment key/value bytes, 1 MiB of stdin, 4,096 cwd
bytes, 1 MiB per commit message, and 64 KiB per log format. Default output
ceilings are 16 MiB stdout, 1 MiB stderr, and 16 MiB combined. Run options can
only tighten those ceilings, discard stderr, or provide a log count hint up to
50,000. Plain `diff` scans at most 100,000 worktree source rows, including
untracked rows it must discard, and renders unmerged paths in Git's combined
format. The first excess fails with `E2BIG`; semantic output is never truncated.

`add`, `commit`, and both rebase actions execute their mutation, format their
success output, and preflight all retained output inside one database
transaction. An output failure therefore rolls back index, worktree, refs, and
operation state. Expected operation failures are mapped only after rollback and
cache revalidation.

## Repository creation

### `git init` — `init()`

| Git | kompjutr | |
|---|---|---|
| `--initial-branch=<name>` | `defaultBranch` (default `main`) | ★ ✔ |
| `--bare` | `bare` | ~ recorded as `core.bare` only; every repository is effectively bare, since the object database is never a directory |
| working directory, `git -C <dir>` | `dir` (default `/`) | ★ ~ several repositories may share one workspace; `init()` records the checkout in SQLite but does not create `dir` in the filesystem |
| `--template`, `--separate-git-dir`, `--shared` | — | ✘ |

If `dir` did not exist before `init()`, walking the fresh checkout root returns
`ENOENT` until a write or explicit directory creation materialises it. Both the
native and Computer surfaces use this database-only creation path.

### `git clone` — `clone()`

| Git | kompjutr | |
|---|---|---|
| `<url>` | `url` | ★ ✔ `http://` and `https://` only — `ssh://`, `git://` and local paths fail with `EURLSCHEME` |
| `--depth <n>` | `depth` | ✔ omitted or `0` means complete history; a positive safe integer is shallow and implies `singleBranch: true` unless explicitly overridden |
| `--single-branch` / `--no-single-branch` | `singleBranch` | ✔ complete clones default to all branches; a positive safe-integer `depth` defaults to one branch |
| `--no-tags` / `--tags` | `noTags` | ✔ `true` suppresses tags; omitted or `false` uses Git clone coverage — complete for all branches, reachable auto-follow for one branch |
| `--branch <ref>` | `ref` | ★ ✔ |
| `--origin <name>` | `remote` (default `origin`) | ✔ |
| — | `paths` | ✔ check out only these paths (kompjutr extension) |
| auth | `headers`, `onAuth`, `onProgress`, `onMessage` | ★ ✔ a per-command credential helper maps onto `onAuth` |
| `--filter=<spec>` (partial clone) | — | ★ ✘ the reference workload clones every project `--filter=blob:none` and backfills blobs lazily |
| `--bare`, `--mirror`, `--recurse-submodules`, `--reference` | — | ✘ |

Clone sets `remote.<name>.url`, `remote.<name>.fetch`,
`branch.<name>.remote` and `branch.<name>.merge`. A clone that fails leaves no
repository behind.

## Working tree and index

### `git worktree` — `worktreeAdd()`, `worktreeList()`, `worktreeRemove()`, `worktreePrune()`

| Git | kompjutr | |
|---|---|---|
| `worktree add <path> <branch>` | `worktreeAdd({ root, target: { kind: "existing-branch", name } })` | ★ ✔ the branch must exist and must not be attached elsewhere |
| `worktree add -b <name> <path> [<start>]` | `target: { kind: "new-branch", name, startPoint? }` | ★ ~ branch creation, checkout state, and filesystem population are atomic, unlike Git's possible leftover branch after a later add failure |
| `worktree add --detach <path> [<start>]` | `target: { kind: "detached", startPoint? }` | ✔ |
| `worktree list` | `worktreeList()` | ★ ~ returns frozen `WorktreeInfo[]` in UTF-8 root order, including exact `present` or `missing` root state |
| `worktree remove <path>` | `worktreeRemove({ root })` | ★ ✔ refuses the primary, dirty, or busy checkout |
| `worktree remove --force <path>` | `worktreeRemove({ root, force: true })` | ★ ~ bypasses dirtiness only; a live operation still fails with `EWORKTREEBUSY` |
| `worktree prune` | `worktreePrune()` | ★ ✔ atomically removes every missing non-primary checkout, or none if an eligible checkout is busy |
| `move`, `lock`, `unlock`, `repair` | — | ★ ✘ no `.git/worktrees` administrative layout, pointer files, locks, or root relocation |

Every `dir`-routed Git operation selects the nearest checkout root. Checkouts of
one store share objects, packs, ordinary refs, config, and shallow state while
keeping raw `HEAD`, index, tracker, dirty state, operation state, and `HEAD`
history isolated. Exactly one checkout is primary. A branch attached by exact
raw `ref: refs/heads/*`, including an unborn branch, can belong to only one
checkout; another attachment fails with `EBRANCHINUSE` and has no force bypass.

### `git status` — `status()`, `statusReport()`, `statusStream()`, formatters

| Git | kompjutr | |
|---|---|---|
| `--porcelain=v1` | `formatPorcelainV1(entries, options?)` | ★ ✔ |
| `--porcelain=v2` | `formatPorcelainV2(details, branch?, options?)` | ✔ ordinary, unmerged, untracked, ignored, and optional branch rows |
| `--short` | `formatShort(entries, options?)` | ★ ✔ |
| `core.quotePath` | `statusFormatOptions(repo, overrides?)` | ✔ Git boolean syntax, default `true`; an explicit `quotePath` override wins |
| `-z` (NUL-framed output) | `zeroTerminate: true` | ★ ✔ disables quoting, NUL-terminates every record and branch header, and emits a rename as destination NUL source NUL |
| `-- <paths>` | `GitStatusOptions.paths` | ~ exact path or directory prefix, no globs |
| `--ignored` | `GitStatusOptions.includeIgnored` | ✔ ignored entries use `!!` in v1/short and `!` in v2 |
| `--untracked-files=no\|normal\|all` | `GitStatusOptions.untrackedFiles` | ✔ default `normal`; `no` suppresses untracked and ignored rows, `normal` collapses wholly untracked directories, and `all` lists their files |
| `-b`, `--branch` header | `statusReport({ branch: true })` | ✔ `oid`, `head`, configured upstream, and bounded ahead/behind counts |
| rename detection (`R`) | `GitStatusOptions.renames` | ~ exact OID moves only; defaults on |
| unmerged codes (`U`, `AA`, `DD`) | `StatusDetail.unmerged` | ★ ✔ all seven legal index-stage shapes and porcelain v2 `u` rows |

`status()` and `Git.status()` remain array-returning APIs. `statusReport()` and
`Git.statusReport()` add an object result only when callers need branch
metadata. `StatusEntry` uses `" " A M D ? ! U R`. An exact rename row uses the
destination as `path`, carries the source as `originalPath`, and reports
`similarity: 100`. `StatusDetail` adds the modes and OIDs required by ordinary,
unmerged, and rename porcelain v2 rows. Exact detection pairs equal authoritative
blob OIDs within compatible regular-file or symlink mode classes. It honours an
explicit `renames` value before `status.renames`, then defaults on. The Computer
compatibility facade keeps its pinned `dir`-only input, disables rename detection,
and rejects unmerged rows that its installed interface cannot express.

In newline mode the formatters use Git's C quoting for control bytes, double
quotes, and backslashes. With `quotePath: true`, they also octal-escape each
non-ASCII UTF-8 byte; `false` leaves valid non-ASCII text raw while still
quoting unsafe ASCII. Porcelain v1 and short also quote leading or trailing
spaces, and quote either side of a rename when it contains the literal ` -> `;
porcelain v2 does not quote a path solely for those conditions. Rename paths
are always processed independently. The formatters and `statusFormatOptions()`
are standalone exports from `kompjutr` and `kompjutr/git`, not methods on `Git`
or the Computer compatibility client. Formatting fails with `E2BIG` rather
than exceeding its bounded record or output budget.

Git tree names may contain arbitrary non-NUL bytes; kompjutr's path model is
valid UTF-8 only. Invalid UTF-8 in an authoritative tree name fails with
`EUNSUPPORTED` before a loose object is published or a pack becomes readable,
and raw SQL tree-name bytes are validated again during traversal. NUL and
ill-formed UTF-16 are also rejected at the public formatter boundary.

When a path exists in HEAD, has been removed from the index, and still exists
in the working tree — the `rm({ cached: true })` shape — status emits both the
staged deletion and a separate untracked row. The second row follows the same
ignore and `untrackedFiles` rules as any other untracked path: it is omitted by
`no`, collapsed by `normal`, listed individually by `all`, or reported as
ignored when `includeIgnored` requests ignored rows. Status groups ordinary
rows before untracked rows and ignored rows in eager `status()` and
`statusReport()` arrays, and therefore in formatted output, with UTF-8 byte
ordering inside each group. The staged deletion thus precedes the same path's
untracked row; `statusStream()` remains path/window ordered.

### `git add` — `add()`

| Git | kompjutr | |
|---|---|---|
| `<pathspec>...` | `paths` | ★ ~ exact path or directory prefix; no globs, no `:(exclude)` magic |
| `-A`, `--all` | `all` | ★ ✔ |
| `-u`, `--update` | `trackedOnly` (with `all`) | ✔ this is the `commit -a` shape |
| `-f`, `--force` | `force` | ★ ✔ stage an ignored path |
| explicitly named ignored path without `--force` | default | ★ ~ succeeds without changing the index, matching isomorphic-git and the Computer contract; the Git CLI fails |
| `-p`, `-i`, `-N`, `--renormalize` | — | ✘ |

A pathspec that matches nothing throws `PathspecNotFoundError`. An ignored path
exists and therefore counts as a match even when it is skipped; `force: true`
stages it.

### `git rm` — `rm()`

| Git | kompjutr | |
|---|---|---|
| `<pathspec>...` | `paths` | ★ ~ exact path or directory prefix; no globs or pathspec magic |
| default | `cached: false` (default) | ✔ removes matching index entries and working-tree files |
| `--cached` | `cached: true` | ✔ removes only matching index entries |
| `-f` | `force: true` | ★ ✔ bypasses content safety, not structural, matching, or resource checks |
| `-r` | `recursive: true` | ✔ required when a pathspec selects directory descendants |
| `--ignore-unmatch` | — | ✘ an unmatched pathspec throws `EPATHSPEC` |

Without `force`, remove-and-unstage accepts a missing working-tree file, or a
path whose index matches HEAD and whose working tree matches the index. Cached
removal accepts a path when either the index matches HEAD or the working tree
matches the index. Other staged or working-tree changes throw
`EUNSAFEREMOVE` before mutation. Paths with unmerged index stages are exempt
from content safety and may be removed as conflict resolution.

A directory pathspec without `recursive` throws `EISDIR`. An indexed file that
is a working-tree directory also throws `EISDIR`, even with `force`. Removal and
index updates are atomic. Empty parent directories are pruned, but untracked
contents are retained. Symlinks are removed without following their targets.
The native client never removes index entries or working-tree paths beneath a
registered nested repository root.

### `git reset` — `reset()`

| Git | kompjutr | |
|---|---|---|
| `--mixed` (default) | default | ★ ✔ replaces the index from `ref` |
| `--hard` | `hard` | ★ ✔ rewrites index and working tree, and clears any pending merge/replay state |
| `<commit>` | `ref` (default HEAD) | ★ ✔ |
| `-- <paths>` | `paths` | ✔ unstage those paths; clears their conflict stages |
| `--soft`, `--merge`, `--keep` | — | ✘ |

### `git checkout` / `git switch` — `checkout()`, `branch()`

| Git | kompjutr | |
|---|---|---|
| `git checkout <ref>` | `checkout({ ref })` | ★ ✔ branch, tag or commit; a commit detaches HEAD |
| `git checkout -- <paths>` | `checkout({ ref, paths })` | ★ ✔ HEAD stays put; absent paths are not pruned |
| `git checkout -f` | `force` | ✔ otherwise a blocking local change throws `ECHECKOUTFAIL` |
| `git checkout -b <name>` | `branch({ name, checkout: true })` | ★ ~ points HEAD at the new branch but does not move the working tree; follow with `checkout()` when `startPoint` differs from HEAD |
| `git switch`, `git restore` | — | ✘ no separate spelling |
| `--orphan`, `--track`, `--merge`, `--patch` | — | ✘ |

### `git clean` — `clean()`

| Git | kompjutr | |
|---|---|---|
| `-n`, `--dry-run` | `dryRun` | ✔ |
| `-d` | `directories` | ★ ✔ |
| `-- <paths>` | `paths` | ✔ exact or directory prefix |
| `-f` | — | ★ ~ implicit: without `dryRun`, `clean()` removes |
| `-x`, `-X` | — | ✘ ignored files are always preserved |

### `git diff` — `diff()`, `diffSummary()`

| Git | kompjutr | |
|---|---|---|
| `git diff` | `{}` | ✔ working tree vs HEAD |
| `git diff <ref>` | `{ ref }` | ★ ✔ working tree vs a commit |
| `git diff <a> <b>` | `{ ref, to }` | ✔ commit vs commit |
| `git diff --cached` / `--staged` | — | ✘ there is no index-vs-HEAD mode |
| `-U<n>` | `context` | ✔ |
| `--abbrev=<n>` | `abbrev` (default 7) | ✔ |
| `-- <paths>` | `paths` | ~ exact or directory prefix, no globs |
| `--numstat`, `--name-status`, `--name-only` | `diffSummary()` | ★ ~ returns structured objects, never framed text; exact renames have `R`, source path, similarity 100, and zero line delta |
| `-M100%` (exact rename detection) | `renames` | ~ equal authoritative blob OIDs and compatible modes only; defaults on |
| similarity-scored `-M<n>`, `-C` | — | ✘ move-plus-edit remains a complete add/delete pair |
| `--binary`, `--full-index` | — | ★ ✘ no patch text an `apply` could consume; binary files emit `Binary files a/… and b/… differ` |
| `--stat`, `--color`, `--word-diff` | — | ✘ |

Output is a `diff --git` patch with correct `new file` / `deleted file` /
`old mode` / `new mode` / `index` headers. Exact moves use `similarity index
100%`, `rename from`, and `rename to` headers. Explicit `renames` overrides
`diff.renames`; the default is enabled. Detection retains at most 10,000
candidates and 16 MiB. Exceeding either cap disables all pairing for that
operation and returns the complete add/delete output.

## Commits and history

### `git commit` — `commit()`

| Git | kompjutr | |
|---|---|---|
| `-m <msg>` | `message` | ★ ~ **required**; an empty message throws `EMSG` |
| `--amend` | `amend` | ✔ |
| `--author` | `author` | ✔ |
| committer override | `committer` | ✔ |
| `GIT_AUTHOR_*` / `GIT_COMMITTER_*` | `env` | ~ read from the passed record only, never from `process.env` |
| `-a` | `add({ all: true, trackedOnly: true })` first | ~ separate call |
| `--allow-empty` | `allowEmpty: true` | ★ ✔ native only |
| continue a merge | `commit()` during a pending merge finalizes it | ✔ `--amend` is rejected there |
| `-F <file>`, `-S`, `--fixup`, `--squash`, `--no-verify` | — | ✘ (no hooks and no signing exist) |

Identity resolution order: explicit option → amended commit (author only) →
`env` → `user.name`/`user.email` → the binding's `defaultIdentity`. A source
wins only when it supplies both name and email; none left throws
`MissingIdentityError`.

An ordinary commit refuses a tree identical to its first parent with
`EEMPTYCOMMIT` unless the native caller sets `allowEmpty`. The same default
refuses an empty root commit; a non-empty root commit succeeds. Amend and
integration continuation keep their own semantics and may create a commit
without an ordinary tree change.

### `git log` — `log()`

| Git | kompjutr | |
|---|---|---|
| `<ref>` | `ref` (default HEAD) | ★ ✔ |
| `-n <count>`, `--max-count` | `depth` | ★ ✔ |
| `--format`, `--pretty`, `--oneline` | — | ★ ~ returns `CommitView[]`, never formatted text; the caller formats |
| `<a>..<b>` (commit range) | — | ★ ✘ `log()` walks back from one tip; a range has to be bounded by the caller |
| `-- <paths>`, `--follow`, `--all`, `--graph` | — | ✘ |

### `git show` — `show()`

Returns the commit's `CommitView` (oid, message, tree, parents, author,
committer). ✘ no patch output, ✘ no tree/blob display.

### `git rev-parse` — `revParse()`

| Syntax | |
|---|---|
| `HEAD`, branch, lightweight tag, `refs/...` | ★ ✔ resolves the ref's direct object id |
| annotated tag of a commit | ✔ the bare name remains the tag-object id, matching Git; `^0` peels it to the commit |
| full 40-char oid | ★ ✔ |
| abbreviated oid | ✔ resolved by unique prefix |
| `<rev>~<n>`, `<rev>^<n>`, `<rev>^0` | ★ ✔ chained suffixes allowed |
| `HEAD@{0}` … `HEAD@{1023}` | ✔ active new-OID reflog endpoints; composes with `^` and `~` |
| `--verify`, `--quiet` (existence probe) | `tryRevParse()` | ★ ~ returns `undefined` only for semantic absence; malformed or corrupt stored state still throws |
| `FETCH_HEAD` | ★ ✘ `fetch()` returns the tip as `fetchHead`; no `FETCH_HEAD` ref is written |
| `<rev>^{}`, `^{commit}`, `^{tree}`, `^{blob}`, `^{tag}` | ★ ✔ bounded typed peeling with authoritative type checks |
| `<rev>:<path>` | ★ ✔ returns the blob or tree oid; internal resolution also preserves the entry mode |
| `@`, `@{upstream}`, arbitrary `<ref>@{n}`, dates, `:/text`, `<a>..<b>` | ★ ✘ |

### Plumbing

| Git | kompjutr | |
|---|---|---|
| `git ls-files` / `--cached` | `lsFiles()` / `{ cached: true }` | ★ ~ returns each index path once, even when conflict stages repeat it; `{ ref }` lists one authenticated tree instead |
| `--others` | `lsFiles({ others: true })` | ★ ✔ returns files and symlinks absent from every index stage; explicit `others` defaults `cached` to false |
| `--cached --others` | `lsFiles({ cached: true, others: true })` | ★ ✔ merges unique cached and untracked paths in Git byte order |
| `--exclude-standard` | `excludeStandard: true` with `others: true` | ★ ~ reads the repository `.gitignore` hierarchy only; no `.git/info/exclude` or global excludes exist |
| `-- <pathspecs>` | `lsFiles({ paths })` | ★ ~ bounded literals and default `*`, `?`, bracket-class, and `**` globs; wildcards cross `/`. Leading `/` and all leading-`:` magic are rejected; bare leading `!` and `^` are literals |
| `--stage`, `--error-unmatch` | — | ✘ |
| `git ls-tree <ref> [<path>]` | `lsTree()` | ★ ~ one level by default; `recursive: true` returns bounded recursive mode/type/oid/path rows; a `<path>` naming a blob returns that single entry |
| `git cat-file <oid>` | `catFile()` | ★ ~ returns `{ oid, bytes }`; `filepath` or the `<oid>:<path>` shorthand reads inside a tree. ✘ `-t`, `-s`, `-p`, ✘ `-e` (a missing path throws instead of exiting non-zero) |
| `git hash-object [-w]` | `hashObject()` | ~ blobs only; `write` stores it. ✘ `-t commit\|tree\|tag`, ✘ stdin batching |
| `git update-ref <ref> <value> [<oldvalue>]` | `updateRef()` | ★ ~ direct refs support `expected` compare-and-set and guarded deletion; `null` means expected absence. Legacy `force` and `symbolic` writes remain. ✘ `--stdin` and multi-ref transactions |
| `git symbolic-ref [-q] HEAD` | `currentBranch({ fullname: true })` | ★ ~ returns the full `refs/heads/…`, and `undefined` when HEAD is detached |
| `git symbolic-ref -q <ref>`, `for-each-ref --format=%(symref) <ref>` | `readRef({ ref })` | ★ ~ exact raw `HEAD` or full `refs/...`; returns `symbolic`, `direct`, or `absent` without following the target or checking object existence |
| `git rev-list --left-right --count <current>...<upstream>` | `divergence({ current, upstream })` | ★ ~ returns exact `ahead`/`behind` plus `identical`, `ahead`, `behind`, `diverged`, `unrelated`, or `shallow` |
| `git merge-base --all <current> <incoming>` | `mergeBase()` | ★ ~ returns every bounded best base plus `already-merged`, `fast-forward`, `divergent`, `unrelated`, or `shallow` classification |
| `git read-tree`, `git write-tree`, `git commit-tree` | `readTree()`, `writeTree()`, `commitTree()` | ★ ✔ ordinary calls target the checkout index; `commitTree()` writes one detached authenticated commit and moves no ref |
| `GIT_INDEX_FILE=<throwaway>` around those commands | `withScratchIndex({ name }, callback)` | ★ ~ the synchronous callback receives `readTree`, `add`, `writeTree`, `commitTree`, and `replaySnapshot`; all scratch rows are transaction-scoped and no index file or persistent alternate index exists |
| `git diff --binary --full-index <snap>^ <snap>` then `git apply --3way --cached` | `scratch.replaySnapshot({ snapshot, onto })` | ★ ~ index-only replay while all objects share one store; clean results return a tree, conflicts return physical stage rows and write nothing. ✘ textual patch interchange |
| general `git rev-list`, ref enumeration through `git for-each-ref` | — | ✘ the bounded reads above do not expose general enumeration |

Omitted selection remains cached-only. `excludeStandard` requires `others`.
Any presence of `cached`, `others`, or `excludeStandard`, including `false`, is
rejected with `{ ref }`. Native client calls prune registered nested checkout
roots instead of returning Git's ordinary directory row for them. Combined
worktree selection accepts at most 64 pathspecs and scans at most 100,000 merged
source rows. Its tested worst-case allocation is 700 SQL statements; cached-only
selection retains its separate 903-statement allocation. Result and matcher
state remain byte-bounded and the first excess fails instead of truncating.

## Branches, tags and refs

### `git branch` — `branch()`, `branchDelete()`, `branchRename()`, `branchList()`

| Git | kompjutr | |
|---|---|---|
| `git branch <name> [<start>]` | `name`, `startPoint` | ★ ✔ start point peels annotated tags |
| `-f`, `--force` | `force` | ✔ |
| `-d` | `branchDelete({ name })` | ★ ✔ deletes only when the tip is provably reachable from the comparison commit; retains bounded recovery history |
| `-D` | `branchDelete({ name, force: true })` | ✔ bypasses only the reachability proof |
| `-m <new>` / `-m <old> <new>` | `branchRename({ newName })` / `branchRename({ oldName, newName })` | ★ ✔ atomically moves the direct ref, selected symbolic `HEAD`, and bounded `branch.<name>.*` config |
| `--list` | `branchList()` | ✔ names only |
| `--show-current` | `currentBranch()` | ★ ✔ `undefined` on a detached HEAD |
| `--set-upstream-to`, `--contains`, `-v` | — | ★ ✘ set upstream through `configSet("branch.<n>.remote"/"…merge")` |

Safe deletion prefers the branch's configured local or remote-tracking
upstream when that direct target exists. Otherwise it compares with the active
checkout's HEAD commit, including a detached HEAD. Invalid, corrupt, or
over-bound upstream configuration fails closed; shallow or over-budget graph
proofs fail with `ESHALLOW` or `E2BIG` rather than deleting.

Every checkout in the shared repository is checked before deletion. A branch
attached to any checkout fails with `EBRANCHFAIL`, even with `force`. Force also
does not bypass authoritative commit validation, structural bounds, or the
transactional expected-tip guard that prevents deleting a concurrently moved
ref. The Computer interface has no `force` field, so its `branchDelete()`
exposes only the safe default.

Rename has no force mode. It rejects an occupied destination, a detached
selected checkout, a source attached to another checkout, destination branch
config, and an active operation. Upstream management and remote rename remain
separate, unsupported operations.

### `git tag` — `tag()`, `tagDelete()`, `tagList()`

| Git | kompjutr | |
|---|---|---|
| `git tag <name> [<object>]` | `name`, `object` (default HEAD) | ~ **lightweight tags only** |
| `-f` | `force` | ✔ |
| `-d` | `tagDelete()` | ✔ |
| `--list` | `tagList()` | ✔ |
| `-a`, `-m`, `-s`, `-u` | — | ✘ kompjutr never *creates* an annotated tag. Annotated tags fetched from a remote are stored, read and peeled correctly |

### Reflog and ref recovery — `reflog()`, `recoverRef()`

| Git | kompjutr | |
|---|---|---|
| `git reflog [<ref>]` | `reflog({ ref, limit, before })` | ~ returns typed rows newest-first; default 100, maximum 1,000, ordinal cursor |
| `git reflog expire` | — | ~ fixed policy: both at most 90 days old and among newest 1,024 rows per ref |
| recover a prior direct ref | `recoverRef({ ref, source, expectedCurrent })` | ✔ selects an active old/new endpoint, verifies the object, and uses CAS |
| branch log after deletion | retained active entry | ~ unlike Git's per-branch log deletion, retained for bounded recovery and future GC roots |
| formatted output, date selectors, arbitrary `<ref>@{n}` | — | ✘ typed reads and `HEAD@{n}` only |

Every successful direct-ref or raw `HEAD` movement records bounded raw and
resolved endpoints, optional actor, timestamp/timezone, and an internal reason in
the same transaction as the mutation. Failed, stale, no-op, unpublished, and
rolled-back movements record nothing.

## Remotes and network

Transport is Smart HTTP over `http(s)` only. Authentication is `headers` or an
`onAuth` callback; there are no credential helpers and no `.netrc`.

### `git ls-remote` — `lsRemote()`

| Git | kompjutr | |
|---|---|---|
| `<remote>` / explicit URL | `remote` (default `origin`), `url` | ★ ✔ |
| no pattern | omitted `patterns` | ✔ returns the complete bounded advertisement |
| `<patterns>...` | `patterns` | ★ ✔ Git tail-wildmatch literals, `*`, `?`, bracket classes, negation, and escapes |
| `--symref` | `headRef` in the result | ✔ validated advertised `HEAD` target |
| peeled annotated tags | `refs` entries ending in `^{}` | ✔ retained in advertisement order |
| auth | `headers`, `onAuth` | ✔ |

Each call performs one logical `upload-pack` discovery and makes no repository
mutation. It returns `{ refs, headRef }`; an empty pattern match still returns
the observed `headRef`. The shared options accept `onProgress` and `onMessage`,
but discovery has no upload or side-band events to emit through them.

### `git remote` — `remoteAdd()`, `remoteRemove()`, `remoteList()`, URL access

| Git | kompjutr | |
|---|---|---|
| `remote add [-f] <name> <url>` | `remoteAdd({ name, url, force })` | ★ ✔ |
| `remote remove <name>` | `remoteRemove()` | ★ ✔ |
| `remote`, `remote -v` | `remoteList()` | ★ ✔ `{ name, url }[]` |
| `remote get-url <name>` | `remoteGetUrl({ name })` | ★ ✔ fetch URL |
| `remote set-url <name> <url>` | `remoteSetUrl({ name, url })` | ★ ✔ replaces the existing fetch URL |
| `remote set-url --add/--delete`, `remote rename`, `remote prune`, `remote show` | — | ✘ |

Both typed URL operations require exactly one configured fetch URL and reject a
missing or multi-valued remote. `remoteSetUrl()` changes the next fetch target
and the push target when no separate `remote.<name>.pushurl` is configured.
Remote names are capped at 2,189 UTF-8 bytes and URLs at 8,192 UTF-8 bytes;
stored values are authenticated before either operation returns or mutates.

### `git fetch` — `fetch()`

| Git | kompjutr | |
|---|---|---|
| `<remote>` / explicit URL | `remote` (default `origin`), `url` | ★ ✔ |
| no ref selector | default | ✔ fetches every advertised `refs/heads/*`; `singleBranch: true` selects the remote HEAD branch instead |
| one legacy selector | `ref`, `remoteRef` | ✔ exact branch-compatible selection |
| one or more refspecs | `refspecs: [{ source, destination, force? }]` | ★ ✔ full `refs/...` names, exact and one-star wildcard mappings |
| `FETCH_HEAD` | `fetchHead` in the result | ★ ~ an oid, not a written ref: `reset --hard FETCH_HEAD` becomes `reset({ ref: fetchHead })` |
| `--depth <n>` | `depth` | ✔ shallow boundaries are recorded and honoured |
| `--single-branch` | `singleBranch: true` | ✔ |
| default tag following | `tags: undefined` | ✔ auto-follows advertised tags whose peeled targets were already held or become held through the selected coverage; an explicit ref selector does not auto-follow other tags |
| `--tags` | `tags: true` | ✔ fetches every advertised tag |
| `--no-tags` | `tags: false` | ✔ disables automatic tag following |
| `--prune` | `prune` | ✔ |
| mapped `--depth`, mapped `--prune` | — | ✘ rejected rather than mixed with typed mappings |
| `--all`, `--unshallow`, `--deepen`, `--filter`, `--recurse-submodules` | — | ✘ |

Legacy fetch returns `{ mode: "legacy", defaultBranch, fetchHead, updates: [] }`.
Mapped fetch returns `{ mode: "mapped", defaultBranch, fetchHead: null,
updates }`, with updates ordered by destination UTF-8 bytes. Exact missing
sources fail; an unmatched wildcard is a successful discovery-only no-op. One
complete validated pack and every selected destination publish atomically.
Interrupted ingest, a stale candidate, or one invalid destination moves no ref.
A selected tag is still fetched when it is itself the explicit selector. Tag
publication authenticates annotated chains and never clobbers a different
existing local tag. Auto-follow silently preserves an existing local tag, while
`tags: true` and an explicitly selected tag reject a different local target
with `ETAGFAIL` and publish no refs.

### `git pull` — `pull()`

| Git | kompjutr | |
|---|---|---|
| `<remote> <branch>` | `remote`, `url`, `ref`, `remoteRef` | ✔ falls back to `branch.<n>.remote` / `branch.<n>.merge` |
| fetch all configured heads / one upstream | `singleBranch` | ~ defaults to canonical all-head coverage for a configured pull; `true` limits head coverage to the upstream |
| `--ff` (default) / `--no-ff` | `fastForward` | ✔ also reads `pull.ff` |
| `--ff-only` | `fastForwardOnly` | ✔ |
| `--no-commit` | `commit: false` | ~ native only |
| `-m <msg>` | `message` | ~ native only |
| `--rebase` / `pull.rebase=true` | — | ✘ throws `UnsupportedOperationError` |
| local-path remote | — | ✘ throws `UnsupportedOperationError` |
| `--autostash`, `--recurse-submodules` | — | ✘ |

Pull targets the checked-out symbolic branch only. Its default fetch coverage
accepts only the canonical
`+refs/heads/*:refs/remotes/<remote>/*` mapping, updates every advertised head
and auto-followed tag in that coverage, but integrates exactly the configured or
explicit upstream commit. A different configured `remote.<name>.fetch` refspec
fails with `EUNSUPPORTED`; it is not partially interpreted. Setting
`singleBranch` to `true` limits head coverage to the upstream. A configured
upstream still auto-follows tags whose peeled targets were already held or
become held through that coverage, while an explicit `remoteRef` defaults to
exact, tagless coverage unless `singleBranch: false` requests canonical
coverage.

Because no SQLite transaction spans an HTTP await, a successful fetch stays
visible even if the integration afterwards refuses (`ESTALEHEAD`,
`ESTALEUPSTREAM`, dirty worktree, fast-forward-only, or a conflict).

### `git push` — `push()`

| Git | kompjutr | |
|---|---|---|
| one legacy branch | `remote`, `ref`, `remoteRef` | ✔ translated through the structured operation |
| `<src>:<dst>` mappings | `refspecs: [{ source, destination, force? }]` | ★ ✔ exact refs, one-star wildcards, full-OID sources, and custom namespaces |
| explicit URL | `url` | ✔ also honours `remote.<n>.pushurl` |
| `--force` | legacy `force`, or per-mapping `force` | ★ ✔ |
| `--delete` | legacy `delete`, or `{ source: null, destination }` | ★ ✔ several explicit deletions may share one request |
| `--force-with-lease` | — | ~ implicit: the advertised old oid is always sent, so the server rejects a concurrent remote update |
| `--atomic` | `atomic` | ★ ✔ requires the advertised capability |
| `--push-option=<text>` | `pushOptions` | ✔ bounded protocol-v0 push options |
| `--tags`, `--all`, `--mirror`, `--set-upstream` | — | ✘ |

Returns ordered `PushResult` with overall `ok`/`error`, unpack status, one row
for every expanded destination, and a separate tracking outcome. A complete
`report-status` resolves even when the server rejects some or all refs; malformed
or incomplete status after POST is uncertain and throws. No-op destinations are
reported without commands, and a wholly unmatched wildcard returns an exact
empty result without discovery. A configured remote reconciles only successful
branch destinations after status; custom refs and explicit URLs never create
tracking refs. Reconciliation reports `updated`, `unchanged`, `stale`,
`deferred`, or `failed` without hiding a confirmed remote result. Pushing from a
detached HEAD without an explicit legacy `ref` throws `EDETACHED`.

## Integration

All four commands below use the same bounded three-way engine and the same
durable operation journal, so each survives a Durable Object restart mid-way.

When the two sides put a regular or executable file and a symlink at the same
path, the symlink stays at the logical path and the regular side is materialised
at a collision-checked `~<label>` relocation, matching Git. Index stages are
split by mode class; when a merge base exists, its stage follows the primary or
relocated path with the same mode class. Continue and abort authenticate both
physical paths after a reopen. A distinct-type conflict involving a gitlink
cannot be materialised and fails atomically with `EUNSUPPORTED`.

### `git merge` — `merge()`, `mergeContinue()`, `mergeAbort()`

| Git | kompjutr | |
|---|---|---|
| `git merge <commit>` | `theirs` | ★ ✔ exactly two heads |
| — | `ours` | ~ optional assertion; it must name the checked-out branch, else `EWRONGHEAD` |
| `--ff` (default) / `--no-ff` | `fastForward` | ✔ |
| `--ff-only` | `fastForwardOnly` | ★ ✔ |
| `-m <msg>` | `message` | ✔ |
| `--no-commit` | `commit: false` | ✔ leaves a resumable pending merge |
| `--continue` | `mergeContinue()` or plain `commit()` | ✔ |
| `--abort` | `mergeAbort()` | ✔ restores only merge-owned paths; a structural blocker fails closed |
| `--squash` | — | ✘ |
| `-s <strategy>`, `-X ours\|theirs\|patience`, `--conflict-style` | — | ✘ one built-in three-way strategy, default markers |
| octopus (3+ heads) | — | ✘ |
| `--allow-unrelated-histories` | — | ✘ unrelated histories are refused |

Conflicts write index stages 1–3 plus marker bytes. A file/directory conflict
also relocates the file side to a collision-checked `~<label>` path.

### `git cherry-pick` — `cherryPick()` + `…Continue/Skip/Abort()`

| Git | kompjutr | |
|---|---|---|
| `git cherry-pick <commit>` | `source` | ~ **one commit per call**; no ranges, no lists |
| `-m <parent>` | `mainline` | ✔ required for a merge commit |
| message / committer override | `message`, `committer` | ~ kompjutr extension; author and message are inherited by default |
| `--continue` / `--skip` / `--abort` | `cherryPickContinue()` / `…Skip()` / `…Abort()` | ✔ |
| `-n`, `-x`, `-e`, `-s` | — | ✘ |

### `git revert` — `revert()` + `…Continue/Skip/Abort()`

Same shape: one `source` per call, `mainline` for merge commits, `message` /
`author` / `committer` overrides, and continue/skip/abort. ✘ ranges, ✘ `-n`.

`ReplayResult` is `committed`, `conflicted`, or `empty` with reason `source`
(the source changed nothing) or `result` (the result equals the current tree).
Cherry-pick suspends both empty outcomes for explicit cancellation, as Git
does; revert completes an empty operation immediately.

### `git rebase` — `rebase()` + `…Continue/Skip/Abort()`

| Git | kompjutr | |
|---|---|---|
| `git rebase <upstream>` | `upstream` | ★ ✔ |
| `--continue` / `--skip` / `--abort` | `rebaseContinue()` / `rebaseSkip()` / `rebaseAbort()` | ★ ✔ |
| committer override | `committer`, `env` | ✔ |
| conflicts | `add()` / `rm()`, then `rebaseContinue()` | ★ ✔ index stages 1–3; survives reopen |
| `--onto <newbase> [upstream] [branch]`, `--root [branch]` | — | ✘ |
| `-i`, edit/reword/squash/fixup/drop, `--autosquash`, `--exec` | — | ✘ |
| `--rebase-merges` | — | ✘ selected merge commits are rejected |
| `--update-refs` | — | ✘ only the checked-out branch is published |
| `--keep-empty`, `--no-ff` | — | ✘ fixed empty-commit and fast-forward policy |
| `-X <strategy-option>` | — | ✘ one built-in three-way strategy |
| `--autostash` | — | ✘ the start requires a clean index and worktree |

Restrictions, each a stable error rather than a fallback:

- the replayed range must be **linear** — a merge commit in it throws `EUNSUPPORTED`;
- exactly one merge base is required (`EUNSUPPORTED` otherwise);
- a shallow boundary throws `ESHALLOW`, unrelated histories throw `EUNRELATED`;
- at most 4,096 replayed commits (`E2BIG`);
- HEAD must be an existing checked-out symbolic local branch, with a clean index
  and worktree;
- a materialized baseline or result tree is limited to 4,096 entries and 32 MiB
  of blob content; gitlinks cannot be materialized;
- source messages must be valid UTF-8 without an `encoding` header.

`RebaseResult` is `up-to-date`, `completed` (with `replayed`, `skipped`,
`fastForward`), or `conflicted`. During replay the branch stays at its original
OID while the authenticated journal owns the unpublished results. Completion
publishes the branch once; continue, skip, and abort work after a cold reopen.
Source-empty commits are retained, while commits whose patch becomes empty on
the new parent are skipped.

## Maintenance

### Bounded storage maintenance — `maintenance()`

`maintenance({ dir? })` advances one durable repository-scoped action. Repeated
calls snapshot roots from every linked checkout, mark logical and physical
reachability, repack reachable loose objects, classify unreachable storage, and
sweep objects whose fixed 14-day grace period has elapsed. The operation has no
public page-size, grace, or pack-tuning options.

The result is discriminated by `status: "progress" | "complete"`. It reports the
durable phase after the call, stable run ID, restart marker, reachable and queued
objects, repacked objects, reclaimed objects and packs, and reclaimed bytes.
`nextEligibleAt` is `null` during progress and reports the next grace boundary
only on a complete `finish` result. While the root epoch is stable, calling
again before a future boundary returns the same terminal result. Root drift or
the eligibility boundary starts a fresh run without also consuming its first
root page.

Every call samples the runtime clock once and stays below the operation SQL and
memory ceilings. Root changes restart discovery safely. Cold reopen and calls
through any linked checkout resume the same shared run.

## Configuration

### `git config` — `configGet()`, `configSet()`

| Git | kompjutr | |
|---|---|---|
| `git config <key>` | `configGet({ path })` | ★ ✔ dotted key |
| `--get-all` | `all: true` | ✔ |
| `git config <key> <value>` | `configSet({ path, value })` | ★ ✔ string, boolean or number |
| `--unset` | `value: undefined` | ✔ |
| `--add` | `append: true` | ✔ |
| `--global`, `--system`, `--file` | — | ★ ✘ one repository-scoped store; no file, no include directives, no scope precedence |
| `git -c <key>=<value> <cmd>` (per command) | — | ★ ✘ pass the value as an operation option instead |
| `--list`, `--edit` | — | ✘ |

Keys the engine actually reads:

| Key | Effect |
|---|---|
| `user.name`, `user.email` | commit identity |
| `remote.<name>.url` | fetch/clone/push URL |
| `remote.<name>.pushurl` | push URL override |
| `remote.<name>.fetch` | written by clone; pull's all-head coverage requires the canonical mapping, status and safe branch deletion recognise its tracking namespace, and standalone `fetch()` does not parse it |
| `branch.<name>.remote`, `branch.<name>.merge` | upstream for pull, push, status metadata, and safe branch deletion |
| `pull.ff` | pull fast-forward policy |
| `pull.rebase` | recognised, then rejected |
| `core.quotePath` | read by `statusFormatOptions()`; defaults to true |
| `status.renames`, `diff.renames` | default exact-rename detection for the respective operation |
| `core.bare` | recorded by `init({ bare: true })`, otherwise inert |

Every other key is stored and returned verbatim but has **no effect** —
including `core.autocrlf`, `core.fileMode`, `core.ignorecase`,
`merge.conflictStyle`, other keys under `status.*` or `diff.*`, and anything
under `gc.*`. The reference workload also sets `safe.directory`,
`init.defaultBranch` and `credential.helper`; those three are inert here.

## Not implemented

These have no typed method, no admitted local argv form, and no equivalent.
`stash` methods throw `UnsupportedOperationError`; the rest simply do not exist
on the surface.

- **State:** `stash` (push/list/pop throw), `rerere`, `notes`
- **Layout:** worktree `move`, `repair`, `lock`, `unlock`, worktree-local config,
  and `.git/worktrees` administration; `submodule` (gitlinks are preserved in
  trees but never followed); `sparse-checkout` as a command — sparse hydration is
  an internal optimisation, not a user-facing mode
- **Inspection:** `blame`, `bisect`, `describe`, `shortlog`, `grep`,
  general `rev-list`, ref enumeration through `for-each-ref`, `whatchanged`;
  bounded remote discovery, merge-base, divergence, and one exact raw-ref read
  are available through the narrower methods above
- **Patches:** `apply` ★, `am`, `format-patch`, `send-email`, `cherry`
- **Maintenance binaries:** `gc`, `fsck`, `repack`, `prune`, `count-objects`,
  `verify-pack`; storage maintenance is available only through the bounded
  `maintenance()` operation above
- **Rewriting:** `filter-branch`, `replace`, `fast-import`, `fast-export`
- **Packaging:** `archive`, `bundle`
- **Mechanisms:** hooks, GPG/SSH signing, credential helpers ★, `.gitattributes`
  (no filters, no eol conversion, no merge drivers), `.mailmap`, Git LFS,
  `git://` and `ssh://` transports, `--filter` partial clone ★

## Surface differences

`kompjutr/compat/computer` implements Computer's `GitClient` interface. It
covers clone, fetch, init, status, diff, diffSummary, clean, add, rm, reset,
commit, log, show, revParse, repoRoot, currentBranch, lsFiles, lsTree, branch,
tag, checkout, remote, config, hashObject, catFile, updateRef, push, pull and
merge. Its `cli()` uses the strict runner above. The typed methods retain these
differences:

- ✘ no `cherryPick`, `revert` or `rebase`;
- ✘ no `reflog` or `recoverRef` surface;
- ✘ no linked-checkout lifecycle, `divergence`, or `readRef` surface;
- ✘ no `readTree`, `writeTree`, `commitTree`, or scoped scratch-index surface;
- ✘ no `lsRemote` surface;
- ✘ no native `branchRename()`, `remoteGetUrl()` / `remoteSetUrl()`, or
  `lsFiles({ paths })` extensions;
- ✘ no `mergeContinue` / `mergeAbort`: merge is single-shot, so a conflict rolls
  the local integration back and reports `EMERGEFAIL`. A conflicting pull still
  keeps the fetched objects and the remote-tracking ref;
- `branchDelete()` has no `force` option on the installed Computer interface,
  so it always uses the native operation's safe merged check;
- `status()` accepts only `dir` on the installed Computer interface; native
  callers own `untrackedFiles`, ignored-row, rename, and formatted-output
  choices;
- `rm()` remains cached-only, recursive, and unconditional: it removes matching
  index entries without changing working-tree bytes or applying native content
  safety checks;
- `fetch()` and `push()` retain Computer's legacy single-selection inputs and
  result shapes. The adapter projects the native structured push status to its
  ref-keyed record and does not expose unpack or tracking reconciliation;
- `pull` returns `void` rather than a `MergeResult`.

## Limits

Accepted operations currently enforce at most 1,000 SQL statements and less
than 100 MiB. An operation that would exceed a structural or projected-count
limit throws a stable error instead of truncating. Backlog 60 tracks replacing
the projected statement barrier with a measured target. The per-operation caps
(integration plan entries, tree bytes, worktree scan rows, path length, journal
steps) are listed in
[`architecture.md`](architecture.md).

Two limits bite most often in ordinary use: the 2,200-byte cap on an emitted
Git path, and the 4,096-step cap on a rebase or replay journal. Revision input is
limited to 1,024 code units and 32 total `^`/`~` traversals. Divergence retains at
most 50,000 commits and 32 MiB. A raw-ref name and returned target are each at
most 1,024 UTF-8 bytes.

Status formatting accepts at most 65,536 output records and 16 MiB of encoded
output, with a separate 16 MiB retained-string budget. It rejects the first
excess with `E2BIG` and never truncates.

One shared store has at most 1,024 checkouts. A checkout root is at most 4,096
UTF-8 bytes, raw `HEAD` is at most 1,024 bytes, and one complete checkout listing
retains at most 6 MiB. An active reflog-root scan fails closed above 9,727
physical direct-ref and checkout-HEAD rows; its SQL state, shared caches, and JS
headroom total at most 100 MiB minus one byte.

One repository admits at most 16 simultaneous scratch-index names, each at most
255 UTF-8 bytes. A scratch callback is synchronous and cannot escape its owning
transaction. `writeTree()` admits at most 10,000 leaf entries, 4 MiB of path
bytes, 4,096 tree objects, and 16 MiB of serialized trees. `commitTree()` accepts
at most two ordered parents and eight cumulative revision traversals. Recursive
`lsTree()` returns at most 10,000 rows and 16 MiB of charged result state.
Snapshot replay inherits the 1,000-entry, 200,000-source-row, 32 MiB retained
plan, and shared 64 MiB memory bounds of the integration engine.

## Path and ordering rules

- Mutating pathspecs are **exact path or directory prefix**. Read-only
  `lsFiles({ paths })` additionally supports its bounded default glob subset.
  No operation accepts `:(exclude)`, `:(icase)`, or leading `:/` magic.
- Paths order by UTF-8 bytes, matching Git and SQLite `BINARY` — never by
  JavaScript string comparison.

## Reference workload coverage

What the ★ marks add up to. Anything the workload issues that is not named below
is already served by the surface as it stands: clone by branch, add / rm / reset /
checkout / clean, commit, status (v1 and short, including unmerged rows and NUL
framing), merge `--ff-only`, rebase with continue and abort plus index-stage
conflict resolution, branch create and delete, remote add / remove / list, fetch
of one branch, typed multi-ref fetch and push, atomic checkpoint transport,
remote discovery, linked-checkout add / list / remove / prune, caller-selected
divergence, offline raw-ref reads, and every local read the agent makes. The
consumer adapter is outside this package.

### Hard gaps — no route through the current surface

| Missing | What issues it |
|---|---|
| `worktree repair` / `unlock` | the broader Git-layout recovery and lock lifecycle; the SQLite-native admission path has no pointer or lock state to repair |
| `--filter=blob:none` partial clone | the initial clone of every project repository ([backlog 41](../backlog/41-partial-clone.md)) |
| `diff -z` | NUL-framed diff path lists parsed by the orchestrator; status formatters already provide NUL framing |

### Adaptable — the capability exists under another shape

| Git spelling | kompjutr route |
|---|---|
| `config --global user.name` / `user.email` | the binding's `defaultIdentity`, or repository-scoped `configSet()` |
| `-c credential.helper=…` per command | `onAuth` or `headers` on the operation |
| `log --format=…`, `log -1 --format=%s` | format `CommitView[]` in the caller |
| `log <a>..<b>` | walk from the tip and stop at the base oid |
| `ls-files --error-unmatch <path>` | membership test against `lsFiles()` |
| `ls-tree -r <ref>` | recurse with `lsTree()`, or read the tree through `lsFiles({ ref })` |
| `rev-parse --verify --quiet <rev>` / `cat-file -e <rev>:<path>` | `tryRevParse()` returns the oid or `undefined` for semantic absence |
| `GIT_INDEX_FILE=<throwaway> read-tree` / `add -A` / `write-tree` / `commit-tree` | one synchronous `withScratchIndex()` callback; it returns the detached snapshot OID without changing the checkout index, worktree, HEAD, refs, reflogs, tracker, operation journal, or maintenance state |
| `diff --binary --full-index <snap>^ <snap>` then `apply --3way --cached` | `scratch.replaySnapshot({ snapshot, onto })` while the snapshot and new tip share one object store; no textual patch crosses the process boundary |
| `update-ref <ref> <new> <old>` / guarded `-d` | `updateRef({ ref, value, expected })` / `updateRef({ ref, delete: true, expected })`; a stale direct target throws `ESTALEHEAD` |
| `reset --hard FETCH_HEAD` | `reset({ ref: fetch().fetchHead, hard: true })` |
| `branch -m main` | `branchRename({ newName: "main" })` |
| `push -u origin main` | `push()` then `configSet("branch.main.remote"/"…merge")` |
| `symbolic-ref -q HEAD` | `currentBranch({ fullname: true })` |
| `symbolic-ref -q refs/remotes/origin/HEAD` | `readRef({ ref: "refs/remotes/origin/HEAD" })` |
| `rev-list --left-right --count <current>...<upstream>` | `divergence({ current, upstream })` |

Credential helpers stay out of scope — `onAuth` covers what this workload needs
from them. The typed checkout lifecycle covers session creation and teardown;
Git's administrative `repair` and `unlock` shapes have no SQLite-native state to
operate on. Textual patch interchange has no current caller. Remote discovery
and branch-plus-checkpoint transport use `lsRemote()`, mapped `fetch()`, and
mapped `push()` directly.

---

The gaps in this document are ranked by severity in
[`../backlog/README.md`](../backlog/README.md#git-parity-tiers).
