# Plan — the shell

A bash-shaped command surface owned by kompjutr, over `Filesystem`.

## The thesis

Every other virtual shell — just-bash included — implements a command as a
**loop over a tree**: walk `readdir`, `readFile` each hit, filter in JS. On a
Durable Object that is one statement per file, which is the cost model
[`bulk-sql.md`](bulk-sql.md) exists to kill.

kompjutr already has the primitives that make a command a **query** instead:

| command | is really | statements |
|---|---|---|
| `find -name "*.ts"` | `fs.glob(root, pattern, { limit })` | **1** |
| `grep -r pat --include="*.ts"` | `discoverFiles` → `readFileHandles` | `⌈files/1000⌉ + ⌈bytes/budget⌉` |
| `ls dir` | `fs.readdir` | **1** |
| `head -20 file` | `fs.readRange(path, 0, n)` | **1** |
| `rm -rf dir` | `fs.removeFiles` (range delete) | **O(1)** |

So the shell is not a bash port that happens to run on SQLite. It is a
**query planner with bash syntax on the front**. That is the only reason to
build one instead of shipping tool calls, and it has to show up in the
statement counts or the whole thing is pointless.

### The lever: the pipeline is a query, not two processes

In a real shell `find . -name '*.ts' | xargs grep -l pat | head -20` is three
processes and full materialisation at every stage. Here all three stages are
the *same* indexed scan, so they fuse into one pass with the limit pushed into
SQL. **This is the feature.** Nobody else can have it, because nobody else's
`find` and `grep` share a cursor.

---

## 1. Scope, from evidence

Measured over 614 real agent command lines (5 sandbox sessions, 10 agents,
one production application). Every number below is from that corpus, not
from taste.

### 1.1 What agents call

29 distinct binaries. With `git` (solved separately) and `bun`/`bunx` (out of
scope — container) removed, the population is **275 lines**.

| | invocations | | invocations |
|---|---:|---|---:|
| `grep` + `rg` | **228** | `cp` | 9 |
| `head` + `tail` | 148 | `sed` | 7 |
| `find` | 33 | `sort` | 2 |
| `ls` | 22 | `which`, `pwd` | 2, 2 |
| `echo` | 17 | `wc` | 1 |
| `cat` | 13 | `mv` | 1 |
| `xargs` | 11 | `env`, `sleep`, `true`, `paste`, `date` | 1 each |

Search is 60 % of the work. Everything else is a rounding error next to it.

### 1.2 What bash grammar they actually use

Parsed all 614 lines through just-bash's parser and collected the AST node
kinds it emitted. Of its ~80 kinds:

| node | lines |
|---|---:|
| `Script` `Statement` `Pipeline` `SimpleCommand` `Word` `Literal` | 613 |
| `DoubleQuoted` | 295 |
| `Redirection` | 145 |
| `SingleQuoted` | 42 |
| `Glob` | 7 |
| `Escaped` | 6 |
| `For` | 4 |
| `ParameterExpansion` | 4 |
| `Assignment` | 2 |
| `If` / `CommandSubstitution` | 1 / 1 |

**11 node kinds cover 613 of 614 lines.** The tail — `For`, `If`,
`ParameterExpansion`, `Assignment`, `CommandSubstitution` — is 8 lines, 1.3 %.

### 1.3 What the syntax is *for*

Of 275 lines: 51 % are a single command with no operator at all. Of the 114
multi-stage lines, **76 end in `| head`**. Most redirection is `2>/dev/null`.
`&&` outside a leading `cd` appears twice; control flow five times;
command substitution once.

Agents are not scripting. They are making single calls with two ergonomic
decorations: **truncate the output** and **swallow the errors**.

That is the design brief. The grammar is small because the usage is small,
and the two things the grammar is mostly carrying — `| head` and
`2>/dev/null` — are exactly the two things the planner can turn into a
`LIMIT` and a flag.

---

## 2. Non-goals

Deliberately not implemented. Each is a decision, not an omission:

- **Arithmetic** (`$(( ))`), `case`, here-docs, process substitution
  (`<( )`), brace expansion, functions, `[[ ]]` conditionals, job control,
  subshell `( )`. Zero occurrences in the corpus.
- **`awk`.** Zero occurrences. It is a language, not a command.
- **A real `sed`.** 7 occurrences, all `s///` and `-n Np`. Ship those two
  forms; error clearly on anything else. A wrong `sed` is worse than no `sed`.
- **Job control, signals, `trap`, `set -e`.** One command, one result.
- **Network commands.** `curl` is 6 lines and belongs to the host's fetch
  seam, not to the filesystem. If it ships, it ships as an injected command.
- **`bun`, `bunx`, `python3`, `node`.** Real binaries. Container's problem.
- **Ignore files.** No `.gitignore` / `.ignore` handling, in either surface.
  A kompjutr workspace is a checkout, not a build tree — `node_modules` is
  not there to be skipped, so the default costs nothing and the machinery
  costs a per-directory read on the discovery path. This is a deliberate
  divergence from real `rg`; §5.1 records it so nobody later "fixes" it by
  accident. If it is ever wanted, it comes from the git layer as a
  discovery-query predicate, never as a post-filter.

`git` is **not** a shell command in this package. It is injected by the
consumer as a registered command, exactly like Computer does it — otherwise
`src/shell/` would depend on `src/git/` and break the one-way rule in
[`architecture.md`](../architecture.md).

---

## 3. Architecture

```
        source string
             │
        ┌────▼────┐
        │  parse  │  11 node kinds. No expansion, no fs access.
        └────┬────┘
             │  AST
        ┌────▼────┐
        │  plan   │  fusion, limit pushdown, glob lowering.
        └────┬────┘   THE POINT. Pure. Fully testable without a database.
             │  Plan
        ┌────▼────┐
        │ execute │  runs the Plan against `Filesystem`. Bounded.
        └─────────┘
```

Three stages, not two. The middle one is why this exists, and keeping it pure
means the interesting behaviour is unit-testable with no SQLite at all.

```
src/shell/
  parse/     lexer.ts  parser.ts  ast.ts
  plan/      plan.ts  fuse.ts  types.ts
  exec/      execute.ts  budget.ts  bytes.ts
  commands/  search.ts  grep.ts  rg.ts  read.ts  list.ts  write.ts  text.ts  misc.ts
  session.ts schema.ts   -- the persistent cwd, §5.2
  index.ts   createShell({ fs, commands, sessionId })
```

`search.ts` is the engine; `grep.ts` and `rg.ts` are the two flag surfaces
over it (§5.1).

Dependencies run one way: `src/shell/` imports `src/fs/` and nothing else in
the repo. Published as `kompjutr/shell`.

---

## 4. The fusion rules

The planner rewrites a pipeline into one bounded query. Each rule is keyed to
the shapes actually observed.

### R1 — limit pushdown (observed 76×)

```
grep -r pat . | head -20     →  search(pat, limit: 20)
find . -name '*.ts' | head   →  glob(pattern, limit: 10)
ls dir | head -5             →  readdir(dir) sliced at 5
```

A trailing `head -N` / `tail -N` never materialises the producer's full
output. For `head`, `N` becomes the SQL `LIMIT` and discovery stops early.
`tail -N` cannot push down (it needs the end), so it becomes a bounded ring
buffer of N lines — memory O(N), not O(output).

**This is the headline win.** `grep -r pat . | head -20` over a 9,000-file
tree must not read 9,000 files.

### R2 — discover/read fusion (observed ~10×)

```
find . -name '*.ts' | xargs grep -l pat   →  search(pat, include: '*.ts', mode: 'files')
grep -rl pat . | xargs cat                →  search(pat, mode: 'content')
```

`find`'s output *is* `discoverFiles`' cursor and `grep`'s input *is*
`readFileHandles`. Fusing them skips one full round trip of paths through
JS and one re-resolution of every path.

### R3 — filter pushdown (observed ~11×)

```
ls dir | grep foo        →  readdir(dir) filtered in memory (no second query)
find . | grep '\.ts$'    →  glob lowered to '*.ts' where the regex is anchored
                            and literal; otherwise scan + filter
```

`fs.glob` caps a GLOB pattern at 50 bytes (`GLOB_PATTERN_MAX_BYTES`). When
lowering would exceed it, fall back to `scan` + in-memory match. The planner
decides; the executor never guesses.

### R4 — stderr elision (observed on most redirected lines)

`2>/dev/null` sets a flag on the plan. It never allocates a buffer that is
then discarded.

### R5 — pure-text stages never touch the filesystem (observed 12×)

`grep pat | grep other`, `... | sort`, `... | wc -l` operate on the previous
stage's byte stream. No second query, no path resolution.

---

## 5. The command set

15 commands. Each row names the `Filesystem` call it lowers to — if a command
cannot name one, it does not belong here.

| command | flags that ship | lowers to |
|---|---|---|
| `grep` | `-r -i -n -l -v -E -F -c -w -A -B -C --include --exclude` | `discoverFiles` + `readFileHandles` |
| `rg` | `-i -S -n -l -v -F -c -w -A -B -C -g -t --hidden --no-filename` | same engine, own surface — §5.1 |
| `find` | `-name -type -maxdepth` | `glob`, else `scan` |
| `ls` | `-l -a -1 -R` | `readdir` / `scan` |
| `cat` | — | `readFiles` (batched when several args) |
| `head` / `tail` | `-n -c` | `readRange` |
| `wc` | `-l -c -w` | `readRange` streaming |
| `cp` / `mv` | `-r` | `writeFiles` / `rename` |
| `rm` | `-r -f` | `removeFiles` |
| `mkdir` | `-p` | `makeDirectories` |
| `touch` | — | `writeFiles` |
| `stat` | — | `stat` |
| `sed` | `s///` and `-n Np` only | `readRange` + `writeFile` |
| `sort` / `uniq` | `-r -n -u` | in-memory, bounded |
| `echo` / `pwd` / `true` / `which` | — | none |
| `xargs` | `-n -I` | usually fused away by R2 |

`cd` is a builtin and the shell owns `cwd` across calls — §5.2.

### 5.1 `grep` and `rg` are two surfaces over one engine

`rg` is **not** an alias. Agents used both (130 vs 98) and their defaults
differ in ways that produce visibly different output, so aliasing would be a
lie that surfaces as wrong results.

One `search()` core in `plan/` and `exec/`. Two flag tables, two default
sets, two dialect mappings on top of it. What differs:

| | `grep` | `rg` |
|---|---|---|
| recursion | opt-in (`-r`) | **default** |
| path filter | `--include='*.ts'` | `-g '*.ts'`, `-t ts` |
| case | sensitive; `-i` | sensitive; `-i`, plus `-S` smart-case |
| dotfiles | searched | **skipped**; `--hidden` to include |
| pattern | BRE by default, ERE with `-E` | ERE-shaped, always |
| filename prefix | when >1 file | when >1 file; `--no-filename` |

`-t ts` needs a small built-in type map (`ts`, `js`, `md`, `json`, `css`,
`html`, `py`, `go`, `rust`, `sh`). Lower it to the same GLOB predicate `-g`
produces, not to a post-filter.

**Regex dialect is the sharp edge.** The engine is JS `RegExp`, which is
neither GNU BRE/ERE nor Rust's `regex`. Policy: translate what maps
mechanically (BRE's `\(` `\)` `\{` `\}`, character classes, anchors), and
**reject with an error naming the construct** for anything that does not —
rather than silently running a pattern that means something else. Real
divergences to reject rather than fake: Rust `regex` has no backreferences
and no lookaround, and POSIX classes (`[:alpha:]`) exist in both greps but
not in JS.

The tty-dependent defaults (heading, line numbers) resolve to the **piped**
form in both surfaces — there is no terminal here. Verify against real `rg`
in the parity tests; do not infer it from documentation.

### 5.2 The shell owns `cwd`

Persistent across calls. This removes the `cd X &&` prefix from 60 % of
observed lines, and with it a whole class of "the agent forgot where it was"
errors.

It has to survive Durable Object eviction, so it is a row, not a field:

```
shell_sessions(session_id TEXT PRIMARY KEY, cwd TEXT NOT NULL, rev INTEGER)
```

`initializeShellSchema(db, now)`, mirroring `initializeFsSchema`. The shell
reaches the database through `Filesystem.db`, which the interface already
exposes — no new dependency, and the one-way rule in
[`architecture.md`](../architecture.md) holds.

Cost: **one write statement per `cd`**, and one read per isolate — the value
is cached in memory for the isolate's lifetime, which is exactly the lifetime
that eviction invalidates anyway. An exec that does not `cd` costs nothing.

`cd` validates against `fs.statTarget` and fails loudly on a missing or
non-directory path; a session must never persist a `cwd` that is not there.

---

## 6. Two disciplines that are easy to get wrong

**Bytes, not strings.** Commands operate on `Uint8Array` end to end. A
pipeline that decodes to UTF-8 at each stage corrupts binary content and
costs two copies per stage. Decode only at the boundary, and only when the
caller asked for text. (This is the one thing worth reading just-bash's
`encoding.d.ts` for — their `ByteString` / `latin1FromBytes` split is the
right shape.)

**Everything is bounded, by construction.** Every plan carries:

- `maxOutputBytes` — the executor stops and marks the result truncated.
  Never "produce then slice".
- `maxStatements` — a hard ceiling per exec, so a pathological pattern
  cannot walk a million rows.
- `budget` — bytes per SQL statement, passed straight to `readFileHandles`.

An agent that forgets `| head` must still get a bounded result. That is a
property of the executor, not of the agent's discipline.

---

## 7. Targets

The done-check numbers. Fixture: Prettier 3.9.6, 9,329 files, as in
[`bulk-sql.md`](bulk-sql.md).

| operation | statement target |
|---|---|
| `ls /repo/src` | 1 |
| `head -20 file` | 1 |
| `cat file` (≤1.5 MB) | ≤2 |
| `find . -name '*.ts' \| head -20` | **1** |
| `grep -r pat . \| head -20` | **≤5** — must not scale with tree size |
| `grep -rl pat . --include='*.ts'` (full) | `⌈files/1000⌉ + ⌈bytes/1.5MB⌉` |
| `rm -rf src` (5,000 files) | O(1) |
| 3-stage fused pipeline | same as the fused single stage |
| `cd dir` | 2 — one `statTarget`, one session write |
| any exec that does not `cd` | +0 for session state after the first |

The second-to-last row is the formula, not a constant: assert the *shape* of
the curve at two tree sizes an order of magnitude apart, per the
[three-part done-check rule](standalone-runtime-units.md).

---

## 8. Decomposition

Territories are disjoint. Waves are barriers.

### Wave A — evidence. Not a deliverable.

| unit | territory | done-check |
|---|---|---|
| **A1 — grep cost probe** | `tmp/grep-probe.ts` | `discoverFiles` + `readFileHandles` over Prettier at three `--include` selectivities. Confirms the §7 formula, or invalidates the plan before anything is built on it. |
| **A2 — early-stop probe** | `tmp/limit-probe.ts` | Can discovery actually stop after 20 matches, or does the keyset cursor force a full page? R1 is the whole thesis; if it does not hold, the plan changes. |

### Wave B — the pure core. No database, no `Filesystem`.

| unit | territory | done-check |
|---|---|---|
| **B1 — lexer + parser** | `src/shell/parse/**` | Parses all 614 corpus lines. Emits exactly the 11 node kinds; rejects the other 69 with a clear error naming the construct. Fuzz the quoting: single, double, escape, unterminated. |
| **B2 — plan types + planner** | `src/shell/plan/**` | Golden-file plans for the 25 observed pipeline shapes. R1–R5 each asserted. Pure — no `Filesystem` import allowed in this territory. |

### Wave C — execution. Depends on B.

| unit | territory | done-check |
|---|---|---|
| **C1 — executor + budgets** | `src/shell/exec/**` | Output truncation, statement ceiling, stderr elision. A command that ignores the budget fails the test. |
| **C2 — search engine + `find`** | `src/shell/commands/{search,find}.ts` | The §7 statement targets, asserted at two tree sizes an order of magnitude apart. Surface-agnostic: no flag tables in this territory. |
| **C2a — `grep` surface** | `src/shell/commands/grep.ts` | Parity against **real GNU grep** on a fixture corpus, one case per shipped flag. BRE→JS translation, with a named error for every construct that does not map. |
| **C2b — `rg` surface** | `src/shell/commands/rg.ts` | Parity against **real `rg`**, same discipline. The six divergences in §5.1 each asserted explicitly, including the deliberate ignore-file one. |
| **C6 — session state** | `src/shell/{session,schema}.ts` | `cd` persists and survives a simulated eviction (drop the in-memory shell, rebuild from the row). Missing or non-directory target fails loudly and does not persist. §7 cost. |
| **C3 — read/list** | `src/shell/commands/{read,list}.ts` | `cat`, `head`, `tail`, `wc`, `ls`, `stat`. `head -20` = 1 statement. |
| **C4 — write** | `src/shell/commands/write.ts` | `cp`, `mv`, `rm`, `mkdir`, `touch`. `rm -rf` on 5,000 files stays O(1). |
| **C5 — text** | `src/shell/commands/{text,misc}.ts` | `sort`, `uniq`, `sed`, `echo`, `pwd`, `true`, `which`, `xargs`. Bounded memory asserted. |

### Wave D — leader-owned. Never delegated.

`src/shell/index.ts`, the `kompjutr/shell` export, the command registry
(where an injected `git` lands), and the macro benchmark scenarios in
`bench/scenarios.ts`.

### Gates

```bash
npx tsc -p tsconfig.json --noEmit
npx biome check .
npx vitest run
cpu-lease run -n 2 -- npm run bench:macro
```

---

## 9. Risks

**R1 might not hold.** If keyset paging forces a full 1,000-row page before
the executor can stop, `grep | head -20` costs a page regardless. Wave A2
answers this first, on purpose. Mitigation if it fails: a small first page
(`limit: 32`) that grows geometrically — trades one extra statement on large
result sets for a bounded cost on the common truncated one.

**The 50-byte GLOB ceiling.** `--include='**/*.{ts,tsx}'` does not lower to
one GLOB. The planner must split it into several `discoverFiles` calls or
fall back to `scan` + filter. Both are correct; the split is faster and the
fallback is simpler. Measure before choosing.

**`grep` flag parity is the real work.** Not the grammar. GNU grep's `-A/-B/-C`
context, `-w` word boundaries and `-E` vs `-F` semantics are where a
plausible-looking implementation silently returns wrong answers. Parity tests
against real grep on a fixture corpus, per flag, are non-negotiable.

**Scope creep from `sed`.** Ship two forms, error on the rest. The moment
`sed` grows a script parser this becomes a bash port and the thesis is lost.

---

## 10. Decisions taken

1. **`rg` gets its own flag surface**, not an alias. One `search()` engine,
   two surfaces over it. §5.1 records the six behavioural divergences and the
   regex-dialect policy; C2a and C2b own one surface each and both test
   against the real binary.
2. **No ignore-file handling**, in either surface. A workspace is a checkout,
   not a build tree — there is no `node_modules` to skip. Recorded as an
   explicit non-goal in §2, and as a stated `rg` divergence in §5.1, so it
   reads as a decision rather than as a gap someone should close.
3. **The shell owns `cwd`**, persisted in a `shell_sessions` row so it
   survives eviction, cached in memory for the isolate's lifetime. §5.2.
   One write per `cd`, nothing on any other exec.

### Still open

- **Where `sed` stops.** §2 says `s///` and `-n Np`. The first agent that
  hits the wall will ask for one more form, and that is how a shell becomes a
  bash port. Worth deciding now that the answer is no, and that the escape
  hatch is the container.
