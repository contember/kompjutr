---
id: 41
title: Add partial clone with lazy blob backfill
blocked-by: []
---

# 41 — Add partial clone with lazy blob backfill

**Summary.** Tier A. `clone()` cannot omit blobs, so first contact with a
repository costs every byte its history ever held.

## Problem

`src/core/ops/network.ts` has no `filter` option and never negotiates the
`filter` capability with `upload-pack`. The only lever on clone size is `depth`,
which trades away *history* — and [38](38-clone-depth-and-deepening.md) already
records how badly that fails closed later.

`--filter=blob:none` trades a different axis: the full commit and tree graph is
kept, only file content is deferred. For a repository whose history carries
large binaries, that is the difference between a usable clone and an impossible
one, and it is the axis the [reference
workload](../reference/git-support.md#the-reference-workload) actually uses.

Nothing today models *missing but promised*. A `git_objects` row is present or
absent, and every read path treats absent as corrupt, so a partial repository
would fail as a broken one.

## Approach / acceptance

- Negotiate `filter` on clone and fetch. A filter the server does not advertise
  is refused with a stable code — never silently downgraded to a full fetch.
- Record the promisor remote and mark the repository partial. Add a promisor
  object state distinct from missing, so a read of an unfetched blob triggers
  one bounded backfill instead of a `CorruptError`.
- Backfill is an explicit bounded operation with its own statement and byte
  budget. A read path that would need an unbounded number of backfills fails
  closed with a stable code rather than issuing a fetch per object.
- Decide and record how partial interacts with shallow (a repository may be
  both) and with the promisor remote being re-pointed — in Git, re-pointing
  `origin` on a partial clone leaves the promised blobs unreachable, and a push
  then dies mid-transfer. kompjutr must detect that before it starts, not during.
- Real Git parity tests: a `blob:none` clone against a real server; reading a
  promised blob; a checkout that materialises many blobs at once; a server
  without `filter`; and a partial repository pushed to a second remote.

## Touch points

`src/core/ops/network.ts`, `src/core/protocol/transport.ts`,
`src/core/protocol/remote.ts`, `src/sqlite/schema.ts`, `src/sqlite/store.ts`,
`src/core/repository.ts`, `src/git/client.ts`, `tests/clone.test.ts`,
`tests/protocol.test.ts`, `docs/decisions/`, `docs/reference/git-support.md`

<!-- Origin: docs/reference/git-support.md#reference-workload-coverage -->
