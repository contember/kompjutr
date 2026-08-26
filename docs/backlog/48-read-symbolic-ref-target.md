---
id: 48
title: Read a symbolic ref's target
blocked-by: []
---

# 48 — Read a symbolic ref's target

**Summary.** Tier B. Fetch already records `refs/remotes/<remote>/HEAD`, but
nothing can read back which branch it names.

## Problem

`fetchInto()` writes the remote's advertised HEAD into the tracking namespace as
a symbolic ref (`src/core/ops/network.ts:220`), once the branch it names has been
fetched. `fetch()` and `clone()` also return `defaultBranch` from the
advertisement. So the answer exists twice — but only in the moment.

Afterwards it is unreachable. `revParse()` resolves a symbolic ref through to its
OID (`src/core/repository.ts:244`), which is the opposite of what a caller asking
"which branch is the remote's default" needs. `currentBranch()`
(`src/git/client.ts:203`) reads local HEAD only. There is no `for-each-ref` and
no `symbolic-ref` read; `updateRef({ symbolic: true })` can write one and never
read one back.

A consumer that wants the default branch must therefore keep the return value of
the clone that created the repository — across restarts, in a store of its own —
or fall back to a hardcoded guess. roj's platform adapter does the latter, and
its port comment records the capability as permanently absent, which was true of
its previous backend and is not true here.

This is deliberately the *offline* read. Item
[42](42-remote-ref-discovery-and-refspec-fetch.md) surfaces the live
advertisement, which carries `symref=HEAD:` and can answer the same question —
but only over the network, and only while the remote is reachable.

## Approach / acceptance

- Add a read returning a ref's raw target: the branch a symbolic ref names, the
  OID a direct ref holds, and an explicit absent for a ref that is not there.
  Bound the returned target the way every other ref read is bounded.
- Do not resolve. A dangling symbolic ref must report the name it points at —
  that is the case a caller is most likely to be diagnosing.
- Real Git parity against `symbolic-ref -q` and `for-each-ref
  --format=%(symref)` for a tracking HEAD written by clone, a tracking HEAD after
  the branch it named was pruned, a direct ref, a missing ref, local `HEAD` both
  symbolic and detached, and a symbolic ref chain.
- `git-support.md` currently documents no symbolic-ref read at all; add it.

## Touch points

`src/core/repository.ts`, `src/core/ops/plumbing.ts`, `src/git/client.ts`,
`src/git/index.ts`, `src/index.ts`, `tests/refs.test.ts`,
`docs/reference/git-support.md`

<!-- Origin: migration assessment of roj's platform adapter onto kompjutr, 2026-08-26. -->
