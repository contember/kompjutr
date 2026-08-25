# Git support checklist

What of Git kompjutr implements, command by command, down to the options that
matter.

## How to read this

kompjutr has **no command line**. Git is a typed method surface — the `Git`
interface from `kompjutr/git` (and the narrower `GitClient` from
`kompjutr/compat/computer`). `cli({ argv })` always throws
`UnsupportedOperationError`; there is no argv parser to add flags to.

The tables therefore map the familiar command-line spelling to the option that
provides it. **A flag that is not listed is not supported.** Unsupported input
fails with a stable `error.code`; nothing silently degrades.

| Mark | Meaning |
|---|---|
| ✔ | supported |
| ~ | supported with a stated difference from Git |
| ✘ | not supported — fails, or has no equivalent |

Two surfaces exist. The native `Git` interface is the full one. The Computer
compatibility client exposes a subset — see [Surface
differences](#surface-differences).

## Repository creation

### `git init` — `init()`

| Git | kompjutr | |
|---|---|---|
| `--initial-branch=<name>` | `defaultBranch` (default `main`) | ✔ |
| `--bare` | `bare` | ~ recorded as `core.bare` only; every repository is effectively bare, since the object database is never a directory |
| working directory | `dir` (default `/`) | ✔ several repositories may share one workspace |
| `--template`, `--separate-git-dir`, `--shared` | — | ✘ |

### `git clone` — `clone()`

| Git | kompjutr | |
|---|---|---|
| `<url>` | `url` | ✔ `http://` and `https://` only — `ssh://`, `git://` and local paths fail with `EURLSCHEME` |
| `--depth <n>` | `depth` | ~ **defaults to `1`**; pass `depth: 0` for a full clone |
| `--single-branch` | `singleBranch` | ~ defaults to `true` |
| `--no-tags` | `noTags` | ~ defaults to `true` |
| `--branch <ref>` | `ref` | ✔ |
| `--origin <name>` | `remote` (default `origin`) | ✔ |
| — | `paths` | ✔ check out only these paths (kompjutr extension) |
| auth | `headers`, `onAuth`, `onProgress`, `onMessage` | ✔ |
| `--bare`, `--mirror`, `--recurse-submodules`, `--filter`, `--reference` | — | ✘ |

Clone sets `remote.<name>.url`, `remote.<name>.fetch`,
`branch.<name>.remote` and `branch.<name>.merge`. A clone that fails leaves no
repository behind.

## Working tree and index

### `git status` — `status()`, `statusStream()`, formatters

| Git | kompjutr | |
|---|---|---|
| `--porcelain=v1` | `formatPorcelainV1(entries)` | ✔ |
| `--porcelain=v2` | `formatPorcelainV2(details)` | ✔ file rows and `?` rows |
| `--short` | `formatShort(entries)` | ✔ |
| `-- <paths>` | `StatusOptions.paths` | ~ exact path or directory prefix, no globs; **not reachable through `Git.status()`** — use the exported `status()` op |
| `--ignored` | `StatusOptions.includeIgnored` | ~ same restriction as above |
| `--untracked-files=normal\|all` | `StatusOptions.untrackedFiles` | ~ same restriction as above |
| `-b`, `--branch` header | — | ✘ formatters emit path rows only |
| rename detection (`R`) | — | ✘ a rename is a delete plus an add |
| unmerged codes (`U`, `AA`, `DD`) | — | ✘ status reads stage 0; a conflicted path reports as modified. Use `readOperationState()` to detect a pending merge or replay |

`Git.status()` returns `StatusEntry[]` (`index` and `worktree` codes drawn from
`" " A M D` plus `?` for untracked). `StatusDetail` adds HEAD/index/worktree
modes and oids.

### `git add` — `add()`

| Git | kompjutr | |
|---|---|---|
| `<pathspec>...` | `paths` | ~ exact path or directory prefix; no globs, no `:(exclude)` magic |
| `-A`, `--all` | `all` | ✔ |
| `-u`, `--update` | `trackedOnly` (with `all`) | ✔ this is the `commit -a` shape |
| `-f`, `--force` | `force` | ✔ stage an ignored path |
| `-p`, `-i`, `-N`, `--renormalize` | — | ✘ |

A pathspec that matches nothing throws `PathspecNotFoundError`.

### `git rm` — `rm()`

| Git | kompjutr | |
|---|---|---|
| `<pathspec>...` | `paths` | ~ exact or directory prefix; a directory prefix is implicitly recursive |
| `--cached` | — | ~ **this is the only behaviour**: `rm()` removes index entries and leaves the working-tree file in place |
| `-f`, `--ignore-unmatch`, `-r` | — | ✘ (`-r` is implicit; an unmatched pathspec always throws) |

### `git reset` — `reset()`

| Git | kompjutr | |
|---|---|---|
| `--mixed` (default) | default | ✔ replaces the index from `ref` |
| `--hard` | `hard` | ✔ rewrites index and working tree, and clears any pending merge/replay state |
| `<commit>` | `ref` (default HEAD) | ✔ |
| `-- <paths>` | `paths` | ✔ unstage those paths; clears their conflict stages |
| `--soft`, `--merge`, `--keep` | — | ✘ |

### `git checkout` / `git switch` — `checkout()`, `branch()`

| Git | kompjutr | |
|---|---|---|
| `git checkout <ref>` | `checkout({ ref })` | ✔ branch, tag or commit; a commit detaches HEAD |
| `git checkout -- <paths>` | `checkout({ ref, paths })` | ✔ HEAD stays put; absent paths are not pruned |
| `git checkout -f` | `force` | ✔ otherwise a blocking local change throws `ECHECKOUTFAIL` |
| `git checkout -b <name>` | `branch({ name, checkout: true })` | ~ points HEAD at the new branch but does not move the working tree; follow with `checkout()` when `startPoint` differs from HEAD |
| `git switch`, `git restore` | — | ✘ no separate spelling |
| `--orphan`, `--track`, `--merge`, `--patch` | — | ✘ |

### `git clean` — `clean()`

| Git | kompjutr | |
|---|---|---|
| `-n`, `--dry-run` | `dryRun` | ✔ |
| `-d` | `directories` | ✔ |
| `-- <paths>` | `paths` | ✔ exact or directory prefix |
| `-f` | — | ~ implicit: without `dryRun`, `clean()` removes |
| `-x`, `-X` | — | ✘ ignored files are always preserved |

### `git diff` — `diff()`, `diffSummary()`

| Git | kompjutr | |
|---|---|---|
| `git diff` | `{}` | ✔ working tree vs HEAD |
| `git diff <ref>` | `{ ref }` | ✔ working tree vs a commit |
| `git diff <a> <b>` | `{ ref, to }` | ✔ commit vs commit |
| `git diff --cached` / `--staged` | — | ✘ there is no index-vs-HEAD mode |
| `-U<n>` | `context` | ✔ |
| `--abbrev=<n>` | `abbrev` (default 7) | ✔ |
| `-- <paths>` | `paths` | ~ exact or directory prefix, no globs |
| `--numstat` | `diffSummary()` | ~ returns `{ path, status, insertions, deletions }` objects, not text |
| `-M`, `-C` (rename/copy detection) | — | ✘ status is only `A`, `M`, `D` |
| `--stat`, `--color`, `--word-diff`, `--binary` | — | ✘ binary files emit `Binary files a/… and b/… differ` |

Output is a `diff --git` patch with correct `new file` / `deleted file` /
`old mode` / `new mode` / `index` headers.

## Commits and history

### `git commit` — `commit()`

| Git | kompjutr | |
|---|---|---|
| `-m <msg>` | `message` | ~ **required**; an empty message throws `EMSG` |
| `--amend` | `amend` | ✔ |
| `--author` | `author` | ✔ |
| committer override | `committer` | ✔ |
| `GIT_AUTHOR_*` / `GIT_COMMITTER_*` | `env` | ~ read from the passed record only, never from `process.env` |
| `-a` | `add({ all: true, trackedOnly: true })` first | ~ separate call |
| `--allow-empty` | — | ~ implicit: an empty commit is always allowed |
| continue a merge | `commit()` during a pending merge finalizes it | ✔ `--amend` is rejected there |
| `-F <file>`, `-S`, `--fixup`, `--squash`, `--no-verify` | — | ✘ (no hooks and no signing exist) |

Identity resolution order: explicit option → amended commit (author only) →
`env` → `user.name`/`user.email` → the binding's `defaultIdentity`. A source
wins only when it supplies both name and email; none left throws
`MissingIdentityError`.

### `git log` — `log()`

| Git | kompjutr | |
|---|---|---|
| `<ref>` | `ref` (default HEAD) | ✔ |
| `-n <count>`, `--max-count` | `depth` | ✔ |
| `-- <paths>`, `--follow`, `--all`, `--graph`, `--pretty` | — | ✘ returns `CommitView[]`, never formatted text |

### `git show` — `show()`

Returns the commit's `CommitView` (oid, message, tree, parents, author,
committer). ✘ no patch output, ✘ no tree/blob display.

### `git rev-parse` — `revParse()`

| Syntax | |
|---|---|
| `HEAD`, branch, tag, `refs/...` | ✔ annotated tags peel to their commit |
| full 40-char oid | ✔ |
| abbreviated oid | ✔ resolved by unique prefix |
| `<rev>~<n>`, `<rev>^<n>`, `<rev>^0` | ✔ chained suffixes allowed |
| `@`, `@{upstream}`, `@{n}`, `:/text`, `<a>..<b>`, `<rev>:<path>` | ✘ (`<oid>:<path>` works in `catFile` only) |

### Plumbing

| Git | kompjutr | |
|---|---|---|
| `git ls-files` | `lsFiles()` | ✔ index paths; `{ ref }` lists a tree instead. ✘ `--stage` |
| `git ls-tree <ref> [<path>]` | `lsTree()` | ~ one level only, never recursive; a `<path>` naming a blob returns that single entry |
| `git cat-file <oid>` | `catFile()` | ✔ returns `{ oid, bytes }`; `filepath` or the `<oid>:<path>` shorthand reads inside a tree. ✘ `-t`, `-s`, `-p` |
| `git hash-object [-w]` | `hashObject()` | ~ blobs only; `write` stores it. ✘ `-t commit\|tree\|tag`, ✘ stdin batching |
| `git update-ref <ref> <value>` | `updateRef()` | ✔ `force` overwrites, `symbolic` writes `ref: …`. ✘ `-d` (delete), ✘ `--stdin`, ✘ old-value guard |
| `git rev-list`, `git for-each-ref`, `git merge-base` | — | ✘ not public (merge-base selection is internal to merge and rebase) |

## Branches, tags and refs

### `git branch` — `branch()`, `branchDelete()`, `branchList()`

| Git | kompjutr | |
|---|---|---|
| `git branch <name> [<start>]` | `name`, `startPoint` | ✔ start point peels annotated tags |
| `-f`, `--force` | `force` | ✔ |
| `-d` / `-D` | `branchDelete({ name })` | ~ one spelling; refuses the checked-out branch (`EBRANCHFAIL`), and does **not** check whether the branch is merged |
| `--list` | `branchList()` | ✔ names only |
| `-m` (rename), `--set-upstream-to`, `--contains`, `-v` | — | ✘ set upstream through `configSet("branch.<n>.remote"/"…merge")` |

### `git tag` — `tag()`, `tagDelete()`, `tagList()`

| Git | kompjutr | |
|---|---|---|
| `git tag <name> [<object>]` | `name`, `object` (default HEAD) | ~ **lightweight tags only** |
| `-f` | `force` | ✔ |
| `-d` | `tagDelete()` | ✔ |
| `--list` | `tagList()` | ✔ |
| `-a`, `-m`, `-s`, `-u` | — | ✘ kompjutr never *creates* an annotated tag. Annotated tags fetched from a remote are stored, read and peeled correctly |

## Remotes and network

Transport is Smart HTTP over `http(s)` only. Authentication is `headers` or an
`onAuth` callback; there are no credential helpers and no `.netrc`.

### `git remote` — `remoteAdd()`, `remoteRemove()`, `remoteList()`

| Git | kompjutr | |
|---|---|---|
| `remote add [-f] <name> <url>` | `remoteAdd({ name, url, force })` | ✔ |
| `remote remove <name>` | `remoteRemove()` | ✔ |
| `remote -v` | `remoteList()` | ✔ `{ name, url }[]` |
| `remote set-url` | — | ~ use `configSet("remote.<n>.url", …)` |
| `remote rename`, `remote prune`, `remote show` | — | ✘ |

### `git fetch` — `fetch()`

| Git | kompjutr | |
|---|---|---|
| `<remote>` / explicit URL | `remote` (default `origin`), `url` | ✔ |
| `<refspec>` | `ref`, `remoteRef` | ~ one branch selector, not refspec syntax |
| `--depth <n>` | `depth` | ✔ shallow boundaries are recorded and honoured |
| `--single-branch` | `singleBranch` | ✔ |
| `--tags` | `tags` | ✔ |
| `--prune` | `prune` | ✔ |
| `--all`, `--unshallow`, `--deepen`, `--filter`, `--recurse-submodules` | — | ✘ |

Returns `{ defaultBranch, fetchHead }`. Only a complete, validated pack becomes
readable; an interrupted ingest cannot move a ref.

### `git pull` — `pull()`

| Git | kompjutr | |
|---|---|---|
| `<remote> <branch>` | `remote`, `url`, `ref`, `remoteRef` | ✔ falls back to `branch.<n>.remote` / `branch.<n>.merge` |
| `--ff` (default) / `--no-ff` | `fastForward` | ✔ also reads `pull.ff` |
| `--ff-only` | `fastForwardOnly` | ✔ |
| `--no-commit` | `commit: false` | ~ native only |
| `-m <msg>` | `message` | ~ native only |
| `--rebase` / `pull.rebase=true` | — | ✘ throws `UnsupportedOperationError` |
| local-path remote | — | ✘ throws `UnsupportedOperationError` |
| `--autostash`, `--recurse-submodules` | — | ✘ |

Pull targets the checked-out symbolic branch only. Because no SQLite
transaction spans an HTTP await, a successful fetch stays visible even if the
integration afterwards refuses (`ESTALEHEAD`, `ESTALEUPSTREAM`, dirty worktree,
fast-forward-only, or a conflict).

### `git push` — `push()`

| Git | kompjutr | |
|---|---|---|
| `<remote> <src>:<dst>` | `remote`, `ref`, `remoteRef` | ~ **one branch per call**; branch refs only |
| explicit URL | `url` | ✔ also honours `remote.<n>.pushurl` |
| `--force` | `force` | ✔ |
| `--delete` | `delete` | ✔ |
| `--force-with-lease` | — | ~ implicit: the advertised old oid is always sent, so the server rejects a concurrent remote update |
| `--tags`, `--all`, `--mirror`, `--set-upstream`, `--atomic` (multi-ref) | — | ✘ |

Returns `PushResult`. The local remote-tracking ref moves only after a complete
`report-status` success. Pushing from a detached HEAD without an explicit `ref`
throws `EDETACHED`.

## Integration

All four commands below use the same bounded three-way engine and the same
durable operation journal, so each survives a Durable Object restart mid-way.

### `git merge` — `merge()`, `mergeContinue()`, `mergeAbort()`

| Git | kompjutr | |
|---|---|---|
| `git merge <commit>` | `theirs` | ✔ exactly two heads |
| — | `ours` | ~ optional assertion; it must name the checked-out branch, else `EWRONGHEAD` |
| `--ff` (default) / `--no-ff` | `fastForward` | ✔ |
| `--ff-only` | `fastForwardOnly` | ✔ |
| `-m <msg>` | `message` | ✔ |
| `--no-commit` | `commit: false` | ✔ leaves a resumable pending merge |
| `--continue` | `mergeContinue()` or plain `commit()` | ✔ |
| `--abort` | `mergeAbort()` | ✔ restores only merge-owned paths; a structural blocker fails closed |
| `--squash` | — | ✘ |
| `-s <strategy>`, `-X ours\|theirs\|patience`, `--conflict-style` | — | ✘ one built-in three-way strategy, default markers |
| octopus (3+ heads) | — | ✘ |
| `--allow-unrelated-histories` | — | ✘ unrelated histories are refused |

Conflicts write index stages 1–3 plus marker bytes. A file/directory conflict
relocates the file side to a collision-checked `~<label>` path.

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
| `git rebase <upstream>` | `upstream` | ✔ |
| `--continue` / `--skip` / `--abort` | `rebaseContinue()` / `rebaseSkip()` / `rebaseAbort()` | ✔ |
| committer override | `committer`, `env` | ✔ |
| conflicts | `add()` / `rm()`, then `rebaseContinue()` | ✔ index stages 1–3; survives reopen |
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

## Configuration

### `git config` — `configGet()`, `configSet()`

| Git | kompjutr | |
|---|---|---|
| `git config <key>` | `configGet({ path })` | ✔ dotted key |
| `--get-all` | `all: true` | ✔ |
| `git config <key> <value>` | `configSet({ path, value })` | ✔ string, boolean or number |
| `--unset` | `value: undefined` | ✔ |
| `--add` | `append: true` | ✔ |
| `--global`, `--system`, `--file` | — | ✘ one repository-scoped store; no file, no include directives, no scope precedence |
| `--list`, `--edit` | — | ✘ |

Keys the engine actually reads:

| Key | Effect |
|---|---|
| `user.name`, `user.email` | commit identity |
| `remote.<name>.url` | fetch/clone/push URL |
| `remote.<name>.pushurl` | push URL override |
| `remote.<name>.fetch` | written by clone; not used as a refspec matcher |
| `branch.<name>.remote`, `branch.<name>.merge` | upstream for pull and push |
| `pull.ff` | pull fast-forward policy |
| `pull.rebase` | recognised, then rejected |
| `core.bare` | recorded by `init({ bare: true })`, otherwise inert |

Every other key is stored and returned verbatim but has **no effect** —
including `core.autocrlf`, `core.fileMode`, `core.ignorecase`,
`merge.conflictStyle`, and anything under `diff.*` or `gc.*`.

## Not implemented

These have no method and no equivalent. `stash` and the argv entry point throw
`UnsupportedOperationError`; the rest simply do not exist on the surface.

- **State:** `stash` (push/list/pop throw), `reflog`, `rerere`, `notes`
- **Layout:** `worktree`, `submodule` (gitlinks are preserved in trees but never
  followed), `sparse-checkout` as a command — sparse hydration is an internal
  optimisation, not a user-facing mode
- **Inspection:** `blame`, `bisect`, `describe`, `shortlog`, `grep`,
  `rev-list`, `for-each-ref`, `merge-base`, `whatchanged`
- **Patches:** `apply`, `am`, `format-patch`, `send-email`, `cherry`
- **Maintenance:** `gc`, `fsck`, `repack`, `prune`, `count-objects`, `verify-pack`
- **Rewriting:** `filter-branch`, `replace`, `fast-import`, `fast-export`
- **Packaging:** `archive`, `bundle`
- **Mechanisms:** hooks, GPG/SSH signing, credential helpers, `.gitattributes`
  (no filters, no eol conversion, no merge drivers), `.mailmap`, Git LFS,
  `git://` and `ssh://` transports, `--filter` partial clone

## Surface differences

`kompjutr/compat/computer` implements Computer's `GitClient` interface. It
covers clone, fetch, init, status, diff, diffSummary, clean, add, rm, reset,
commit, log, show, revParse, repoRoot, currentBranch, lsFiles, lsTree, branch,
tag, checkout, remote, config, hashObject, catFile, updateRef, push, pull and
merge — with these differences:

- ✘ no `cherryPick`, `revert` or `rebase`;
- ✘ no `mergeContinue` / `mergeAbort`: merge is single-shot, so a conflict rolls
  the local integration back and reports `EMERGEFAIL`. A conflicting pull still
  keeps the fetched objects and the remote-tracking ref;
- `pull` returns `void` rather than a `MergeResult`.

## Limits

Every accepted operation stays inside ≤1,000 SQL statements and <100 MiB. An
operation that would exceed a structural limit throws a stable error instead of
truncating. The per-operation caps (integration plan entries, tree bytes,
worktree scan rows, path length, journal steps) are listed in
[`architecture.md`](architecture.md).

Two limits bite most often in ordinary use: the 2,200-byte cap on an emitted
Git path, and the 4,096-step cap on a rebase or replay journal.

## Path and ordering rules

- Pathspecs everywhere are **exact path or directory prefix**. No globs, no
  `:(exclude)`, no `:(icase)`, no leading `:/`.
- Paths order by UTF-8 bytes, matching Git and SQLite `BINARY` — never by
  JavaScript string comparison.
