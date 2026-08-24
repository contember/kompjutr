# Plan — the shell

A bash-shaped command surface owned by kompjutr, over `Filesystem`.

> **Status: waves A–D shipped**, as `kompjutr/shell`. §11 records what the
> measurements changed, §12 the SQL content predicate that came after them,
> and §13 what running the real `grep` and `rg` corrected. Several of this
> document's claims were wrong and are fixed in place; the rest held.

## The thesis

Every other virtual shell — just-bash included — implements a command as a
**loop over a tree**: walk `readdir`, `readFile` each hit, filter in JS. On a
Durable Object that is one statement per file, which is the cost model
[`bulk-sql.md`](bulk-sql.md) exists to kill.

kompjutr already has the primitives that make a command a **query** instead:

| command | is really | statements |
|---|---|---|
| `find -name "*.ts"` | `fs.glob(root, pattern, { limit })` | **1** |
| `grep -rl pat` (literal) | `fs.discoverFilesContaining` | **1** |
| `grep -r pat` (expression) | `discoverFiles` → `readFileHandles` | `⌈files/1000⌉ + ⌈bytes/budget⌉` |
| `ls dir` | `fs.readdir` | **1** |
| `head -20 file` | `fs.readRange(path, 0, n)` | **1** |
| `rm -rf dir` | `fs.removeFiles` (range delete) | **O(1)** |

The second row is the one that took two attempts. See §12.

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
[`architecture.md`](../../reference/architecture.md).

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

### R1 — a trailing `head -N` bounds the source (observed 76×)

**The stage stays.** It is the mechanism: execution is pull-based, so a
`head` that stops pulling stops the search behind it, which stops the reads
behind that. An earlier draft of this section said `N` became a SQL `LIMIT`
and the stage was dropped — see §11 for what that actually did.

What the planner contributes is the *knowledge* that the pipeline is
bounded, published as `limitHint`, plus the refusal to publish it when a
blocking stage (`sort`, `wc`) sits in between and would swallow it.

`tail -N` is not a limiter: it needs the end of its input. It becomes a
bounded ring buffer of N lines — memory O(N), not O(output) — and a
`tail -N file` reads backwards from the end rather than through the file.

**This is the headline win, and it measures.** `grep -rl pat . | head -20`
costs 8 statements at 2,000 files and 8 at 6,000, while the same search
without the `head` goes from 11 to 23.

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
| `grep` | `-r -R -i -n -l -L -v -E -F -c -w -x -h -H -s -e -A -B -C --include --exclude` | `discoverFilesContaining`, else `discoverFiles` + `readFileHandles` |
| `rg` | `-i -S -s -n -N -l -v -F -c -w -x -e -A -B -C -g -t --hidden --no-filename --no-heading` | same engine, own surface — §5.1 |
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
| `-c` on a file with no match | prints `path:0` | **omits the file** |
| a binary file a walk found | reported | **skipped silently** |
| the binary notice | `grep: <path>: binary file matches`, on **stderr** | `<path>: binary file matches (found "\0" byte around offset N)`, on **stdout** |
| a hidden file matching `-g`/`-t` | n/a — dotfiles are searched | **whitelisted**, overriding the dotfile skip |

The last four rows are not from the documentation. They came out of the
parity suite, which is the point of running the real binaries — see §13.

Two of them reach further than their row suggests. `rg -c` listing only
matches means the SQL predicate answers it exactly, so `rg -c` keeps the
push-down that `grep -c` cannot have. And rg skipping walked binaries would
have forced a read of every candidate to find the NUL — giving the
push-down straight back — so the NUL test goes into the same statement as
the needle: `instr(bytes, X'00')`.

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
form in both surfaces — there is no terminal here. Verified against real
`rg` in the parity tests rather than inferred from documentation.

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
[`architecture.md`](../../reference/architecture.md) holds.

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

Measured in `tests/shell/cost.test.ts`, on a fixture of realistic file sizes
(~3 KB) with one file in ten matching.

| operation | measured | note |
|---|---|---|
| `pwd` | **0** | answered from the session cache |
| `cat file` (≤ budget) | 3 | |
| `cd dir` | 3 | one `statTarget`, one row written |
| `find . -name '*.ts'` | 4 | one indexed GLOB |
| `ls dir` | 6 | |
| `grep -rl pat --include='*.ts'` (literal) | **6 at 2,000 files, 6 at 6,000** | of which 1 is the search |
| the same with `\| head -20` | 7 either way | |
| `grep -rn pat` (literal, prints lines) | 8 at 2,000, 9 at 6,000 | +1 read batch for 3x the matching bytes |
| `grep -rl 'pa.t'` (expression) | 12 at 2,000, **24** at 6,000 | no regex to push down |
| `rm -r` (200 vs 2,000 files) | 10 either way | a range delete |

The search block is the result that matters, and the reason the shape is
asserted at two sizes rather than against a constant. A literal search is
flat; the expression fallback doubles over the same step, which is what
proves the push-down is the half doing the work.

**These are not 1 apiece, and the original draft of this table said they
should be.** Roughly half of each figure is resolving a path through every
symlink on the way before it reaches `fs_paths` — the §3.6 invariant the
store is built on, not overhead the shell can remove. What the shell owes is
that the numbers are *constants*, and they are.

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
| **C2b — `rg` surface** | `src/shell/commands/rg.ts` | Parity against **real `rg`**, same discipline. Every divergence in §5.1 asserted explicitly, including the deliberate ignore-file one. |
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
   two surfaces over it. §5.1 records the behavioural divergences and the
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

## 11. What the measurements changed

Both corrections came from tests that were written to be able to fail.

**R1 cannot remove the `head` stage.** The first implementation lifted the
limit into a hint and dropped the stage, on the reasoning that laziness
would bound the source. Nothing then enforced the line count and
`cat file | head -2` returned the whole file. The stage *is* the mechanism:
it is what stops pulling. The hint is only advice about page sizing, and §4
now says so.

**The Wave A probe taught the wrong lesson.** It concluded that a discovery
page should be seeded at `2 × limitHint`, because a fixed 32 cost a second
round trip. Its fixture matched every *other* file. At a realistic density —
one in ten — that seeding made `grep … | head -20` cost **12 statements
against the unbounded search's 9**: the bounded query was more expensive
than the thing it was meant to beat. Discovery costs one statement whatever
the page size (which A1 had already shown), so pages are always full now.

The hint survives in exactly one place it earns: `cat big.log | head -20`
reads a bounded range instead of the file.

The lesson worth keeping is about fixtures, not about paging. A probe whose
fixture is too kind produces a confident number that is wrong in the
direction you were already hoping for.

## 12. The content predicate

Everything above was written on the assumption that a search reads its
candidate files and matches them in JS. It does not have to.

`instr()` over a stored BLOB is a byte search, so "which files contain these
bytes" is a SQL predicate, and `discoverFilesContaining` in `src/fs/` answers
it in one indexed statement. The content of a file that cannot match never
reaches the isolate — which on a Durable Object matters more than the
statement it saves, because the heap is the ceiling
[`computer-git-index-ceiling`](../benchmarks/benchmark-reference.md) is about.

What it covers: a **literal, case-sensitive, positive** search, which is most
of what the corpus contains. `instr` has no case folding, so `-i` falls back;
it cannot prove the absence `-v` asks about; and `-c` prints a count for
every file searched including zeros, which a predicate that returns only
matches cannot supply. Each of those is a named condition in the surfaces,
not an accident.

What it cannot settle: a needle straddling a chunk boundary. Content is
stored in `CHUNK_SIZE` pieces and `instr` sees one at a time, so a
multi-chunk file may contain the needle without any single chunk doing so.
Those files come back as `undecided` and are read. Note the asymmetry with
the glob narrowing, where SQL gives a *superset* and JS trims: here a naive
predicate gives a *subset*, and the failure mode is a search that silently
misses a file rather than one that is merely slow.

The equivalence suite runs every search twice — once where the predicate
decides it, once forced down the read-and-match path — and demands identical
bytes. It found the `-c` divergence on its first run.

### What the bench shows

`bench/shell.ts`, `npm run bench -- --scenarios=shell-*`. The pair to read
is the first two rows: the same tree, the same files found, one searched
with a substring and one with an expression.

| operation | N | wall ms | statements | rows | peak RSS |
|---|---|---|---|---|---|
| `shell-grep-literal` | 2,000 | 19 | 5 | 203 | 0.2 MB |
| `shell-grep-literal` | 6,000 | 48 | **5** | 603 | 2.6 MB |
| `shell-grep-regex` | 2,000 | 136 | 12 | 4,004 | 0.4 MB |
| `shell-grep-regex` | 6,000 | 372 | **28** | 12,008 | 8.0 MB |
| `shell-grep-lines` | 6,000 | 84 | 7 | 1,203 | — |
| `shell-grep-head` | 6,000 | 50 | 5 | 603 | — |
| `shell-find` | 6,000 | 30 | 5 | 6,003 | 1.0 MB |
| `shell-rm-rf` | 6,000 | 3 | 12 | 7 | 0.1 MB |

**Rows is the number that carries the argument**, more than statements. At
6,000 files the literal search moves 603 rows and the expression moves
12,008 — twenty times as many — because the expression has to bring every
candidate file's content into the isolate to test it. Peak RSS follows:
2.6 MB against 8.0 MB, and 13.3 MB on the deep variant. On a Durable Object
that is the ceiling that binds first.

Three rows confirm claims made earlier from statement counts alone.
`shell-grep-head` is identical to `shell-grep-literal`, which is what §11
predicted once the search stopped reading the tree — the `head` bounds the
output and nothing else. `shell-find` returns a row per file but never a
byte of content. And `shell-rm-rf` is 12 statements and 7 rows at both
sizes: the range delete does not care how much it deletes.

## 13. What parity changed

C2a and C2b called for parity against the real binaries. Running them found
eight things this implementation had wrong, none of which a hand-written
expectation would have caught, because every one of them was written the way
I assumed it worked:

| what | was | is |
|---|---|---|
| `-L` | in grep's flag table, absent from its switch — accepted, then rejected as unknown | implemented; exit status follows the *pattern*, not the listing |
| adjacent matches under `-C` | the second printed as a context line (`3-HIT`) | a match line (`3:HIT`), whoever's window emitted it |
| the binary notice | `Binary file X matches` on stdout | GNU's stderr form for `grep`, rg's stdout form for `rg` |
| a binary file under `-l`/`-c` | replaced by the notice | listed and counted like any other file |
| binary detection | a NUL in the first 8 KiB | a NUL anywhere; both binaries find a late one |
| `rg -c` | printed `path:0` rows | omits them, and therefore keeps the push-down |
| walked binaries in `rg` | reported | skipped, decided in SQL |
| a missing or unreadable path | silent, exit 2 | GNU's diagnostic, and `-s` to silence it |
| context groups over a pipe | no `--` between them | `--`, as both binaries print |

The suite lives in `tests/shell/parity-{grep,rg}.test.ts` over
`tests/helpers/parity.ts`, and it skips loudly rather than passing quietly
when a binary is missing. Three dimensions are controlled rather than
compared, because neither implementation specifies them: `LC_ALL=C`, rg's
ignore files (the deliberate divergence, switched off on rg's side so the
rest is comparable), and walk order — `rg --sort path` fixes it, GNU grep
has no equivalent, so its recursive cases compare as sets. That the shell's
own order is sorted is asserted separately: it is a property of the shell,
not something inherited.

One trap worth naming: on a developer machine `grep` is often aliased to
something else — ugrep here. The harness spawns without a shell, so the
alias cannot substitute itself, and it checks `--version` says GNU before
believing anything.
